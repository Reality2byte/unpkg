import { createHash } from "node:crypto";

import {
  resolvePackageExport,
  rewriteImports,
} from "unpkg-worker";

import { getFile } from "./npm-files.ts";

const defaultEsmOrigin = "https://esm.unpkg.com";

export interface BuildRequest {
  packageName: string;
  version: string;
  filename?: string;
  options: NormalizedBuildOptions;
}

export interface NormalizedBuildOptions {
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
  let rewritten = rewriteImports(code, request.options.origin, deps);
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
    env: searchParams.has("dev") || searchParams.get("env") === "development" ? "development" : "production",
    external: searchParams.get("external")?.split(",").filter(Boolean) ?? [],
    minify: searchParams.has("min"),
    origin: searchParams.get("origin") ?? defaultEsmOrigin,
    sourcemap: searchParams.has("sourcemap"),
    target: searchParams.get("target") ?? "es2022",
  };
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
