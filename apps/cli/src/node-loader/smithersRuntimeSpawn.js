import { fileURLToPath } from "node:url";

/**
 * Command and arguments for re-entering a Smithers CLI entry file in a child
 * process, under whichever runtime is executing right now.
 *
 * Bun runs the entry file directly. Node needs its own executable plus the
 * `--import` hook that installs the TypeScript/JSX module loader, because
 * module hooks do not survive a spawn and the CLI entry, the packages it
 * imports, and user workflow files are all TypeScript or JSX.
 *
 * Spawning the literal string "bun" fails with ENOENT on a machine that has no
 * Bun installed, which is the whole point of supporting Node.
 *
 * @param {string[]} args arguments after the executable, starting with the entry file
 * @returns {{ command: string; args: string[] }}
 */
export function smithersRuntimeSpawn(args) {
  if (typeof Bun !== "undefined") return { command: "bun", args };
  const register = fileURLToPath(new URL("./register.js", import.meta.url));
  return { command: process.execPath, args: ["--import", register, ...args] };
}

/**
 * Re-enter a CLI file while preserving the absolute Bun executable used by
 * call sites that already relied on `process.execPath`. Node still needs the
 * loader hook installed in the child process.
 *
 * @param {string[]} args arguments after the executable, starting with the entry file
 * @returns {{ command: string; args: string[] }}
 */
export function smithersRuntimeReentry(args) {
  if (typeof Bun !== "undefined") return { command: process.execPath, args };
  return smithersRuntimeSpawn(args);
}
