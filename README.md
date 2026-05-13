## UNPKG

Welcome to UNPKG!

UNPKG is a fast, global content delivery network for everything on npm. Use it to quickly and easily load any file from [npm](https://npmjs.com) using a URL like:

```
https://unpkg.com/:package@:version/:file
```

Where `:package` is the package name, `:version` is the version range, and `:file` is the path to the file in the package.

You can [learn more about UNPKG on the website](https://unpkg.com).

## Development

This repository contains the production source for UNPKG. There are 5 packages:

- [`unpkg-www`](./packages/unpkg-www/) is the main UNPKG website and package file CDN worker
- [`unpkg-app`](./packages/unpkg-app/) is the package browser app worker
- [`unpkg-esm`](./packages/unpkg-esm/) is the `esm.unpkg.com` package import worker for browser-ready ESM, CSS modules, import maps, and inline TS/TSX transforms
- [`unpkg-files`](./packages/unpkg-files/) is the Bun file server backend that fetches npm tarballs, extracts files, and builds ESM artifacts for the workers
- [`unpkg-worker`](./packages/unpkg-worker/) is the shared TypeScript library used by the workers and the files backend

We use [pnpm](https://pnpm.io/) for workspace tooling and [Bun](https://bun.sh/) for the runtime and tests. Install these first.

Next, install all dependencies and run the tests:

```sh
pnpm install
pnpm test
```

Then start the file server and each worker, plus the asset servers for the two HTML apps:

```sh
pnpm --filter unpkg-files dev
pnpm --filter unpkg-www dev
pnpm --filter unpkg-www dev:assets
pnpm --filter unpkg-app dev
pnpm --filter unpkg-app dev:assets
pnpm --filter unpkg-esm dev
```

The local services listen on these ports:

- `unpkg-www`: `http://localhost:3000`
- `unpkg-app`: `http://localhost:3001`
- `unpkg-esm`: `http://localhost:3002`
- `unpkg-files`: `http://localhost:4000`

## Deploying

The `unpkg-files` backend is deployed on [Fly.io](https://fly.io). You'll need an account.

Next, adjust the Fly config in `packages/unpkg-files/fly.json` (you'll need your own app `name`) and deploy:

```sh
pnpm --filter unpkg-files run deploy
```

To deploy the workers, you'll need a [Cloudflare](https://cloudflare.com) account. You will also need to (1) edit the `wrangler.json` file in each worker and update its [`routes`](https://developers.cloudflare.com/workers/wrangler/configuration/) to your own domain(s) and (2) adjust each worker's environment `vars` (in `wrangler.json`) so they can find one another in production.

Once you've done that, you can deploy each worker with:

```sh
pnpm --filter unpkg-www run deploy
pnpm --filter unpkg-app run deploy
pnpm --filter unpkg-esm run deploy
```

## License

Please see [LICENSE](./LICENSE) for more information.
