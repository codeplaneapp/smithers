/**
 * The xterm.js `ITheme` fields the Smithers terminal adapter sets. Kept as a
 * plain record so the styleguide stays free of an `@xterm/xterm` dependency;
 * the adapter widens it to `ITheme` at the call site.
 */
export type TerminalPalette = {
  background: string;
  foreground: string;
  cursor: string;
  /** An upstream alpha color, or a derived rgba fallback when the theme omits one. */
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
};
