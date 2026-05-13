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

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Browser-ready npm package imports from UNPKG.">
  <title>esm.unpkg.com</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #ffffff;
      --ink: #0f172a;
      --muted: #475569;
      --line: #dbe3ec;
      --soft: #f8fafc;
      --code: #f1f5f9;
      --accent: #2563eb;
      --accent-dark: #1d4ed8;
      --beta-bg: #fef3c7;
      --beta-ink: #92400e;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.6;
    }

    a {
      color: var(--accent);
      text-decoration: none;
    }

    a:hover {
      text-decoration: underline;
    }

    .page {
      width: min(100%, 1180px);
      margin: 0 auto;
      padding: 28px 24px 72px;
    }

    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
      padding: 10px 0 48px;
    }

    .brand {
      display: inline-flex;
      align-items: baseline;
      gap: 10px;
      color: var(--ink);
      font-size: 20px;
      font-weight: 700;
      letter-spacing: 0;
    }

    .brand span {
      color: var(--muted);
      font-weight: 500;
    }

    nav {
      display: flex;
      align-items: center;
      gap: 20px;
      color: var(--muted);
      font-size: 14px;
    }

    .hero {
      display: grid;
      grid-template-columns: minmax(0, 1.02fr) minmax(320px, 0.98fr);
      align-items: center;
      gap: 48px;
      padding-bottom: 64px;
      border-bottom: 1px solid var(--line);
    }

    .eyebrow {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      background: var(--beta-bg);
      color: var(--beta-ink);
      font-size: 13px;
      font-weight: 700;
      padding: 6px 12px;
      text-transform: uppercase;
    }

    h1 {
      max-width: 780px;
      margin: 20px 0 18px;
      font-size: clamp(46px, 8vw, 84px);
      line-height: 0.94;
      letter-spacing: 0;
    }

    .lead {
      max-width: 680px;
      color: var(--muted);
      font-size: 21px;
      line-height: 1.5;
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 14px;
      margin-top: 34px;
    }

    .button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 44px;
      border-radius: 8px;
      padding: 10px 16px;
      border: 1px solid var(--line);
      color: var(--ink);
      font-weight: 650;
    }

    .button.primary {
      border-color: var(--accent);
      background: var(--accent);
      color: #ffffff;
    }

    .button.primary:hover {
      background: var(--accent-dark);
      text-decoration: none;
    }

    .panel {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--soft);
      overflow: hidden;
    }

    .panel-header {
      border-bottom: 1px solid var(--line);
      color: var(--muted);
      font-size: 13px;
      padding: 12px 16px;
    }

    pre {
      margin: 0;
      overflow-x: auto;
      padding: 18px;
      background: #0f172a;
      color: #e2e8f0;
      font-size: 14px;
      line-height: 1.7;
      tab-size: 2;
    }

    code {
      border-radius: 5px;
      background: var(--code);
      color: var(--ink);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 0.92em;
      padding: 0.13em 0.34em;
    }

    pre code {
      background: transparent;
      color: inherit;
      padding: 0;
    }

    main {
      display: grid;
      gap: 54px;
      padding-top: 54px;
    }

    section {
      display: grid;
      grid-template-columns: 280px minmax(0, 1fr);
      gap: 40px;
      align-items: start;
    }

    h2 {
      margin: 0;
      font-size: 22px;
      line-height: 1.25;
      letter-spacing: 0;
    }

    .content > *:first-child {
      margin-top: 0;
    }

    .content > *:last-child {
      margin-bottom: 0;
    }

    p {
      color: var(--muted);
      margin: 16px 0;
    }

    ul {
      color: var(--muted);
      margin: 16px 0 0;
      padding-left: 22px;
    }

    li + li {
      margin-top: 8px;
    }

    footer {
      border-top: 1px solid var(--line);
      color: var(--muted);
      margin-top: 60px;
      padding-top: 28px;
      font-size: 14px;
    }

    @media (max-width: 820px) {
      .page {
        padding: 22px 18px 52px;
      }

      header,
      .hero,
      section {
        display: block;
      }

      nav {
        margin-top: 14px;
      }

      .hero {
        padding-bottom: 42px;
      }

      .panel {
        margin-top: 30px;
      }

      section {
        padding-top: 8px;
      }

      section + section {
        border-top: 1px solid var(--line);
        padding-top: 34px;
      }

      h1 {
        font-size: 52px;
      }

      .lead {
        font-size: 18px;
      }

      .content {
        margin-top: 16px;
      }
    }
  </style>
</head>
<body>
  <div class="page">
    <header>
      <a class="brand" href="${esmOrigin}/">UNPKG <span>ESM</span></a>
      <nav>
        <a href="${wwwOrigin}/">UNPKG home</a>
        <a href="${wwwOrigin}/#browser-modules">Docs</a>
        <a href="${esmOrigin}/react@18.3.1?target=es2022">Example module</a>
      </nav>
    </header>

    <div class="hero">
      <div>
        <div class="eyebrow">Beta service</div>
        <h1>Browser-ready modules from npm.</h1>
        <p class="lead">
          esm.unpkg.com resolves npm packages, bundles package internals when needed, rewrites dependency imports to
          stable UNPKG URLs, and returns JavaScript that modern browsers can import directly.
        </p>
        <div class="actions">
          <a class="button primary" href="${wwwOrigin}/#browser-modules">Read the official docs</a>
          <a class="button" href="${esmOrigin}/react@18.3.1?meta">View module metadata</a>
        </div>
      </div>

      <div class="panel">
        <div class="panel-header">Import React without a build step</div>
        <pre><code>&lt;script type="module"&gt;
  import React from "${esmOrigin}/react@18.3.1";
  import { createRoot } from "${esmOrigin}/react-dom@18.3.1/client";

  createRoot(document.getElementById("root")).render(
    React.createElement("h1", null, "Hello from esm.unpkg.com")
  );
&lt;/script&gt;</code></pre>
      </div>
    </div>

    <main>
      <section>
        <h2>URL format</h2>
        <div class="content">
          <p>
            Use the same package URL shape as UNPKG, but on the ESM subdomain:
          </p>
          <div class="panel">
            <pre><code>${esmOrigin}/:package@:version/:subpath</code></pre>
          </div>
          <p>
            Versions may be exact versions, npm dist-tags, or semver ranges. Requests normalize to version-pinned URLs
            whenever possible so generated imports are stable and cacheable.
          </p>
        </div>
      </section>

      <section>
        <h2>Common options</h2>
        <div class="content">
          <ul>
            <li><code>?target=es2022</code> selects the JavaScript output target.</li>
            <li><code>?dev</code> or <code>?env=development</code> builds development output.</li>
            <li><code>?bundle</code>, <code>?standalone</code>, and <code>?no-bundle</code> control bundling.</li>
            <li><code>?deps=react@18.3.1</code> overrides dependency versions.</li>
            <li><code>?alias=react:preact/compat</code> rewrites package imports.</li>
            <li><code>?external=react</code> leaves matching dependencies as bare imports.</li>
            <li><code>?meta</code> returns JSON metadata for the resolved module.</li>
            <li><code>?raw</code> serves the raw package file without transforming it.</li>
          </ul>
        </div>
      </section>

      <section>
        <h2>Beta status</h2>
        <div class="content">
          <p>
            This service is currently in beta. It is designed for esm.sh-style browser imports on top of UNPKG, and the
            supported behavior will continue to tighten as compatibility testing expands across the npm ecosystem.
          </p>
          <p>
            For the canonical UNPKG documentation, including package URLs, metadata, exports, import maps, and the full
            browser modules guide, visit the <a href="${wwwOrigin}/">main UNPKG home page</a>.
          </p>
        </div>
      </section>
    </main>

    <footer>
      ESM service for UNPKG. Packages are resolved from npm and served from UNPKG infrastructure.
    </footer>
  </div>
</body>
</html>`;
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
