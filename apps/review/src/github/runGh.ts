import { spawnSync } from "node:child_process";

/**
 * The gh executable this process spawns.
 *
 * `SMITHERS_GH_BIN` overrides it, for non-standard installs and for hermetic
 * tests that inject a fake gh by absolute path. Every caller resolves the
 * binary here, so a preflight check and the call it guards can never disagree
 * about which gh they mean.
 */
export function ghBin(): string {
  return process.env.SMITHERS_GH_BIN || "gh";
}

/**
 * Run the gh CLI in a repo directory; resolves stdout, throws with stderr.
 */
export async function runGh(repoDir: string, args: string[], stdin?: string): Promise<string> {
  const result = spawnSync(ghBin(), args, {
    cwd: repoDir,
    input: stdin ?? undefined,
    encoding: "utf8",
    // Pass env explicitly so env vars set at runtime (e.g. a freshly exported
    // GH_TOKEN) reach gh; the default snapshot would miss them.
    env: process.env,
  });
  if (result.error) {
    throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${result.error.message}`);
  }
  const stderr = result.stderr ?? "";
  if (result.status !== 0) {
    const detail =
      stderr.trim() || `exited with code ${result.status}${result.signal ? `, signal ${result.signal}` : ""}`;
    throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${detail}`);
  }
  return result.stdout ?? "";
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
export async function runGhJsonLines(repoDir: string, args: string[], gh: typeof runGh = runGh): Promise<object[]> {
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
