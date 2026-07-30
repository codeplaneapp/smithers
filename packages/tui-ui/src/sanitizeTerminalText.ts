export type SanitizeTerminalTextOptions = {
  /** Preserve ANSI SGR color/style sequences. All other escape sequences are stripped. */
  preserveSgr?: boolean;
};

const ESC = 0x1b;
const BEL = 0x07;
const C1_CSI = 0x9b;
const C1_ST = 0x9c;
const C1_OSC = 0x9d;
const STRING_CONTROLS = new Set([0x90, 0x98, 0x9e, 0x9f]);

function skipStringControl(value: string, start: number): number {
  let index = start;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code === BEL || code === C1_ST) return index + 1;
    if (code === ESC && value.charCodeAt(index + 1) === 0x5c) return index + 2;
    index += 1;
  }
  return index;
}

function consumeCsi(value: string, start: number): { end: number; isSgr: boolean } {
  let index = start;
  let validSgrBody = true;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) {
      return { end: index + 1, isSgr: validSgrBody && code === 0x6d };
    }
    if (code < 0x20 || code > 0x3f) validSgrBody = false;
    index += 1;
  }
  return { end: index, isSgr: false };
}

/**
 * Make untrusted text safe to write to a terminal or OpenTUI text buffer.
 * Newlines and tabs survive; C0/C1 controls and terminal escape sequences do not.
 */
export function sanitizeTerminalText(value: unknown, options: SanitizeTerminalTextOptions = {}): string {
  const input = String(value ?? "");
  let output = "";
  let index = 0;

  while (index < input.length) {
    const code = input.charCodeAt(index);

    if (code === ESC) {
      const next = input.charCodeAt(index + 1);
      if (next === 0x5d) {
        index = skipStringControl(input, index + 2);
      } else if (next === 0x5b) {
        const sequence = consumeCsi(input, index + 2);
        if (options.preserveSgr && sequence.isSgr) output += input.slice(index, sequence.end);
        index = sequence.end;
      } else if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
        index = skipStringControl(input, index + 2);
      } else {
        index += 1;
        while (index < input.length && input.charCodeAt(index) >= 0x20 && input.charCodeAt(index) <= 0x2f) {
          index += 1;
        }
        if (index < input.length && input.charCodeAt(index) >= 0x30 && input.charCodeAt(index) <= 0x7e) {
          index += 1;
        }
      }
      continue;
    }

    if (code === C1_OSC || STRING_CONTROLS.has(code)) {
      index = skipStringControl(input, index + 1);
      continue;
    }

    if (code === C1_CSI) {
      const sequence = consumeCsi(input, index + 1);
      if (options.preserveSgr && sequence.isSgr) output += `\x1b[${input.slice(index + 1, sequence.end)}`;
      index = sequence.end;
      continue;
    }

    if ((code >= 0x00 && code <= 0x1f && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f)) {
      index += 1;
      continue;
    }

    output += input[index];
    index += 1;
  }

  return output;
}
