#!/usr/bin/env bun

import { readFile } from "node:fs/promises";

type ExpectedBehavior = "module" | "json" | "redirect" | "diagnostic";
type FailureCategory =
  | "content-type-mismatch"
  | "diagnostic"
  | "fetch-error"
  | "ok-mismatch"
  | "redirect-mismatch"
  | "server-error"
  | "unexpected-success";

interface CompatCase {
  category?: string;
  description: string;
  expect: ExpectedBehavior;
  features?: string[];
  package?: string;
  path: string;
}

interface CompatCorpus {
  cases: CompatCase[];
  description?: string;
  name?: string;
}

interface RedirectHop {
  location: string | null;
  status: number;
  url: string;
}

interface FetchSummary {
  contentLength: number;
  contentType: string | null;
  diagnosticCode: string | null;
  durationMs: number;
  executableModule: boolean;
  finalUrl: string;
  headers: Record<string, string>;
  ok: boolean;
  redirectChain: RedirectHop[];
  status: number;
}

interface CompatResult {
  case: CompatCase;
  esmSh: FetchSummary;
  esmUnpkg: FetchSummary;
  failureCategory: FailureCategory | null;
  passed: boolean;
  reason: string | null;
}

interface CompatReport {
  comparedAt: string;
  corpus: {
    caseCount: number;
    description?: string;
    name: string;
  };
  origins: {
    esmSh: string;
    esmUnpkg: string;
  };
  results: CompatResult[];
  summary: CompatSummary;
}

interface CompatSummary {
  byCategory: Record<string, { failed: number; passed: number; total: number }>;
  byFailureCategory: Record<string, number>;
  failed: number;
  passed: number;
  total: number;
}

const defaultCases: CompatCase[] = [
  {
    category: "package-root",
    description: "React package root",
    expect: "module",
    features: ["package-root", "version"],
    package: "react",
    path: "/react@18.3.1",
  },
  {
    category: "subpath",
    description: "React DOM client subpath",
    expect: "module",
    features: ["subpath", "version"],
    package: "react-dom",
    path: "/react-dom@18.3.1/client",
  },
  {
    category: "external",
    description: "External all shorthand",
    expect: "module",
    features: ["external-all"],
    package: "swr",
    path: "/*swr@1.3.0",
  },
  {
    category: "dependency-control",
    description: "Dependency override",
    expect: "module",
    features: ["deps"],
    package: "react-dom",
    path: "/react-dom@18.3.1/client?deps=react@18.2.0",
  },
  {
    category: "dependency-control",
    description: "Alias React to Preact compat",
    expect: "module",
    features: ["alias", "deps"],
    package: "react-dom",
    path: "/react-dom@18.3.1/client?alias=react:preact/compat&deps=preact@10.25.4",
  },
  {
    category: "bundling",
    description: "No-bundle mode",
    expect: "module",
    features: ["no-bundle"],
    package: "preact",
    path: "/preact@10.26.4/hooks?no-bundle",
  },
  {
    category: "metadata",
    description: "Metadata",
    expect: "json",
    features: ["meta"],
    package: "preact",
    path: "/preact@10.26.4?meta",
  },
  {
    category: "worker",
    description: "Worker wrapper",
    expect: "module",
    features: ["worker"],
    package: "preact",
    path: "/preact@10.26.4?worker",
  },
  {
    category: "runtime-target",
    description: "Runtime-native target",
    expect: "module",
    features: ["target-node"],
    package: "react",
    path: "/react@18.3.1?target=node",
  },
  {
    category: "diagnostic",
    description: "Unsupported source diagnostic",
    expect: "diagnostic",
    features: ["unsupported-source"],
    package: "preact",
    path: "/preact@10.26.4/component.vue",
  },
];

let options = parseArgs(process.argv.slice(2));
let esmShOrigin = stripTrailingSlash(process.env.ESM_SH_ORIGIN ?? "https://esm.sh");
let esmUnpkgOrigin = stripTrailingSlash(process.env.ESM_UNPKG_ORIGIN ?? "https://esm.unpkg.com");
let corpus = await loadCorpus(options.corpusPath);
let results = options.dryRun
  ? corpus.cases.map(createDryRunResult)
  : await runCases(corpus.cases);
let report: CompatReport = {
  comparedAt: new Date().toISOString(),
  corpus: {
    caseCount: corpus.cases.length,
    description: corpus.description,
    name: corpus.name ?? (options.corpusPath == null ? "default" : options.corpusPath),
  },
  origins: {
    esmSh: esmShOrigin,
    esmUnpkg: esmUnpkgOrigin,
  },
  results,
  summary: summarizeResults(results),
};

printReport(report, options.jsonOutput);

if (!options.dryRun && report.summary.failed > 0) {
  process.exitCode = 1;
}

async function loadCorpus(corpusPath: string | null): Promise<CompatCorpus> {
  if (corpusPath == null) {
    return {
      cases: defaultCases,
      description: "Built-in representative esm.sh compatibility scenarios.",
      name: "default",
    };
  }

  let text = await readFile(corpusPath, "utf8");
  let value = JSON.parse(text) as unknown;
  if (!isCompatCorpus(value)) {
    throw new Error(`Invalid compatibility corpus: ${corpusPath}`);
  }

  return value;
}

async function runCases(cases: CompatCase[]): Promise<CompatResult[]> {
  return Promise.all(cases.map(runCase));
}

async function runCase(compatCase: CompatCase): Promise<CompatResult> {
  let [esmSh, esmUnpkg] = await Promise.all([
    summarizeFetch(new URL(compatCase.path, esmShOrigin)),
    summarizeFetch(new URL(compatCase.path, esmUnpkgOrigin)),
  ]);
  let comparison = compareSummaries(compatCase, esmSh, esmUnpkg);

  return {
    case: compatCase,
    esmSh,
    esmUnpkg,
    failureCategory: comparison.failureCategory,
    passed: comparison.reason == null,
    reason: comparison.reason,
  };
}

async function summarizeFetch(url: URL): Promise<FetchSummary> {
  let startedAt = performance.now();
  let currentUrl = url;
  let redirectChain: RedirectHop[] = [];
  let response: Response;

  try {
    for (let index = 0; index < 10; index += 1) {
      response = await fetch(currentUrl, {
        redirect: "manual",
        headers: {
          Accept: "application/javascript, application/json;q=0.9, */*;q=0.1",
        },
      });

      if (!isRedirect(response.status)) {
        return await summarizeResponse(response, currentUrl, redirectChain, startedAt);
      }

      let location = response.headers.get("Location");
      redirectChain.push({
        location,
        status: response.status,
        url: currentUrl.toString(),
      });
      if (location == null) {
        return await summarizeResponse(response, currentUrl, redirectChain, startedAt);
      }

      currentUrl = new URL(location, currentUrl);
    }
  } catch {
    return {
      contentLength: 0,
      contentType: null,
      diagnosticCode: "FETCH_ERROR",
      durationMs: Math.round(performance.now() - startedAt),
      executableModule: false,
      finalUrl: currentUrl.toString(),
      headers: {},
      ok: false,
      redirectChain,
      status: 0,
    };
  }

  return {
    contentLength: 0,
    contentType: null,
    diagnosticCode: "REDIRECT_LIMIT",
    durationMs: Math.round(performance.now() - startedAt),
    executableModule: false,
    finalUrl: currentUrl.toString(),
    headers: {},
    ok: false,
    redirectChain,
    status: 0,
  };
}

async function summarizeResponse(
  response: Response,
  finalUrl: URL,
  redirectChain: RedirectHop[],
  startedAt: number
): Promise<FetchSummary> {
  let bytes = new Uint8Array(await response.arrayBuffer());
  let contentType = response.headers.get("Content-Type");
  let text = looksTextual(contentType) ? new TextDecoder().decode(bytes) : "";

  return {
    contentLength: bytes.byteLength,
    contentType,
    diagnosticCode: readDiagnosticCode(text, contentType),
    durationMs: Math.round(performance.now() - startedAt),
    executableModule: isExecutableModule(text, contentType),
    finalUrl: finalUrl.toString(),
    headers: collectRelevantHeaders(response.headers),
    ok: response.ok,
    redirectChain,
    status: response.status,
  };
}

function compareSummaries(
  compatCase: CompatCase,
  esmSh: FetchSummary,
  esmUnpkg: FetchSummary
): { failureCategory: FailureCategory | null; reason: string | null } {
  if (esmSh.diagnosticCode === "FETCH_ERROR" || esmUnpkg.diagnosticCode === "FETCH_ERROR") {
    return {
      failureCategory: "fetch-error",
      reason: `fetch error: esm.sh=${esmSh.status}, esm.unpkg.com=${esmUnpkg.status}`,
    };
  }

  if (compatCase.expect === "diagnostic") {
    return esmUnpkg.status >= 400
      ? { failureCategory: null, reason: null }
      : {
          failureCategory: "unexpected-success",
          reason: `expected esm.unpkg.com diagnostic, got ${esmUnpkg.status}`,
        };
  }

  if (esmSh.status >= 500 || esmUnpkg.status >= 500) {
    return {
      failureCategory: "server-error",
      reason: `server error: esm.sh=${esmSh.status}, esm.unpkg.com=${esmUnpkg.status}`,
    };
  }

  if (esmSh.ok !== esmUnpkg.ok) {
    return {
      failureCategory: esmUnpkg.diagnosticCode == null ? "ok-mismatch" : "diagnostic",
      reason: `ok mismatch: esm.sh=${esmSh.status}, esm.unpkg.com=${esmUnpkg.status}`,
    };
  }

  if (compatCase.expect === "json" && !isJson(esmUnpkg.contentType)) {
    return {
      failureCategory: "content-type-mismatch",
      reason: `expected JSON from esm.unpkg.com, got ${esmUnpkg.contentType ?? "missing content type"}`,
    };
  }

  if (compatCase.expect === "module" && !isJavaScript(esmUnpkg.contentType)) {
    return {
      failureCategory: "content-type-mismatch",
      reason: `expected JavaScript from esm.unpkg.com, got ${esmUnpkg.contentType ?? "missing content type"}`,
    };
  }

  if (compatCase.expect === "module" && !esmUnpkg.executableModule) {
    return {
      failureCategory: "content-type-mismatch",
      reason: "expected esm.unpkg.com response to look like an executable module",
    };
  }

  if (compatCase.expect === "redirect" && esmUnpkg.redirectChain.length === 0) {
    return {
      failureCategory: "redirect-mismatch",
      reason: "expected esm.unpkg.com redirect chain",
    };
  }

  return { failureCategory: null, reason: null };
}

function summarizeResults(results: CompatResult[]): CompatSummary {
  let summary: CompatSummary = {
    byCategory: {},
    byFailureCategory: {},
    failed: 0,
    passed: 0,
    total: results.length,
  };

  for (let result of results) {
    if (result.passed) {
      summary.passed += 1;
    } else {
      summary.failed += 1;
    }

    let category = result.case.category ?? "uncategorized";
    let categorySummary = summary.byCategory[category] ?? { failed: 0, passed: 0, total: 0 };
    categorySummary.total += 1;
    if (result.passed) {
      categorySummary.passed += 1;
    } else {
      categorySummary.failed += 1;
    }
    summary.byCategory[category] = categorySummary;

    if (result.failureCategory != null) {
      summary.byFailureCategory[result.failureCategory] =
        (summary.byFailureCategory[result.failureCategory] ?? 0) + 1;
    }
  }

  return summary;
}

function createDryRunResult(compatCase: CompatCase): CompatResult {
  return {
    case: compatCase,
    esmSh: pendingSummary(new URL(compatCase.path, esmShOrigin).toString()),
    esmUnpkg: pendingSummary(new URL(compatCase.path, esmUnpkgOrigin).toString()),
    failureCategory: null,
    passed: true,
    reason: null,
  };
}

function pendingSummary(finalUrl: string): FetchSummary {
  return {
    contentLength: 0,
    contentType: null,
    diagnosticCode: null,
    durationMs: 0,
    executableModule: false,
    finalUrl,
    headers: {},
    ok: true,
    redirectChain: [],
    status: 0,
  };
}

function printReport(report: CompatReport, jsonOutput: boolean): void {
  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(
    `${report.corpus.name}: ${report.summary.passed}/${report.summary.total} passed against ${report.origins.esmUnpkg}`
  );

  for (let result of report.results) {
    let marker = result.passed ? "PASS" : "FAIL";
    let diagnostic = result.esmUnpkg.diagnosticCode == null ? "" : ` (${result.esmUnpkg.diagnosticCode})`;
    let category = result.case.category == null ? "" : `[${result.case.category}] `;
    console.log(`${marker} ${category}${result.case.description}: ${result.esmUnpkg.status}${diagnostic} ${result.case.path}`);
    if (result.reason != null) {
      console.log(`  ${result.reason}`);
    }
  }

  if (report.summary.failed > 0) {
    console.log("Failure categories:");
    for (let [category, count] of Object.entries(report.summary.byFailureCategory)) {
      console.log(`  ${category}: ${count}`);
    }
  }
}

function readDiagnosticCode(text: string, contentType: string | null): string | null {
  if (!isJson(contentType)) {
    return null;
  }

  try {
    let value = JSON.parse(text) as unknown;
    if (typeof value !== "object" || value == null) {
      return null;
    }

    let error = (value as { error?: unknown }).error;
    if (typeof error !== "object" || error == null) {
      return null;
    }

    let code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}

function isCompatCorpus(value: unknown): value is CompatCorpus {
  if (typeof value !== "object" || value == null) {
    return false;
  }

  let corpus = value as { cases?: unknown };
  return Array.isArray(corpus.cases) && corpus.cases.every(isCompatCase);
}

function isCompatCase(value: unknown): value is CompatCase {
  if (typeof value !== "object" || value == null) {
    return false;
  }

  let compatCase = value as Record<string, unknown>;
  return (
    typeof compatCase.description === "string" &&
    typeof compatCase.path === "string" &&
    (compatCase.expect === "module" ||
      compatCase.expect === "json" ||
      compatCase.expect === "redirect" ||
      compatCase.expect === "diagnostic")
  );
}

function collectRelevantHeaders(headers: Headers): Record<string, string> {
  let result: Record<string, string> = {};
  for (let name of [
    "Access-Control-Allow-Origin",
    "Cache-Control",
    "Content-Digest",
    "Content-Length",
    "Content-Type",
    "Cross-Origin-Resource-Policy",
    "Location",
    "X-TypeScript-Types",
    "X-UNPKG-Build-Key",
    "X-UNPKG-Transformer",
  ]) {
    let value = headers.get(name);
    if (value != null) {
      result[name] = value;
    }
  }

  return result;
}

function isExecutableModule(text: string, contentType: string | null): boolean {
  if (!isJavaScript(contentType)) {
    return false;
  }

  return /\b(?:import|export)\b/.test(text);
}

function looksTextual(contentType: string | null): boolean {
  return contentType == null || /(?:json|javascript|ecmascript|text)/.test(contentType);
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isJson(contentType: string | null): boolean {
  return contentType?.includes("application/json") ?? false;
}

function isJavaScript(contentType: string | null): boolean {
  return contentType?.includes("javascript") || contentType?.includes("ecmascript") || false;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function parseArgs(args: string[]): { corpusPath: string | null; dryRun: boolean; jsonOutput: boolean } {
  let corpusPath: string | null = null;
  let dryRun = false;
  let jsonOutput = false;

  for (let index = 0; index < args.length; index += 1) {
    let arg = args[index];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--json") {
      jsonOutput = true;
    } else if (arg === "--corpus") {
      corpusPath = args[index + 1] ?? null;
      index += 1;
    } else if (arg.startsWith("--corpus=")) {
      corpusPath = arg.slice("--corpus=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { corpusPath, dryRun, jsonOutput };
}
