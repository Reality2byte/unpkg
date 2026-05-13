# `esm.unpkg.com` esm.sh Compatibility

This document tracks npm-package compatibility with `esm.sh`. Package registries other than npm and CSS transforms are intentionally out of scope for the current effort.

## Compatibility Runner

Run the representative compatibility suite with:

```sh
pnpm test:esm-compat
```

By default the runner compares `https://esm.sh` with `https://esm.unpkg.com`. For beta or local validation, override origins:

```sh
ESM_UNPKG_ORIGIN=https://esm-beta.unpkg.com pnpm test:esm-compat
```

Useful options:

- `--dry-run` prints the cases without making network requests.
- `--json` emits machine-readable results for dashboards or CI artifacts.

The suite currently covers package roots, subpaths, `?deps`, `?alias`, `?external` shorthand, no-bundle mode, metadata, worker wrappers, runtime-native targets, and unsupported source diagnostics. The launch gate should expand this list with the agreed top-100 npm package set before `esm.unpkg.com` is promoted from beta.

For the broader path from the current representative suite to ecosystem-scale confidence, see [`esm-unpkg-ecosystem-compatibility-plan.md`](./esm-unpkg-ecosystem-compatibility-plan.md).

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
| `/run` and `/tsx` helpers | Supported | Helper modules discover inline `text/babel`, `text/jsx`, `text/ts`, and `text/tsx` scripts and transform them through the build service. |
| Common browser-compatible Node builtins | Supported | `process`, `buffer`, `events`, `util`, `path`, `url`, and `stream` rewrite to JSPM browser shims for browser targets. |
| Hard Node-only builtins in browser output | Diagnostic | `fs`, `net`, `tls`, and `child_process` return clear build diagnostics for browser targets. |
| Vue and Svelte single-file components | Diagnostic | `.vue` and `.svelte` return `415 Unsupported Media Type` until those transforms become launch requirements. |
| CSS transforms | Excluded | Explicitly out of scope for now. |
| Non-npm registries | Excluded | Explicitly out of scope. |

## Beta Launch Checklist

- Run `pnpm test` on every implementation change.
- Run `pnpm test:esm-compat --json` against the beta hostname and archive the result.
- Expand the runner to the agreed top-100 npm package set and classify each failure by diagnostic code or transform stage.
- Monitor build failure rate, cache hit rate, transform latency, artifact size, unsupported-source diagnostics, and Node-builtin diagnostics.
- Keep rollback simple: disable the `esm.unpkg.com` route without changing `unpkg.com` traffic.
- Promote DNS only after the agreed top-100 pass threshold, reliability targets, and rollback plan are signed off.
