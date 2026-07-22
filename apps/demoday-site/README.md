# Smithers demo-day pitch

The 3-minute, YC-demo-day-style pitch deck, live at https://demoday.smithers.sh,
plus the working documents behind it. Moved here from the standalone `~/pitches`
project.

## Run the deck locally

```sh
pnpm -C apps/demoday-site dev
```

Keys: **→ / space** next · **←** back · **N** speaker notes · **P** rehearsal
mode (TTS narration plays and auto-advances the deck; the full read is 3:00) ·
**T** 3:00 timer (**R** resets) · **F** fullscreen. 14 steps; steps 5–9 are one
"super slide" that advances through five product screenshots.

The narration in `public/narration/` is generated from the slide notes with
OpenAI TTS: `OPENAI_API_KEY=... bun scripts/narrate.ts` (re-run after editing
notes in `src/slides.ts`; the worker test pins the total at 3:00).

## Deploy

```sh
pnpm -C apps/demoday-site build        # vite build → site/
pnpm -C apps/demoday-site run deploy   # wrangler → demoday.smithers.sh
```

The Worker (`src/worker.ts`) serves the built `site/` directory with security and
cache headers, the same pattern as the other `apps/*-site` workers.

## Files

- `script.md` — the read-aloud presenter script with clock marks and cut lines
- `pitch-v2.md` — the current pitch content (source of truth for the slides)
- `pitch-v1.md` — earlier draft
- `demo-day-template.md` — the 3-minute demo-day format template
- `airbnb-template.md` — the Airbnb 2008 deck template (content-quality reference)
- `materials.md` — distilled facts: traction, taglines, pricing, competition, tensions
- `TODO.md` — recorded iteration notes
- `public/shots/` — product screenshots from the multi UI
- `src/slides.ts` — slide copy + the traction chart; edit here to change the deck
- `src/main.ts` — deck runtime (navigation, notes, timer)
