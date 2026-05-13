import { describe, expect, it } from "bun:test";

import { getEsmPackageSubpath, normalizeEsmRequestUrl, parseEsmPackagePathname } from "./esm-url.ts";

describe("parseEsmPackagePathname", () => {
  it("parses package roots", () => {
    expect(parseEsmPackagePathname("/react")).toEqual({
      externalAll: false,
      package: "react",
      scope: undefined,
      version: undefined,
      filename: undefined,
    });
  });

  it("parses scoped packages with versions and subpaths", () => {
    expect(parseEsmPackagePathname("/@scope/pkg@1.2.3/sub/module")).toEqual({
      externalAll: false,
      package: "@scope/pkg",
      scope: "@scope",
      version: "1.2.3",
      filename: "/sub/module",
    });
  });

  it("parses the esm.sh all-dependencies-external shorthand", () => {
    expect(parseEsmPackagePathname("/*swr@1.3.0")).toEqual({
      externalAll: true,
      package: "swr",
      scope: undefined,
      version: "1.3.0",
      filename: undefined,
    });
  });
});

describe("normalizeEsmRequestUrl", () => {
  it("adds the default target", () => {
    let result = normalizeEsmRequestUrl("https://esm.unpkg.com/react@18");
    expect("url" in result && result.url.search).toBe("?target=es2022");
  });

  it("normalizes import-map-friendly path query syntax", () => {
    let result = normalizeEsmRequestUrl("https://esm.unpkg.com/react-dom@18.3.1&dev/client");

    expect("url" in result && result.url.pathname).toBe("/react-dom@18.3.1/client");
    expect("url" in result && result.url.search).toBe("?dev=&target=es2022");
  });

  it("accepts runtime-native esm.sh compatibility targets", () => {
    let result = normalizeEsmRequestUrl("https://esm.unpkg.com/react?target=node");

    expect("url" in result && result.url.search).toBe("?target=node");
  });

  it("rejects conflicting development and production flags", () => {
    expect(normalizeEsmRequestUrl("https://esm.unpkg.com/react?dev&env=production")).toEqual({
      code: "INVALID_QUERY",
      message: "?dev cannot be combined with ?env=production",
      status: 400,
    });
  });

  it("does not add a default target to raw requests", () => {
    let result = normalizeEsmRequestUrl("https://esm.unpkg.com/react@18/package.json?raw");

    expect("url" in result && result.url.search).toBe("?raw=");
  });
});

describe("getEsmPackageSubpath", () => {
  it("normalizes package roots to dot", () => {
    expect(getEsmPackageSubpath(undefined)).toBe(".");
    expect(getEsmPackageSubpath("/")).toBe(".");
  });

  it("normalizes package subpaths to export subpaths", () => {
    expect(getEsmPackageSubpath("/jsx-runtime")).toBe("./jsx-runtime");
  });
});
