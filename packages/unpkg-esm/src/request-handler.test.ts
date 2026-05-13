import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { ExecutionContext } from "@cloudflare/workers-types";
import { handleRequest as handleFilesRequest } from "unpkg-files";

import { packageInfo, packageTarballs } from "../test/fixtures.ts";
import type { Env } from "./env.ts";
import { handleRequest, resolveTypesPath } from "./request-handler.ts";

const env: Env = {
  FILES_ORIGIN: "https://files.unpkg.com",
  MODE: "test",
  ORIGIN: "https://esm.unpkg.com",
};

const context = {
  waitUntil() {},
} as unknown as ExecutionContext;

function dispatchFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let request = input instanceof Request ? input : new Request(input, init);
  return handleRequest(request, env, context);
}

function fileResponse(path: string): Response {
  return new Response(Bun.file(path));
}

describe("handleRequest", () => {
  let globalCaches: CacheStorage | undefined;
  let globalFetch: typeof fetch | undefined;

  beforeAll(() => {
    globalCaches = globalThis.caches;
    globalFetch = globalThis.fetch;

    globalThis.caches = {
      async open() {
        return {
          async match() {
            return null;
          },
          async put() {},
        };
      },
    } as unknown as CacheStorage;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      let request = input instanceof Request ? input : new Request(input, init);
      let url = new URL(request.url);

      if (url.origin === env.FILES_ORIGIN) {
        return handleFilesRequest(request);
      }

      switch (url.href) {
        case "https://registry.npmjs.org/@types/react":
          return Response.json({
            name: "@types/react",
            "dist-tags": { latest: "18.2.0" },
            versions: {
              "18.2.0": {
                name: "@types/react",
                version: "18.2.0",
                types: "index.d.ts",
              },
            },
          });
        case "https://registry.npmjs.org/preact":
          return fileResponse(packageInfo.preact);
        case "https://registry.npmjs.org/react":
          return fileResponse(packageInfo.react);
        case "https://registry.npmjs.org/preact/-/preact-10.26.4.tgz":
          return fileResponse(packageTarballs.preact["10.26.4"]);
        case "https://registry.npmjs.org/react/-/react-18.2.0.tgz":
          return fileResponse(packageTarballs.react["18.2.0"]);
        default:
          throw new Error(`Unexpected URL: ${url}`);
      }
    }) as unknown as typeof fetch;
  });

  afterAll(() => {
    globalThis.caches = globalCaches!;
    globalThis.fetch = globalFetch!;
  });

  it("resolves semver ranges with a normalized temporary redirect", async () => {
    let response = await dispatchFetch("https://esm.unpkg.com/react@^18?meta", { redirect: "manual" });
    expect(response.status).toBe(302);
    let location = response.headers.get("Location");
    expect(location).not.toBeNull();
    expect(location).toMatch(/^\/react@18\.\d+\.\d+\?meta=&target=es2022$/);
  });

  it("normalizes import-map-friendly path query syntax", async () => {
    let response = await dispatchFetch("https://esm.unpkg.com/preact@10.26.4&dev/hooks?meta", {
      redirect: "manual",
    });
    expect(response.status).toBe(301);
    expect(response.headers.get("Location")).toBe("/preact@10.26.4/hooks?dev=&meta=&target=es2022");
  });

  it("returns build metadata for exact package URLs", async () => {
    let redirectResponse = await dispatchFetch("https://esm.unpkg.com/react@18.2.0?meta", { redirect: "manual" });
    expect(redirectResponse.status).toBe(301);

    let response = await dispatchFetch(`https://esm.unpkg.com${redirectResponse.headers.get("Location")}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/^application\/json/);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");

    let json = (await response.json()) as any;
    expect(json.name).toBe("react");
    expect(json.version).toBe("18.2.0");
    expect(json.subpath).toBe(".");
    expect(json.target).toBe("es2022");
    expect(json.module).toBe("https://esm.unpkg.com/react@18.2.0?target=es2022");
    expect(json.types).toBeNull();
    expect(json.integrity).toMatch(/^sha384-/);
  });

  it("returns type metadata for packages with declarations", async () => {
    let redirectResponse = await dispatchFetch("https://esm.unpkg.com/preact@10.26.4?meta", { redirect: "manual" });
    expect(redirectResponse.status).toBe(301);

    let response = await dispatchFetch(`https://esm.unpkg.com${redirectResponse.headers.get("Location")}`);
    expect(response.status).toBe(200);

    let json = (await response.json()) as any;
    expect(json.types).toBe("https://esm.unpkg.com/preact@10.26.4/src/index.d.ts");
  });

  it("returns JSON diagnostics for invalid query combinations", async () => {
    let response = await dispatchFetch("https://esm.unpkg.com/react?dev&env=production");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "INVALID_QUERY",
        message: "?dev cannot be combined with ?env=production",
      },
    });
  });

  it("proxies build artifacts from the files origin", async () => {
    let redirectResponse = await dispatchFetch("https://esm.unpkg.com/preact@10.26.4/src/component.js?no-bundle", {
      redirect: "manual",
    });
    expect(redirectResponse.status).toBe(301);

    let response = await dispatchFetch(`https://esm.unpkg.com${redirectResponse.headers.get("Location")}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/javascript; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=60, s-maxage=300");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.has("X-UNPKG-Build-Key")).toBe(true);
    expect(await response.text()).toContain('from "./util?target=es2022";');
  });

  it("adds TypeScript declaration headers to build artifacts", async () => {
    let redirectResponse = await dispatchFetch("https://esm.unpkg.com/preact@10.26.4?no-bundle", {
      redirect: "manual",
    });
    expect(redirectResponse.status).toBe(301);

    let response = await dispatchFetch(`https://esm.unpkg.com${redirectResponse.headers.get("Location")}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("X-TypeScript-Types")).toBe("https://esm.unpkg.com/preact@10.26.4/src/index.d.ts");
  });

  it("serves raw files without adding a default target", async () => {
    let redirectResponse = await dispatchFetch("https://esm.unpkg.com/react@18.2.0/package.json?raw", {
      redirect: "manual",
    });
    expect(redirectResponse.status).toBe(301);
    expect(redirectResponse.headers.get("Location")).toBe("/react@18.2.0/package.json?raw=");

    let response = await dispatchFetch(`https://esm.unpkg.com${redirectResponse.headers.get("Location")}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/^application\/json/);
    expect(await response.text()).toMatch(/"name": "react"/);
  });

  it("serves declaration files without building them", async () => {
    let redirectResponse = await dispatchFetch("https://esm.unpkg.com/preact@10.26.4/src/index.d.ts", {
      redirect: "manual",
    });
    expect(redirectResponse.status).toBe(301);

    let response = await dispatchFetch(`https://esm.unpkg.com${redirectResponse.headers.get("Location")}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/typescript; charset=utf-8");
    expect(await response.text()).toContain("export as namespace preact");
  });

  it("redirects types-only package metadata requests to declarations", async () => {
    let redirectResponse = await dispatchFetch("https://esm.unpkg.com/@types/react@18.2.0?meta", {
      redirect: "manual",
    });
    expect(redirectResponse.status).toBe(301);

    let response = await dispatchFetch(`https://esm.unpkg.com${redirectResponse.headers.get("Location")}`, {
      redirect: "manual",
    });
    expect(response.status).toBe(301);
    expect(response.headers.get("Location")).toBe("/@types/react@18.2.0/index.d.ts");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=60, s-maxage=300");
  });

  it("returns module worker wrappers", async () => {
    let redirectResponse = await dispatchFetch("https://esm.unpkg.com/preact@10.26.4/src/component.js?worker", {
      redirect: "manual",
    });
    expect(redirectResponse.status).toBe(301);

    let response = await dispatchFetch(`https://esm.unpkg.com${redirectResponse.headers.get("Location")}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/javascript; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=60, s-maxage=300");
    expect(await response.text()).toContain(
      'return new Worker("https://esm.unpkg.com/preact@10.26.4/src/component.js?target=es2022", { type: "module", ...options });'
    );
  });

  it("returns inline TSX runner helper modules", async () => {
    let response = await dispatchFetch("https://esm.unpkg.com/run");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/javascript; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=60, s-maxage=300");
    expect(await response.text()).toContain("export async function run");

    response = await dispatchFetch("https://esm.unpkg.com/tsx");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"/transform?"');
  });

  it("proxies inline transforms to the files origin", async () => {
    let response = await dispatchFetch("https://esm.unpkg.com/transform?target=es2022&jsx=automatic&external=*", {
      method: "POST",
      body: JSON.stringify({
        filename: "/inline.tsx",
        source: "export const view: JSX.Element = <div />;",
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await response.text()).toContain('from "react/jsx-runtime";');
  });
});

describe("resolveTypesPath", () => {
  it("resolves declaration paths from typesVersions", () => {
    expect(
      resolveTypesPath(
        {
          dependencies: {},
          description: "",
          name: "pkg",
          typesVersions: {
            "*": {
              "*": ["dist/*"],
              "subpath": ["dist/subpath.d.ts"],
            },
          },
          version: "1.0.0",
        },
        "./subpath"
      )
    ).toBe("dist/subpath.d.ts");
  });

  it("prefers export-specific types over typesVersions", () => {
    expect(
      resolveTypesPath(
        {
          dependencies: {},
          description: "",
          exports: {
            "./subpath": {
              types: "./types/subpath.d.ts",
              import: "./dist/subpath.js",
            },
          },
          name: "pkg",
          typesVersions: {
            "*": {
              "subpath": ["dist/subpath.d.ts"],
            },
          },
          version: "1.0.0",
        },
        "./subpath"
      )
    ).toBe("./types/subpath.d.ts");
  });

  it("resolves nested types export conditions before typesVersions", () => {
    expect(
      resolveTypesPath(
        {
          dependencies: {},
          description: "",
          exports: {
            ".": {
              "types@<=5.0": {
                default: "./ts5.0/index.d.ts",
              },
              types: {
                default: "./index.d.ts",
              },
            },
          },
          name: "@types/pkg",
          types: "index.d.ts",
          typesVersions: {
            "<=5.0": {
              "*": ["ts5.0/*"],
            },
          },
          version: "1.0.0",
        },
        "."
      )
    ).toBe("./index.d.ts");
  });
});
