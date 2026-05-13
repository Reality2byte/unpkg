import * as path from "node:path";

const __dirname = path.dirname(new URL(import.meta.url).pathname);

export function fixturePath(...filename: string[]): string {
  return path.resolve(__dirname, "fixtures", ...filename);
}

function packageInfoPath(packageName: string): string {
  return fixturePath("package-info", `${packageName}.json`);
}

export const packageInfo = {
  preact: packageInfoPath("preact"),
  react: packageInfoPath("react"),
};

function packageTarballPath(packageName: string): string {
  return fixturePath("package-tarballs", `${packageName}.tgz`);
}

export const packageTarballs = {
  preact: {
    "10.26.4": packageTarballPath("preact-10.26.4"),
  },
  react: {
    "18.2.0": packageTarballPath("react-18.2.0"),
  },
};
