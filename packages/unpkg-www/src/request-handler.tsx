import type { VNode } from "preact";
import { render } from "preact-render-to-string";
import {
  getEsmPackageSubpath,
  fetchFile,
  getPackageInfo,
  listFiles,
  normalizeEsmRequestUrl,
  parsePackagePathname,
  resolvePackageExport,
  resolvePackageVersion,
  rewriteImports,
} from "unpkg-worker";
import type { EsmRequestError, PackageJson } from "unpkg-worker";

import { AssetsContext } from "./assets-context.ts";
import { loadAssetsManifest } from "./assets-manifest.ts";
import type { Env } from "./env.ts";
import { Document } from "./components/document.tsx";
import { Home } from "./components/home.tsx";

const publicNpmRegistry = "https://registry.npmjs.org";

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
  if (url.hostname === "esm.unpkg.com" && url.pathname === "/transform" && request.method === "POST") {
    return handleEsmInlineTransformRequest(request, env);
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(`Invalid request method: ${request.method}`, {
      status: 405,
    });
  }

  if (url.pathname === "/_health") {
    return new Response("OK");
  }

  if (url.hostname === "esm.unpkg.com") {
    return handleEsmRequest(request, env, context);
  }

  if (url.pathname === "/favicon.ico") {
    return notFound();
  }
  if (url.pathname === "/index.html") {
    return redirect("/", 301);
  }
  if (url.pathname === "/") {
    return renderPage(env, <Home />, {
      headers: {
        "Cache-Control": env.DEV ? "no-store" : "public, max-age=60, s-maxage=300",
      },
    });
  }

  // Redirect legacy /browse/* URLs to the app's /files view
  if (url.pathname.startsWith("/browse/")) {
    let parsed = parsePackagePathname(url.pathname.slice(7));
    if (parsed) {
      return redirect(new URL(filesPathname(parsed.package, parsed.version, parsed.filename), env.APP_ORIGIN), 301);
    }
  }

  // Parse and validate the package path
  let parsed = parsePackagePathname(url.pathname);
  if (parsed == null) {
    return notFound(`Invalid URL pathname: ${url.pathname}`);
  }

  let packageName = parsed.package.toLowerCase();
  let packageInfo = await getPackageInfo(context, publicNpmRegistry, packageName);
  if (packageInfo == null) {
    return notFound(`Package not found: ${parsed.package}`);
  }

  let version = resolvePackageVersion(packageInfo, parsed.version ?? "latest");
  if (version == null || packageInfo.versions == null || packageInfo.versions[version] == null) {
    return notFound(`Package version not found: ${packageName}@${parsed.version}`);
  }

  let packageJson = packageInfo.versions[version];
  let filename = parsed.filename;

  // Handle ?meta requests
  if (url.searchParams.has("meta")) {
    let prefix = filename == null ? "/" : filename.replace(/\/*$/, "/");

    // If the version number is not already resolved, redirect to a permanent URL
    if (version !== parsed.version) {
      return redirect(`/${packageName}@${version}${prefix}${url.search}`, {
        headers: {
          "Cache-Control": "public, max-age=60, s-maxage=300",
        },
      });
    }

    let files = await listFiles(context, env.FILES_ORIGIN, packageName, version, prefix);
    let fileListing = {
      package: packageName,
      version,
      prefix,
      files,
    };

    return Response.json(fileListing, {
      headers: {
        "Cache-Control": "public, max-age=31536000",
        "Cache-Tag": "meta", // This allows us to purge the cache if ?meta behavior ever changes
        "Content-Type": "application/json",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Origin": "*",
        "Cross-Origin-Resource-Policy": "cross-origin",
      },
    });
  }

  // Support "append a /" behavior for viewing file listings in the app
  if (filename != null && filename.endsWith("/")) {
    // If the version number is already resolved, we can issue a permanent redirect (301)
    if (version === parsed.version) {
      return redirect(new URL(filesPathname(packageName, version, filename), env.APP_ORIGIN), 301);
    }

    // Otherwise it should be temporary (302)
    return redirect(new URL(filesPathname(packageName, version, filename), env.APP_ORIGIN), {
      headers: {
        "Cache-Control": "public, max-age=60, s-maxage=300",
      },
    });
  }

  // Try to resolve the filename using package.json exports, main, etc.
  let conditions = url.searchParams.has("conditions")
    ? url.searchParams.getAll("conditions").flatMap((condition) => condition.split(","))
    : undefined;
  let wantsBrowser = url.searchParams.has("browser");
  let wantsModule = url.searchParams.has("module");

  let resolvedFilename = resolvePackageExport(packageJson, filename ?? "/", {
    useBrowserField: wantsBrowser,
    useModuleField: wantsModule,
    conditions,
  });

  // If the resolved filename is different from the original filename, redirect to the new URL
  if (resolvedFilename != null && resolvedFilename !== filename) {
    let location = `/${packageName}@${version}${resolvedFilename}${url.search}`;

    // If the version number is already resolved, we can issue a permanent redirect (301)
    if (version === parsed.version) {
      return redirect(location, {
        status: 301,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Cross-Origin-Resource-Policy": "cross-origin",
        },
      });
    }

    // Otherwise it should be temporary (302)
    return redirect(location, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=60, s-maxage=300",
        "Cross-Origin-Resource-Policy": "cross-origin",
      },
    });
  }

  // Maximize cache hits by redirecting to the permanent URL if the version
  // number is different from the one that was used in the request
  if (version !== parsed.version) {
    return redirect(`/${packageName}@${version}${filename ?? ""}${url.search}`, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=60, s-maxage=300",
        "Cross-Origin-Resource-Policy": "cross-origin",
      },
    });
  }

  let files = await listFiles(context, env.FILES_ORIGIN, packageName, version);

  if (filename != null && files.some((file) => file.path.toLowerCase() === filename.toLowerCase())) {
    let response = await fetchFile(context, env.FILES_ORIGIN, packageName, version, filename);

    if (response != null) {
      // In ?module requests, rewrite imports to unpkg.com/* URLs in JavaScript modules
      if (
        response.headers.has("Content-Type") &&
        response.headers.get("Content-Type")!.startsWith("text/javascript") &&
        url.searchParams.has("module")
      ) {
        let code = new TextDecoder().decode(await response.arrayBuffer());
        let deps = Object.assign({}, packageJson.peerDependencies, packageJson.dependencies);
        let newCode = rewriteImports(code, url.origin, deps);

        return new Response(newCode, {
          headers: {
            "Cache-Control": "public, max-age=31536000",
            "Cache-Tag": "js-module", // This allows us to purge the cache if ?module behavior ever changes
            "Content-Type": "text/javascript; charset=utf-8",
            "Access-Control-Allow-Headers": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Expose-Headers": "*",
            "Cross-Origin-Resource-Policy": "cross-origin",
          },
        });
      }

      // In all other requests adjust some headers and pass the response straight through
      let headers = new Headers(response.headers);

      // Cache the response for 1 year if it isn't already set
      if (!headers.has("Cache-Control")) {
        headers.set("Cache-Control", "public, max-age=31536000");
      }

      // Serve JavaScript files with charset="utf-8"
      if (headers.get("Content-Type") === "text/javascript") {
        headers.set("Content-Type", "text/javascript; charset=utf-8");
      }

      // Add CORS headers
      headers.set("Access-Control-Allow-Headers", "*");
      headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Access-Control-Expose-Headers", "*");
      headers.set("Cross-Origin-Resource-Policy", "cross-origin");

      let body = await response.arrayBuffer();

      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
  }

  // We were unable to find a file based on either the original filename in the URL,
  // or the resolved filename from package.json (exports, main, etc.). Try to find a
  // matching file based on some legacy Node.js heuristics.
  // Redirect
  // - /path/to/file => /path/to/file.js
  // - /path/to/file => /path/to/file/index.js
  // if either of those files exist. This is to support legacy Node.js behavior where a
  // request for files without an extension will resolve to a .js file or a directory with
  // an index.js file.
  // See https://nodejs.org/api/modules.html#file-modules and
  // https://nodejs.org/api/modules.html#folders-as-modules
  let basename = filename == null || filename === "/" ? "" : filename.replace(/\/+$/, "");
  let match =
    files.find((file) => file.path === `${basename}.js`) || files.find((file) => file.path === `${basename}/index.js`);
  if (match != null) {
    return redirect(`/${packageName}@${version}${match.path}${url.search}`, {
      status: 301, // Version number in the URL is already resolved, so this is a permanent redirect
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cross-Origin-Resource-Policy": "cross-origin",
      },
    });
  }

  return notFound(`Not found: ${url.pathname}${url.search}`);
}

async function handleEsmRequest(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
  let originalUrl = new URL(request.url);
  if (originalUrl.pathname === "/run" || originalUrl.pathname === "/tsx") {
    return new Response(createEsmInlineRunner(), {
      headers: esmCorsHeaders({
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Type": "application/javascript; charset=utf-8",
      }),
    });
  }

  let normalized = normalizeEsmRequestUrl(request.url);
  if ("code" in normalized) {
    return esmError(normalized);
  }

  let packagePath = normalized.packagePath;
  let packageName = packagePath.package.toLowerCase();
  let packageInfo = await getPackageInfo(context, publicNpmRegistry, packageName);
  if (packageInfo == null) {
    return esmError({
      code: "PACKAGE_NOT_FOUND",
      message: `Package not found: ${packagePath.package}`,
      status: 404,
    });
  }

  let version = resolvePackageVersion(packageInfo, packagePath.version ?? "latest");
  if (version == null || packageInfo.versions == null || packageInfo.versions[version] == null) {
    return esmError({
      code: "PACKAGE_VERSION_NOT_FOUND",
      message: `Package version not found: ${packageName}@${packagePath.version ?? "latest"}`,
      status: 404,
    });
  }

  let searchParams = new URLSearchParams(normalized.searchParams);
  if (packagePath.externalAll && !searchParams.has("external")) {
    searchParams.set("external", "*");
  }

  let search = normalizeEsmSearch(searchParams);
  let pathname = `/${packageName}@${version}${packagePath.filename ?? ""}`;
  let shouldRedirect =
    packagePath.externalAll ||
    packageName !== packagePath.package ||
    packagePath.version !== version ||
    originalUrl.pathname !== normalized.url.pathname ||
    originalUrl.search !== normalized.url.search ||
    normalized.url.pathname !== pathname ||
    normalized.url.search !== search;

  if (shouldRedirect) {
    return redirect(`${pathname}${search}`, {
      status: packagePath.version === version ? 301 : 302,
      headers: esmCorsHeaders({
        "Cache-Control": "public, max-age=60, s-maxage=300",
      }),
    });
  }

  let packageJson = packageInfo.versions[version];

  if (searchParams.has("meta")) {
    return Response.json(await createEsmMetadata(env, normalized.url.origin, packageName, version, packagePath.filename, packageJson, searchParams), {
      headers: esmCorsHeaders({
        "Cache-Control": "public, max-age=60, s-maxage=300",
        "Content-Type": "application/json",
      }),
    });
  }

  if (searchParams.has("worker")) {
    let workerSearchParams = new URLSearchParams(searchParams);
    workerSearchParams.delete("worker");
    let workerUrl = new URL(`/${packageName}@${version}${packagePath.filename ?? ""}${normalizeEsmSearch(workerSearchParams)}`, normalized.url.origin);
    let code = `export default function createWorker(options) {\n  return new Worker(${JSON.stringify(workerUrl.toString())}, { type: "module", ...options });\n}\n`;

    return new Response(code, {
      headers: esmCorsHeaders({
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Type": "application/javascript; charset=utf-8",
      }),
    });
  }

  if (searchParams.has("raw")) {
    let rawResponse = await fetch(new URL(`/file/${packageName}@${version}${packagePath.filename ?? "/package.json"}`, env.FILES_ORIGIN));
    if (!rawResponse.ok) {
      return esmError({
        code: "RAW_FILE_NOT_FOUND",
        message: await rawResponse.text(),
        status: rawResponse.status,
      });
    }

    let headers = new Headers(rawResponse.headers);
    for (let [name, value] of Object.entries(esmCorsHeaders())) {
      headers.set(name, value);
    }

    return new Response(await rawResponse.arrayBuffer(), {
      status: rawResponse.status,
      statusText: rawResponse.statusText,
      headers,
    });
  }

  let buildSearchParams = new URLSearchParams(searchParams);
  buildSearchParams.set("origin", normalized.url.origin);
  let buildResponse = await fetch(new URL(`/build/${packageName}@${version}${packagePath.filename ?? ""}${normalizeEsmSearch(buildSearchParams)}`, env.FILES_ORIGIN));
  if (!buildResponse.ok) {
    return esmError({
      code: "BUILD_FAILED",
      message: await buildResponse.text(),
      status: buildResponse.status === 404 ? 422 : buildResponse.status,
    });
  }

  let headers = new Headers(buildResponse.headers);
  for (let [name, value] of Object.entries(esmCorsHeaders())) {
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

interface EsmMetadata {
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

async function createEsmMetadata(
  env: Env,
  origin: string,
  packageName: string,
  version: string,
  filename: string | undefined,
  packageJson: PackageJson,
  searchParams: URLSearchParams
): Promise<EsmMetadata> {
  let subpath = getEsmPackageSubpath(filename);
  let target = searchParams.get("target") ?? "es2022";
  let artifactSearchParams = new URLSearchParams(searchParams);
  artifactSearchParams.delete("meta");
  let artifactSearch = normalizeEsmSearch(artifactSearchParams);
  let modulePath = `/${packageName}@${version}${filename ?? ""}${artifactSearch}`;
  let module = new URL(modulePath, origin).toString();
  let types = getPackageTypesUrl(origin, packageName, version, filename, packageJson);
  let integrity = await getBuildIntegrity(env, packageName, version, filename, artifactSearchParams);

  return {
    name: packageName,
    version,
    specifier: `${packageName}@${version}`,
    subpath,
    target,
    module,
    types,
    integrity,
    dependencies: packageJson.dependencies ?? {},
    peerDependencies: packageJson.peerDependencies ?? {},
    exports: listEsmExportSubpaths(packageJson),
    build: {
      bundle: searchParams.has("standalone") ? "standalone" : searchParams.has("bundle") ? "bundle" : "smart",
      minify: searchParams.has("min"),
      sourcemap: searchParams.has("sourcemap"),
    },
  };
}

async function getBuildIntegrity(
  env: Env,
  packageName: string,
  version: string,
  filename: string | undefined,
  searchParams: URLSearchParams
): Promise<string | null> {
  if (searchParams.has("raw")) {
    return null;
  }

  let buildSearchParams = new URLSearchParams(searchParams);
  buildSearchParams.set("origin", "https://esm.unpkg.com");
  let response = await fetch(new URL(`/build/${packageName}@${version}${filename ?? ""}${normalizeEsmSearch(buildSearchParams)}`, env.FILES_ORIGIN));
  if (!response.ok) {
    return null;
  }

  let bytes = await response.arrayBuffer();
  let digest = await crypto.subtle.digest("SHA-384", bytes);
  return `sha384-${base64Encode(new Uint8Array(digest))}`;
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

function resolveTypesPath(packageJson: PackageJson, subpath: string): string | null {
  let exports = packageJson.exports;
  if (typeof exports === "object" && exports != null) {
    let exportValue = exports[subpath];
    let resolved = findTypesExport(exportValue);
    if (resolved != null) {
      return resolved;
    }
  }

  return packageJson.types ?? packageJson.typings ?? null;
}

function findTypesExport(value: unknown): string | null {
  if (typeof value === "string") {
    return null;
  }
  if (typeof value !== "object" || value == null) {
    return null;
  }

  if ("types" in value && typeof value.types === "string") {
    return value.types;
  }

  for (let nested of Object.values(value)) {
    let resolved = findTypesExport(nested);
    if (resolved != null) {
      return resolved;
    }
  }

  return null;
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (let byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function listEsmExportSubpaths(packageJson: PackageJson): string[] {
  if (typeof packageJson.exports !== "object" || packageJson.exports == null) {
    return [];
  }

  return Object.keys(packageJson.exports).filter((key) => key.startsWith("."));
}

function normalizeEsmSearch(searchParams: URLSearchParams): string {
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

function esmError(error: EsmRequestError | { code: string; message: string; status: number }): Response {
  return Response.json(
    {
      error: {
        code: error.code,
        message: error.message,
      },
    },
    {
      status: error.status,
      headers: esmCorsHeaders({
        "Cache-Control": "public, max-age=60, s-maxage=300",
        "Content-Type": "application/json",
      }),
    }
  );
}

function esmCorsHeaders(headers?: HeadersInit): HeadersInit {
  return {
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "*",
    "Cross-Origin-Resource-Policy": "cross-origin",
    ...headers,
  };
}

function notFound(message?: string, init?: ResponseInit): Response {
  return new Response(message ?? "Not Found", { status: 404, ...init });
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

async function handleEsmInlineTransformRequest(request: Request, env: Env): Promise<Response> {
  let sourceResponse = await fetch(new URL(`/transform${new URL(request.url).search}`, env.FILES_ORIGIN), {
    method: "POST",
    headers: {
      "Content-Type": request.headers.get("Content-Type") ?? "application/json",
    },
    body: await request.arrayBuffer(),
  });

  let headers = new Headers(sourceResponse.headers);
  for (let [name, value] of Object.entries(esmCorsHeaders())) {
    headers.set(name, value);
  }

  return new Response(await sourceResponse.arrayBuffer(), {
    status: sourceResponse.status,
    statusText: sourceResponse.statusText,
    headers,
  });
}

function createEsmInlineRunner(): string {
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

async function renderPage(env: Env, node: VNode, init?: ResponseInit): Promise<Response> {
  let assetsManifest = await loadAssetsManifest(env);

  let html = render(
    <AssetsContext.Provider value={assetsManifest}>
      <Document origin={env.ORIGIN}>{node}</Document>
    </AssetsContext.Provider>
  );

  return new Response("<!DOCTYPE html>" + html, {
    ...init,
    headers: {
      "Content-Type": "text/html",
      ...init?.headers,
    },
  });
}

function filesPathname(packageName: string, version?: string, filename?: string): string {
  // The /files prefix is not needed for the root of the file browser.
  let path = filename == null || filename === "/" ? "" : `/files${filename.replace(/\/+$/, "")}`;
  return `/${packageName}${version ? `@${version}` : ""}${path}`;
}
