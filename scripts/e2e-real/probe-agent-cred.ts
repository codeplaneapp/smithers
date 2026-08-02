import { listAccounts } from "@smthrs/accounts";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const model = process.env.SMITHERS_E2E_LUNA_MODEL ?? process.env.SMITHERS_E2E_CODEX_MODEL ?? "gpt-5.6-luna";
const unusablePattern = /rate[_ -]?limit|session limit|api_error_status.*429/i;

type ProbeResult = { ok: boolean; detail: string };

async function probe(command: string[], env: NodeJS.ProcessEnv): Promise<ProbeResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(command, {
      cwd: repoRoot,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGKILL");
    } catch {}
  }, 180_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  const combined = `${stdout}\n${stderr}`;
  return {
    ok: !timedOut && exitCode === 0 && stdout.trim().length > 0 && !unusablePattern.test(combined),
    detail: timedOut ? "timed out" : `exit ${exitCode}`,
  };
}

const codexCandidates: Array<{ label: string; env: NodeJS.ProcessEnv }> = [
  { label: "ambient Codex", env: { ...process.env } },
];
try {
  for (const account of listAccounts(process.env)) {
    if (account.provider === "codex") {
      codexCandidates.push({
        label: `registered Codex account ${account.label}`,
        env: { ...process.env, CODEX_HOME: account.configDir },
      });
    } else if (account.provider === "openai-api") {
      codexCandidates.push({
        label: `registered OpenAI account ${account.label}`,
        env: { ...process.env, OPENAI_API_KEY: account.apiKey },
      });
    }
  }
} catch {
  // A missing/malformed account registry must not prevent ambient Codex or the
  // explicitly retained Claude fallback from being probed.
}

const failures: string[] = [];
for (const candidate of codexCandidates) {
  const result = await probe(["codex", "exec", "--skip-git-repo-check", "--model", model, "Say OK"], candidate.env);
  if (result.ok) {
    console.log(`Codex credential probe passed with ${candidate.label} (${model}).`);
    process.exit(0);
  }
  failures.push(`${candidate.label}: ${result.detail}`);
}

const claudeEnv = { ...process.env };
if (process.env.SMITHERS_E2E_ENV_SUPPLIED_ANTHROPIC_KEY !== "1") {
  delete claudeEnv.ANTHROPIC_API_KEY;
}
const claude = await probe(["claude", "-p", "Say OK", "--model", "claude-sonnet-5"], claudeEnv);
if (claude.ok) {
  console.log("Codex credentials were unavailable; Claude fallback credential probe passed.");
  process.exit(0);
}

console.error(
  `Agent credential probe failed after all Codex candidates (${failures.join(
    "; ",
  )}) and the Claude fallback (${claude.detail}). Run codex login or register another Codex/OpenAI account. If Codex is unavailable, run claude /login or claude setup-token, or set ANTHROPIC_API_KEY in apps/smithers/.env.e2e.local.`,
);
process.exit(1);
