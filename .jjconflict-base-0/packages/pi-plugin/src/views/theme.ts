// Shared theming helpers for the pi-tui inspector views. Theme methods are
// optional so every view degrades to plain (uncolored) text when the host
// provides no theme.
export type Theme = {
  fg?: (color: string, value: string) => string;
  bold?: (value: string) => string;
};

export function paint(theme: Theme, color: string, value: string) {
  return theme.fg ? theme.fg(color, value) : value;
}

export function bold(theme: Theme, value: string) {
  return theme.bold ? theme.bold(value) : value;
}

export function stripAnsi(value: string) {
  return value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
}
