import { handleRequest } from "./lib/request-handler.ts";

let server = Bun.serve({
  fetch: handleRequest,
  idleTimeout: 255,
});

console.log(`Server listening on http://${server.hostname}:${server.port} ...`);
console.log();
