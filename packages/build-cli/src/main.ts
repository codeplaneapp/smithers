#!/usr/bin/env node

/**
 * Runs the smthrs command-line process against the real process.
 *
 * @since 0.1.0
 */

import { main } from "./Entry.ts"
import { terminalOf } from "./Reporter.ts"

await main({
  argv: process.argv.slice(2),
  env: process.env,
  stdout: terminalOf(process.stdout),
  stderr: terminalOf(process.stderr),
  once: (signal, listener) => {
    process.once(signal, listener)
  },
  removeListener: (signal, listener) => {
    process.removeListener(signal, listener)
  },
  setExitCode: (code) => {
    process.exitCode = code
  }
})
