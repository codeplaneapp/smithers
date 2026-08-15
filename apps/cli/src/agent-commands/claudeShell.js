import { spawnSync } from "node:child_process";
import { listAccounts } from "@smthrs/accounts";
import { accountQuotaBlock, orderAccountsByUsage, readAccountQuotaState } from "@smthrs/usage";

/** @param {string[]} argv */
export function parseClaudeShellArgs(argv) {
  let label;
  let dryRun = false;
  const forwarded = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      forwarded.push(...argv.slice(index + 1));
      break;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--label") {
      label = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--label=")) {
      label = arg.slice("--label=".length);
      continue;
    }
    forwarded.push(arg);
  }
  return { label, dryRun, forwarded };
}

/** @param {string[]} argv */
function forwardedModel(argv) {
  const equals = argv.find((arg) => arg.startsWith("--model="));
  if (equals) return equals.slice("--model=".length);
  const index = argv.indexOf("--model");
  return index >= 0 ? argv[index + 1] : undefined;
}

/**
 * Select the healthiest registered Claude subscription and run Claude Code
 * with its isolated config directory.
 *
 * @param {string[]} argv
 * @param {{ env?: NodeJS.ProcessEnv; accounts?: import("@smthrs/accounts").Account[]; spawn?: typeof spawnSync; stdout?: Pick<NodeJS.WriteStream, "write">; stderr?: Pick<NodeJS.WriteStream, "write"> }} [deps]
 */
export function runClaudeShell(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const parsed = parseClaudeShellArgs(argv);
  const separator = argv.indexOf("--");
  const wrapperArgs = separator === -1 ? argv : argv.slice(0, separator);
  if (wrapperArgs.includes("--help") || wrapperArgs.includes("-h")) {
    stdout.write("Usage: smithers claude-shell [--label LABEL] [--dry-run] [--] [CLAUDE_ARGS...]\n");
    return 0;
  }
  const registered = (deps.accounts ?? listAccounts(env)).filter((account) => account.provider === "claude-code");
  const candidates = parsed.label ? registered.filter((account) => account.label === parsed.label) : registered;
  if (candidates.length === 0) {
    stderr.write(
      parsed.label
        ? `No Claude account with label "${parsed.label}" is registered.\n`
        : "No Claude accounts are registered.\n",
    );
    return 4;
  }
  const model = forwardedModel(parsed.forwarded);
  const ordered = orderAccountsByUsage(candidates, { env, modelFor: () => model });
  const quota = readAccountQuotaState(env).entries;
  const selected = ordered.find((account) => !accountQuotaBlock(quota, account.label, model));
  if (!selected) {
    const soonest = ordered[0];
    const block = accountQuotaBlock(quota, soonest.label, model);
    stderr.write(
      `All registered Claude accounts are rate-limited. ${soonest.label} resets at ${new Date(block.untilMs).toISOString()}.\n`,
    );
    return 75;
  }
  stderr.write(`Using ${selected.label} (${selected.configDir}).\n`);
  if (parsed.dryRun) return 0;
  const childEnv = { ...env, CLAUDE_CONFIG_DIR: selected.configDir, ANTHROPIC_API_KEY: "" };
  const result = (deps.spawn ?? spawnSync)("claude", parsed.forwarded, { env: childEnv, stdio: "inherit" });
  if (result.error) {
    stderr.write(`${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}
