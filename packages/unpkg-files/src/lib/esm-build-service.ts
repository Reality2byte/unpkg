import { createHash } from "node:crypto";

import { parse } from "es-module-lexer/js";
import {
  resolvePackageExport,
  resolvePackageVersion,
} from "unpkg-worker";
import type { PackageInfo } from "unpkg-worker";

import { getFile } from "./npm-files.ts";

const defaultEsmOrigin = "https://esm.unpkg.com";

export interface BuildRequest {
  packageName: string;
  version: string;
  filename?: string;
  options: NormalizedBuildOptions;
}

export interface NormalizedBuildOptions {
  aliases: Record<string, string>;
  dependencyOverrides: Record<string, string>;
  env: "development" | "production";
  external: string[];
  minify: boolean;
  origin: string;
  sourcemap: boolean;
  target: string;
}

export interface BuildMetadata {
  buildKey: string;
  input: string;
  output: string;
  packageName: string;
  target: string;
  version: string;
}

export interface BuildResult {
  code: string;
  headers: Record<string, string>;
  metadata: BuildMetadata;
}

interface PackageJson {
  dependencies?: Record<string, string>;
  exports?: string | Record<string, unknown>;
  main?: string;
  module?: string;
  name?: string;
  peerDependencies?: Record<string, string>;
  version?: string;
}

export async function buildEsmModule(registry: string, request: BuildRequest): Promise<BuildResult | null> {
  let packageJsonFile = await getFile(registry, request.packageName, request.version, "/package.json");
  if (packageJsonFile == null) {
    return null;
  }

  let packageJson = JSON.parse(new TextDecoder().decode(packageJsonFile.body)) as PackageJson;
  let filename = resolveBuildFilename(packageJson, request.filename);
  if (filename == null) {
    return null;
  }

  let file = await getFile(registry, request.packageName, request.version, filename);
  if (file == null || !isJavaScriptContentType(file.type)) {
    return null;
  }

  let code = new TextDecoder().decode(file.body);
  let deps = Object.assign({}, packageJson.peerDependencies, packageJson.dependencies);
  let rewritten = await rewriteEsmImports(code, registry, request.options.origin, deps, request.options);
  let buildKey = createBuildKey(request, filename);
  let metadata: BuildMetadata = {
    buildKey,
    input: filename,
    output: `/${request.packageName}@${request.version}${request.filename ?? ""}`,
    packageName: request.packageName,
    target: request.options.target,
    version: request.version,
  };

  return {
    code: rewritten,
    headers: {
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Type": "application/javascript; charset=utf-8",
      "X-UNPKG-Build-Key": buildKey,
      "X-UNPKG-Build-Input": filename,
    },
    metadata,
  };
}

export function normalizeBuildOptions(searchParams: URLSearchParams): NormalizedBuildOptions {
  return {
    aliases: parseAliases(searchParams.get("alias")),
    dependencyOverrides: parseDependencyOverrides(searchParams.get("deps")),
    env: searchParams.has("dev") || searchParams.get("env") === "development" ? "development" : "production",
    external: searchParams.get("external")?.split(",").filter(Boolean) ?? [],
    minify: searchParams.has("min"),
    origin: searchParams.get("origin") ?? defaultEsmOrigin,
    sourcemap: searchParams.has("sourcemap"),
    target: searchParams.get("target") ?? "es2022",
  };
}

export async function rewriteEsmImports(
  code: string,
  registry: string,
  origin: string,
  dependencies: Record<string, string>,
  options: NormalizedBuildOptions
): Promise<string> {
  let [imports] = parse(code);
  let rewrites: { start: number; end: number; value: string }[] = [];

  for (let imp of imports) {
    if (imp.n === undefined) {
      continue;
    }

    let specifier = code.slice(imp.s, imp.e);
    let rewriteValue: string;

    if (imp.t === 2) {
      let match = /^(["'])([^"']*)\1$/.exec(specifier);
      if (match === null) continue;

      rewriteValue = match[1] + await rewriteEsmSpecifier(match[2], registry, origin, dependencies, options) + match[1];
    } else {
      rewriteValue = await rewriteEsmSpecifier(specifier, registry, origin, dependencies, options);
    }

    if (rewriteValue !== specifier) {
      rewrites.push({ start: imp.s, end: imp.e, value: rewriteValue });
    }
  }

  rewrites.sort((a, b) => b.start - a.start);

  let result = code;
  for (let { start, end, value } of rewrites) {
    result = result.slice(0, start) + value + result.slice(end);
  }

  return result;
}

export function parseDependencyOverrides(value: string | null): Record<string, string> {
  let overrides: Record<string, string> = {};
  if (value == null || value === "") {
    return overrides;
  }

  for (let item of value.split(",")) {
    let parsed = parsePackageVersionPair(item);
    if (parsed != null) {
      overrides[parsed.packageName] = parsed.version;
    }
  }

  return overrides;
}

export function parseAliases(value: string | null): Record<string, string> {
  let aliases: Record<string, string> = {};
  if (value == null || value === "") {
    return aliases;
  }

  for (let item of value.split(",")) {
    let colonIndex = item.indexOf(":");
    if (colonIndex === -1) continue;

    let from = item.slice(0, colonIndex);
    let to = item.slice(colonIndex + 1);
    if (from !== "" && to !== "") {
      aliases[from] = to;
    }
  }

  return aliases;
}

export function createBuildKey(request: BuildRequest, resolvedFilename: string): string {
  let key = JSON.stringify({
    packageName: request.packageName,
    version: request.version,
    filename: request.filename ?? null,
    resolvedFilename,
    options: request.options,
    service: "esm-build-service-v1",
  });

  return createHash("sha256").update(key).digest("hex");
}

function resolveBuildFilename(packageJson: PackageJson, filename: string | undefined): string | null {
  if (filename != null && filename !== "/") {
    return filename;
  }

  return resolvePackageExport(packageJson as Parameters<typeof resolvePackageExport>[0], "/", {
    conditions: ["browser", "production", "import", "module", "default"],
    useBrowserField: true,
    useModuleField: true,
  });
}

function isJavaScriptContentType(contentType: string): boolean {
  return contentType === "text/javascript" || contentType === "application/javascript";
}

async function rewriteEsmSpecifier(
  specifier: string,
  registry: string,
  origin: string,
  dependencies: Record<string, string>,
  options: NormalizedBuildOptions
): Promise<string> {
  if (specifier === "" || isValidUrl(specifier)) {
    return specifier;
  }

  if (isBareSpecifier(specifier)) {
    let parsed = parseBareSpecifier(specifier);
    if (parsed == null) return specifier;

    let aliased = applyAlias(parsed.packageName, parsed.path, options.aliases);
    if (shouldExternalize(aliased.packageName, options.external)) {
      return `${aliased.packageName}${aliased.path}`;
    }

    let requestedVersion =
      options.dependencyOverrides[aliased.packageName] ??
      dependencies[aliased.packageName] ??
      "latest";
    let version = await resolveDependencyVersion(registry, aliased.packageName, requestedVersion);
    let search = options.external.length > 0 ? `?external=${encodeURIComponent(options.external.join(","))}` : "";

    return `${origin}/${aliased.packageName}@${version}${stripTrailingSlash(aliased.path)}${search}`;
  }

  return `${stripTrailingSlash(specifier)}?target=${options.target}`;
}

function shouldExternalize(packageName: string, external: string[]): boolean {
  return external.includes("*") || external.includes(packageName);
}

function applyAlias(
  packageName: string,
  path: string,
  aliases: Record<string, string>
): { packageName: string; path: string } {
  let alias = aliases[packageName];
  if (alias == null) {
    return { packageName, path };
  }

  let parsed = parseBareSpecifier(alias);
  if (parsed == null) {
    return { packageName, path };
  }

  return {
    packageName: parsed.packageName,
    path: parsed.path || path,
  };
}

async function resolveDependencyVersion(registry: string, packageName: string, versionRangeOrTag: string): Promise<string> {
  let response = await fetch(new URL(`/${packageName.toLowerCase()}`, registry), {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    return versionRangeOrTag;
  }

  let packageInfo = await response.json() as PackageInfo;
  return resolvePackageVersion(packageInfo, versionRangeOrTag) ?? versionRangeOrTag;
}

function parsePackageVersionPair(value: string): { packageName: string; version: string } | null {
  let atIndex = value.startsWith("@") ? value.indexOf("@", 1) : value.indexOf("@");
  if (atIndex === -1) {
    return null;
  }

  let packageName = value.slice(0, atIndex);
  let version = value.slice(atIndex + 1);
  if (packageName === "" || version === "") {
    return null;
  }

  return { packageName, version };
}

function parseBareSpecifier(specifier: string): { packageName: string; path: string } | null {
  let match = /^((?:@[^/]+\/)?[^/]+)(\/.*)?$/.exec(specifier);
  if (match == null) {
    return null;
  }

  return {
    packageName: match[1],
    path: match[2] ?? "",
  };
}

function stripTrailingSlash(path: string): string {
  return path.replace(/\/+$/, "");
}

function isValidUrl(url: string): boolean {
  return URL.parse(url) !== null || url.startsWith("//");
}

function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith(".") && !specifier.startsWith("/");
}
