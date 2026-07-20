#!/usr/bin/env bash
# Encode captured frame sequences (/tmp/anim/<card>) into looping GIFs.
# Usage: marketing/0.22.0/assets/_gif.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
FPS=20
WIDTH=1200

encode() {
  local name="$1" out="$2"
  local src="/tmp/anim/${name}"
  local pal="/tmp/anim/${name}-palette.png"
  ffmpeg -y -framerate "$FPS" -i "${src}/f%04d.png" \
    -vf "fps=${FPS},scale=${WIDTH}:-1:flags=lanczos,palettegen=stats_mode=full" "$pal" >/dev/null 2>&1
  ffmpeg -y -framerate "$FPS" -i "${src}/f%04d.png" -i "$pal" \
    -lavfi "fps=${FPS},scale=${WIDTH}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=sierra2_4a" \
    -loop 0 "${HERE}/${out}" >/dev/null 2>&1
  echo "encoded ${out} ($(du -h "${HERE}/${out}" | cut -f1))"
}

encode fork task-fork.gif
encode chat chat-first.gif
