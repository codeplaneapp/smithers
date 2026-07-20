export type Env = { LOG_LEVEL?: string };

export function readLogLevel(env: Env): string {
  return env.LOG_LEVEL!;
}
