import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

type ManifestEntry = {
  slug: string;
  title: string;
  spec: string;
  gif: string;
};

const repoRoot = process.cwd();
const artifactRoot = resolve(repoRoot, "artifacts/feature-gifs");
const manifestPath = resolve(artifactRoot, "manifest.json");
const slideshowPath = resolve(artifactRoot, "index.html");

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function humanizeTitle(entry: ManifestEntry) {
  const specName = basename(entry.spec, ".spec.ts")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ");
  const title = entry.title
    .replace(/^\//, "")
    .replaceAll("/", " / ")
    .replace(/\s+/g, " ")
    .trim();
  const combined = `${specName}: ${title}`;
  return combined.charAt(0).toUpperCase() + combined.slice(1);
}

function relativeGifPath(entry: ManifestEntry) {
  return `gifs/${entry.slug}.gif`;
}

if (!existsSync(manifestPath)) {
  throw new Error(`Feature GIF manifest does not exist: ${manifestPath}`);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ManifestEntry[];
if (!Array.isArray(manifest) || manifest.length === 0) {
  throw new Error(`Feature GIF manifest must contain at least one entry: ${manifestPath}`);
}

for (const entry of manifest) {
  const gifPath = resolve(artifactRoot, relativeGifPath(entry));
  if (!entry.slug || !entry.title || !entry.spec || !existsSync(gifPath)) {
    throw new Error(`Invalid slideshow manifest entry or missing gif: ${JSON.stringify(entry)}`);
  }
}

const generatedAt = new Date().toISOString();
const totalSlides = manifest.length + 1;
const slides = [
  `<section class="slide title-slide is-active" data-testid="slideshow-slide" aria-label="Title slide">
    <div class="title-copy">
      <p class="eyebrow">Generated ${escapeHtml(generatedAt)}</p>
      <h1 data-testid="slideshow-title">Smithers &mdash; features proven end-to-end</h1>
      <p class="count">${manifest.length} captured feature GIFs</p>
      <div class="commands" aria-label="Regeneration commands">
        <code>bun scripts/e2e-real/capture-gifs.ts</code>
        <code>bun scripts/e2e-real/build-slideshow.ts</code>
      </div>
    </div>
  </section>`,
  ...manifest.map(
    (entry) => `<section class="slide gif-slide" data-testid="slideshow-slide" aria-label="${escapeHtml(
      humanizeTitle(entry),
    )}">
    <div class="feature-copy">
      <p class="eyebrow">${escapeHtml(entry.spec)}</p>
      <h2 data-testid="slideshow-title">${escapeHtml(humanizeTitle(entry))}</h2>
    </div>
    <figure>
      <img src="${escapeHtml(relativeGifPath(entry))}" alt="${escapeHtml(humanizeTitle(entry))}" loading="eager" />
      <figcaption>Proved by ${escapeHtml(entry.spec)}</figcaption>
    </figure>
  </section>`,
  ),
].join("\n");

const dots = Array.from(
  { length: totalSlides },
  (_, index) =>
    `<button type="button" class="dot${index === 0 ? " is-active" : ""}" aria-label="Go to slide ${
      index + 1
    }" aria-current="${index === 0 ? "true" : "false"}" data-slide-index="${index}"></button>`,
).join("");

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Smithers &mdash; features proven end-to-end</title>
  <style>
    :root {
      color-scheme: dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #111316;
      color: #f5f0e8;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: #111316;
      color: #f5f0e8;
      overflow: hidden;
    }
    main {
      min-height: 100vh;
      display: grid;
      grid-template-rows: 1fr auto;
    }
    .slides {
      position: relative;
      min-height: 0;
    }
    .slide {
      position: absolute;
      inset: 0;
      display: grid;
      align-items: center;
      justify-items: center;
      gap: 28px;
      padding: 44px 56px 104px;
      opacity: 0;
      transform: translateX(24px);
      pointer-events: none;
      transition: opacity 180ms ease, transform 180ms ease;
    }
    .slide.is-active {
      opacity: 1;
      transform: translateX(0);
      pointer-events: auto;
    }
    .title-slide {
      align-content: center;
      text-align: center;
      background:
        linear-gradient(135deg, rgba(84, 132, 196, 0.22), transparent 42%),
        linear-gradient(315deg, rgba(214, 108, 81, 0.2), transparent 40%),
        #111316;
    }
    .title-copy, .feature-copy {
      width: min(1080px, 100%);
    }
    .eyebrow {
      margin: 0 0 12px;
      color: #9fb8d8;
      font-size: 14px;
      font-weight: 700;
      letter-spacing: 0;
      text-transform: uppercase;
    }
    h1, h2 {
      margin: 0;
      letter-spacing: 0;
      line-height: 1.02;
    }
    h1 {
      font-size: clamp(42px, 8vw, 96px);
      max-width: 1050px;
      margin-inline: auto;
    }
    h2 {
      font-size: clamp(28px, 4.2vw, 58px);
      max-width: 1180px;
    }
    .count {
      margin: 22px 0 0;
      color: #d9d1c3;
      font-size: 20px;
    }
    .commands {
      display: grid;
      gap: 10px;
      justify-content: center;
      margin-top: 34px;
    }
    code {
      display: block;
      padding: 10px 14px;
      border: 1px solid #3f4751;
      border-radius: 6px;
      background: #171b20;
      color: #f6e7ba;
      font: 15px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      overflow-wrap: anywhere;
    }
    .gif-slide {
      grid-template-rows: auto minmax(0, 1fr);
      align-items: stretch;
      justify-items: stretch;
      background: #15181d;
    }
    figure {
      min-height: 0;
      display: grid;
      grid-template-rows: minmax(0, 1fr) auto;
      gap: 14px;
      margin: 0;
    }
    img {
      width: 100%;
      height: 100%;
      min-height: 0;
      object-fit: contain;
      border: 1px solid #303842;
      border-radius: 8px;
      background: #0d0f12;
    }
    figcaption {
      color: #d9d1c3;
      font-size: 15px;
      text-align: center;
    }
    .controls {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: 18px;
      padding: 16px 22px;
      border-top: 1px solid #2f3741;
      background: rgba(17, 19, 22, 0.94);
      backdrop-filter: blur(12px);
    }
    .button-row {
      display: flex;
      gap: 10px;
    }
    button {
      min-width: 44px;
      min-height: 40px;
      border: 1px solid #48515d;
      border-radius: 6px;
      background: #20262d;
      color: #f5f0e8;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }
    button:hover { background: #2b333d; }
    .dots {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      min-width: 0;
      overflow-x: auto;
      padding: 6px 0;
    }
    .dot {
      min-width: 10px;
      width: 10px;
      min-height: 10px;
      height: 10px;
      padding: 0;
      border-radius: 999px;
      border-color: #596472;
      background: #596472;
    }
    .dot.is-active {
      width: 28px;
      background: #f6e7ba;
      border-color: #f6e7ba;
    }
    .counter {
      min-width: 72px;
      color: #d9d1c3;
      font-variant-numeric: tabular-nums;
      text-align: right;
    }
    @media (max-width: 720px) {
      .slide { padding: 28px 18px 118px; }
      .controls {
        grid-template-columns: 1fr;
        justify-items: center;
        gap: 8px;
      }
      .counter { text-align: center; }
    }
  </style>
</head>
<body>
  <main>
    <div class="slides">
      ${slides}
    </div>
    <nav class="controls" aria-label="Slideshow controls">
      <div class="button-row">
        <button type="button" data-testid="slideshow-prev" aria-label="Previous slide">Prev</button>
        <button type="button" data-testid="slideshow-next" aria-label="Next slide">Next</button>
      </div>
      <div class="dots" data-testid="slideshow-dots">${dots}</div>
      <div class="counter" aria-live="polite">1 / ${totalSlides}</div>
    </nav>
  </main>
  <script>
    (() => {
      const slides = Array.from(document.querySelectorAll('[data-testid="slideshow-slide"]'));
      const dots = Array.from(document.querySelectorAll('[data-slide-index]'));
      const counter = document.querySelector('.counter');
      const prev = document.querySelector('[data-testid="slideshow-prev"]');
      const next = document.querySelector('[data-testid="slideshow-next"]');
      let current = 0;

      function show(index) {
        current = (index + slides.length) % slides.length;
        slides.forEach((slide, slideIndex) => {
          slide.classList.toggle('is-active', slideIndex === current);
          slide.setAttribute('aria-hidden', slideIndex === current ? 'false' : 'true');
        });
        dots.forEach((dot, dotIndex) => {
          dot.classList.toggle('is-active', dotIndex === current);
          dot.setAttribute('aria-current', dotIndex === current ? 'true' : 'false');
        });
        counter.textContent = String(current + 1) + ' / ' + String(slides.length);
      }

      prev.addEventListener('click', () => show(current - 1));
      next.addEventListener('click', () => show(current + 1));
      dots.forEach((dot) => {
        dot.addEventListener('click', () => show(Number(dot.dataset.slideIndex)));
      });
      window.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowLeft') show(current - 1);
        if (event.key === 'ArrowRight') show(current + 1);
      });
      show(0);
    })();
  </script>
</body>
</html>
`;

writeFileSync(slideshowPath, html);
console.log(`[build-slideshow] wrote ${slideshowPath}`);
