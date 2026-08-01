import { readdir, mkdir, link, copyFile, rm } from "node:fs/promises";
import { resolve, relative, join, dirname, extname } from "node:path";
import { existsSync } from "node:fs";
import { Effect } from "effect";
import { toSmithersError } from "@smithers-orchestrator/errors/toSmithersError";
/** @typedef {import("./OverlayOptions.ts").OverlayOptions} OverlayOptions */
/** @typedef {import("@smithers-orchestrator/errors/SmithersError").SmithersError} SmithersError */

const DEFAULT_EXCLUDE = ["node_modules", ".git", ".jj", ".smithers", ".DS_Store"];
const SNAPSHOT_COPY_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".json", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);

/**
 * @param {unknown} cause
 * @param {string} operation
 * @param {Record<string, unknown>} details
 * @returns {SmithersError}
 */
function hotOverlayError(cause, operation, details) {
  return toSmithersError(cause, operation, {
    code: "HOT_OVERLAY_FAILED",
    details,
  });
}
/**
 * @param {string} operation
 * @param {Record<string, unknown>} details
 * @returns {(cause: unknown) => SmithersError}
 */
function hotOverlayErrorMapper(operation, details) {
  return (cause) => hotOverlayError(cause, operation, details);
}
function shouldCopySnapshotFile(filePath) {
  return SNAPSHOT_COPY_EXTENSIONS.has(extname(filePath).toLowerCase());
}
/**
 * Build a generation overlay by hardlinking (or copying) the hot root
 * tree into a new generation directory.
 *
 * Returns the absolute path to the overlay directory.
 *
 * @param {string} hotRoot
 * @param {string} outDir
 * @param {number} generation
 * @param {OverlayOptions} [opts]
 * @returns {Effect.Effect<string, SmithersError>}
 */
export function buildOverlayEffect(hotRoot, outDir, generation, opts) {
  const exclude = new Set(opts?.exclude ?? DEFAULT_EXCLUDE);
  const genDir = join(outDir, `gen-${generation}`);
  return Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => mkdir(genDir, { recursive: true }),
      catch: hotOverlayErrorMapper("create hot overlay generation dir", {
        hotRoot,
        outDir,
        generation,
      }),
    });
    yield* mirrorTreeEffect(hotRoot, genDir, exclude);
    return genDir;
  }).pipe(
    Effect.annotateLogs({
      hotRoot,
      outDir,
      generation,
      excludeCount: exclude.size,
    }),
    Effect.withLogSpan("hot:build-overlay"),
  );
}
/**
 * @param {string} hotRoot
 * @param {string} outDir
 * @param {number} generation
 * @param {OverlayOptions} [opts]
 * @returns {Promise<string>}
 */
export async function buildOverlay(hotRoot, outDir, generation, opts) {
  return Effect.runPromise(buildOverlayEffect(hotRoot, outDir, generation, opts));
}
/**
 * Recursively mirror `src` into `dest`, using hardlinks where possible
 * and falling back to copy. Skips excluded directory basenames.
 *
 * @param {string} src
 * @param {string} dest
 * @param {Set<string>} exclude
 * @returns {Effect.Effect<void, SmithersError>}
 */
function mirrorTreeEffect(src, dest, exclude) {
  return Effect.gen(function* () {
    const entries = yield* Effect.tryPromise({
      try: () => readdir(src, { withFileTypes: true }),
      catch: hotOverlayErrorMapper("read hot overlay source dir", {
        src,
        dest,
      }),
    });
    for (const entry of entries) {
      if (exclude.has(entry.name)) continue;
      if (entry.name.startsWith(".")) continue;
      const srcPath = join(src, entry.name);
      const destPath = join(dest, entry.name);
      if (entry.isDirectory()) {
        yield* Effect.tryPromise({
          try: () => mkdir(destPath, { recursive: true }),
          catch: hotOverlayErrorMapper("create mirrored hot overlay dir", {
            srcPath,
            destPath,
          }),
        });
        yield* mirrorTreeEffect(srcPath, destPath, exclude);
      } else if (entry.isFile()) {
        const copyFileEffect = Effect.tryPromise({
          try: () => copyFile(srcPath, destPath),
          catch: hotOverlayErrorMapper("copy overlay file", {
            srcPath,
            destPath,
          }),
        });
        // Module and JSON files need an independent inode per generation.
        // Hardlinks can keep old generations tied to in-place source edits.
        if (shouldCopySnapshotFile(srcPath)) {
          yield* copyFileEffect;
          continue;
        }
        const linked = yield* Effect.result(
          Effect.tryPromise({
            try: () => link(srcPath, destPath),
            catch: hotOverlayErrorMapper("hardlink overlay file", {
              srcPath,
              destPath,
            }),
          }),
        );
        if (linked._tag === "Failure") {
          yield* Effect.tryPromise({
            try: () => mkdir(dirname(destPath), { recursive: true }),
            catch: hotOverlayErrorMapper("create overlay file parent dir", {
              srcPath,
              destPath,
            }),
          });
          yield* copyFileEffect;
        }
      }
    }
  });
}
/**
 * Remove old generation directories, keeping only the last `keepLast`.
 *
 * @param {string} outDir
 * @param {number} keepLast
 * @returns {Effect.Effect<void, SmithersError>}
 */
export function cleanupGenerationsEffect(outDir, keepLast) {
  return Effect.gen(function* () {
    if (!existsSync(outDir)) return;
    const entries = yield* Effect.tryPromise({
      try: () => readdir(outDir, { withFileTypes: true }),
      catch: hotOverlayErrorMapper("read hot overlay generations", {
        outDir,
        keepLast,
      }),
    });
    const genDirs = entries
      .filter((e) => e.isDirectory() && e.name.startsWith("gen-"))
      .map((e) => {
        const num = parseInt(e.name.slice(4), 10);
        return { name: e.name, num: isNaN(num) ? -1 : num };
      })
      .filter((e) => e.num >= 0)
      .sort((a, b) => a.num - b.num);
    const toRemove = genDirs.slice(0, Math.max(0, genDirs.length - keepLast));
    for (const dir of toRemove) {
      yield* Effect.result(
        Effect.tryPromise({
          try: () => rm(join(outDir, dir.name), { recursive: true, force: true }),
          catch: hotOverlayErrorMapper("remove stale hot overlay generation", {
            outDir,
            generationDir: dir.name,
          }),
        }),
      );
    }
  }).pipe(
    Effect.annotateLogs({
      outDir,
      keepLast,
    }),
    Effect.withLogSpan("hot:cleanup-generations"),
  );
}
/**
 * @param {string} outDir
 * @param {number} keepLast
 * @returns {Promise<void>}
 */
export async function cleanupGenerations(outDir, keepLast) {
  await Effect.runPromise(cleanupGenerationsEffect(outDir, keepLast));
}
/**
 * Resolve the overlay entry path given the original entry path,
 * the hot root, and the overlay generation directory.
 *
 * @param {string} entryPath
 * @param {string} hotRoot
 * @param {string} genDir
 * @returns {string}
 */
export function resolveOverlayEntry(entryPath, hotRoot, genDir) {
  const rel = relative(hotRoot, entryPath);
  return resolve(genDir, rel);
}

export const __overlayInternals = {
  hotOverlayError,
  hotOverlayErrorMapper,
  mirrorTreeEffect,
  shouldCopySnapshotFile,
};
