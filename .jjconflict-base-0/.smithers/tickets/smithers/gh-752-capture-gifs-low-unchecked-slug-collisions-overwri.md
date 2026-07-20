# 🐛 capture-gifs: [low] unchecked slug collisions overwrite gifs and produce duplicate manifest entries for one file

GitHub: https://github.com/smithersai/smithers/issues/752

_via ultracode (Opus multi-agent) review_

**Summary:** Gif output paths are derived from a lossy slug with no collision check, so distinct captures can overwrite each other's gif while the manifest still counts both.

**Location:** `scripts/e2e-real/capture-gifs.ts:153` (slug/path derivation), `:175-185` (ffmpeg `-y` overwrite), `:238` (`captures.map(convertToGif)` with no dedup), `:243` (`manifest.length < 8` counts entries, not distinct files).

**Failure scenario:** `slug = slugify(`${specBase}--${title}`)` and `gifPath = gifs/${slug}.gif`. `slugify` lowercases and collapses all non-alphanumerics, and `specBase = basename(spec, extname(spec))` strips only the final extension. So two captures collide when:
- titles differ only in case/punctuation (e.g. "Run a workflow" vs "Run a Workflow"), or
- two specs in different directories share a basename and title (e.g. `a/foo.spec.ts` and `b/foo.spec.ts`).

Playwright does not enforce unique test titles across files. On collision, the second `ffmpeg` invocation (with `-y`) overwrites the first's gif; both `ManifestEntry` rows then reference the same `gifs/<slug>.gif`, and `manifest.length` still counts both — passing the `< 8` guard while one capture's video is silently dropped.

(Note: the `foo.spec.ts` vs `foo.e2e.ts` example does NOT collide — `extname` strips only `.ts`, yielding `foo.spec` vs `foo.e2e`.)

**Why it matters:** The manifest/slideshow claims N distinct feature gifs but silently contains fewer, misrepresenting captured evidence with no failure. A `Set`-based assert on already-seen slugs (or folding a stable spec-path hash into the slug) would fail loudly instead.
