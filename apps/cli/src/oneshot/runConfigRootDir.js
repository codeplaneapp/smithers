/**
 * The directory a run executes in, read from its stored config.
 *
 * The engine stamps `rootDir` into the run's `config_json` on every start and
 * resume, so this is the durable record of which tree a run is editing. There
 * is no `cwd` column on the run row. Returns `null` for a run whose config is
 * absent or malformed, which keeps a bad row from being treated as a match.
 *
 * @param {string | null | undefined} configJson
 * @returns {string | null}
 */
export function runConfigRootDir(configJson) {
  if (typeof configJson !== "string" || configJson.length === 0) return null;
  try {
    const parsed = JSON.parse(configJson);
    const rootDir = parsed?.rootDir;
    return typeof rootDir === "string" && rootDir.length > 0 ? rootDir : null;
  } catch {
    return null;
  }
}
