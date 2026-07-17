/**
 * The Smithers Signal runner entry point.
 *
 * Runs inside the Cloudflare Container built from apps/signal/runner/Dockerfile:
 * sync state/ceo-intel.sqlite down from R2 -> `smithers up daily-ceo-intel`
 * headless (detach=false) -> sync state up -> exit/response code reflects
 * whether the issue actually published (not just whether the CLI exited 0 —
 * a compose/verify pass with a downstream publish failure still exits 0).
 *
 * CF credentials being present in env makes the workflow's own effective mode
 * resolve to "publish" (see .smithers/lib/daily-ceo-intel/config.ts
 * resolveEffectiveMode); this script does not force publishMode unless
 * SIGNAL_PUBLISH_MODE overrides it, so a misconfigured container without CF
 * creds safely falls back to archive-only instead of silently no-op'ing.
 */
import { mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CloudflareCreds } from "../../../../.smithers/lib/daily-ceo-intel/cloudflare";
import { getR2Object, putR2Object } from "../../../../.smithers/lib/daily-ceo-intel/cloudflare";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const CONFIG_PATH = process.env.SIGNAL_CONFIG_PATH?.trim() || "config/ceo-intel.json";
const DB_RELATIVE_PATH = "data/ceo-intel.sqlite";
const R2_STATE_KEY = "state/ceo-intel.sqlite";
const PORT = Number(process.env.PORT ?? 8080);

function readCreds(): CloudflareCreds | null {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
  const kvNamespaceId = process.env.CLOUDFLARE_KV_NAMESPACE_ID?.trim();
  const r2Bucket = process.env.CLOUDFLARE_R2_BUCKET?.trim();
  if (!accountId || !apiToken || !kvNamespaceId || !r2Bucket) return null;
  return { accountId, apiToken, kvNamespaceId, r2Bucket };
}

async function syncStateDown(creds: CloudflareCreds): Promise<{ synced: boolean }> {
  const bytes = await getR2Object(creds, R2_STATE_KEY);
  if (!bytes) return { synced: false };
  const dbPath = join(REPO_ROOT, DB_RELATIVE_PATH);
  mkdirSync(dirname(dbPath), { recursive: true });
  await Bun.write(dbPath, bytes);
  return { synced: true };
}

async function syncStateUp(creds: CloudflareCreds): Promise<{ synced: boolean }> {
  const dbPath = join(REPO_ROOT, DB_RELATIVE_PATH);
  if (!existsSync(dbPath)) return { synced: false };
  const bytes = new Uint8Array(await Bun.file(dbPath).arrayBuffer());
  await putR2Object(creds, R2_STATE_KEY, bytes, "application/vnd.sqlite3");
  return { synced: true };
}

type RunResult = {
  ok: boolean;
  runId: string;
  cliExitCode: number;
  published: boolean;
  publishSkippedReason: string | null;
  finalizeStatus: string | null;
  errors: string[];
  stateSyncedDown: boolean;
  stateSyncedUp: boolean;
};

function redactSecrets(value: string): string {
  let result = value;
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "CLOUDFLARE_API_TOKEN", "SIGNAL_MANUAL_TRIGGER_SECRET"]) {
    const secret = process.env[key]?.trim();
    if (secret) result = result.split(secret).join("[REDACTED]");
  }
  return result;
}

async function runSmithersCli(runId: string, input: Record<string, unknown>): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(
    [
      join(REPO_ROOT, "node_modules", ".bin", "smithers"),
      "up",
      "daily-ceo-intel",
      "--run-id",
      runId,
      "--input",
      JSON.stringify(input),
      "--format",
      "json",
      "--no-report",
      "--no-post-failure",
    ],
    { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe", env: process.env },
  );
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stdout, stderr };
}

async function readNodeOutput(runId: string, nodeId: string): Promise<Record<string, unknown> | null> {
  const proc = Bun.spawn([join(REPO_ROOT, "node_modules", ".bin", "smithers"), "output", runId, nodeId, "--format", "json"], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  try {
    return JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function runOnce(): Promise<RunResult> {
  const creds = readCreds();
  const runId = `signal-${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`;
  const errors: string[] = [];
  let stateSyncedDown = false;
  let stateSyncedUp = false;

  if (creds) {
    try {
      stateSyncedDown = (await syncStateDown(creds)).synced;
    } catch (error) {
      errors.push(`state sync down failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    errors.push("Cloudflare credentials not present in env; running without R2 state sync (archive-only expected).");
  }

  const publishMode = process.env.SIGNAL_PUBLISH_MODE?.trim() || "auto";
  const { exitCode, stderr } = await runSmithersCli(runId, { publishMode, configPath: CONFIG_PATH });
  if (exitCode !== 0) errors.push(`smithers up exited ${exitCode}: ${redactSecrets(stderr.slice(-2000))}`);

  let published = false;
  let publishSkippedReason: string | null = null;
  let finalizeStatus: string | null = null;
  if (exitCode === 0) {
    const publishOut = await readNodeOutput(runId, "publish");
    published = Boolean(publishOut?.published) || Boolean(publishOut?.idempotentSkip);
    publishSkippedReason = (publishOut?.skippedReason as string | undefined) ?? null;
    const finalizeOut = await readNodeOutput(runId, "finalize");
    finalizeStatus = (finalizeOut?.status as string | undefined) ?? null;
  }

  if (creds) {
    try {
      stateSyncedUp = (await syncStateUp(creds)).synced;
    } catch (error) {
      errors.push(`state sync up failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const ok = exitCode === 0 && (creds === null || published);
  return { ok, runId, cliExitCode: exitCode, published, publishSkippedReason, finalizeStatus, errors, stateSyncedDown, stateSyncedUp };
}

function serve(): void {
  Bun.serve({
    port: PORT,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/health" || url.pathname === "/ping") {
        return new Response("ok", { status: 200 });
      }
      if (url.pathname === "/run" && request.method === "POST") {
        try {
          const result = await runOnce();
          return Response.json(result, { status: result.ok ? 200 : 500 });
        } catch (error) {
          return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
        }
      }
      return new Response("not found", { status: 404 });
    },
  });
  console.log(`[signal-runner] listening on :${PORT}`);
}

if (process.argv.includes("--serve")) {
  serve();
} else if (import.meta.main) {
  const result = await runOnce();
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
