/**
 * The `smithers` help output, parsed.
 *
 * The CLI is the authority for what the binary offers. The page generator
 * renders these records and `check-docs.mjs` re-reads them, so a command that
 * appears, disappears, or changes its summary shows up as documentation drift
 * instead of as a stale page nobody noticed.
 */
import { execFile, spawnSync } from "node:child_process"
import { join } from "node:path"
import { repoRoot } from "./docs-contract.mjs"

/** The working-tree CLI entry point. Never a published copy. */
export const cliEntry = join(repoRoot, "packages", "cli", "bin", "smithers.mjs")

/** Reads one indented block out of `--help` output. */
export const helpBlock = (text, heading) => {
  const lines = text.split("\n")
  const start = lines.indexOf(heading)
  if (start < 0) return []
  const block = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") {
      if (block.length > 0) break
      continue
    }
    if (!line.startsWith(" ")) break
    block.push(line.trim())
  }
  return block
}

/**
 * Splits an entry of a help block into its signature and its description.
 *
 * Help columns are separated by two or more spaces, so `--status string` keeps
 * its type in the signature while `--help, -h` keeps its short form.
 */
export const helpEntry = (line) => {
  const [signature, ...rest] = line.split(/\s{2,}/)
  if (signature === undefined || signature === "") return undefined
  return { signature: signature.trim(), name: signature.trim().split(/[\s,]+/)[0], description: rest.join(" ").trim() }
}

/**
 * Parses `smithers --help` or `smithers <command> --help`.
 *
 * `GLOBAL FLAGS` is dropped: it is the same block on every command and belongs
 * on the CLI overview page once, not on every command page.
 */
export const parseHelp = (text) => ({
  description: helpBlock(text, "DESCRIPTION").join(" "),
  usage: helpBlock(text, "USAGE"),
  flags: helpBlock(text, "FLAGS").map(helpEntry).filter((entry) => entry !== undefined),
  globalFlags: helpBlock(text, "GLOBAL FLAGS").map(helpEntry).filter((entry) => entry !== undefined),
  subcommands: helpBlock(text, "SUBCOMMANDS").map(helpEntry).filter((entry) => entry !== undefined)
})

/** Runs the working-tree CLI and returns its combined output. */
export const runHelp = (args, entry = cliEntry) => {
  const result = spawnSync(process.execPath, [entry, ...args, "--help"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" }
  })
  if (result.error !== undefined) throw result.error
  return `${result.stdout ?? ""}${result.stderr ?? ""}`
}

/**
 * Runs the working-tree CLI once and reports its output and whether it exited.
 *
 * Every spawn is bounded. A verb the removal table lists can also be bound as
 * a live command that starts a server, and then it never returns: without a
 * bound the proof stops being a test and becomes a hang, which reads as a slow
 * CI job rather than as the contradiction it is. `exited: false` is that
 * contradiction, and the caller reports it as an offender.
 *
 * @param {ReadonlyArray<string>} args the argument vector after the entry point
 * @param {{ entry?: string, timeoutMs?: number }} [options] entry point and bound
 * @returns {Promise<{ text: string, exited: boolean }>} combined output, and whether the child ended on its own
 */
export const runCli = (args, options = {}) => {
  const entry = options.entry ?? cliEntry
  const timeout = options.timeoutMs ?? 15000
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [entry, ...args],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
        timeout,
        killSignal: "SIGKILL"
      },
      (error, stdout, stderr) => {
        resolve({ text: `${stdout ?? ""}${stderr ?? ""}`.trim(), exited: error === null || error.killed !== true })
      }
    )
  })
}

/** The command tree the binary currently offers, keyed by command name. */
export const cliCatalog = (entry = cliEntry) => {
  const root = parseHelp(runHelp([], entry))
  const commands = new Map()
  for (const subcommand of root.subcommands) {
    commands.set(subcommand.name, { ...subcommand, help: parseHelp(runHelp([subcommand.name], entry)) })
  }
  return { root, commands }
}
