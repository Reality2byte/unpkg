import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import {
  normalizeBuildOptions,
  parseAliases,
  parseDependencyOverrides,
  rewriteEsmImports,
  transformSource,
  UnsupportedNodeBuiltinError,
} from "./esm-build-service.ts";

const registry = "https://registry.npmjs.org";

describe("parseDependencyOverrides", () => {
  it("parses package version overrides", () => {
    expect(parseDependencyOverrides("react@18.2.0,@scope/pkg@1.2.3")).toEqual({
      react: "18.2.0",
      "@scope/pkg": "1.2.3",
    });
  });
});

describe("parseAliases", () => {
  it("parses dependency aliases", () => {
    expect(parseAliases("react:preact/compat,react-dom:preact/compat")).toEqual({
      react: "preact/compat",
      "react-dom": "preact/compat",
    });
  });
});

describe("rewriteEsmImports", () => {
  let globalFetch: typeof fetch | undefined;

  beforeAll(() => {
    globalFetch = globalThis.fetch;

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      let request = input instanceof Request ? input : new Request(input);
      let url = new URL(request.url);

      switch (url.href) {
        case "https://registry.npmjs.org/react":
          return Response.json(packageInfo("react", ["18.2.0", "18.3.1"], "18.3.1"));
        case "https://registry.npmjs.org/preact":
          return Response.json(packageInfo("preact", ["10.25.4", "10.26.4"], "10.26.4"));
        default:
          throw new Error(`Unexpected URL: ${url}`);
      }
    }) as unknown as typeof fetch;
  });

  afterAll(() => {
    if (globalFetch) {
      globalThis.fetch = globalFetch;
    }
  });

  it("rewrites bare imports to exact esm.unpkg.com versions", async () => {
    let code = 'import React from "react";';
    let result = await rewriteEsmImports(code, registry, "https://esm.unpkg.com", { react: "^18" }, options());

    expect(result).toBe('import React from "https://esm.unpkg.com/react@18.3.1";');
  });

  it("applies dependency version overrides", async () => {
    let code = 'import React from "react";';
    let result = await rewriteEsmImports(code, registry, "https://esm.unpkg.com", { react: "^18" }, options("deps=react@18.2.0"));

    expect(result).toBe('import React from "https://esm.unpkg.com/react@18.2.0";');
  });

  it("applies aliases before version resolution", async () => {
    let code = 'import React from "react";';
    let result = await rewriteEsmImports(
      code,
      registry,
      "https://esm.unpkg.com",
      { react: "^18" },
      options("alias=react:preact/compat&deps=preact@10.25.4")
    );

    expect(result).toBe('import React from "https://esm.unpkg.com/preact@10.25.4/compat";');
  });

  it("keeps externalized dependencies as bare specifiers", async () => {
    let code = 'import React from "react";';
    let result = await rewriteEsmImports(code, registry, "https://esm.unpkg.com", { react: "^18" }, options("external=react"));

    expect(result).toBe('import React from "react";');
  });

  it("rewrites local imports with the active target", async () => {
    let code = 'import util from "./util";';
    let result = await rewriteEsmImports(code, registry, "https://esm.unpkg.com", {}, options());

    expect(result).toBe('import util from "./util?target=es2022";');
  });

  it("rewrites common Node builtins to browser polyfills", async () => {
    let code = 'import process from "node:process";';
    let result = await rewriteEsmImports(code, registry, "https://esm.unpkg.com", {}, options());

    expect(result).toBe('import process from "https://esm.unpkg.com/@jspm/core@2/nodelibs/browser/process";');
  });

  it("rejects hard Node-only builtins", async () => {
    let code = 'import fs from "node:fs";';

    await expect(rewriteEsmImports(code, registry, "https://esm.unpkg.com", {}, options())).rejects.toBeInstanceOf(
      UnsupportedNodeBuiltinError
    );
  });

  it("preserves Node builtins for runtime-native targets", async () => {
    let code = 'import fs from "node:fs";\nimport process from "node:process";';
    let result = await rewriteEsmImports(code, registry, "https://esm.unpkg.com", {}, options("target=node"));

    expect(result).toBe(code);
  });
});

describe("transformSource", () => {
  it("transforms TypeScript and replaces NODE_ENV", async () => {
    let result = await transformSource(
      "export const mode: string = process.env.NODE_ENV;",
      "/src/index.ts",
      options("target=es2017&env=development")
    );

    expect(result.code).toContain('const mode = "development";');
  });

  it("transforms JSX with the automatic runtime", async () => {
    let result = await transformSource(
      "export const view = <div />;",
      "/src/index.jsx",
      options("jsx=automatic&jsxImportSource=preact")
    );

    expect(result.code).toContain("preact/jsx-runtime");
  });

  it("minifies output when requested", async () => {
    let result = await transformSource(
      "export const value = 1 + 2;",
      "/src/index.js",
      options("min")
    );

    expect(result.code.trim()).toMatch(/^const \w=3;export\{\w as value\};$/);
  });
});

function options(search = "") {
  return normalizeBuildOptions(new URLSearchParams(search));
}

function packageInfo(name: string, versions: string[], latest: string) {
  return {
    name,
    "dist-tags": {
      latest,
    },
    time: {},
    versions: Object.fromEntries(versions.map((version) => [version, { name, version, dependencies: {}, description: "" }])),
  };
}
