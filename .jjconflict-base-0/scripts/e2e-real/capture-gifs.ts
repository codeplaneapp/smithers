import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

type JsonReport = {
  suites?: ReportSuite[];
};

type ReportSuite = {
  title?: string;
  file?: string;
  suites?: ReportSuite[];
  specs?: ReportSpec[];
};

type ReportSpec = {
  title: string;
  file?: string;
  tests?: ReportTest[];
};

type ReportTest = {
  status?: string;
  results?: ReportResult[];
};

type ReportResult = {
  status?: string;
  duration?: number;
  attachments?: ReportAttachment[];
};

type ReportAttachment = {
  name?: string;
  contentType?: string;
  path?: string;
};

export type PassedCapture = {
  title: string;
  spec: string;
  video: string;
  durationMs: number;
};

type ManifestEntry = {
  slug: string;
  title: string;
  spec: string;
  gif: string;
  bytes: number;
  durationMs: number;
};

const repoRoot = process.cwd();
const appRoot = resolve(repoRoot, "apps/smithers");
const reportPath = resolve(appRoot, "capture-report/report.json");
const artifactRoot = resolve(repoRoot, "artifacts/feature-gifs");
const gifsDir = resolve(artifactRoot, "gifs");
const manifestPath = resolve(artifactRoot, "manifest.json");
const ffmpegArgs = ["-hide_banner", "-loglevel", "error"] as const;

function run(command: string, args: string[], options: { cwd?: string } = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: process.env,
    stdio: "inherit",
  });
}

export function slugify(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .toLowerCase();
}

export function gifSlugForCapture(capture: Pick<PassedCapture, "spec" | "title">) {
  const specBase = basename(capture.spec, extname(capture.spec));
  return slugify(`${specBase}--${capture.title}`);
}

export function assertUniqueGifSlugs(
  captures: readonly Pick<PassedCapture, "spec" | "title">[],
) {
  const firstCaptureBySlug = new Map<string, Pick<PassedCapture, "spec" | "title">>();
  const collisions = new Map<string, string[]>();

  for (const capture of captures) {
    const slug = gifSlugForCapture(capture);
    const firstCapture = firstCaptureBySlug.get(slug);
    if (!firstCapture) {
      firstCaptureBySlug.set(slug, capture);
      continue;
    }

    const entries = collisions.get(slug) ?? [
      `${firstCapture.spec} :: ${firstCapture.title}`,
    ];
    entries.push(`${capture.spec} :: ${capture.title}`);
    collisions.set(slug, entries);
  }

  if (collisions.size === 0) return;

  const details = [...collisions.entries()]
    .map(
      ([slug, entries]) =>
        `  ${slug || "<empty>"}:\n${entries.map((entry) => `    ${entry}`).join("\n")}`,
    )
    .join("\n");
  throw new Error(
    `GIF slug collision(s) detected; refusing to overwrite output files:\n${details}`,
  );
}

function collectPassedCaptures(report: JsonReport) {
  const captures: PassedCapture[] = [];
  const missingVideos: string[] = [];

  function visitSuite(suite: ReportSuite) {
    for (const spec of suite.specs ?? []) {
      const title = spec.title;
      const specPath = spec.file ?? suite.file ?? "";
      if (title.includes("@nogif")) {
        console.log(`[capture-gifs] skipping @nogif: ${specPath} :: ${title}`);
        continue;
      }

      for (const test of spec.tests ?? []) {
        const passedResults = (test.results ?? []).filter((result) => result.status === "passed");
        if (test.status !== "expected" && passedResults.length === 0) {
          continue;
        }

        const result = passedResults.at(-1);
        const video = result?.attachments?.find(
          (attachment) =>
            attachment.name === "video" &&
            attachment.path &&
            (attachment.contentType === "video/webm" || attachment.path.endsWith(".webm")),
        );

        if (!video?.path) {
          missingVideos.push(`${specPath} :: ${title}`);
          continue;
        }

        captures.push({
          title,
          spec: specPath,
          video: resolve(appRoot, video.path),
          durationMs: result?.duration ?? 0,
        });
      }
    }

    for (const child of suite.suites ?? []) {
      visitSuite(child);
    }
  }

  for (const suite of report.suites ?? []) {
    visitSuite(suite);
  }

  if (missingVideos.length > 0) {
    throw new Error(
      `Passed non-@nogif tests without video attachments:\n${missingVideos.join("\n")}`,
    );
  }

  return captures;
}

function convertToGif(capture: PassedCapture): ManifestEntry {
  if (!existsSync(capture.video)) {
    throw new Error(`Video attachment does not exist: ${capture.video}`);
  }

  const slug = gifSlugForCapture(capture);
  const gifPath = join(gifsDir, `${slug}.gif`);
  const palettePath = join(gifsDir, `${slug}.palette.png`);
  const vf = "fps=10,scale=960:-1:flags=lanczos";

  console.log(
    `[capture-gifs] converting ${capture.spec} :: ${capture.title} -> ${relative(repoRoot, gifPath)}`,
  );

  const palette = run("ffmpeg", [
    "-y",
    ...ffmpegArgs,
    "-i",
    capture.video,
    "-vf",
    `${vf},palettegen`,
    palettePath,
  ]);
  if (palette.status !== 0) {
    throw new Error(`ffmpeg palette generation failed for ${capture.video}`);
  }

  const gif = run("ffmpeg", [
    "-y",
    ...ffmpegArgs,
    "-i",
    capture.video,
    "-i",
    palettePath,
    "-lavfi",
    `${vf} [x]; [x][1:v] paletteuse`,
    gifPath,
  ]);
  if (gif.status !== 0) {
    throw new Error(`ffmpeg gif conversion failed for ${capture.video}`);
  }

  rmSync(palettePath, { force: true });

  const bytes = statSync(gifPath).size;
  if (bytes < 20_000) {
    throw new Error(`Generated gif is under 20KB: ${gifPath} (${bytes} bytes)`);
  }

  return {
    slug,
    title: capture.title,
    spec: capture.spec,
    gif: relative(repoRoot, gifPath),
    bytes,
    durationMs: capture.durationMs,
  };
}

function main() {
  rmSync(resolve(appRoot, "capture-results"), { recursive: true, force: true });
  rmSync(resolve(appRoot, "capture-report"), { recursive: true, force: true });
  rmSync(artifactRoot, { recursive: true, force: true });
  mkdirSync(gifsDir, { recursive: true });
  mkdirSync(dirname(reportPath), { recursive: true });

  const ffmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  if (ffmpeg.status !== 0) {
    throw new Error("Host ffmpeg is required for gif capture conversion.");
  }

  const playwright = run("pnpm", [
    "-C",
    "apps/smithers",
    "exec",
    "playwright",
    "test",
    "--config",
    "playwright.capture.config.ts",
  ]);

  if (playwright.status !== 0) {
    throw new Error(`Playwright capture run failed with exit code ${playwright.status ?? "unknown"}`);
  }

  if (!existsSync(reportPath)) {
    throw new Error(`Playwright JSON report was not written: ${reportPath}`);
  }

  const report = JSON.parse(readFileSync(reportPath, "utf8")) as JsonReport;
  const captures = collectPassedCaptures(report);
  assertUniqueGifSlugs(captures);
  const manifest = captures.map(convertToGif).sort((a, b) => {
    const specOrder = a.spec.localeCompare(b.spec);
    return specOrder === 0 ? a.title.localeCompare(b.title) : specOrder;
  });
  const distinctGifs = new Set(manifest.map((entry) => entry.gif));

  if (distinctGifs.size !== manifest.length) {
    throw new Error(
      `Manifest contains duplicate gif paths: ${manifest.length} entries reference ${distinctGifs.size} files`,
    );
  }

  if (distinctGifs.size < 8) {
    throw new Error(`Expected at least 8 feature gifs, produced ${distinctGifs.size}`);
  }

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[capture-gifs] wrote ${manifest.length} gifs and ${relative(repoRoot, manifestPath)}`);
}

if (import.meta.main) {
  main();
}
