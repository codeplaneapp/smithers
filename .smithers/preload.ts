import { mdxPlugin } from "smthrs";

mdxPlugin();

// Pack tests assert the exact Codex-first agent chains, so an operator's live
// quota pause (~/.smithers/codex-paused.json) must not leak into them. bun
// test sets NODE_ENV=test; real workflow runs never see this override.
if (process.env.NODE_ENV === "test" && !process.env.SMITHERS_CODEX_PAUSED) {
  process.env.SMITHERS_CODEX_PAUSED = "0";
}
