#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

interface CompatCase {
  category?: string;
  description: string;
  expect: "module" | "json" | "diagnostic";
  features?: string[];
  package?: string;
  path: string;
}

interface CompatCorpus {
  cases: CompatCase[];
  description?: string;
  name?: string;
}

interface BrowserSmokeResult {
  case: CompatCase;
  durationMs: number;
  error: string | null;
  exportKeys: string[];
  requestCount: number;
  transferredBytes: number;
  url: string;
}

interface BrowserSmokeReport {
  browser: "chromium";
  corpus: string;
  createdAt: string;
  failed: number;
  origin: string;
  passed: number;
  results: BrowserSmokeResult[];
  total: number;
}

let options = parseArgs(process.argv.slice(2));
let origin = stripTrailingSlash(options.origin ?? process.env.ESM_BROWSER_ORIGIN ?? "https://esm.sh");
let corpus = await loadCorpus(options.corpusPath);
let smokeCases = corpus.cases.filter((compatCase) => {
  if (compatCase.expect !== "module") return false;
  if (compatCase.features?.includes("worker")) return false;
  if (compatCase.features?.includes("target-node")) return false;
  return options.packageName == null || compatCase.package === options.packageName;
}).slice(0, options.limit);

if (options.dryRun) {
  printReport({
    browser: "chromium",
    corpus: corpus.name ?? options.corpusPath,
    createdAt: new Date().toISOString(),
    failed: 0,
    origin,
    passed: smokeCases.length,
    results: smokeCases.map((compatCase) => ({
      case: compatCase,
      durationMs: 0,
      error: null,
      exportKeys: [],
      requestCount: 0,
      transferredBytes: 0,
      url: new URL(compatCase.path, origin).toString(),
    })),
    total: smokeCases.length,
  }, options.jsonOutput);
  process.exit(0);
}

let browser = await chromium.launch();
try {
  let page = await browser.newPage();
  let results: BrowserSmokeResult[] = [];
  for (let compatCase of smokeCases) {
    results.push(await runCase(page, compatCase, origin));
  }

  let failed = results.filter((result) => result.error != null).length;
  printReport({
    browser: "chromium",
    corpus: corpus.name ?? options.corpusPath,
    createdAt: new Date().toISOString(),
    failed,
    origin,
    passed: results.length - failed,
    results,
    total: results.length,
  }, options.jsonOutput);

  if (failed > 0) {
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}

async function runCase(page: import("playwright").Page, compatCase: CompatCase, origin: string): Promise<BrowserSmokeResult> {
  let url = new URL(compatCase.path, origin).toString();
  let startedAt = performance.now();
  let requestCount = 0;
  let transferredBytes = 0;

  let responseHandler = async (response: import("playwright").Response): Promise<void> => {
    if (!response.url().startsWith(origin)) return;
    requestCount += 1;
    let headerLength = Number(response.headers()["content-length"]);
    if (Number.isFinite(headerLength)) {
      transferredBytes += headerLength;
    } else {
      try {
        transferredBytes += (await response.body()).byteLength;
      } catch {
        // Some cross-origin responses are not readable through Playwright. Request count
        // still gives us a useful signal for bundle-vs-unbundle scenarios.
      }
    }
  };

  page.on("response", responseHandler);
  try {
    let exportKeys = await page.evaluate(async (moduleUrl) => {
      let module = await import(moduleUrl);
      return Object.keys(module).sort();
    }, url);

    return {
      case: compatCase,
      durationMs: Math.round(performance.now() - startedAt),
      error: null,
      exportKeys,
      requestCount,
      transferredBytes,
      url,
    };
  } catch (error) {
    return {
      case: compatCase,
      durationMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : String(error),
      exportKeys: [],
      requestCount,
      transferredBytes,
      url,
    };
  } finally {
    page.off("response", responseHandler);
  }
}

async function loadCorpus(corpusPath: string): Promise<CompatCorpus> {
  let text = await readFile(corpusPath, "utf8");
  let value = JSON.parse(text) as unknown;
  if (!isCompatCorpus(value)) {
    throw new Error(`Invalid compatibility corpus: ${corpusPath}`);
  }

  return value;
}

function printReport(report: BrowserSmokeReport, jsonOutput: boolean): void {
  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`${report.corpus}: ${report.passed}/${report.total} browser smoke cases passed against ${report.origin}`);
  for (let result of report.results) {
    let marker = result.error == null ? "PASS" : "FAIL";
    console.log(`${marker} ${result.case.description}: ${result.requestCount} requests, ${result.transferredBytes} bytes`);
    if (result.error != null) {
      console.log(`  ${result.error}`);
    }
  }
}

function isCompatCorpus(value: unknown): value is CompatCorpus {
  if (typeof value !== "object" || value == null) return false;
  let corpus = value as { cases?: unknown };
  return Array.isArray(corpus.cases) && corpus.cases.every(isCompatCase);
}

function isCompatCase(value: unknown): value is CompatCase {
  if (typeof value !== "object" || value == null) return false;
  let compatCase = value as Record<string, unknown>;
  return typeof compatCase.description === "string" && typeof compatCase.path === "string";
}

function parseArgs(args: string[]): {
  corpusPath: string;
  dryRun: boolean;
  jsonOutput: boolean;
  limit: number;
  origin: string | null;
  packageName: string | null;
} {
  let corpusPath = "scripts/esm-compat-corpus.seed.json";
  let dryRun = false;
  let jsonOutput = false;
  let limit = 10;
  let origin: string | null = null;
  let packageName: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    let arg = args[index];
    if (arg === "--corpus") {
      corpusPath = args[index + 1] ?? corpusPath;
      index += 1;
    } else if (arg.startsWith("--corpus=")) {
      corpusPath = arg.slice("--corpus=".length);
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--json") {
      jsonOutput = true;
    } else if (arg === "--limit") {
      limit = Number(args[index + 1] ?? limit);
      index += 1;
    } else if (arg.startsWith("--limit=")) {
      limit = Number(arg.slice("--limit=".length));
    } else if (arg === "--origin") {
      origin = args[index + 1] ?? null;
      index += 1;
    } else if (arg.startsWith("--origin=")) {
      origin = arg.slice("--origin=".length);
    } else if (arg === "--package") {
      packageName = args[index + 1] ?? null;
      index += 1;
    } else if (arg.startsWith("--package=")) {
      packageName = arg.slice("--package=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return {
    corpusPath,
    dryRun,
    jsonOutput,
    limit: Number.isFinite(limit) && limit > 0 ? limit : 10,
    origin,
    packageName,
  };
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
