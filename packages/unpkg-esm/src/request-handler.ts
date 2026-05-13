import {
  getEsmPackageSubpath,
  getPackageInfo,
  normalizeEsmRequestUrl,
  resolvePackageVersion,
} from "unpkg-worker";
import type { EsmRequestError, PackageJson } from "unpkg-worker";

import type { Env } from "./env.ts";

const publicNpmRegistry = "https://registry.npmjs.org";
const moduleCacheControl = "public, max-age=60, s-maxage=300";

export async function handleRequest(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
  let url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        Allow: "GET, HEAD, OPTIONS, POST",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS, POST",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  if (url.pathname === "/transform" && request.method === "POST") {
    return handleInlineTransformRequest(request, env);
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(`Invalid request method: ${request.method}`, {
      status: 405,
    });
  }

  if (url.pathname === "/_health") {
    return new Response("OK");
  }

  if (url.pathname === "/run" || url.pathname === "/tsx") {
    return new Response(createInlineRunner(), {
      headers: corsHeaders({
        "Cache-Control": moduleCacheControl,
        "Content-Type": "application/javascript; charset=utf-8",
      }),
    });
  }

  let normalized = normalizeEsmRequestUrl(request.url);
  if ("code" in normalized) {
    return jsonError(normalized);
  }

  let packagePath = normalized.packagePath;
  let packageName = packagePath.package.toLowerCase();
  let packageInfo = await getPackageInfo(context, publicNpmRegistry, packageName);
  if (packageInfo == null) {
    return jsonError({
      code: "PACKAGE_NOT_FOUND",
      message: `Package not found: ${packagePath.package}`,
      status: 404,
    });
  }

  let version = resolvePackageVersion(packageInfo, packagePath.version ?? "latest");
  if (version == null || packageInfo.versions == null || packageInfo.versions[version] == null) {
    return jsonError({
      code: "PACKAGE_VERSION_NOT_FOUND",
      message: `Package version not found: ${packageName}@${packagePath.version ?? "latest"}`,
      status: 404,
    });
  }

  let searchParams = new URLSearchParams(normalized.searchParams);
  if (packagePath.externalAll && !searchParams.has("external")) {
    searchParams.set("external", "*");
  }

  let search = normalizeSearch(searchParams);
  let pathname = `/${packageName}@${version}${packagePath.filename ?? ""}`;
  let shouldRedirect =
    packagePath.externalAll ||
    packageName !== packagePath.package ||
    packagePath.version !== version ||
    url.pathname !== normalized.url.pathname ||
    url.search !== normalized.url.search ||
    normalized.url.pathname !== pathname ||
    normalized.url.search !== search;

  if (shouldRedirect) {
    return redirect(`${pathname}${search}`, {
      status: packagePath.version === version ? 301 : 302,
      headers: corsHeaders({
        "Cache-Control": "public, max-age=60, s-maxage=300",
      }),
    });
  }

  let packageJson = packageInfo.versions[version];

  if (isTypeDeclarationPath(packagePath.filename)) {
    return serveRawFile(env, packageName, version, packagePath.filename);
  }

  if (isTypesOnlyPackage(packageName) && packagePath.filename == null) {
    let typesPath = getPackageTypesUrl(normalized.url.origin, packageName, version, packagePath.filename, packageJson);
    if (typesPath != null) {
      return redirect(new URL(typesPath).pathname, {
        status: 301,
        headers: corsHeaders({
          "Cache-Control": moduleCacheControl,
        }),
      });
    }
  }

  if (searchParams.has("meta")) {
    let metadata = await createMetadata(
      env,
      normalized.url.origin,
      packageName,
      version,
      packagePath.filename,
      packageJson,
      searchParams
    );
    if ("response" in metadata) {
      return metadata.response;
    }

    return Response.json(metadata, {
      headers: corsHeaders({
        "Cache-Control": "public, max-age=60, s-maxage=300",
        "Content-Type": "application/json",
      }),
    });
  }

  if (searchParams.has("worker")) {
    let workerSearchParams = new URLSearchParams(searchParams);
    workerSearchParams.delete("worker");
    let workerUrl = new URL(
      `/${packageName}@${version}${packagePath.filename ?? ""}${normalizeSearch(workerSearchParams)}`,
      normalized.url.origin
    );
    let code = `export default function createWorker(options) {\n  return new Worker(${JSON.stringify(workerUrl.toString())}, { type: "module", ...options });\n}\n`;

    return new Response(code, {
      headers: corsHeaders({
        "Cache-Control": moduleCacheControl,
        "Content-Type": "application/javascript; charset=utf-8",
      }),
    });
  }

  if (searchParams.has("raw")) {
    return serveRawFile(env, packageName, version, packagePath.filename ?? "/package.json");
  }

  let buildSearchParams = new URLSearchParams(searchParams);
  buildSearchParams.set("origin", normalized.url.origin);
  let buildResponse = await fetch(
    new URL(`/build/${packageName}@${version}${packagePath.filename ?? ""}${normalizeSearch(buildSearchParams)}`, env.FILES_ORIGIN)
  );
  if (!buildResponse.ok) {
    return jsonError({
      code: "BUILD_FAILED",
      message: await buildResponse.text(),
      status: buildResponse.status,
    });
  }

  let headers = new Headers(buildResponse.headers);
  for (let [name, value] of Object.entries(corsHeaders())) {
    headers.set(name, value);
  }
  let types = getPackageTypesUrl(normalized.url.origin, packageName, version, packagePath.filename, packageJson);
  if (types != null && !searchParams.has("no-dts")) {
    headers.set("X-TypeScript-Types", types);
  }

  return new Response(await buildResponse.arrayBuffer(), {
    status: buildResponse.status,
    statusText: buildResponse.statusText,
    headers,
  });
}

interface Metadata {
  build: {
    bundle: string;
    minify: boolean;
    sourcemap: boolean;
  };
  dependencies: Record<string, string>;
  exports: string[];
  integrity: string | null;
  module: string;
  name: string;
  peerDependencies: Record<string, string>;
  specifier: string;
  subpath: string;
  target: string;
  types: string | null;
  version: string;
}

async function createMetadata(
  env: Env,
  origin: string,
  packageName: string,
  version: string,
  filename: string | undefined,
  packageJson: PackageJson,
  searchParams: URLSearchParams
): Promise<Metadata | { response: Response }> {
  let subpath = getEsmPackageSubpath(filename);
  let target = searchParams.get("target") ?? "es2022";
  let artifactSearchParams = new URLSearchParams(searchParams);
  artifactSearchParams.delete("meta");
  let artifactSearch = normalizeSearch(artifactSearchParams);
  let modulePath = `/${packageName}@${version}${filename ?? ""}${artifactSearch}`;
  let module = new URL(modulePath, origin).toString();
  let types = getPackageTypesUrl(origin, packageName, version, filename, packageJson);
  let integrity = await getBuildIntegrity(env, origin, packageName, version, filename, artifactSearchParams);
  if ("response" in integrity) {
    return integrity;
  }

  return {
    name: packageName,
    version,
    specifier: `${packageName}@${version}`,
    subpath,
    target,
    module,
    types,
    integrity: integrity.value,
    dependencies: packageJson.dependencies ?? {},
    peerDependencies: packageJson.peerDependencies ?? {},
    exports: listExportSubpaths(packageJson),
    build: {
      bundle: searchParams.has("standalone") ? "standalone" : searchParams.has("bundle") ? "bundle" : "smart",
      minify: searchParams.has("min"),
      sourcemap: searchParams.has("sourcemap"),
    },
  };
}

async function getBuildIntegrity(
  env: Env,
  origin: string,
  packageName: string,
  version: string,
  filename: string | undefined,
  searchParams: URLSearchParams
): Promise<{ response: Response } | { value: string | null }> {
  if (searchParams.has("raw")) {
    return { value: null };
  }

  let buildSearchParams = new URLSearchParams(searchParams);
  buildSearchParams.set("origin", origin);
  let response: Response;
  try {
    response = await fetch(
      new URL(`/build/${packageName}@${version}${filename ?? ""}${normalizeSearch(buildSearchParams)}`, env.FILES_ORIGIN)
    );
  } catch {
    return { value: null };
  }

  if (!response.ok) {
    if (response.status === 404) {
      return {
        response: jsonError({
          code: "BUILD_NOT_FOUND",
          message: await response.text(),
          status: 404,
        }),
      };
    }

    return { value: null };
  }

  let bytes = await response.arrayBuffer();
  let digest = await crypto.subtle.digest("SHA-384", bytes);
  return { value: `sha384-${base64Encode(new Uint8Array(digest))}` };
}

async function serveRawFile(env: Env, packageName: string, version: string, filename: string): Promise<Response> {
  let rawResponse = await fetch(new URL(`/file/${packageName}@${version}${filename}`, env.FILES_ORIGIN));
  if (!rawResponse.ok) {
    return jsonError({
      code: "RAW_FILE_NOT_FOUND",
      message: await rawResponse.text(),
      status: rawResponse.status,
    });
  }

  let headers = new Headers(rawResponse.headers);
  if (isTypeDeclarationPath(filename)) {
    headers.set("Content-Type", "application/typescript; charset=utf-8");
  }
  for (let [name, value] of Object.entries(corsHeaders())) {
    headers.set(name, value);
  }

  return new Response(await rawResponse.arrayBuffer(), {
    status: rawResponse.status,
    statusText: rawResponse.statusText,
    headers,
  });
}

function getPackageTypesUrl(
  origin: string,
  packageName: string,
  version: string,
  filename: string | undefined,
  packageJson: PackageJson
): string | null {
  let types = resolveTypesPath(packageJson, getEsmPackageSubpath(filename));
  return types == null ? null : new URL(`/${packageName}@${version}/${types.replace(/^\.?\/*/, "")}`, origin).toString();
}

function isTypesOnlyPackage(packageName: string): boolean {
  return packageName.startsWith("@types/");
}

function isTypeDeclarationPath(filename: string | undefined): filename is string {
  return filename?.endsWith(".d.ts") || filename?.endsWith(".d.mts") || filename?.endsWith(".d.cts") || false;
}

export function resolveTypesPath(packageJson: PackageJson, subpath: string): string | null {
  let exports = packageJson.exports;
  if (typeof exports === "object" && exports != null) {
    let exportValue = exports[subpath];
    let resolved = findTypesExport(exportValue);
    if (resolved != null) {
      return resolved;
    }
  }

  let typesVersionsPath = resolveTypesVersionsPath(packageJson, subpath);
  if (typesVersionsPath != null) {
    return typesVersionsPath;
  }

  return packageJson.types ?? packageJson.typings ?? null;
}

function resolveTypesVersionsPath(packageJson: PackageJson, subpath: string): string | null {
  let typesVersions = packageJson.typesVersions;
  if (typesVersions == null) {
    return null;
  }

  let requestedPath = subpath === "." ? "" : subpath.replace(/^\.\//, "");
  for (let mappings of Object.values(typesVersions)) {
    let match = resolveTypesVersionMapping(mappings, requestedPath);
    if (match != null) {
      return match;
    }
  }

  return null;
}

function resolveTypesVersionMapping(mappings: Record<string, string[]>, requestedPath: string): string | null {
  let exact = mappings[requestedPath];
  if (exact?.[0] != null) {
    return exact[0];
  }

  for (let [pattern, targets] of Object.entries(mappings)) {
    if (!pattern.includes("*") || targets[0] == null) {
      continue;
    }

    let [prefix, suffix] = pattern.split("*", 2);
    if (requestedPath.startsWith(prefix) && requestedPath.endsWith(suffix)) {
      let matched = requestedPath.slice(prefix.length, requestedPath.length - suffix.length);
      return targets[0].replace("*", matched);
    }
  }

  return null;
}

function findTypesExport(value: unknown): string | null {
  if (typeof value === "string") {
    return null;
  }
  if (typeof value !== "object" || value == null) {
    return null;
  }

  let conditions = value as Record<string, unknown>;
  let types = conditions.types;
  if (typeof types === "string") {
    return types;
  }
  if (typeof types === "object" && types != null) {
    let resolved = findConditionalExport(types);
    if (resolved != null) {
      return resolved;
    }
  }

  for (let [name, nested] of Object.entries(conditions)) {
    if (name === "types" || name.startsWith("types@")) {
      continue;
    }

    let resolved = findTypesExport(nested);
    if (resolved != null) {
      return resolved;
    }
  }

  return null;
}

function findConditionalExport(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value !== "object" || value == null) {
    return null;
  }

  let conditions = value as Record<string, unknown>;
  if (typeof conditions.default === "string") {
    return conditions.default;
  }

  for (let nested of Object.values(conditions)) {
    let resolved = findConditionalExport(nested);
    if (resolved != null) {
      return resolved;
    }
  }

  return null;
}

function listExportSubpaths(packageJson: PackageJson): string[] {
  if (typeof packageJson.exports !== "object" || packageJson.exports == null) {
    return [];
  }

  return Object.keys(packageJson.exports).filter((key) => key.startsWith("."));
}

function normalizeSearch(searchParams: URLSearchParams): string {
  let entries = Array.from(searchParams.entries()).sort(([leftName, leftValue], [rightName, rightValue]) => {
    if (leftName === rightName) {
      return leftValue.localeCompare(rightValue);
    }

    return leftName.localeCompare(rightName);
  });
  let normalized = new URLSearchParams();

  for (let [name, value] of entries) {
    normalized.append(name, value);
  }

  let search = normalized.toString();
  return search === "" ? "" : `?${search}`;
}

function jsonError(error: EsmRequestError | { code: string; message: string; status: number }): Response {
  return Response.json(
    {
      error: {
        code: error.code,
        message: error.message,
      },
    },
    {
      status: error.status,
      headers: corsHeaders({
        "Cache-Control": "public, max-age=60, s-maxage=300",
        "Content-Type": "application/json",
      }),
    }
  );
}

function corsHeaders(headers?: HeadersInit): HeadersInit {
  return {
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "*",
    "Cross-Origin-Resource-Policy": "cross-origin",
    ...headers,
  };
}

function redirect(location: string | URL, init?: ResponseInit | number): Response {
  if (typeof init === "number") {
    return new Response(`Redirecting to ${location}`, {
      status: init,
      headers: {
        Location: location.toString(),
      },
    });
  }

  return new Response(`Redirecting to ${location}`, {
    status: 302,
    ...init,
    headers: {
      Location: location.toString(),
      ...init?.headers,
    },
  });
}

async function handleInlineTransformRequest(request: Request, env: Env): Promise<Response> {
  let sourceResponse = await fetch(new URL(`/transform${new URL(request.url).search}`, env.FILES_ORIGIN), {
    method: "POST",
    headers: {
      "Content-Type": request.headers.get("Content-Type") ?? "application/json",
    },
    body: await request.arrayBuffer(),
  });

  let headers = new Headers(sourceResponse.headers);
  for (let [name, value] of Object.entries(corsHeaders())) {
    headers.set(name, value);
  }

  return new Response(await sourceResponse.arrayBuffer(), {
    status: sourceResponse.status,
    statusText: sourceResponse.statusText,
    headers,
  });
}

function createInlineRunner(): string {
  return `const supportedScriptTypes = new Set(["text/babel", "text/jsx", "text/ts", "text/tsx"]);

function scriptFilename(script, index) {
  return script.getAttribute("data-filename") || "/inline-" + index + extensionForType(script.type);
}

function extensionForType(type) {
  if (type === "text/ts") return ".ts";
  if (type === "text/tsx") return ".tsx";
  if (type === "text/jsx") return ".jsx";
  return ".js";
}

function transformSearchParams(script) {
  let params = new URLSearchParams();
  params.set("target", script.getAttribute("data-target") || "es2022");
  params.set("external", "*");

  let type = script.type;
  if (type === "text/jsx" || type === "text/tsx" || type === "text/babel") {
    params.set("jsx", script.getAttribute("data-jsx") || "automatic");
  }
  if (script.hasAttribute("data-jsx-import-source")) {
    params.set("jsxImportSource", script.getAttribute("data-jsx-import-source"));
  }
  if (script.hasAttribute("data-dev")) {
    params.set("env", "development");
  }

  return params;
}

async function transformScript(script, index) {
  let filename = scriptFilename(script, index);
  let response = await fetch(new URL("/transform?" + transformSearchParams(script), import.meta.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename,
      source: script.textContent || ""
    })
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.text();
}

export async function run(root = document) {
  let scripts = Array.from(root.querySelectorAll("script[type]")).filter((script) => {
    return supportedScriptTypes.has(script.type) && !script.hasAttribute("data-esm-unpkg-ran");
  });

  for (let index = 0; index < scripts.length; index += 1) {
    let script = scripts[index];
    script.setAttribute("data-esm-unpkg-ran", "");

    let moduleScript = document.createElement("script");
    moduleScript.type = "module";
    if (script.nonce) {
      moduleScript.nonce = script.nonce;
    }
    moduleScript.textContent = await transformScript(script, index);
    script.after(moduleScript);
  }
}

export default run;

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => run(), { once: true });
  } else {
    run();
  }
}
`;
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (let byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}
