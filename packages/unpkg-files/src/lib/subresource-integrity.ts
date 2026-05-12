import crypto from "node:crypto";

export function getSubresourceIntegrity(buffer: Uint8Array, algorithm = "sha256"): string {
  let hash = crypto.createHash(algorithm).update(buffer).digest("base64");
  return `${algorithm}-${hash}`;
}

export class SubresourceIntegrityHasher {
  private hash: crypto.Hash;
  private algorithm: string;

  constructor(algorithm = "sha256") {
    this.algorithm = algorithm;
    this.hash = crypto.createHash(algorithm);
  }

  update(chunk: Uint8Array): void {
    this.hash.update(chunk);
  }

  digest(): string {
    return `${this.algorithm}-${this.hash.digest("base64")}`;
  }
}
