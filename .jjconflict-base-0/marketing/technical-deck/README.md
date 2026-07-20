# Smithers technical deck — Google Slides edition

A real `.pptx` of the **technical / product deck** generated from the terminal
demo in `.smithers/workflows/demo.tsx` (the deck `.smithers/scripts/run-demo.sh`
plays). PowerPoint Open XML is the format Google Slides imports at full
fidelity, so **no Slides API or MCP server is needed.**

- `smithers-technical-deck.pptx` — the deck. 35 slides, 16:9.
- Every slide's spoken narration from the terminal deck is preserved verbatim as
  **speaker notes**.
- Native, editable text / shapes (no flat screenshots) — the terminal look
  (dark panels, monospace, colored boxes) is reproduced with real shapes.
- Code slides are rendered as syntax-highlighted "editor" panels.
- The two **live-demo** slides (durability, time travel) — which run real
  nested `smithers up` sub-runs in the terminal — are shown as the workflow
  source plus the expected transcript. Run them live from the terminal during
  the talk for the real thing.

## Get it into Google Slides

1. Go to [slides.google.com](https://slides.google.com) → upload, **or** drop the
   `.pptx` into Google Drive.
2. Right-click → **Open with → Google Slides** (Drive auto-converts it).
   - Or, into an existing deck: **File → Import slides → Upload**.

Fonts used: **Inter** + **Roboto Mono** (both in the Google Slides font picker).

## Regenerate / update

The deck content mirrors the `SLIDES` array in `.smithers/workflows/demo.tsx`.
Edit the `SLIDES` list near the top of `build_deck.py` to match, then rebuild:

```bash
python3 -m venv marketing/technical-deck/.venv
marketing/technical-deck/.venv/bin/pip install python-pptx
marketing/technical-deck/.venv/bin/python marketing/technical-deck/build_deck.py
```

## Preview every slide as PNG (optional QA)

Needs LibreOffice + poppler (`brew install --cask libreoffice` / `brew install poppler`):

```bash
marketing/technical-deck/render.sh   # writes render/slide-*.png
```
