# `esm.unpkg.com` esm.sh Compatibility

This document tracks npm-package compatibility with `esm.sh`. Package registries other than npm are intentionally out of scope for the current effort.

## Compatibility Runner

Run the representative compatibility suite with:

```sh
pnpm test:esm-compat
```

By default the runner compares `https://esm.sh` with `https://esm.unpkg.com`. For repeatable corpus runs, prefer the pinned local esm.sh Docker baseline instead of production `https://esm.sh`:

```sh
pnpm vendor:esm-sh
pnpm test:esm-compat:local-baseline -- --corpus scripts/esm-compat-corpus.ecosystem.json
```

`pnpm vendor:esm-sh` runs `ghcr.io/esm-dev/esm.sh:v137_3` pinned by digest on `http://localhost:8081`. It stores generated baseline artifacts under `.reports/esm-sh-baseline`, which can be cleared with `pnpm clean:reports`.

For beta or local `esm.unpkg.com` validation, override origins:

```sh
ESM_UNPKG_ORIGIN=https://esm-beta.unpkg.com pnpm test:esm-compat
ESM_SH_ORIGIN=http://localhost:8081 ESM_UNPKG_ORIGIN=http://localhost:3002 pnpm test:esm-compat
```

Useful options:

- `--corpus <path>` runs a checked-in or generated corpus file instead of the built-in seed cases.
- `--dry-run` prints the cases without making network requests.
- `--json` emits machine-readable results with response headers, redirect chains, diagnostic categories, content lengths, durations, and grouped summaries for dashboards or CI artifacts.
- `--ndjson` streams newline-delimited JSON: a `start` event, one `result` event per case as it completes, optional `service` recovery events, and a final `summary` event.
- `--concurrency <count>` limits live checks to a small number of cases at a time. The default is `6`.
- `--skip-baseline` skips live `esm.sh` requests and validates only the configured `esm.unpkg.com` origin against each case's expected behavior.
- `--timeout-ms <ms>` limits each live fetch attempt. The default is `15000`.
- `--no-restart-local-services` disables automatic health checks and restarts for localhost origins.

When either origin points at `localhost`, `127.0.0.1`, or `::1`, live runs check local service health before starting. If a local service becomes unreachable during the run, the runner restarts the appropriate default command and retries the failed case once. The managed commands are `pnpm vendor:esm-sh`, `pnpm --filter unpkg-esm dev`, and `pnpm --filter unpkg-files dev`.

The built-in seed suite is also available as `scripts/esm-compat-corpus.seed.json`. It covers package roots, subpaths, CSS stylesheets, CSS modules, `?deps`, `?alias`, `?external` shorthand, no-bundle mode, metadata, worker wrappers, runtime-native targets, and unsupported source diagnostics. The launch gate should expand this list with the agreed top-100 npm package set before `esm.unpkg.com` is promoted from beta.

For the broader path from the current representative suite to ecosystem-scale confidence, see [`esm-unpkg-ecosystem-compatibility-plan.md`](./esm-unpkg-ecosystem-compatibility-plan.md).
For the launch decision checklist, see [`esm-unpkg-launch-readiness.md`](./esm-unpkg-launch-readiness.md).

For browser execution smoke checks, run:

```sh
pnpm test:esm-browser -- --corpus scripts/esm-compat-corpus.seed.json --origin https://esm.sh
```

The browser smoke runner imports selected module scenarios in Chromium and records evaluation success, export names, request count, transferred bytes, and duration. It also runs focused runtime assertions for the most important browser workflows: React rendering through `react-dom/client`, Preact rendering, CommonJS subpath execution, browser-native package APIs, import-map externalization, and constructable CSS stylesheet modules. Use `ESM_BROWSER_ORIGIN` or `--origin` to point it at a beta `esm.unpkg.com` deployment.

To evaluate beta readiness from saved JSON reports:

```sh
bun scripts/esm-compat-suite.ts --json --corpus scripts/esm-compat-corpus.ecosystem.json > compat-report.json
bun scripts/esm-browser-smoke.ts --json --corpus scripts/esm-compat-corpus.seed.json --origin https://esm-beta.unpkg.com > browser-report.json
pnpm test:esm-readiness -- --compat compat-report.json --browser browser-report.json
```

The readiness summary checks compatibility pass rate, browser smoke pass rate, p95 response duration, p95 artifact size, and whether failures are classified by diagnostic or failure category.

## Compatibility Matrix

| Feature | Status | Notes |
| --- | --- | --- |
| npm package roots and subpaths | Supported | Semver ranges and dist-tags redirect to concrete versions. |
| Import-map-friendly `&flag/` syntax | Supported | Normalizes to canonical query parameters. |
| Browser targets `es2015` through `esnext` | Supported | `es2022` is the default target. |
| Runtime targets `deno`, `denonext`, `node` | Supported | Builtins are preserved for runtime-native targets; output lowering maps these to `es2022`. |
| `?dev` and `?env=development` | Supported | Replaces `process.env.NODE_ENV` during transform. |
| `?deps` | Supported | Dependency overrides resolve to exact npm versions. |
| `?alias` | Supported | Aliases apply before dependency version resolution. |
| `?external` and `*pkg` shorthand | Supported | External dependencies stay as bare specifiers. |
| TypeScript, JSX, and TSX package sources | Supported | Transformed by esbuild on the `unpkg-files` origin. |
| Smart package-internal bundling | Supported | Local package imports are bundled by default; `?no-bundle` and `?bundle=false` opt out. |
| `?bundle`, `?standalone`, and minification flags | Supported | Current standalone behavior uses the same internal bundling path and should be expanded as dependency bundling matures. |
| Source maps | Supported | Inline source maps are available with `?sourcemap`. |
| Metadata and integrity | Supported | `?meta` includes resolved version, module URL, exports, declaration URL when available, and SRI-compatible integrity. |
| Raw files | Supported | `?raw` serves files without adding transform defaults. |
| Declaration headers | Supported | Build artifacts expose `X-TypeScript-Types` when declarations are known. |
| Worker wrappers | Supported | `?worker` returns a module-worker factory. |
| `unpkg.com/run` helper | Supported | The main UNPKG domain serves one browser helper that discovers inline `text/babel`, `text/jsx`, `text/ts`, and `text/tsx` scripts and transforms them through the ESM build service. |
| Common browser-compatible Node builtins | Supported | `process`, `buffer`, `events`, `util`, `path`, `url`, and `stream` rewrite to JSPM browser shims for browser targets. |
| Hard Node-only builtins in browser output | Diagnostic | `fs`, `net`, `tls`, and `child_process` return clear build diagnostics for browser targets. |
| Vue and Svelte single-file components | Diagnostic | `.vue` and `.svelte` return `415 Unsupported Media Type` until those transforms become launch requirements. |
| CSS package files and CSS modules | Supported | Direct CSS files are served as `text/css`; `?module` returns a constructable `CSSStyleSheet` module; CSS package roots and subpaths redirect when package metadata identifies a stylesheet entry. |
| Non-npm registries | Excluded | Explicitly out of scope. |

## Beta Launch Checklist

- Run `pnpm test` on every implementation change.
- Run `pnpm test:esm-compat --json` against the beta hostname and archive the result.
- Expand the runner to the agreed top-100 npm package set and classify each failure by diagnostic code or transform stage.
- Monitor build failure rate, cache hit rate, transform latency, artifact size, unsupported-source diagnostics, and Node-builtin diagnostics.
- Keep rollback simple: disable the `esm.unpkg.com` route without changing `unpkg.com` traffic.
- Promote DNS only after the agreed top-100 pass threshold, reliability targets, and rollback plan are signed off.
