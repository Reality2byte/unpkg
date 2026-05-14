import highlight from "highlight.js/lib/common";

import {
  getEsmPackageSubpath,
  getPackageInfo,
  normalizeEsmRequestUrl,
  resolvePackageExport,
  resolvePackageVersion,
} from "unpkg-worker";
import type { EsmRequestError, PackageJson } from "unpkg-worker";

import type { Env } from "./env.ts";

const publicNpmRegistry = "https://registry.npmjs.org";
const moduleCacheControl = "public, max-age=60, s-maxage=300";
const homePageExample = `<script type="module">
  import React from "%%ESM_ORIGIN%%/react@18.3.1";
  import { createRoot } from "%%ESM_ORIGIN%%/react-dom@18.3.1/client";

  createRoot(document.getElementById("root")).render(
    React.createElement("h1", null, "Hello from esm.unpkg.com")
  );
</script>`;

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

  if (url.pathname === "/index.html") {
    return redirect("/", 301);
  }

  if (url.pathname === "/") {
    return new Response(createHomePage(env), {
      headers: {
        "Cache-Control": "public, max-age=60, s-maxage=300",
        "Content-Type": "text/html; charset=utf-8",
      },
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

  let cssPath = resolveCssPath(packageJson, packagePath.filename);
  if (cssPath != null) {
    if (packagePath.filename !== cssPath) {
      return redirect(`/${packageName}@${version}${cssPath}${search}`, {
        status: 301,
        headers: corsHeaders({
          "Cache-Control": moduleCacheControl,
        }),
      });
    }

    return searchParams.has("module")
      ? serveCssModule(env, packageName, version, cssPath)
      : serveRawFile(env, packageName, version, cssPath);
  }
  if (searchParams.has("css")) {
    return jsonError({
      code: "CSS_NOT_FOUND",
      message: `Package CSS not found: ${packageName}@${version}${packagePath.filename ?? ""}`,
      status: 404,
    });
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
  } else if (isCssPath(filename)) {
    headers.set("Content-Type", "text/css; charset=utf-8");
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

async function serveCssModule(env: Env, packageName: string, version: string, filename: string): Promise<Response> {
  let response = await serveRawFile(env, packageName, version, filename);
  if (!response.ok) {
    return response;
  }

  let css = await response.text();
  let code = [
    "/* esm.unpkg.com - css module */",
    "const stylesheet = new CSSStyleSheet();",
    `stylesheet.replaceSync(${JSON.stringify(css)});`,
    "export default stylesheet;",
    "",
  ].join("\n");

  return new Response(code, {
    headers: corsHeaders({
      "Cache-Control": moduleCacheControl,
      "Content-Type": "application/javascript; charset=utf-8",
    }),
  });
}

function resolveCssPath(packageJson: PackageJson, filename: string | undefined): string | null {
  if (filename != null && filename !== "/") {
    if (isCssPath(filename)) {
      return filename;
    }

    let resolved = resolvePackageExport(packageJson, filename, {
      conditions: ["style", "css", "browser", "import", "default"],
      useBrowserField: true,
      useModuleField: false,
    });
    return resolved != null && isCssPath(resolved) ? resolved : null;
  }

  for (let candidate of [
    getPackageJsonString(packageJson, "style"),
    getPackageJsonString(packageJson, "css"),
    getPackageJsonString(packageJson, "unpkg"),
    resolvePackageExport(packageJson, "/", {
      conditions: ["style", "css", "browser", "import", "default"],
      useBrowserField: true,
      useModuleField: false,
    }),
    packageJson.main,
  ]) {
    if (candidate != null && isCssPath(candidate)) {
      return normalizePackageFilename(candidate);
    }
  }

  return null;
}

function getPackageJsonString(packageJson: PackageJson, key: string): string | undefined {
  let value = (packageJson as PackageJson & Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function normalizePackageFilename(filename: string): string {
  return filename.replace(/^\.?\/*/, "/");
}

function isCssPath(filename: string): boolean {
  return filename.endsWith(".css");
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

function createHomePage(env: Env): string {
  let wwwOrigin = env.WWW_ORIGIN.replace(/\/+$/, "");
  let esmOrigin = env.ORIGIN.replace(/\/+$/, "");
  let exampleHtml = highlightCode(homePageExample.replaceAll("%%ESM_ORIGIN%%", esmOrigin));

  return `<!DOCTYPE html>
<html lang="en" style="background-color: white;">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Browser-ready npm package imports from UNPKG.">
  <link rel="icon" type="image/jpeg" href="/favicon.jpg">
  <title>UNPKG ESM</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: #0f172a;
      background: white;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.625;
    }
    header, main, footer {
      max-width: 768px;
      margin-left: auto;
      margin-right: auto;
    }
    header {
      padding: 8rem 2rem 0;
      text-align: center;
    }
    h1 {
      margin: 0;
      color: #000;
      font-size: 4.5rem;
      line-height: 1;
      font-weight: 900;
      letter-spacing: 0;
    }
    main {
      max-width: 100%;
      padding: 4rem 2rem 8rem;
    }
    .content {
      max-width: 768px;
      margin-left: auto;
      margin-right: auto;
    }
    section + section {
      margin-top: 4rem;
    }
    h2 {
      margin: 0 0 1rem;
      color: #0f172a;
      font-size: 1.25rem;
      line-height: 1.3;
      letter-spacing: 0;
    }
    p {
      margin: 1rem 0 0;
    }
    ul {
      margin: 1rem 0 0 1.5rem;
      padding: 0;
      list-style: disc outside;
    }
    li + li {
      margin-top: 0.35rem;
    }
    a {
      color: #2563eb;
      text-decoration: none;
    }
    a:hover {
      text-decoration: underline;
    }
    code {
      border-radius: 0;
      background: #f1f5f9;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 0.875rem;
      padding: 0.1rem 0.25rem;
    }
    .code-block {
      margin-top: 3rem;
      overflow-x: auto;
      background: #f1f5f9;
      padding: 1rem;
      text-align: left;
    }
    .code-block code {
      display: block;
      min-width: max-content;
      background: transparent;
      padding: 0;
      white-space: pre;
    }
    .hljs-listing {
      background: #fbfdff;
      color: #383a42;
    }
    .hljs-comment,
    .hljs-quote {
      color: #a0a1a7;
      font-style: italic;
    }
    .hljs-doctag,
    .hljs-keyword,
    .hljs-link,
    .hljs-formula {
      color: #a626a4;
    }
    .hljs-section,
    .hljs-name,
    .hljs-selector-tag,
    .hljs-deletion,
    .hljs-subst {
      color: #e45649;
    }
    .hljs-literal {
      color: #0184bb;
    }
    .hljs-string,
    .hljs-regexp,
    .hljs-addition,
    .hljs-attribute,
    .hljs-meta-string {
      color: #50a14f;
    }
    .hljs-built_in,
    .hljs-class .hljs-title {
      color: #c18401;
    }
    .hljs-attr,
    .hljs-variable,
    .hljs-template-variable,
    .hljs-type,
    .hljs-selector-class,
    .hljs-selector-attr,
    .hljs-selector-pseudo,
    .hljs-number {
      color: #986801;
    }
    .hljs-symbol,
    .hljs-bullet,
    .hljs-meta,
    .hljs-selector-id,
    .hljs-title {
      color: #4078f2;
    }
    .hljs-emphasis {
      font-style: italic;
    }
    .hljs-strong {
      font-weight: bold;
    }
    .callout {
      margin-top: 3rem;
      background: #f1f5f9;
      padding: 1rem;
      text-align: center;
    }
    footer {
      border-top: 1px solid #e2e8f0;
      color: #475569;
      padding: 2rem 2rem 6rem;
      font-size: 0.875rem;
    }
    @media (max-width: 640px) {
      header { padding-top: 5rem; }
      h1 { font-size: 3.5rem; }
      main { padding-top: 3rem; }
    }
  </style>
</head>
<body style="background-color: white;">
  <header>
    <h1>UNPKG ESM</h1>
  </header>

  <main>
    <div class="content">
      <section>
        <p>
          <strong>esm.unpkg.com is currently in beta.</strong> It serves browser-ready ES modules from npm packages using
          UNPKG infrastructure. Use it when a package is not already published as browser-ready ESM and you want to load
          it directly in modern browsers without a build step.
        </p>

        <p class="callout">
          <code>${esmOrigin}/:package@:version/:subpath</code>
        </p>
      </section>

      <section>
        <h2>Example</h2>
        <p>Import packages from <code>esm.unpkg.com</code> in a module script:</p>

        <div class="code-block hljs-listing"><code>${exampleHtml}</code></div>
      </section>

      <section>
        <h2>Usage</h2>
        <ul>
          <li>Omit the version to use the package's <code>latest</code> npm tag.</li>
          <li>Use npm dist-tags, semver ranges, or exact versions in the URL.</li>
          <li>Add <code>?target=es2022</code> to choose an output target.</li>
          <li>Add <code>?dev</code> for development builds.</li>
          <li>Add <code>?bundle</code>, <code>?standalone</code>, or <code>?no-bundle</code> to control bundling.</li>
          <li>Add <code>?meta</code> to inspect resolved module metadata.</li>
        </ul>
      </section>

      <section>
        <h2>Documentation</h2>
        <p>
          For official UNPKG documentation, including package URLs, exports, metadata, import maps, and browser module
          options, visit the <a href="${wwwOrigin}/">main UNPKG home page</a>. The browser modules section is available
          at <a href="${wwwOrigin}/#browser-modules">${wwwOrigin}/#browser-modules</a>.
        </p>
      </section>
    </div>
  </main>

  <footer>
    <a href="https://github.com/unpkg" title="UNPKG on GitHub">GitHub</a>
    ·
    <a href="https://x.com/unpkg" title="UNPKG on X">X</a>
  </footer>
</body>
</html>`;
}

function highlightCode(code: string): string {
  return highlight.highlight(code, { language: "xml" }).value;
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

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (let byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}
