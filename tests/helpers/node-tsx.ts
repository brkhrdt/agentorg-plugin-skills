import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const loader = require.resolve("tsx");

/** Args for running a TypeScript fixture with the current Node executable. */
export function nodeTsxArgs(entrypoint: string, ...args: string[]): string[] {
  return ["--import", loader, entrypoint, ...args];
}
