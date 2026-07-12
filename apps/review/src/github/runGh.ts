import { execFile } from "node:child_process";

export interface RunGhOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

function safeGhDetail(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/@(?!\u200b)/g, "@\u200b")
    .slice(0, 1_000);
}

function decodeGhOutput(value: Uint8Array, label: string): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(value); }
  catch { throw new Error(`${label} is not valid UTF-8`); }
}

/**
 * Run the gh CLI in a repo directory; resolves stdout, throws with stderr.
 */
export async function runGh(repoDir: string, args: string[], stdin?: string, options: RunGhOptions = {}): Promise<string> {
  // Honor an explicit gh path (non-standard installs, and hermetic tests that
  // inject a fake gh by absolute path).
  const ghBin = process.env.SMITHERS_GH_BIN || "gh";
  const timeout = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000) throw new Error("gh timeout is invalid");
  if (stdin !== undefined && Buffer.byteLength(stdin) > 1_000_000) throw new Error("gh stdin exceeds 1 MB");
  return await new Promise<string>((resolve, reject) => {
    const child = execFile(ghBin, args, {
      cwd: repoDir,
      encoding: "buffer",
      // Pass env explicitly so env vars set at runtime (e.g. a freshly exported
      // GH_TOKEN) reach gh; the default snapshot would miss them.
      env: process.env,
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      killSignal: "SIGKILL",
      signal: options.signal,
    }, (error, stdout, stderr) => {
      if (error) {
        const failure = error as Error & { code?: string | number; signal?: string };
        const exitDetail = typeof failure.code === "number"
          ? `exited with code ${failure.code}${failure.signal ? `, signal ${failure.signal}` : ""}`
          : failure.message;
        let stderrText = "";
        try { stderrText = decodeGhOutput(stderr, "gh stderr"); } catch { stderrText = "gh stderr is not valid UTF-8"; }
        const detail = safeGhDetail((stderrText || exitDetail).trim() || "command failed");
        reject(new Error(`gh ${safeGhDetail(args.slice(0, 2).join(" "))} failed: ${detail}`));
        return;
      }
      try { resolve(decodeGhOutput(stdout, "gh stdout")); }
      catch (decodeError) { reject(decodeError); }
    });
    // EPIPE is reflected in the process callback; consuming it here prevents
    // an unhandled stream error if gh exits before reading a rejected payload.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(stdin);
  });
}

/**
 * Run gh with a per-item `... | @json` --jq program and parse each stdout
 * line as one JSON record. One compact object per line survives gh's
 * per-page --jq application under --paginate where raw concatenated page
 * arrays would not parse. gh prints jq string results raw, but
 * double-encoded output (a JSON string containing JSON) has been observed
 * across jq builds, so string results are unwrapped once; blank and
 * unparseable lines are skipped.
 */
export async function runGhJsonLines(
  repoDir: string,
  args: string[],
  gh: typeof runGh = runGh,
): Promise<object[]> {
  const raw = await gh(repoDir, args);
  const records: object[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") parsed = JSON.parse(parsed);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === "object") records.push(parsed);
  }
  return records;
}
