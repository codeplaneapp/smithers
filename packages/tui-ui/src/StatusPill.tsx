/** @jsxImportSource @opentui/react */

/**
 * The shared status tone vocabulary, mirroring `@smithers-orchestrator/ui`'s
 * `StatusClass` ("ok" | "warn" | "bad" | "muted" | "run") so a web reader
 * recognizes the terminal coloring. Kept as a local copy, not an import: leaf
 * visual packages carry no cross-package coupling (props-in/callbacks-out).
 */
export type TuiStatusTone = "ok" | "warn" | "bad" | "muted" | "run";

const TONE_GLYPH: Readonly<Record<TuiStatusTone, string>> = {
  ok: "●",
  warn: "●",
  bad: "●",
  muted: "○",
  run: "◐",
};

const TONE_COLOR: Readonly<Record<TuiStatusTone, string>> = {
  ok: "#5faf5f",
  warn: "#d7af00",
  bad: "#d75f5f",
  muted: "#888888",
  run: "#00d7ff",
};

/** The leading glyph for a status tone. Pure so it is testable without a TTY. */
export function statusPillGlyph(tone: TuiStatusTone): string {
  return TONE_GLYPH[tone];
}

/** The color for a status tone. Pure so it is testable without a TTY. */
export function statusPillColor(tone: TuiStatusTone): string {
  return TONE_COLOR[tone];
}

export type StatusPillProps = {
  tone: TuiStatusTone;
  label: string;
};

/** Status tone in, colored glyph + label out. Props-in/callbacks-out: no business logic. */
export function StatusPill({ tone, label }: StatusPillProps) {
  return (
    <box flexDirection="row">
      <text fg={statusPillColor(tone)}>{`${statusPillGlyph(tone)} `}</text>
      <text fg="#cccccc">{label}</text>
    </box>
  );
}
