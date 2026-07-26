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
 * Verified on macOS with Claude Code 2.1.220: setting CLAUDE_CONFIG_DIR at all
 * switches Claude to a config-dir-scoped credential store, separate from the
 * default `Claude Code-credentials` Keychain item. Pointing CLAUDE_CONFIG_DIR at
 * `~/.claude` — the very directory the ambient login uses — still reports
 * `loggedIn: false`, which is how we know the scoping is by the setting rather
 * than by path. Two consequences: every seat needs its own OAuth (the ambient
 * login cannot be adopted as one of them), and the fleet cannot clobber the
 * user's existing login.
 *
 * Login is the vendor's own browser OAuth flow, which needs a human, so this is
 * interactive by design. Accounts that are already signed in are skipped, so
 * re-running is cheap and safe.
 *
 *   node .smithers/scripts/accounts-login.mjs            # provision + log in
 *   node .smithers/scripts/accounts-login.mjs --status   # report only
 *   node .smithers/scripts/accounts-login.mjs --claude 8 --codex 2
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
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

/**
 * ANTHROPIC_API_KEY takes precedence over the subscription OAuth this fleet is
 * built on. Left set, `auth status` reports the API key's identity instead of
 * the account's and `auth login` signs into the wrong thing, so every vendor
 * call below blanks it.
 */
const noApiKey = { ANTHROPIC_API_KEY: "" };

const run = (cmd, cmdArgs, env) =>
  spawnSync(cmd, cmdArgs, { encoding: "utf8", env: { ...process.env, ...env } });

const PROVIDERS = {
  "claude-code": {
    labels: Array.from({ length: CLAUDE_N }, (_, i) => `claude-${i + 1}`),
    env: (dir) => ({ CLAUDE_CONFIG_DIR: dir, ...noApiKey }),
    envName: "CLAUDE_CONFIG_DIR",
    /**
     * `claude auth status --json` is the authoritative check: it costs no
     * tokens and reports the identity behind this config dir. Sniffing the
     * directory for files does NOT work — merely running claude once populates
     * `.claude.json`, `projects/`, and friends without any login happening.
     */
    status(dir) {
      const r = run("claude", ["auth", "status", "--json"], this.env(dir));
      try {
        const j = JSON.parse(r.stdout);
        return {
          loggedIn: Boolean(j.loggedIn),
          identity: j.email ?? null,
          detail: j.subscriptionType ? `${j.subscriptionType}` : (j.authMethod ?? null),
        };
      } catch {
        return { loggedIn: false, identity: null, detail: null };
      }
    },
    // --claudeai signs into the Claude subscription (not Console API billing),
    // which is the whole point of running a fleet of them.
    login: ["claude", ["auth", "login", "--claudeai"]],
  },
  codex: {
    labels: Array.from({ length: CODEX_N }, (_, i) => `codex-acct-${i + 1}`),
    env: (dir) => ({ CODEX_HOME: dir }),
    envName: "CODEX_HOME",
    status(dir) {
      const r = run("codex", ["login", "status"], this.env(dir));
      const out = `${r.stdout}${r.stderr}`;
      const loggedIn = /logged in/i.test(out) && !/not logged in/i.test(out);
      const identity = out.match(/logged in using ([^\n]+)/i)?.[1]?.trim() ?? null;
      return { loggedIn, identity, detail: null };
    },
    login: ["codex", ["login"]],
  },
};

const registered = (() => {
  const r = run("smithers", ["agents", "list", "--format", "json"], {});
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
    mkdirSync(dir, { recursive: true });
    plan.push({ provider, label, dir, spec, ...spec.status(dir), registered: registered.has(label) });
  }
}

const mark = (b) => (b ? "✓" : "·");

function report() {
  console.log(`\nAccount fleet — ${CLAUDE_N} claude + ${CODEX_N} codex\n`);
  for (const p of plan) {
    const who = p.identity ? `${p.identity}${p.detail ? ` (${p.detail})` : ""}` : "—";
    console.log(
      `  ${mark(p.loggedIn)} login  ${mark(p.registered)} registered  ${p.label.padEnd(14)} ${who}`,
    );
  }
  const inCount = plan.filter((p) => p.loggedIn).length;
  console.log(
    `\n${inCount}/${plan.length} logged in, ` +
      `${plan.filter((p) => p.registered).length}/${plan.length} registered.`,
  );

  // A fleet of eight seats all pointing at one subscription has one quota and
  // buys nothing, so surface it loudly rather than letting it look healthy.
  const seen = new Map();
  for (const p of plan) {
    if (!p.loggedIn || !p.identity) continue;
    const key = `${p.provider}:${p.identity}`;
    seen.set(key, [...(seen.get(key) ?? []), p.label]);
  }
  const dupes = [...seen.entries()].filter(([, labels]) => labels.length > 1);
  if (dupes.length > 0) {
    console.log(`\n  ⚠ SHARED SUBSCRIPTIONS — these seats draw from one quota:`);
    for (const [key, labels] of dupes) {
      console.log(`      ${key.split(":").slice(1).join(":")} → ${labels.join(", ")}`);
    }
    console.log(`    Log those labels out and back in with different accounts.`);
  }
  console.log("");
}

report();
if (STATUS_ONLY) process.exit(0);

const missing = plan.filter((p) => !p.loggedIn);
if (missing.length > 0) {
  console.log(
    `${missing.length} account(s) need a browser sign-in. Each opens your browser with an\n` +
      `isolated config dir; complete the OAuth flow and it moves on to the next.\n\n` +
      `Sign in with a DIFFERENT subscription for each label — otherwise they all share\n` +
      `one quota and the fleet buys nothing.\n`,
  );
}

for (const p of missing) {
  const [cmd, cmdArgs] = p.spec.login;
  console.log(`\n── ${p.label} ─────────────────────────────────────────────`);
  console.log(`   ${cmd} ${cmdArgs.join(" ")}   (${p.spec.envName}=${p.dir})`);
  const r = spawnSync(cmd, cmdArgs, {
    stdio: "inherit",
    env: { ...process.env, ...p.spec.env(p.dir) },
  });
  if (r.error) {
    console.log(`   ! could not launch ${cmd}: ${r.error.message}`);
    continue;
  }
  const after = p.spec.status(p.dir);
  Object.assign(p, after);
  console.log(
    p.loggedIn ? `   ✓ signed in as ${p.identity ?? "(unknown)"}` : "   · still not signed in",
  );
}

for (const p of plan) {
  if (!p.loggedIn || p.registered) continue;
  const r = run(
    "smithers",
    ["agents", "add", "--provider", p.provider, "--label", p.label, "--config-dir", p.dir, "--replace"],
    {},
  );
  if (r.status === 0) {
    p.registered = true;
    console.log(`  ✓ registered ${p.label}`);
  } else {
    console.log(`  ! register ${p.label} failed: ${(r.stderr || r.stdout || "").trim().split("\n")[0]}`);
  }
}

report();
console.log(`Next: \`smithers usage\` shows per-account headroom; the campaign's`);
console.log(`accounts:refresh task snapshots it for load-balanced seat selection.\n`);
