#!/usr/bin/env bun

import { readFile } from "node:fs/promises";

interface CompatReport {
  results: Array<{
    esmUnpkg: {
      contentLength: number;
      diagnosticCode: string | null;
      durationMs: number;
      status: number;
    };
    failureCategory: string | null;
    passed: boolean;
  }>;
  summary: {
    failed: number;
    passed: number;
    total: number;
  };
}

interface BrowserSmokeReport {
  failed: number;
  passed: number;
  results: Array<{
    durationMs: number;
    error: string | null;
    requestCount: number;
    transferredBytes: number;
  }>;
  total: number;
}

interface Gate {
  actual: number;
  name: string;
  passed: boolean;
  threshold: number;
}

let options = parseArgs(process.argv.slice(2));
let compatReport = await readJson<CompatReport>(options.compatPath);
let browserReport = options.browserPath == null ? null : await readJson<BrowserSmokeReport>(options.browserPath);
let gates = createGates(compatReport, browserReport);

for (let gate of gates) {
  let marker = gate.passed ? "PASS" : "FAIL";
  console.log(`${marker} ${gate.name}: ${formatNumber(gate.actual)} >= ${formatNumber(gate.threshold)}`);
}

let diagnostics = summarizeDiagnostics(compatReport);
if (Object.keys(diagnostics).length > 0) {
  console.log("Diagnostics:");
  for (let [code, count] of Object.entries(diagnostics)) {
    console.log(`  ${code}: ${count}`);
  }
}

let failures = gates.filter((gate) => !gate.passed);
if (failures.length > 0) {
  process.exitCode = 1;
}

function createGates(compatReport: CompatReport, browserReport: BrowserSmokeReport | null): Gate[] {
  let compatPassRate = percentage(compatReport.summary.passed, compatReport.summary.total);
  let p95Duration = percentile(compatReport.results.map((result) => result.esmUnpkg.durationMs), 95);
  let p95ContentLength = percentile(compatReport.results.map((result) => result.esmUnpkg.contentLength), 95);
  let clearDiagnostics = compatReport.results.every((result) => {
    return result.passed || result.failureCategory != null || result.esmUnpkg.diagnosticCode != null;
  });

  let gates: Gate[] = [
    {
      actual: compatPassRate,
      name: "compat pass rate",
      passed: compatPassRate >= options.minCompatPassRate,
      threshold: options.minCompatPassRate,
    },
    {
      actual: options.maxP95DurationMs - p95Duration,
      name: "compat p95 duration budget remaining",
      passed: p95Duration <= options.maxP95DurationMs,
      threshold: 0,
    },
    {
      actual: options.maxP95ContentLengthBytes - p95ContentLength,
      name: "compat p95 artifact-size budget remaining",
      passed: p95ContentLength <= options.maxP95ContentLengthBytes,
      threshold: 0,
    },
    {
      actual: clearDiagnostics ? 100 : 0,
      name: "classified failures",
      passed: clearDiagnostics,
      threshold: 100,
    },
  ];

  if (browserReport != null) {
    let browserPassRate = percentage(browserReport.passed, browserReport.total);
    gates.push({
      actual: browserPassRate,
      name: "browser smoke pass rate",
      passed: browserPassRate >= options.minBrowserPassRate,
      threshold: options.minBrowserPassRate,
    });
  }

  return gates;
}

function summarizeDiagnostics(report: CompatReport): Record<string, number> {
  let diagnostics: Record<string, number> = {};
  for (let result of report.results) {
    let code = result.esmUnpkg.diagnosticCode ?? result.failureCategory;
    if (code != null) {
      diagnostics[code] = (diagnostics[code] ?? 0) + 1;
    }
  }

  return diagnostics;
}

async function readJson<T>(filename: string): Promise<T> {
  return JSON.parse(await readFile(filename, "utf8")) as T;
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) {
    return 0;
  }

  let sorted = values.slice().sort((left, right) => left - right);
  let index = Math.ceil((percentileValue / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

function percentage(numerator: number, denominator: number): number {
  return denominator === 0 ? 100 : (numerator / denominator) * 100;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? value.toString() : value.toFixed(2);
}

function parseArgs(args: string[]): {
  browserPath: string | null;
  compatPath: string;
  maxP95ContentLengthBytes: number;
  maxP95DurationMs: number;
  minBrowserPassRate: number;
  minCompatPassRate: number;
} {
  let browserPath: string | null = null;
  let compatPath = "";
  let maxP95ContentLengthBytes = Number(process.env.ESM_MAX_P95_BYTES ?? 500_000);
  let maxP95DurationMs = Number(process.env.ESM_MAX_P95_DURATION_MS ?? 5_000);
  let minBrowserPassRate = Number(process.env.ESM_MIN_BROWSER_PASS_RATE ?? 90);
  let minCompatPassRate = Number(process.env.ESM_MIN_COMPAT_PASS_RATE ?? 95);

  for (let index = 0; index < args.length; index += 1) {
    let arg = args[index];
    if (arg === "--compat") {
      compatPath = args[index + 1] ?? compatPath;
      index += 1;
    } else if (arg.startsWith("--compat=")) {
      compatPath = arg.slice("--compat=".length);
    } else if (arg === "--browser") {
      browserPath = args[index + 1] ?? null;
      index += 1;
    } else if (arg.startsWith("--browser=")) {
      browserPath = arg.slice("--browser=".length);
    } else if (arg === "--min-compat-pass-rate") {
      minCompatPassRate = Number(args[index + 1] ?? minCompatPassRate);
      index += 1;
    } else if (arg.startsWith("--min-compat-pass-rate=")) {
      minCompatPassRate = Number(arg.slice("--min-compat-pass-rate=".length));
    } else if (arg === "--min-browser-pass-rate") {
      minBrowserPassRate = Number(args[index + 1] ?? minBrowserPassRate);
      index += 1;
    } else if (arg.startsWith("--min-browser-pass-rate=")) {
      minBrowserPassRate = Number(arg.slice("--min-browser-pass-rate=".length));
    } else if (arg === "--max-p95-duration-ms") {
      maxP95DurationMs = Number(args[index + 1] ?? maxP95DurationMs);
      index += 1;
    } else if (arg.startsWith("--max-p95-duration-ms=")) {
      maxP95DurationMs = Number(arg.slice("--max-p95-duration-ms=".length));
    } else if (arg === "--max-p95-bytes") {
      maxP95ContentLengthBytes = Number(args[index + 1] ?? maxP95ContentLengthBytes);
      index += 1;
    } else if (arg.startsWith("--max-p95-bytes=")) {
      maxP95ContentLengthBytes = Number(arg.slice("--max-p95-bytes=".length));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (compatPath === "") {
    throw new Error("Missing required --compat <report.json>");
  }

  return {
    browserPath,
    compatPath,
    maxP95ContentLengthBytes,
    maxP95DurationMs,
    minBrowserPassRate,
    minCompatPassRate,
  };
}
