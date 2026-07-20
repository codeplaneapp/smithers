#!/usr/bin/env bash
# Render the deck to per-slide PNGs for visual QA.
# Usage: marketing/investor-deck/render.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SOFFICE="/Applications/LibreOffice.app/Contents/MacOS/soffice"
OUT="$HERE/render"
rm -rf "$OUT" && mkdir -p "$OUT"

# pptx -> pdf
"$SOFFICE" --headless --convert-to pdf --outdir "$OUT" "$HERE/smithers-investor-deck.pptx" >/dev/null 2>&1
PDF="$OUT/smithers-investor-deck.pdf"

# pdf -> png per page (ffmpeg can't page pdf; use sips? use pdftoppm if present, else macOS 'sips' on each page via Quartz)
if command -v pdftoppm >/dev/null 2>&1; then
  pdftoppm -r 110 -png "$PDF" "$OUT/slide" >/dev/null 2>&1
else
  # fall back: use the bundled LibreOffice to export PNGs directly is per-page-hard;
  # use macOS 'sips'/Quartz via a tiny python pdf->png (PyMuPDF) if available, else just keep the PDF.
  python3 - "$PDF" "$OUT" <<'PY' 2>/dev/null || echo "no pdftoppm/PyMuPDF — open the PDF at $PDF"
import sys
try:
    import fitz  # PyMuPDF
except Exception:
    sys.exit(1)
pdf, out = sys.argv[1], sys.argv[2]
doc = fitz.open(pdf)
for i, page in enumerate(doc, 1):
    pix = page.get_pixmap(dpi=110)
    pix.save(f"{out}/slide-{i:02d}.png")
PY
fi
echo "rendered to $OUT"
ls "$OUT"
