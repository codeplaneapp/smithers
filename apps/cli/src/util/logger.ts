import { format, inspect } from "node:util";
import { Cause, Layer, Logger, LogLevel } from "effect";
import pc from "picocolors";

type JsonModeState = {
  jsonMode: boolean;
  consoleRoutingInstalled: boolean;
};

const STATE_KEY = Symbol.for("smithers.cli.jsonMode");
const ANSI_RE = /\x1B\[[0-9;]*m/g;
type CliLoggerOptions = Parameters<typeof Logger.stringLogger.log>[0];

function getState(): JsonModeState {
  const globalState = globalThis as typeof globalThis & {
    [STATE_KEY]?: JsonModeState;
  };
  globalState[STATE_KEY] ??= {
    jsonMode: false,
    consoleRoutingInstalled: false,
  };
  return globalState[STATE_KEY];
}

export function setJsonMode(enabled: boolean): void {
  getState().jsonMode = enabled;
}

export function isJsonMode(): boolean {
  return getState().jsonMode === true;
}

function writeConsoleArgsToStderr(args: ReadonlyArray<unknown>): void {
  process.stderr.write(`${format(...args)}\n`);
}

export function resolveCliLogLevel(value: string | undefined = process.env.SMITHERS_LOG_LEVEL): LogLevel.LogLevel {
  switch ((value ?? "info").toLowerCase()) {
    case "all":
      return LogLevel.All;
    case "trace":
      return LogLevel.Trace;
    case "debug":
      return LogLevel.Debug;
    case "info":
      return LogLevel.Info;
    case "warning":
    case "warn":
      return LogLevel.Warning;
    case "error":
      return LogLevel.Error;
    case "fatal":
      return LogLevel.Fatal;
    case "none":
    case "off":
    case "silent":
      return LogLevel.None;
    default:
      return LogLevel.Warning;
  }
}

export function shouldEmitLogLevel(
  logLevel: LogLevel.LogLevel,
  minimum: LogLevel.LogLevel = resolveCliLogLevel(),
): boolean {
  return logLevel.ordinal >= minimum.ordinal;
}

function visibleLength(value: string): number {
  return value.replace(ANSI_RE, "").length;
}

function wrapLine(text: string, width: number): string[] {
  const max = Math.max(20, width);
  const words = String(text)
    .replace(/[\r\n]+/g, " ")
    .split(/ +/)
    .filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (!line) {
      line = word;
    } else if (visibleLength(line) + 1 + visibleLength(word) <= max) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
    while (visibleLength(line) > max) {
      lines.push(line.slice(0, max));
      line = line.slice(max);
    }
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [""];
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  return inspect(value, {
    breakLength: Infinity,
    colors: false,
    compact: true,
    depth: 4,
  });
}

function formatMessage(message: unknown): string {
  const parts = Array.isArray(message) ? message : [message];
  return parts.map(formatValue).join(" ");
}

function formatDetailValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string" && /^[^\s=]+$/.test(value)) return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return inspect(value, {
    breakLength: Infinity,
    colors: false,
    compact: true,
    depth: 2,
  }).replace(/\s+/g, " ");
}

function styleLevel(logLevel: LogLevel.LogLevel): string {
  const label = (logLevel.label === "WARN" ? "warn" : logLevel.label.toLowerCase()).padEnd(5);
  switch (logLevel._tag) {
    case "Fatal":
      return pc.bgRed(pc.white(label));
    case "Error":
      return pc.red(label);
    case "Warning":
      return pc.yellow(label);
    case "Info":
      return pc.cyan(label);
    case "Debug":
    case "Trace":
      return pc.dim(label);
    default:
      return pc.dim(label);
  }
}

function formatLogDetails(options: CliLoggerOptions): string[] {
  const details: string[] = [];
  const now = options.date.getTime();
  for (const span of options.spans) {
    details.push(`${span.label}=${Math.max(0, now - span.startTime)}ms`);
  }
  for (const [key, value] of options.annotations) {
    if (key === "service" && value === "smithers") continue;
    details.push(`${key}=${formatDetailValue(value)}`);
  }
  if (!Cause.isEmpty(options.cause)) {
    details.push(`cause=${Cause.pretty(options.cause, { renderErrorCause: true }).replace(/\s+/g, " ")}`);
  }
  return details;
}

function formatCompactLog(logLevel: LogLevel.LogLevel, message: string, details: ReadonlyArray<string> = []): string {
  const prefix = `${styleLevel(logLevel)} `;
  const body = details.length > 0 ? `${message}  ${pc.dim(details.join(" "))}` : message;
  const width = Math.max(20, (process.stdout.columns || 100) - visibleLength(prefix));
  const lines = wrapLine(body, width);
  const continuation = " ".repeat(visibleLength(prefix));
  return lines.map((line, index) => `${index === 0 ? prefix : continuation}${line}`).join("\n");
}

export function formatCliLogLine(options: CliLoggerOptions): string {
  return formatCompactLog(options.logLevel, formatMessage(options.message), formatLogDetails(options));
}

function routeConsoleArgs(args: ReadonlyArray<unknown>, original: (...args: unknown[]) => void): void {
  if (isJsonMode()) return writeConsoleArgsToStderr(args);
  return original(...args);
}

export function installJsonModeConsoleRouting(): void {
  const state = getState();
  if (state.consoleRoutingInstalled) {
    return;
  }

  const originalConsole = {
    debug: console.debug.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
    log: console.log.bind(console),
    trace: console.trace.bind(console),
    warn: console.warn.bind(console),
  };

  console.debug = (...args: unknown[]) => {
    return routeConsoleArgs(args, originalConsole.debug);
  };
  console.error = (...args: unknown[]) => {
    return routeConsoleArgs(args, originalConsole.error);
  };
  console.info = (...args: unknown[]) => {
    return routeConsoleArgs(args, originalConsole.info);
  };
  console.log = (...args: unknown[]) => {
    return routeConsoleArgs(args, originalConsole.log);
  };
  console.trace = (...args: unknown[]) => {
    return routeConsoleArgs(args, originalConsole.trace);
  };
  console.warn = (...args: unknown[]) => {
    return routeConsoleArgs(args, originalConsole.warn);
  };

  state.consoleRoutingInstalled = true;
}

export const smithersEffectLogger = Logger.make<unknown, void>((options) => {
  if (!shouldEmitLogLevel(options.logLevel)) return;
  const line = isJsonMode() ? Logger.stringLogger.log(options) : formatCliLogLine(options);
  const stream = isJsonMode() ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
});

export const SmithersLoggerLayer = Layer.mergeAll(
  Logger.replace(Logger.defaultLogger, smithersEffectLogger),
  Logger.minimumLogLevel(resolveCliLogLevel()),
);

installJsonModeConsoleRouting();
