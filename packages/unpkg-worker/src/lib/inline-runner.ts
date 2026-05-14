export interface InlineRunnerOptions {
  transformOrigin: string;
}

export function createInlineRunner(options: InlineRunnerOptions): string {
  let transformOrigin = options.transformOrigin.replace(/\/+$/, "");

  return `const transformOrigin = ${JSON.stringify(transformOrigin)};
const supportedScriptTypes = new Set(["text/babel", "text/jsx", "text/ts", "text/tsx"]);

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
  let response = await fetch(new URL("/transform?" + transformSearchParams(script), transformOrigin), {
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
