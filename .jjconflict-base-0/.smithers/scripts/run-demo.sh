#!/usr/bin/env bash
# Keyboard-driven Smithers slide deck.
#
#   ▸ / Space / Enter / Down  — next slide
#   ◂ / Up                    — previous slide
#   r                         — replay current slide's narration
#   m                         — mute / unmute audio for the rest of the deck
#   q / Esc / Ctrl-C          — quit
#
# Usage (from repo root):
#   ./.smithers/scripts/run-demo.sh                # full deck, audio on
#   ./.smithers/scripts/run-demo.sh --silent       # no audio
#   ./.smithers/scripts/run-demo.sh --start-at 12  # jump straight to slide 13
#   ./.smithers/scripts/run-demo.sh --voice Daniel
#   ./.smithers/scripts/run-demo.sh --auto --silent --auto-ms 4000   # auto rehearsal
#
# Any other flags get forwarded to `smithers up`.

set -euo pipefail

cd "$(dirname "$0")/../.."

silent=false
auto=false
auto_ms=8000
start_at=0
voice="Ava (Premium)"
rate=195
forward=()

while (("$#")); do
  case "$1" in
    --silent|--no-audio|--no-sound|--mute)
                 silent=true; shift ;;
    --auto)      auto=true; shift ;;
    --auto-ms)   auto_ms=$2; shift 2 ;;
    --start-at)  start_at=$2; shift 2 ;;
    --voice)     voice=$2; shift 2 ;;
    --rate)      rate=$2; shift 2 ;;
    *)           forward+=("$1"); shift ;;
  esac
done

input=$(printf '{"silent":%s,"auto":%s,"autoMs":%s,"startAt":%s,"voice":"%s","rate":%s}' \
  "$silent" "$auto" "$auto_ms" "$start_at" "$voice" "$rate")

exec bun run smithers up .smithers/workflows/demo.tsx \
  --input "$input" "${forward[@]+"${forward[@]}"}"
