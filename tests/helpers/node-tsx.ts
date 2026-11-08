import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Args for running a TypeScript fixture with the current Node executable. */
export function nodeTsxArgs(entrypoint: string, tsxLoader = require.resolve("tsx"), ...args: string[]): string[] {
  return ["--import", tsxLoader, entrypoint, ...args];
}
