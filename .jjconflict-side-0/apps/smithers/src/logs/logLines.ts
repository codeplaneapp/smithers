/** A transcript line. `noise` lines are hidden by "Hide noise". */
export type LogRole = "agent" | "tool" | "noise";

export type LogLine = {
  role: LogRole;
  text: string;
  /** When set, the substring is masked while Redact is on. */
  secret?: string;
};

export const AUTH_REFACTOR_LOG: LogLine[] = [
  { role: "agent", text: "Reading auth/session.ts to map the token flow." },
  { role: "tool", text: 'grep "sign(" → 3 matches' },
  { role: "noise", text: "spawned pid 48213 · pty attach · heartbeat ok" },
  {
    role: "agent",
    text: "Rotating tokens; setting ttl from env ROTATE_TTL=sk-rotate-9f21",
    secret: "sk-rotate-9f21",
  },
  { role: "tool", text: "Edit auth/session.ts (+18 −4)" },
  { role: "noise", text: "fs watch · 6 files · debounce 120ms" },
  { role: "tool", text: "Write auth/token.ts (+31 −9)" },
  { role: "agent", text: "Done editing. Running the suite next." },
];
