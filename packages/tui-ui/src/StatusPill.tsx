/** @jsxImportSource @opentui/react */

import { statusToneColor, type TuiStatusTone } from "./status.ts";

export { statusToneColor as statusPillColor, type TuiStatusTone } from "./status.ts";

const TONE_GLYPH: Readonly<Record<TuiStatusTone, string>> = {
  ok: "●",
  warn: "●",
  bad: "●",
  muted: "○",
  run: "◐",
};

/** The leading glyph for a status tone. Pure so it is testable without a TTY. */
export function statusPillGlyph(tone: TuiStatusTone): string {
  return TONE_GLYPH[tone];
}

export type StatusPillProps = {
  tone: TuiStatusTone;
  label: string;
};

/** Status tone in, colored glyph + label out. Props-in/callbacks-out: no business logic. */
export function StatusPill({ tone, label }: StatusPillProps) {
  return (
    <box flexDirection="row">
      <text fg={statusToneColor(tone)}>{`${statusPillGlyph(tone)} `}</text>
      <text fg="#cccccc">{label}</text>
    </box>
  );
}
