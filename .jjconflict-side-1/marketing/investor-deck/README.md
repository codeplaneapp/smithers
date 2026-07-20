# Smithers investor deck — Google Slides edition

A real `.pptx` investor deck generated from the terminal pitch deck in
`.smithers/workflows/investor.tsx`. PowerPoint Open XML is the format Google
Slides imports at full fidelity, so **no Slides API or MCP server is needed.**

- `smithers-investor-deck.pptx` — the deck. 19 slides, 16:9.
- Every slide's terminal narration is preserved verbatim as **speaker notes**.
- Native, editable text / shapes / charts (no flat screenshots of slides).
- Embeds real product **GIFs** (animate in present mode) + screenshots from
  `marketing/*/assets`, copied into `assets/`.

## Get it into Google Slides

1. Go to [slides.google.com](https://slides.google.com) → upload, **or** drop the
   `.pptx` into Google Drive.
2. Right-click → **Open with → Google Slides** (Drive auto-converts it).
   - Or, into an existing deck: **File → Import slides → Upload**.
3. Animated GIFs play in **present mode** (Slides keeps them animated on import).

Fonts used: **Inter** + **Roboto Mono** (both in the Google Slides font picker).

## Regenerate / update the numbers

The traction figures live in the `DOWNLOADS` / `STARS` blocks near the top of
`build_deck.py` (mirroring the `DATA` block in `investor.tsx`). Refresh them,
then rebuild:

```bash
python3 -m venv marketing/investor-deck/.venv
marketing/investor-deck/.venv/bin/pip install python-pptx
marketing/investor-deck/.venv/bin/python marketing/investor-deck/build_deck.py
```

## Preview every slide as PNG (optional QA)

Needs LibreOffice + poppler (`brew install --cask libreoffice` / `brew install poppler`):

```bash
marketing/investor-deck/render.sh   # writes render/slide-*.png
```
