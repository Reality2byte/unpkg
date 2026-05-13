## Project Context

This repository powers UNPKG, a CDN and web app for serving npm package files directly from package tarballs. It includes Cloudflare Workers for public request handling, a Bun origin service for package file access and transformations, and shared tooling for compatibility and release work.

## Repository Structure

- This is a pnpm workspace. Root scripts fan out to the packages under `packages/*`.
- `packages/unpkg-www` is the main `unpkg.com` Cloudflare Worker, including the `esm.unpkg.com` routing layer.
- `packages/unpkg-app` is the app/browse Cloudflare Worker.
- `packages/unpkg-files` is the Bun-based origin file server. Package file reads, tarball handling, and ESM build/transform work live here.
- `packages/unpkg-worker` contains shared Cloudflare Worker utilities used by the worker packages.
- `scripts` contains repo-level maintenance and compatibility runners, including the ESM compatibility, browser smoke, readiness, and corpus generation tools.
- `docs` contains product and implementation specs for larger efforts.

## Runtime And Tooling

- Node.js is used for tooling. The repo requires Node `>=23`.
- Bun is used for runtime and tests. The `unpkg-files` server runs on Bun, and package tests use `bun test`.
- Use pnpm for workspace commands and dependency management.
- Do not assume Node and Bun are interchangeable here: prefer the command already declared in `package.json` scripts.

## Common Commands

- Install dependencies with `pnpm install`.
- Build everything with `pnpm run build`.
- Run the full repo test suite with `pnpm test`. This runs a build first via `pretest`.
- Run package-specific commands with `pnpm --filter <package> <script>`, for example `pnpm --filter unpkg-files test`.
- Start local development servers with the package `dev` scripts:
  - `pnpm --filter unpkg-www dev` for the main Worker on port 3000.
  - `pnpm --filter unpkg-app dev` for the app Worker on port 3001.
  - `pnpm --filter unpkg-files dev` for the Bun file server on port 4000.

## ESM Compatibility Tools

- Run the seed compatibility suite with `pnpm test:esm-compat`.
- Run a corpus with `pnpm test:esm-compat -- --corpus scripts/esm-compat-corpus.ecosystem.json`.
- Use `--dry-run` to validate and print corpus cases without network requests.
- For live runs, set `ESM_UNPKG_ORIGIN` to the local, staging, or beta origin you intend to test. The default is `https://esm.unpkg.com`.
- The compatibility runner limits live checks with `--concurrency` and `--timeout-ms`, and aborts early when the first batch cannot connect to an origin.
