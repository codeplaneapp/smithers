/** @jsxImportSource @opentui/react */

import { nodeStatusColor, nodeStatusGlyph } from "./status.ts";

export { nodeStatusColor, nodeStatusGlyph } from "./status.ts";

export type StatusGlyphProps = {
  status: string;
};

/** A node's status glyph, colored. Props-in/callbacks-out: no business logic. */
export function StatusGlyph({ status }: StatusGlyphProps) {
  return <text fg={nodeStatusColor(status)}>{nodeStatusGlyph(status)}</text>;
}
