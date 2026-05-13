#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

interface CompatCase {
  category?: string;
  description: string;
  expect: "module" | "json" | "css" | "diagnostic";
  features?: string[];
  package?: string;
  path: string;
}

interface RuntimeSmokeCase {
  case: CompatCase;
  run: (page: import("playwright").Page, origin: string) => Promise<string[]>;
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
  if (compatCase.features?.includes("external")) return false;
  if (compatCase.features?.includes("external-all")) return false;
  if (compatCase.features?.includes("target-node")) return false;
  return options.packageName == null || compatCase.package === options.packageName;
}).slice(0, options.limit);
let runtimeCases = options.packageName == null ? createRuntimeSmokeCases() : [];

if (options.dryRun) {
  let importResults = smokeCases.map((compatCase) => ({
    case: compatCase,
    durationMs: 0,
    error: null,
    exportKeys: [],
    requestCount: 0,
    transferredBytes: 0,
    url: new URL(compatCase.path, origin).toString(),
  }));
  let runtimeResults = runtimeCases.map(({ case: smokeCase }) => ({
    case: smokeCase,
    durationMs: 0,
    error: null,
    exportKeys: [],
    requestCount: 0,
    transferredBytes: 0,
    url: new URL(smokeCase.path, origin).toString(),
  }));
  let results = [...importResults, ...runtimeResults];
  printReport({
    browser: "chromium",
    corpus: corpus.name ?? options.corpusPath,
    createdAt: new Date().toISOString(),
    failed: 0,
    origin,
    passed: results.length,
    results,
    total: results.length,
  }, options.jsonOutput);
  process.exit(0);
}

let browser = await chromium.launch();
try {
  let context = await browser.newContext();
  let page = await context.newPage();
  let results: BrowserSmokeResult[] = [];
  for (let compatCase of smokeCases) {
    results.push(await runCase(page, compatCase, origin));
  }
  for (let runtimeCase of runtimeCases) {
    results.push(await runRuntimeCase(page, runtimeCase, origin));
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
  return trackBrowserCase(page, compatCase, origin, url, async () => {
    return page.evaluate(async (moduleUrl) => {
      let module = await import(moduleUrl);
      return Object.keys(module).sort();
    }, url);
  });
}

async function runRuntimeCase(
  page: import("playwright").Page,
  runtimeCase: RuntimeSmokeCase,
  origin: string
): Promise<BrowserSmokeResult> {
  let url = new URL(runtimeCase.case.path, origin).toString();
  let runtimePage = await page.context().newPage();
  try {
    await runtimePage.setContent("<!doctype html><html><body></body></html>");
    return await trackBrowserCase(runtimePage, runtimeCase.case, origin, url, () => runtimeCase.run(runtimePage, origin));
  } finally {
    await runtimePage.close();
  }
}

async function trackBrowserCase(
  page: import("playwright").Page,
  compatCase: CompatCase,
  origin: string,
  url: string,
  callback: () => Promise<string[]>
): Promise<BrowserSmokeResult> {
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
    let exportKeys = await callback();

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

function createRuntimeSmokeCases(): RuntimeSmokeCase[] {
  return [
    {
      case: {
        category: "runtime",
        description: "React renders with react-dom/client",
        expect: "module",
        features: ["runtime", "react", "render"],
        package: "react-dom",
        path: "/__runtime/react-render",
      },
      run: (page, origin) =>
        page.evaluate(async (esmOrigin) => {
          let ReactModule = await import(`${esmOrigin}/react@18.3.1`);
          let React = ReactModule.default ?? ReactModule;
          let ReactDOM = await import(`${esmOrigin}/react-dom@18.3.1/client`);
          let container = document.createElement("div");
          document.body.append(container);
          let root = ReactDOM.createRoot(container);
          root.render(React.createElement("button", { type: "button" }, "Hello React"));
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          if (container.textContent !== "Hello React") {
            throw new Error(`React render failed: ${container.textContent ?? ""}`);
          }
          root.unmount();
          return ["createRoot", "render"];
        }, origin),
    },
    {
      case: {
        category: "runtime",
        description: "Preact renders DOM in Chromium",
        expect: "module",
        features: ["runtime", "preact", "render"],
        package: "preact",
        path: "/__runtime/preact-render",
      },
      run: (page, origin) =>
        page.evaluate(async (esmOrigin) => {
          let { h, render } = await import(`${esmOrigin}/preact@10.26.4`);
          let container = document.createElement("div");
          document.body.append(container);
          render(h("button", { type: "button" }, "Hello Preact"), container);
          await new Promise((resolve) => requestAnimationFrame(resolve));
          if (container.textContent !== "Hello Preact") {
            throw new Error(`Preact render failed: ${container.textContent ?? ""}`);
          }
          render(null, container);
          return ["h", "render"];
        }, origin),
    },
    {
      case: {
        category: "runtime",
        description: "CommonJS lodash subpath executes in the browser",
        expect: "module",
        features: ["runtime", "cjs"],
        package: "lodash",
        path: "/__runtime/lodash-cjs",
      },
      run: (page, origin) =>
        page.evaluate(async (esmOrigin) => {
          let module = await import(`${esmOrigin}/lodash@4.17.21/map`);
          let map = module.default;
          let result = map([1, 2, 3], (value) => value * 2);
          if (result.join(",") !== "2,4,6") {
            throw new Error(`Unexpected lodash result: ${result.join(",")}`);
          }
          return ["default", "map"];
        }, origin),
    },
    {
      case: {
        category: "runtime",
        description: "Browser package API executes in Chromium",
        expect: "module",
        features: ["runtime", "browser"],
        package: "uuid",
        path: "/__runtime/uuid-browser",
      },
      run: (page, origin) =>
        page.evaluate(async (esmOrigin) => {
          let { validate, v4 } = await import(`${esmOrigin}/uuid@14.0.0`);
          let id = v4();
          if (!validate(id)) {
            throw new Error(`Invalid UUID generated: ${id}`);
          }
          return ["v4", "validate"];
        }, origin),
    },
    {
      case: {
        category: "runtime",
        description: "Import-map externalization resolves bare imports",
        expect: "module",
        features: ["runtime", "external", "import-map"],
        package: "react-dom",
        path: "/__runtime/import-map-external",
      },
      run: async (page, origin) => {
        await page.setContent(`<!doctype html><html><head><script type="importmap">${JSON.stringify({
          imports: {
            react: `${origin}/react@18.3.1`,
          },
        })}</script></head><body></body></html>`);

        return page.evaluate(async (moduleUrl) => {
          let ReactDOM = await import(moduleUrl);
          if (typeof ReactDOM.createRoot !== "function") {
            throw new Error("Externalized react-dom/client did not expose createRoot");
          }
          return ["createRoot", "importmap"];
        }, `${origin}/react-dom@18.3.1/client?external=react`);
      },
    },
    {
      case: {
        category: "runtime",
        description: "CSS module exports a constructable stylesheet",
        expect: "module",
        features: ["runtime", "css", "css-module"],
        package: "react-toastify",
        path: "/__runtime/css-module",
      },
      run: (page, origin) =>
        page.evaluate(async (esmOrigin) => {
          let module = await import(`${esmOrigin}/react-toastify@11.0.5/dist/ReactToastify.css?module`);
          if (!(module.default instanceof CSSStyleSheet)) {
            throw new Error("CSS module did not export a CSSStyleSheet");
          }
          document.adoptedStyleSheets = [...document.adoptedStyleSheets, module.default];
          if (!document.adoptedStyleSheets.includes(module.default)) {
            throw new Error("CSSStyleSheet was not adopted by the document");
          }
          return ["CSSStyleSheet", "adoptedStyleSheets"];
        }, origin),
    },
    {
      case: {
        category: "runtime",
        description: "Worker wrapper starts a module worker",
        expect: "module",
        features: ["runtime", "worker"],
        package: "uuid",
        path: "/__runtime/worker-wrapper",
      },
      run: async (page, origin) => {
        await page.goto(`${origin}/_health`);
        return page.evaluate(async (esmOrigin) => {
          let { default: createWorker } = await import(`${esmOrigin}/uuid@14.0.0?worker`);
          let worker = createWorker({ name: "esm-unpkg-browser-smoke" });
          try {
            await new Promise<void>((resolve, reject) => {
              let timeout = setTimeout(resolve, 500);
              worker.addEventListener("error", (event) => {
                clearTimeout(timeout);
                reject(new Error(event.message || "Worker failed to start"));
              }, { once: true });
            });
          } finally {
            worker.terminate();
          }
          return ["Worker", "createWorker"];
        }, origin);
      },
    },
    {
      case: {
        category: "runtime",
        description: "Inline TSX helper transforms browser scripts",
        expect: "module",
        features: ["runtime", "tsx"],
        path: "/__runtime/inline-tsx-helper",
      },
      run: async (page, origin) => {
        await page.setContent([
          "<!doctype html><html><body>",
          '<script type="text/ts">window.__esmUnpkgInlineValue = 21 as number;</script>',
          "</body></html>",
        ].join(""));
        await page.addScriptTag({
          type: "module",
          url: `${origin}/tsx`,
        });
        await page.waitForFunction(() => globalThis.__esmUnpkgInlineValue === 21);
        return ["tsx", "transform"];
      },
    },
  ];
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
