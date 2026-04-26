import { format } from "node:util";
import { Logger } from "effect";

type JsonModeState = {
  jsonMode: boolean;
  consoleRoutingInstalled: boolean;
  originalConsole?: {
    debug: typeof console.debug;
    error: typeof console.error;
    info: typeof console.info;
    log: typeof console.log;
    trace: typeof console.trace;
    warn: typeof console.warn;
  };
};

const STATE_KEY = Symbol.for("smithers.cli.jsonMode");

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
    if (isJsonMode()) return writeConsoleArgsToStderr(args);
    return originalConsole.debug(...args);
  };
  console.error = (...args: unknown[]) => {
    if (isJsonMode()) return writeConsoleArgsToStderr(args);
    return originalConsole.error(...args);
  };
  console.info = (...args: unknown[]) => {
    if (isJsonMode()) return writeConsoleArgsToStderr(args);
    return originalConsole.info(...args);
  };
  console.log = (...args: unknown[]) => {
    if (isJsonMode()) return writeConsoleArgsToStderr(args);
    return originalConsole.log(...args);
  };
  console.trace = (...args: unknown[]) => {
    if (isJsonMode()) return writeConsoleArgsToStderr(args);
    return originalConsole.trace(...args);
  };
  console.warn = (...args: unknown[]) => {
    if (isJsonMode()) return writeConsoleArgsToStderr(args);
    return originalConsole.warn(...args);
  };

  state.originalConsole = originalConsole;
  state.consoleRoutingInstalled = true;
}

export const smithersEffectLogger = Logger.make<unknown, void>((options) => {
  const line = Logger.stringLogger.log(options);
  const stream = isJsonMode() ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
});

export const SmithersLoggerLayer = Logger.replace(
  Logger.defaultLogger,
  smithersEffectLogger,
);

installJsonModeConsoleRouting();
