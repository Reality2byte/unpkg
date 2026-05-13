# `esm.unpkg.com` Launch Readiness

This checklist is the decision record for moving `esm.unpkg.com` from draft implementation to beta, and from beta to a public esm.sh-compatible claim for npm packages.

The compatibility claim should be based on measured behavior, not on implementation completeness. Non-npm registries remain an intentional exclusion.

## Required Reports

Before changing the PR from draft to ready, attach or link these artifacts:

- Compatibility report from `scripts/esm-compat-corpus.ecosystem.json`.
- Browser smoke report for representative module execution.
- Readiness gate output from `pnpm test:esm-readiness`.
- List of known failures grouped by diagnostic or failure category.
- Rollback note describing how to disable the `esm.unpkg.com` route without affecting `unpkg.com`.

Suggested commands:

```sh
bun scripts/esm-compat-suite.ts --json --corpus scripts/esm-compat-corpus.ecosystem.json > compat-report.json
bun scripts/esm-browser-smoke.ts --json --corpus scripts/esm-compat-corpus.seed.json --origin https://esm-beta.unpkg.com > browser-report.json
pnpm test:esm-readiness -- --compat compat-report.json --browser browser-report.json
```

## Draft to Beta Gate

Beta is acceptable when:

- The representative seed compatibility suite passes.
- The ecosystem corpus can run to completion against the beta hostname.
- All failed scenarios are classified.
- Browser smoke tests pass for React, React DOM, Preact, import-map externalization, worker wrappers, and inline TSX.
- p95 compatibility response duration and artifact size are within the thresholds configured for `pnpm test:esm-readiness`.
- Observability can separate cold builds, cache hits, transform failures, unsupported-source diagnostics, and runtime/browser failures.

## Beta to Public Compatibility Gate

The service can claim ecosystem-scale esm.sh compatibility for the supported npm scope when:

- At least 95% of supported ecosystem corpus scenarios pass, excluding documented intentional exclusions.
- At least 90% of browser execution scenarios pass where runtime execution is meaningful.
- 100% of intentional exclusions and unsupported feature failures return clear diagnostics.
- No unresolved P0/P1 issues remain in resolver behavior, CJS interop, dependency graph controls, metadata integrity, cache correctness, or route rollback.
- The compatibility docs list supported features, diagnostic behavior, intentional exclusions, and migration examples from esm.sh URLs to `esm.unpkg.com` URLs.

## Current PR State

This PR now includes the machinery needed to gather launch evidence:

- A richer compatibility runner with corpus support and JSON output.
- A generated 101-package, 375-scenario ecosystem corpus.
- A Chromium browser smoke runner.
- Resolver, CJS, dependency graph, builtin, and type metadata improvements with targeted tests.
- A readiness gate script that summarizes pass rates, duration, artifact size, and failure classification.

The PR should remain a draft until reports from a real `esm.unpkg.com` beta origin satisfy the draft-to-beta gate.
