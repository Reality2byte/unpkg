# `esm.unpkg.com` Ecosystem Compatibility Plan

This document describes the work needed to move `esm.unpkg.com` from a promising first implementation to ecosystem-scale compatibility with esm.sh for npm packages.

The target is not byte-for-byte output parity. The target is behavioral compatibility: npm package URLs that work on esm.sh should work on `esm.unpkg.com` with equivalent browser/runtime behavior, equivalent query semantics, useful metadata, and clear diagnostics for intentional exclusions. Non-npm registries and CSS transforms remain outside the current scope.

## Compatibility Definition

We should only call the service esm.sh-compatible at ecosystem scale when all of these are true:

- Representative npm package corpora build successfully at agreed thresholds.
- Generated browser modules execute in real browsers for packages where execution is meaningful to test.
- Query options match esm.sh behavior for the supported scope: `target`, `dev`, `env`, `deps`, `alias`, `external`, `bundle=false`, `no-bundle`, `standalone`, `raw`, `conditions`, `keep-names`, `ignore-annotations`, `no-dts`, `meta`, `worker`, `/run`, and `/tsx`.
- Failures are classified into actionable buckets, such as resolver mismatch, CJS interop, unsupported Node API, unsupported asset, transform failure, runtime failure, timeout, or intentional exclusion.
- Compatibility status is visible in docs and in machine-readable test output.
- Beta observability shows stable latency, cache behavior, artifact size, and failure rates under real traffic.

## Phase 1: Strengthen the Compatibility Harness

The current `pnpm test:esm-compat` runner is a useful seed, but it is not enough to measure ecosystem behavior. First, turn it into a durable comparison tool.

Build out the runner so every case records the requested URL, normalized final URL, status code, content type, response headers that affect browser loading, diagnostic code, output size, redirect chain, build duration when available, and whether the response looks like an executable module. Store results as JSON so regressions can be compared over time.

Add corpus support instead of hard-coded cases. The runner should accept a file of package scenarios, run them against both esm.sh and `esm.unpkg.com`, and produce a summary grouped by feature, package family, and failure class.

Add a local/staging mode that can run against a beta hostname or a locally running Worker plus `unpkg-files` origin. The same corpus should be runnable before deploy, in CI, and against production.

Exit criteria:

- The runner can execute a checked-in corpus file and emit stable JSON.
- Each failure has a normalized diagnostic category.
- Results can be diffed between two commits or two origins.
- The representative seed suite still passes.

## Phase 2: Build the Package Corpus

Compatibility confidence depends on the package mix. A top-100 list is necessary, but not sufficient; popular packages skew toward packages that may already publish browser-friendly ESM. We need a corpus that includes the rough edges esm.sh has learned to handle.

Create a version-pinned corpus with these groups:

- Top npm packages by downloads.
- Framework packages: React, React DOM, Preact, Vue runtime packages, Solid, Svelte runtime packages, Lit, htm, and related JSX runtimes.
- Common CJS packages: lodash, debug, ms, qs, uuid, chalk-era packages, date libraries, and packages with mixed CJS/ESM publishing.
- Conditional exports packages with browser, development, production, import, require, default, node, deno, and custom conditions.
- Peer-dependency-heavy packages such as SWR, Zustand, TanStack packages, React Router, and packages with React peer alignment needs.
- Node builtin packages that should work in browsers with shims, plus packages that should fail cleanly because they require hard Node-only APIs.
- TypeScript/JSX/TSX source packages.
- Large graph packages such as D3-style module families where bundling behavior and request count matter.
- Known esm.sh compatibility examples from docs, issues, and user-reported cases.

Each corpus entry should specify the expected mode: browser module should load, metadata should match shape, import-map workflow should keep externals bare, runtime target should preserve builtins, or diagnostic should be returned.

Exit criteria:

- A checked-in corpus covers at least 100 packages and at least 250 URL scenarios.
- The corpus includes every supported query option and every known intentional exclusion.
- Every scenario has an owner category and expected outcome.

## Phase 3: Browser Execution Testing

HTTP response comparison catches only the first layer. Ecosystem compatibility requires executing generated modules in real browsers.

Add Playwright-based smoke tests that import generated modules in Chromium. The tests should verify that module evaluation completes, expected exports exist, import maps work for externalized dependencies, worker wrappers can instantiate a module worker, and `/run` can execute inline TSX for React and Preact examples.

For packages with obvious runtime APIs, add small assertions rather than only checking that import succeeds. Examples: render a React root, create a Preact vnode, call a lodash function, format a date, instantiate a nanoid, import a D3 submodule, and exercise a package that depends on a browser-shimmed Node builtin.

Track request count, total transferred bytes, and evaluation time for bundled versus unbundled variants. This is especially important for large package graphs where esm.sh users expect a practical browser experience, not only a syntactically valid module.

Exit criteria:

- Browser smoke tests cover package imports, import maps, worker mode, metadata-driven imports, and inline TSX.
- Runtime failures are categorized separately from build failures.
- Request-count and size metrics are captured for large graph scenarios.

## Phase 4: Resolver and Condition Parity

Resolver mismatch is one of the highest-risk compatibility gaps. esm.sh has many real-world behaviors around package exports, browser fields, conditions, peer dependencies, and subpaths.

Audit resolver behavior against esm.sh across the corpus. Pay special attention to condition priority for browser builds, development versus production, `?conditions`, package `browser` field objects, packages with both `module` and `exports`, custom subpaths, extensionless files, and package roots that resolve differently under import versus browser conditions.

Add targeted resolver tests for every mismatch that is not an intentional divergence. Keep a separate documented list of divergences where UNPKG intentionally preserves different semantics.

Exit criteria:

- Resolver mismatches are reduced to documented intentional differences or tracked implementation issues.
- Package roots and subpaths in the corpus resolve to equivalent browser-compatible entries.
- Development and production condition behavior matches esm.sh for supported scenarios.

## Phase 5: CJS Interop and Transform Semantics

CJS compatibility is likely the largest implementation gap. Many npm packages still ship CJS, mixed modules, dynamic require patterns, or exports that need careful default/named interop.

Compare generated output and runtime behavior for CJS-heavy corpus entries. Add support for common patterns: default export synthesis, named export detection, `module.exports` assignment forms, `exports.foo`, `require()` of package-internal modules, JSON requires, and guarded or unreachable Node-only branches that can be eliminated.

Dynamic require should not become a black hole. When it cannot be transformed safely, return a diagnostic that explains the unresolved require and points to `?external`, `?target=node`, or another available workaround when one exists.

Exit criteria:

- Common CJS packages in the corpus import and execute in the browser.
- CJS named/default export behavior matches esm.sh for supported scenarios.
- Dynamic require failures are classified and actionable.

## Phase 6: Bundling and Dependency Graph Parity

The current implementation bundles package-internal imports and rewrites external dependencies. Ecosystem-scale compatibility needs stronger behavior around `?bundle`, `?standalone`, peer dependencies, externals, and graph-wide version alignment.

Implement dependency graph planning before transformation. The planner should decide which modules are package-internal, which dependencies are bundled, which peer dependencies remain external, which aliases apply transitively, and which dependency versions are forced by `?deps`.

Define exact behavior for `?bundle` and `?standalone` relative to esm.sh. In particular, decide how peer dependencies, hard externals, Node builtins, wasm/assets, and unsupported dynamic imports are represented in standalone artifacts.

Exit criteria:

- `?bundle`, `?standalone`, `?no-bundle`, and `?external` produce distinct, documented, deterministic graph shapes.
- Peer dependency alignment works for React/Preact and other peer-heavy corpus entries.
- Large graph packages show meaningful request-count reduction without hiding runtime breakage.

## Phase 7: Runtime Targets and Builtin Compatibility

Browser builds, Node-target builds, and Deno-target builds should not share exactly the same assumptions. The service should model runtime targets explicitly.

For browser targets, expand builtin handling using a maintained compatibility layer where possible. Continue to return diagnostics for hard Node-only APIs when they are active in browser code. For `target=node`, preserve Node builtins and prefer Node-appropriate conditions. For `target=deno` and `target=denonext`, preserve runtime-native imports and prefer Deno-compatible conditions where packages expose them.

Add corpus entries that verify builtins are shimmed, preserved, or rejected according to target.

Exit criteria:

- Builtin behavior is target-aware and covered by tests.
- Runtime target condition selection matches esm.sh behavior for representative packages.
- Browser polyfill choices are documented and observable in metadata.

## Phase 8: Metadata, Types, and Tooling Details

Metadata and type behavior matter for import-map generation, editor support, and cache correctness.

Expand `?meta` parity checks to compare shape, resolved module URL, dependency metadata, peer dependencies, export subpaths, declaration URL, build options, diagnostics, and integrity. Improve declaration discovery through `exports` condition trees, `types`, `typings`, `typesVersions`, and package subpath declarations.

Add tests for `?no-dts`, declaration headers, raw declaration files, and declaration behavior for aliased or externalized dependencies.

Exit criteria:

- Metadata shape is stable and documented.
- Type headers and declaration URLs are correct for common package layouts.
- Integrity is computed for build artifacts and is usable by clients.

## Phase 9: Performance, Cache, and Reliability Beta

Compatibility is not only correctness. esm.sh is useful because it can serve generated modules reliably and quickly.

Deploy behind a beta hostname and collect metrics for build latency, cache hit rate, origin error rate, artifact size, memory usage, timeout rate, unsupported feature rate, and top failure categories. Separate cold builds from cache hits. Track packages that repeatedly fail so they can feed back into the corpus.

Add guardrails: build timeouts, artifact size limits, concurrency controls, cache key versioning, and rollback controls that can disable `esm.unpkg.com` without affecting `unpkg.com`.

Exit criteria:

- Beta traffic shows acceptable latency and error rates.
- Top failure classes are known, quantified, and either fixed or documented.
- Rollback and cache invalidation procedures have been tested.

## Phase 10: Launch Readiness and Compatibility Claim

Only make an ecosystem-scale compatibility claim after the corpus, browser execution tests, and beta metrics agree.

Suggested launch gates:

- At least 95% build success across the supported top-package corpus, excluding documented intentional exclusions.
- At least 90% browser execution success for scenarios where runtime execution is meaningful.
- 100% clear diagnostics for intentional exclusions and unsupported source types.
- No unresolved P0/P1 resolver, CJS interop, metadata integrity, or cache correctness issues.
- Public compatibility docs list supported features, known limitations, and migration examples from esm.sh URLs to `esm.unpkg.com` URLs.

The final decision should be based on observed data, not the existence of implementation code. If the numbers are close but not there, launch as beta with an honest compatibility label and keep the corpus running until the remaining failures are understood.

## Ongoing Work After Launch

Keep the compatibility corpus alive as a regression suite. Add every reported incompatibility before fixing it. Periodically refresh package versions, but keep a pinned historical corpus so old failures do not disappear accidentally when packages change.

The most important habit is classification. Every incompatibility should become one of: fixed, intentionally unsupported, waiting on a broader product decision, or tracked as a known limitation with a suggested workaround. That is how `esm.unpkg.com` can steadily converge on esm.sh-scale compatibility without pretending the ecosystem is simpler than it is.
