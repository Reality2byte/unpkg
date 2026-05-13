# `esm.unpkg.com` Specification

## Overview

`esm.unpkg.com` is an npm-only ESM transformation service for UNPKG. It serves packages from npm as browser-ready ES modules, with on-demand transformation, dependency rewriting, configurable bundling, TypeScript/JSX transforms, metadata, and cacheable build artifacts.

The service should strive for esm.sh compatibility for npm packages. A URL that works on esm.sh for an npm package should either work the same way on `esm.unpkg.com` or fail with a documented, intentional limitation. There are two explicit initial exclusions:

- Non-npm registries are out of scope.
- CSS handling is out of scope.

The primary goal is to let developers import npm packages directly in modern browsers without local install or build tooling:

```js
import React from "https://esm.unpkg.com/react@18.3.1";
import { createRoot } from "https://esm.unpkg.com/react-dom@18.3.1/client";
```

## Goals

- Serve valid browser-compatible ESM for npm packages and package subpaths.
- Support CJS-to-ESM, TS/TSX/JSX transforms, package export conditions, dependency overrides, aliasing, externals, source maps, types, and metadata.
- Reduce network request counts through smart bundling while preserving package semantics where possible.
- Produce deterministic, cacheable build artifacts keyed by package version, subpath, target, dependency graph options, and transform options.
- Preserve UNPKG's existing strengths: npm-first URL ergonomics, CDN caching, clear redirects, and compatibility with package paths.
- Match esm.sh's npm package URL behavior and query-parameter semantics wherever doing so does not conflict with the explicit non-goals.

## esm.sh Compatibility Contract

Compatibility with esm.sh is a product requirement, not just inspiration. The implementation should maintain an `esm.sh` compatibility suite that exercises equivalent npm package URLs against both services and records whether `esm.unpkg.com` returns equivalent module behavior.

Required compatibility targets:

- npm package root imports, version ranges, dist-tags, and subpath imports;
- `?target`, `?dev`, `?deps`, `?alias`, `?external`, `?bundle=false`, `?no-bundle`, `?standalone`, `?raw`, `?exports`, `?conditions`, `?keep-names`, `?ignore-annotations`, `?no-dts`, `?meta`, and `?worker`;
- import-map workflows where externalized dependencies remain bare specifiers;
- TypeScript, JSX, and TSX source transforms;
- browser-compatible handling of common Node builtins;
- SRI-compatible integrity values in metadata.

Intentional compatibility exclusions:

- Non-npm registry paths such as `/jsr/`, `/gh/`, `/pr/`, and `/pkg.pr.new/`.
- CSS features such as `?css` and JS-imported CSS rewriting.

Deferred compatibility items:

- `?target=deno`, `?target=denonext`, and `?target=node`.
- Vue and Svelte single-file component transforms.
- `/tsx` and `/run` inline TS/JSX browser helpers.

Deferred items should remain in the roadmap, but the first public package-import release should prioritize browser-target npm package imports.

When compatibility is not possible in the first release, the service should return a clear diagnostic and the docs should list the limitation in an esm.sh compatibility table.

## Non-Goals

- No JSR, GitHub, pkg.pr.new, or other non-npm package registries in the initial release.
- No CSS import rewriting, extraction, or `?css` behavior in the initial release.
- No IE11 or legacy non-module browser support.
- No private npm package support unless a future UNPKG product explicitly adds authenticated registry access.
- No guarantee of exact Node.js runtime semantics for browser output.

## URL Format

The public URL format mirrors UNPKG package addressing:

```txt
https://esm.unpkg.com/:package@:range/:subpath?:query
```

Examples:

```txt
https://esm.unpkg.com/react
https://esm.unpkg.com/react@18
https://esm.unpkg.com/react@18.3.1/jsx-runtime
https://esm.unpkg.com/@scope/pkg@1.2.3/sub/module?target=es2022&dev
```

Requests without an explicit version range resolve using npm dist-tags and semver metadata. Requests with a range resolve to a concrete version and then redirect to a versioned URL unless the response is a metadata or error response.

Package subpaths are first-class. The service must support both package `exports` subpaths and package file paths where package exports allow or no exports map constrains them.

## Response Model

The service has two URL classes:

- Friendly URLs, such as `/react@18`, that resolve npm metadata and redirect or proxy to a build artifact.
- Versioned build artifact URLs, such as `/react@18.3.1?target=es2022`, that are option-addressed and cacheable with a bounded, revalidatable TTL.

Friendly URLs should redirect to versioned build artifact URLs after version and option resolution. They should use short CDN TTLs because dist-tags and semver ranges can move. Build artifacts must not use `immutable` cache semantics because output also depends on the UNPKG transformer implementation.

Generated modules should rewrite dependency imports to absolute `https://esm.unpkg.com/...` URLs with concrete resolved versions and normalized query options. This avoids version drift inside generated output and maximizes cache reuse.

All JavaScript module responses must include:

```txt
Content-Type: application/javascript; charset=utf-8
Access-Control-Allow-Origin: *
Cache-Control: public, max-age=60, s-maxage=300
```

Range, dist-tag, metadata, and error responses may use shorter cache lifetimes.

## Query Parameters

### Build Target

```txt
?target=es2015|es2016|...|es2024|esnext
```

The v1 default target is deterministic and does not vary by `User-Agent`. The default is `es2022`.

The initial public release should support browser targets from `es2015` through the current stable ECMAScript year plus `esnext`. The original SOW's `es5` target is intentionally omitted because native ESM output cannot provide meaningful IE11-style compatibility.

`deno`, `denonext`, and `node` targets are part of the esm.sh compatibility roadmap, but v1 may return `400 Unsupported target` for these values until runtime-specific output is implemented.

### Production and Development Mode

```txt
?dev
?env=development|production
```

`?dev` is shorthand for `?env=development`.

Development mode must:

- define `process.env.NODE_ENV` as `"development"` where build-time replacement is needed;
- prefer the `development` export condition when resolving package exports;
- preserve useful debug names where compatible with minification and target options.

Production mode must:

- define `process.env.NODE_ENV` as `"production"`;
- prefer production/default export conditions;
- allow minification with `?min`.

Production mode is the default. `?min` is never implied by production mode; minification is explicit so generated output remains debuggable unless callers ask for smaller output.

If both `?dev` and `?env=production` are present, return `400`.

### Minification

```txt
?min
```

Minifies JavaScript output. Minification is part of the build cache key.

### Source Maps

```txt
?sourcemap
```

Includes source maps. The public behavior should use external `.map` artifacts with the same bounded cache semantics as the JavaScript artifact. Inline source maps are acceptable only during early local development and should not be the long-term public behavior for large packages.

### Dependency Version Overrides

```txt
?deps=react@18.3.1,react-dom@18.3.1
```

Overrides dependency resolution for named packages. This is required for peer dependency alignment and avoiding duplicate framework instances.

Rules:

- Package names may be scoped.
- Each dependency override must include a valid npm semver range, dist-tag, or exact version.
- Overrides apply transitively unless a nested package has a stronger package-local dependency that cannot be satisfied by the override.
- The resolved concrete override versions are included in the build cache key and `?meta` response.

### Dependency Aliasing

```txt
?alias=react:preact/compat
?alias=react:preact/compat,react-dom:preact/compat
```

Aliases imports from one package specifier to another. Aliasing happens before dependency resolution and before externalization.

Aliases must support:

- package-to-package aliases;
- package-to-subpath aliases;
- aliases combined with `?deps`, such as `?alias=react:preact/compat&deps=preact@10.25.4`.

### External Dependencies

```txt
?external=react,react-dom
?external=*
```

External dependencies are not bundled or rewritten to UNPKG URLs. They remain as bare import specifiers so the browser can resolve them through an import map.

Rules:

- `?external=react` leaves `import "react"` intact.
- `?external=react` also externalizes `react/jsx-runtime` unless a more specific rule says otherwise.
- `?external=*` externalizes all npm package dependencies but does not externalize relative imports inside the requested package.
- Externalization participates in the cache key.

The esm.sh shorthand `*pkg` should also be supported as an alias for externalizing all dependencies of the requested package, e.g. `https://esm.unpkg.com/*swr@1.3.0`.

### Bundling Strategy

```txt
?bundle
?bundle=false
?no-bundle
?standalone
```

The service should use smart bundling by default:

- Package-internal modules may be bundled to reduce request counts.
- Shared export entry points should avoid duplicate module copies where the package `exports` map provides enough structure.
- Dependencies may remain as URL imports by default unless bundling is explicitly requested.

Modes:

- `?bundle` forces bundling the requested package's internal module graph and non-external dependencies when practical.
- `?bundle=false` and `?no-bundle` disable default bundling and emit rewritten ESM imports instead.
- `?standalone` bundles dependencies into one module except packages listed in `peerDependencies`, packages requested in `?external`, and modules that cannot be safely bundled.

If a dependency cannot be bundled due to dynamic resolution, Node-only APIs, unsupported assets, or transform failures, the service should either leave a rewritten URL import when compatible with the requested mode or return a diagnostic error when the requested mode requires a single file.

### Raw Source

```txt
?raw
```

Returns package files without ESM transformation or bundling. Raw mode exists as an escape hatch for files that should be served as-is.

Rules:

- Raw mode is mutually exclusive with transform flags such as `?bundle`, `?standalone`, `?target`, `?min`, `?jsx`, and `?exports`.
- Raw mode may still use package/version resolution and redirects.
- Raw responses should preserve the file's content type where known.

### JSX and TypeScript

```txt
?jsx=react|preact|automatic
?jsxImportSource=preact
```

The service must transform JavaScript, TypeScript, JSX, and TSX sources where they appear in npm packages.

Required source extensions:

- `.js`
- `.mjs`
- `.cjs`
- `.jsx`
- `.ts`
- `.tsx`

The default JSX mode is `automatic` when the package or import context indicates an automatic runtime, otherwise `react`. `?jsxImportSource` controls the automatic runtime import source.

Vue and Svelte single-file component transforms are deferred compatibility items. v1 should return a clear `415 Unsupported Media Type` diagnostic for `.vue` and `.svelte` files rather than opaque build failures.

### Export Conditions

```txt
?conditions=worker,browser,custom
```

Adds custom package export conditions to the resolver.

Default condition order for browser builds:

```txt
unpkg, browser, import, module, default
```

Development builds add `development` before `import`. Production builds add `production` before `import`.

Default condition order for production browser builds:

```txt
browser, production, import, module, default
```

Default condition order for development browser builds:

```txt
browser, development, import, module, default
```

The existing package `unpkg` field should not be blindly preferred on `esm.unpkg.com`; the resolver should prefer browser and ESM-oriented entries first. The `unpkg` field may be used as a fallback only when it points to transformable JavaScript and no better ESM/browser entry is available.

The exact condition order must be documented and covered by tests because it changes which files packages expose.

### Tree Shaking by Export Selection

```txt
?exports=foo,bar
```

Builds an entry module that only exposes the listed named exports when the package format and bundler can prove this is safe.

Rules:

- Works for ESM packages and ESM-compatible transformed modules.
- May return `400` for CJS modules when named export selection cannot be proven.
- Export selection is included in the build cache key.

### Esbuild Compatibility Flags

```txt
?keep-names
?ignore-annotations
```

Pass through equivalent esbuild behavior when esbuild is the transformer. If a different transformer is used, implement equivalent behavior or return `400` with a clear unsupported option diagnostic.

### Type Declaration Metadata

```txt
?no-dts
```

By default, JavaScript module responses should include type metadata when declarations are available:

```txt
X-TypeScript-Types: https://esm.unpkg.com/:package@:version/:path/to/types.d.ts
```

`?no-dts` disables the header.

Declaration behavior:

- Discover package declarations from `exports[...].types`, `types`, and `typings`.
- Serve declaration files as raw text with `Content-Type: text/typescript; charset=utf-8`.
- Rewrite declaration imports when necessary so declarations resolve through stable `esm.unpkg.com` URLs.
- Declaration bundling is deferred. Declaration discovery and serving are required in v1, with import rewriting where straightforward.

The original SOW's `?types` flag should not be the primary API. If retained for compatibility, `?types` should redirect to or return the resolved declaration file.

### Metadata

```txt
?meta
```

Returns machine-readable build metadata instead of JavaScript.

Example:

```json
{
  "name": "react",
  "version": "18.3.1",
  "specifier": "react@18",
  "subpath": ".",
  "target": "es2022",
  "module": "/react@18.3.1/es2022/react.mjs",
  "types": "/react@18.3.1/index.d.ts",
  "integrity": "sha384-...",
  "dependencies": {},
  "peerDependencies": {},
  "exports": ["./jsx-runtime", "./jsx-dev-runtime"],
  "build": {
    "bundle": "smart",
    "minify": false,
    "sourcemap": false
  }
}
```

Metadata responses must include the resolved concrete version, module URL, declaration URL when available, supported export subpaths when known, and an SRI-compatible integrity hash for the module artifact.

### Web Worker Mode

```txt
?worker
```

Returns a module that creates a browser `Worker` for the requested module.

Minimum API:

```js
import createWorker from "https://esm.unpkg.com/pkg/subpath?worker";

let worker = createWorker();
let named = createWorker({ name: "pkg-worker" });
```

The generated worker wrapper must use the resolved versioned module URL internally and work under standard browser module worker semantics.

An `inject` helper like esm.sh is deferred until after the first package-import release.

### Inline TS/JSX Runner

```txt
/tsx
/run
```

esm.sh provides a small browser helper that compiles inline `text/babel`, `text/jsx`, `text/ts`, and `text/tsx` scripts without a local build step. `esm.unpkg.com` should provide an equivalent after the package import service is stable.

Required behavior:

- Load as a module script from `https://esm.unpkg.com/tsx` or `https://esm.unpkg.com/run`.
- Discover inline script tags with supported TypeScript and JSX MIME types.
- Transform source through the same build service used for npm package transforms.
- Respect import maps, including JSX runtime configuration.
- Cache compiled source by content hash at the edge.
- Avoid blocking the core package import launch if this feature is not ready, but track it as part of esm.sh compatibility rather than a permanent exclusion.

## Package Resolution

Package resolution starts with npm metadata and existing UNPKG file access.

Root entry resolution order:

1. package `exports` using the active condition set;
2. package `module`;
3. package `main`;
4. `/index.js`;
5. diagnostic `404`.

Subpath resolution order:

1. package `exports` subpath using the active condition set;
2. direct file path when package exports do not block direct file access;
3. extension probing only where existing UNPKG behavior already supports it;
4. diagnostic `404`.

The existing `unpkg` package field should continue to serve the current `unpkg.com` use case. For `esm.unpkg.com`, the resolver should prefer ESM-oriented conditions and fields over the `unpkg` field unless a package explicitly adds a future `esm.unpkg` field.

## Node Builtins and Browser Compatibility

Many npm packages reference Node builtins. The service must define behavior for:

- `node:process`
- `process`
- `node:buffer`
- `buffer`
- `node:events`
- `node:util`
- `node:path`
- `node:url`
- `node:stream`
- hard Node-only modules such as `fs`, `net`, `tls`, `child_process`

Required behavior:

- Provide browser-compatible polyfills or shims for common modules such as `process`, `buffer`, `events`, `util`, `path`, and `url`.
- Return clear diagnostics for hard Node-only modules that cannot run in browsers unless the package guards them behind inactive conditions.
- Include builtin polyfill decisions in build metadata.
- For `?target=deno`, `?target=denonext`, and `?target=node`, prefer runtime-native builtins and conditions over browser shims where that matches esm.sh behavior.

The implementation should evaluate `unenv` or an equivalent maintained compatibility layer before hand-rolling Node builtin polyfills.

## Import Map Support

The service must work well with browser import maps.

Externalized dependencies remain bare specifiers:

```html
<script type="importmap">
{
  "imports": {
    "react": "https://esm.unpkg.com/react@18.3.1",
    "react-dom/": "https://esm.unpkg.com/react-dom@18.3.1/"
  }
}
</script>
```

When query parameters are needed on a trailing-slash import-map entry, the service should support an import-map-friendly form equivalent to esm.sh's `&flag/` pattern:

```txt
https://esm.unpkg.com/react-dom@18.3.1&dev/
```

This should be normalized internally to the same cache key as:

```txt
https://esm.unpkg.com/react-dom@18.3.1/?dev
```

## Error Responses

Errors must be deterministic, JSON by default for API-like requests, and readable in browsers.

Required status codes:

- `400` invalid query, incompatible options, unsupported target, invalid semver, invalid alias/deps syntax;
- `404` package, version, subpath, or declaration file not found;
- `415` unsupported source type, such as unsupported `.vue` or `.svelte` when not enabled;
- `422` package found but cannot be transformed for the requested mode;
- `500` unexpected server failure;
- `503` build queued or timed out with retry guidance.

Deterministic build failures should be cached for a short TTL to avoid repeated expensive rebuild attempts. Expensive builds should run synchronously up to a short timeout; if the timeout is exceeded, the build should continue in the background and return `503` with retry guidance. Duplicate concurrent requests for the same build cache key should share one queued build.

Error shape:

```json
{
  "error": {
    "code": "UNSUPPORTED_NODE_BUILTIN",
    "message": "Package foo imports node:fs, which is not available in browser builds.",
    "package": "foo",
    "version": "1.2.3",
    "subpath": "."
  }
}
```

## Architecture

The implementation should preserve a clear boundary between edge request handling and heavier build work. Heavy bundling should run on the `unpkg-files` origin or a sibling Bun service, not inside Cloudflare Workers.

Recommended components:

- `packages/unpkg-esm`: route `esm.unpkg.com` traffic at the Cloudflare Worker layer, normalize URLs, parse query parameters, handle redirects, serve cached artifacts, and call the build service on misses.
- `packages/unpkg-www`: continue to serve the main `unpkg.com` website and file CDN surface.
- `packages/unpkg-worker`: share package parsing, npm metadata lookup, package export resolution, import rewriting, cache helpers, and diagnostics.
- `packages/unpkg-files`: continue to provide npm package tarball/file access and add origin build endpoints for CPU-heavy transforms.
- New build service module or package inside or next to `unpkg-files`: encapsulate bundler integration, dependency graph construction, transform options, source maps, declaration metadata, and artifact generation.

Bundler choice:

- Try Bun's built-in bundler first because `unpkg-files` runs on Bun.
- Keep the build-service abstraction bundler-agnostic.
- Fall back to esbuild running on Bun when Bun's bundler cannot provide the resolver hooks, transform behavior, source maps, or esm.sh compatibility required by this spec.

Artifact storage:

- Persist build artifacts at the origin rather than relying only on Cloudflare cache.
- Use filesystem or volume storage if `unpkg-files` has durable storage available.
- Otherwise use object storage such as R2 keyed by the normalized build cache key.
- Cloudflare should cache artifact responses at the edge, but an edge cache miss should fetch a persisted artifact before rebuilding.

## Build Cache Key

The build cache key must include:

- package name;
- resolved package version;
- resolved subpath;
- target;
- environment mode;
- minification;
- source map mode;
- bundling mode;
- dependency overrides and their resolved versions;
- aliases;
- externals;
- export conditions;
- selected exports;
- JSX mode and import source;
- worker mode;
- transformer version;
- UNPKG ESM service version.

The key must not include raw semver ranges after resolution except in metadata fields. Build artifacts are keyed by concrete versions and normalized options.

## Security and Limits

- Do not execute package code during builds.
- Enforce build timeouts and memory limits.
- Enforce maximum output size and maximum module graph size.
- Enforce a build queue with per-key de-duplication and global concurrency limits.
- Prevent SSRF by only fetching package contents and metadata through approved npm/UNPKG services.
- Sanitize source map paths.
- Source maps should reference public package URLs or stable virtual package paths, never origin filesystem paths.
- Avoid leaking internal build-service URLs in public artifacts.
- Rate limit repeated failed builds and oversized packages.

## Observability

Track:

- request count by package, version, subpath, and option set;
- cache hit/miss at edge and build artifact layers;
- build duration and queue time;
- build failures by diagnostic code;
- top unsupported Node builtins;
- top unsupported source types;
- artifact size before and after minification;
- request count savings for bundled output versus unbundled output.

## Documentation Requirements

Public docs must include:

- URL format and package subpath examples;
- all query parameters and conflicts;
- import map examples;
- React and Preact examples with `?deps` and `?alias`;
- development versus production examples;
- standalone bundle examples;
- TypeScript declaration behavior;
- `?meta` examples with integrity;
- limitations, including no non-npm registries and no CSS support in the initial release;
- an esm.sh compatibility table that separates supported, deferred, and intentionally unsupported features.

## Test Plan

### Unit Tests

- URL parser and query normalization.
- npm package specifier parsing, including scoped packages and subpaths.
- package `exports` and condition resolution.
- dependency override and alias parsing.
- externalization matching.
- build cache key normalization.
- error response generation.

### Integration Tests

Validate browser-compatible output for representative packages:

- `react`
- `react-dom/client`
- `preact`
- `htm`
- `lit`
- `lodash-es`
- `lodash`
- `d3`
- `date-fns`
- `nanoid`
- `zustand`
- `swr` with `?deps=react@18.3.1`
- a React package aliased to Preact with `?alias=react:preact/compat`
- a TypeScript package source
- a TSX package source
- a package with conditional exports
- a package with Node builtin references
- a package requiring `?external`
- a package using `peerDependencies`

### Browser Tests

Use real browser tests to verify:

- direct module imports execute;
- import maps resolve externalized dependencies;
- worker mode creates and starts a module worker;
- source maps are discoverable;
- type declaration headers are present or absent with `?no-dts`;
- bundled D3-style output materially reduces request count versus unbundled UNPKG `?module`.

### Compatibility Suite

Run a recurring suite over the top 100 npm packages by download count. The public beta target is at least 80% successful transform/build coverage, with failures classified by diagnostic code. The final launch threshold should be agreed after the beta produces real package data.

Record:

- build success/failure;
- browser execution smoke result where practical;
- output size;
- number of generated module requests;
- unsupported feature diagnostics.

## Implementation Plan

The implementation should be built in vertical slices. Each phase should ship tests and a small set of real package fixtures before the next layer is added.

### Phase 1: Routing, URL Semantics, and Metadata

Primary files and modules:

- Add a dedicated `packages/unpkg-esm` Worker with production and staging routes for `esm.unpkg.com` and `esm.unpkg.dev`.
- Add shared URL parsing and query normalization helpers in `packages/unpkg-worker`.
- Reuse existing npm metadata and file helpers from `packages/unpkg-worker`.

Tasks:

1. Parse npm package names, scoped package names, semver ranges, dist-tags, and subpaths from `esm.unpkg.com` URLs.
2. Normalize esm.sh-compatible query syntax, including import-map-friendly `&flag/` trailing-slash URLs.
3. Resolve ranges and dist-tags to concrete npm versions.
4. Implement redirects from friendly URLs to versioned artifact URLs.
5. Implement `?meta` with package name, resolved version, subpath, target, export subpaths when known, declaration path when known, and placeholder artifact URLs.
6. Add JSON diagnostics for invalid package specs, invalid query combinations, missing packages, and missing versions.

Exit criteria:

- `https://esm.unpkg.com/react`, `https://esm.unpkg.com/react@18`, and `https://esm.unpkg.com/react-dom@18/client?meta` resolve deterministically.
- Unit tests cover scoped packages, subpaths, query normalization, and error shape.

### Phase 2: Build Service Skeleton

Primary files and modules:

- Create a build-service module or package dedicated to ESM artifact generation inside or next to `packages/unpkg-files`.
- Add origin build endpoints to `packages/unpkg-files`.
- Keep the build-service API independent of Cloudflare Worker APIs so the edge worker only sees cacheable artifact and metadata responses.

Build service API:

```ts
interface BuildRequest {
  packageName: string;
  version: string;
  subpath: string;
  options: NormalizedBuildOptions;
}

interface BuildResult {
  code: string;
  map?: string;
  headers: Record<string, string>;
  metadata: BuildMetadata;
  diagnostics: BuildDiagnostic[];
}
```

Tasks:

1. Fetch package files through existing UNPKG file services rather than arbitrary network access.
2. Create a deterministic build cache key from the normalized request.
3. Build a simple JavaScript ESM response for packages that already publish browser-compatible ESM.
4. Rewrite bare dependency imports to `esm.unpkg.com` URLs.
5. Persist build artifacts at origin and serve them with bounded, revalidatable cache headers.
6. Start with Bun's built-in bundler where it can satisfy the required resolver hooks, while preserving a clean esbuild fallback path.

Exit criteria:

- ESM packages such as `lodash-es`, `nanoid`, and `date-fns` import successfully in a browser.
- Build cache keys are stable across equivalent URLs.

### Phase 3: Resolver and esm.sh Dependency Controls

Primary files and modules:

- Extend `packages/unpkg-worker/src/lib/pkg-exports.ts` or adjacent resolver modules.
- Add dependency graph utilities in the build service.

Tasks:

1. Implement the browser condition order and `?conditions`.
2. Implement `?deps` with concrete version resolution and transitive application.
3. Implement `?alias` before dependency resolution.
4. Implement `?external` and `?external=*`, preserving bare specifiers for import maps.
5. Add peer dependency awareness so common framework packages do not duplicate React/Preact.
6. Compare behavior against esm.sh for representative URLs and encode divergences as tests or documented limitations.

Exit criteria:

- `swr?deps=react@18.3.1` uses the requested React version.
- `?alias=react:preact/compat&deps=preact@10.25.4` produces Preact-compatible imports.
- `?external=react` leaves React imports bare.

### Phase 4: Transform Pipeline

Recommended transformer:

- Prefer Bun's built-in bundler if it can provide the required behavior.
- Use esbuild on Bun for JavaScript, CommonJS, TypeScript, JSX, TSX, target lowering, minification, source maps, selected exports where Bun cannot meet the compatibility requirements.

Tasks:

1. Add CJS-to-ESM transformation.
2. Add `.ts`, `.tsx`, and `.jsx` transforms.
3. Implement browser `?target`, `?dev`, `?env`, `?min`, and `?sourcemap`.
4. Implement `?keep-names` and `?ignore-annotations`.
5. Implement `?exports` for modules where export selection is safe.
6. Return clear `415` diagnostics for CSS, Vue, Svelte, and other unsupported source formats.
7. Return clear `422` diagnostics for transform failures.

Exit criteria:

- React, React DOM, Preact, htm, lodash, and TypeScript/TSX fixtures load in browser tests.
- Development builds choose development conditions and replace `process.env.NODE_ENV` appropriately.

### Phase 5: Bundling Modes

Tasks:

1. Implement default smart bundling for package-internal modules.
2. Implement `?bundle=false` and `?no-bundle` as no-bundle modes that emit rewritten ESM imports.
3. Implement `?bundle` as explicit dependency bundling where safe.
4. Implement `?standalone` as single-artifact bundling except peer dependencies, externals, and unsupported modules.
5. Track request-count reduction and output size in metadata and observability.

Exit criteria:

- D3-style packages show a large request-count reduction compared with UNPKG `?module`.
- Bundling modes produce deterministic, distinct artifacts.
- Side-effect-sensitive and `import.meta.url`-sensitive packages have compatibility tests or documented limitations.

### Phase 6: Types, Raw Mode, Metadata, and Integrity

Tasks:

1. Implement declaration discovery from `exports[...].types`, `types`, and `typings`.
2. Serve declaration files and emit `X-TypeScript-Types` unless `?no-dts` is present.
3. Implement `?raw` for untransformed package files.
4. Fill out `?meta` with module URL, type URL, dependency versions, peer dependencies, build options, diagnostics, and integrity.
5. Compute SRI-compatible hashes over build artifacts.

Exit criteria:

- Type-aware tools can discover declarations through the response header.
- `?meta` is useful for import-map generation and cache/integrity tooling.
- Raw mode is mutually exclusive with transform options and returns useful diagnostics for conflicts.

### Phase 7: Runtime Targets, Polyfills, and Worker Mode

Tasks:

1. Add browser shims for common Node builtins: `process`, `buffer`, `events`, `util`, `path`, and `url`.
2. Return diagnostics for hard Node-only modules such as `fs`, `net`, `tls`, and `child_process` when active browser code imports them.
3. Include polyfill decisions in build metadata.
4. Evaluate `unenv` or an equivalent maintained compatibility layer.
5. Implement `?worker` with a default export `createWorker(options?)`.
6. Verify module worker behavior in browser tests.

Exit criteria:

- Packages with common Node builtin references work when browser-compatible shims are sufficient.
- Worker mode can instantiate and message a generated module worker.

### Phase 8: Deferred esm.sh Compatibility Items

These items are part of the compatibility roadmap but are not required for the first public package-import release.

Tasks:

1. Implement `?target=deno`, `?target=denonext`, and `?target=node` with runtime-appropriate conditions and builtin handling.
2. Implement `/tsx` and `/run` as esm.sh-compatible helper modules.
3. Compile inline `text/babel`, `text/jsx`, `text/ts`, and `text/tsx` scripts through the build service.
4. Cache compiled source by content hash.
5. Respect import maps and JSX runtime configuration.
6. Add browser tests covering React and Preact inline TSX.
7. Implement Vue and Svelte transforms if they become launch requirements.

Exit criteria:

- Deno and Node targets produce runtime-appropriate output for representative npm packages.
- A no-build HTML page using inline TSX runs with `https://esm.unpkg.com/run`.
- Import-map runtime selection works for React and Preact.

### Phase 9: Compatibility Suite, Beta, and Launch

Tasks:

1. Build an automated esm.sh compatibility runner that tests equivalent npm URLs on `esm.sh` and `esm.unpkg.com`.
2. Run the top-100 npm compatibility suite and classify failures by diagnostic code.
3. Add public documentation with an esm.sh compatibility table.
4. Launch behind a beta hostname or feature flag.
5. Monitor build failures, cache misses, queue time, artifact size, and popular unsupported features.
6. Promote `esm.unpkg.com` DNS only after compatibility, reliability, and performance thresholds are met.

Exit criteria:

- The top-100 compatibility threshold is agreed and met.
- All intentional gaps are documented.
- Rollback is possible by disabling the `esm.unpkg.com` route without affecting `unpkg.com`.

Implementation notes:

- The representative runner lives at `scripts/esm-compat-suite.ts` and is exposed as `pnpm test:esm-compat`.
- The public compatibility matrix and beta launch checklist live in `docs/esm-unpkg-compatibility.md`.
- The runner defaults to `https://esm.unpkg.com` and can be pointed at beta/staging with `ESM_UNPKG_ORIGIN`.

## Acceptance Criteria

- `https://esm.unpkg.com/react@18.3.1` returns valid browser ESM with correct headers.
- `https://esm.unpkg.com/react-dom@18.3.1/client` resolves the subpath correctly.
- `?deps`, `?alias`, `?external`, `?bundle=false`, `?no-bundle`, and `?standalone` produce distinct, deterministic artifacts.
- `?dev` and `?env=production` select the correct package conditions and `NODE_ENV` replacement.
- TypeScript and TSX package sources transform successfully.
- `?meta` returns resolved version, artifact URL, types URL when available, exports, dependencies, and integrity.
- Import-map workflows work for external dependencies.
- Browser tests show a large request-count reduction for a D3-style bundled package.
- The top-100 npm compatibility suite passes at an agreed threshold, with failures classified by diagnostic code.
