#!/usr/bin/env node
/**
 * Provision and log in the account fleet: 8 Claude subscriptions + 2 Codex.
 *
 * Each account is an isolated CLI config directory under
 * `~/.smithers/accounts/<label>`. Pointing the vendor CLI at one via
 * CLAUDE_CONFIG_DIR / CODEX_HOME is the primitive that lets several
 * subscriptions coexist on one machine; this script drives it in bulk and
 * registers the result in `~/.smithers/accounts.json`.
 *
 * Login is the vendor's own browser OAuth flow, which needs a human. So this is
 * interactive by design: for each account still missing credentials it launches
 * that CLI with an isolated config dir, you complete sign-in in the browser,
 * and it moves on. Accounts that already have credentials are skipped, so
 * re-running is cheap and safe.
 *
 *   node .smithers/scripts/accounts-login.mjs            # provision + log in
 *   node .smithers/scripts/accounts-login.mjs --status   # report only
 *   node .smithers/scripts/accounts-login.mjs --claude 8 --codex 2
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : dflt;
};
const CLAUDE_N = Number(flag("claude", "8"));
const CODEX_N = Number(flag("codex", "2"));
const STATUS_ONLY = args.includes("--status");

const ACCOUNTS_ROOT = join(homedir(), ".smithers", "accounts");

const PROVIDERS = {
  "claude-code": {
    labels: Array.from({ length: CLAUDE_N }, (_, i) => `claude-${i + 1}`),
    // Credentials may live in the config dir OR the macOS Keychain, so a
    // populated directory is the signal that a login happened here.
    hasCreds: (dir) =>
      existsSync(join(dir, ".credentials.json")) ||
      (existsSync(dir) && readdirSync(dir).length > 0),
    env: (dir) => ({ CLAUDE_CONFIG_DIR: dir }),
    // `claude` with no args opens the interactive UI, which runs OAuth in the
    // browser when the config dir has no credentials.
    loginCmd: "claude",
    loginArgs: [],
  },
  codex: {
    labels: Array.from({ length: CODEX_N }, (_, i) => `codex-acct-${i + 1}`),
    hasCreds: (dir) => existsSync(join(dir, "auth.json")),
    env: (dir) => ({ CODEX_HOME: dir }),
    loginCmd: "codex",
    loginArgs: ["login"],
  },
};

const registered = (() => {
  const r = spawnSync("smithers", ["agents", "list", "--format", "json"], { encoding: "utf8" });
  try {
    const parsed = JSON.parse(r.stdout);
    const rows = parsed?.data?.accounts ?? parsed?.accounts ?? parsed?.data ?? [];
    return new Set((Array.isArray(rows) ? rows : []).map((a) => a.label));
  } catch {
    return new Set();
  }
})();

const plan = [];
for (const [provider, spec] of Object.entries(PROVIDERS)) {
  for (const label of spec.labels) {
    const dir = join(ACCOUNTS_ROOT, label);
    plan.push({
      provider,
      label,
      dir,
      spec,
      loggedIn: spec.hasCreds(dir),
      registered: registered.has(label),
    });
  }
}

const mark = (b) => (b ? "✓" : "·");
console.log(`\nAccount fleet — ${CLAUDE_N} claude + ${CODEX_N} codex\n`);
for (const p of plan) {
  console.log(
    `  ${mark(p.loggedIn)} login  ${mark(p.registered)} registered  ${p.label.padEnd(16)} ${p.dir}`,
  );
}
const missing = plan.filter((p) => !p.loggedIn);
console.log(
  `\n${plan.length - missing.length}/${plan.length} logged in, ` +
    `${plan.filter((p) => p.registered).length}/${plan.length} registered.\n`,
);

if (STATUS_ONLY) process.exit(0);

if (missing.length > 0) {
  console.log(
    `${missing.length} account(s) need a browser sign-in. Each launches its CLI with an\n` +
      `isolated config dir; complete the OAuth flow in the browser, then quit the CLI\n` +
      `(Ctrl-D or /exit) to continue to the next.\n\n` +
      `Sign in with a DIFFERENT subscription for each label — otherwise they all share\n` +
      `one quota and the entire point of the fleet is lost.\n`,
  );
}

for (const p of missing) {
  mkdirSync(p.dir, { recursive: true });
  const envName = Object.keys(p.spec.env(p.dir))[0];
  console.log(`\n── ${p.label} ─────────────────────────────────────────────`);
  console.log(`   ${p.spec.loginCmd} ${p.spec.loginArgs.join(" ")}   (${envName}=${p.dir})`);
  const r = spawnSync(p.spec.loginCmd, p.spec.loginArgs, {
    stdio: "inherit",
    // Blank the API key: it would override the subscription OAuth we are here
    // to establish, and the whole fleet exists to use subscriptions.
    env: { ...process.env, ...p.spec.env(p.dir), ANTHROPIC_API_KEY: "" },
  });
  if (r.error) {
    console.log(`   ! could not launch ${p.spec.loginCmd}: ${r.error.message}`);
    continue;
  }
  p.loggedIn = p.spec.hasCreds(p.dir);
  console.log(p.loggedIn ? "   ✓ credentials present" : "   · still no credentials — skipped");
}

for (const p of plan) {
  if (!p.spec.hasCreds(p.dir) || p.registered) continue;
  const r = spawnSync(
    "smithers",
    [
      "agents", "add",
      "--provider", p.provider,
      "--label", p.label,
      "--config-dir", p.dir,
      "--replace",
    ],
    { encoding: "utf8" },
  );
  console.log(
    r.status === 0
      ? `  ✓ registered ${p.label}`
      : `  ! register ${p.label} failed: ${(r.stderr || r.stdout || "").trim().split("\n")[0]}`,
  );
}

console.log(`\nNext: \`smithers usage\` shows per-account headroom; the campaign's`);
console.log(`accounts:refresh task snapshots it for load-balanced seat selection.\n`);
