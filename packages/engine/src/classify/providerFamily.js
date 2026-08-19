/**
 * Which provider family a failed attempt came from.
 *
 * Spec 1.5 keeps this in Smithers on purpose: the families differ in how they
 * say "you are out of quota" and, more importantly, in how they say when the
 * limit resets. That vocabulary is the hard-won part, and it is exactly what
 * must not migrate into an executor.
 *
 * @typedef {import("./WaitWakeClassifiers.ts").ProviderFamily} ProviderFamily
 */

/**
 * Agent engine id to provider family. The engine id is the reliable signal:
 * it is stamped on every `AGENT_QUOTA_EXCEEDED` by `BaseCliAgent`, whereas the
 * message text is provider-version dependent.
 * @type {Readonly<Record<string, ProviderFamily>>}
 */
const FAMILY_BY_ENGINE = Object.freeze({
  "claude-code": "anthropic",
  claude: "anthropic",
  anthropic: "anthropic",
  fable: "anthropic",
  openclaw: "anthropic",
  codex: "openai",
  nanocodex: "openai",
  openai: "openai",
  gemini: "google",
  antigravity: "google",
  google: "google",
  grok: "xai",
  xai: "xai",
});

/**
 * Message tokens that identify a family when the engine id is missing, keyed
 * by the family they prove. Order matters: the first match wins.
 * @type {ReadonlyArray<{ family: ProviderFamily; re: RegExp }>}
 */
const FAMILY_PATTERNS = Object.freeze([
  // Claude/Fable subscription banners: a wall-clock reset in a named zone, and
  // the credit-exhaustion banner that arrives on stdout with exit 0.
  { family: /** @type {ProviderFamily} */ ("anthropic"), re: /\bout\s+of\s+usage\s+credits\b/i },
  { family: /** @type {ProviderFamily} */ ("anthropic"), re: /\brun\s+\/usage-credits\b/i },
  { family: /** @type {ProviderFamily} */ ("anthropic"), re: /\bout_of_credits\b/i },
  {
    family: /** @type {ProviderFamily} */ ("anthropic"),
    re: /\breset(?:s)?\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)\s*\(/i,
  },
  // Codex/OpenAI 429 bodies carry the underscored machine token.
  { family: /** @type {ProviderFamily} */ ("openai"), re: /\busage_limit_reached\b/i },
  { family: /** @type {ProviderFamily} */ ("openai"), re: /\btry again at\s+[A-Z][a-z]+ \d+/i },
  // Gemini surfaces the gRPC status name alongside the quota message.
  { family: /** @type {ProviderFamily} */ ("google"), re: /\bRESOURCE_EXHAUSTED\b/ },
  { family: /** @type {ProviderFamily} */ ("google"), re: /\bquota\s+exceeded\b/i },
  { family: /** @type {ProviderFamily} */ ("xai"), re: /\bx\.?ai\b/i },
]);

/**
 * @param {string | null | undefined} engineId
 * @param {string} message
 * @returns {ProviderFamily}
 */
export function providerFamilyFor(engineId, message) {
  const byEngine = engineId ? FAMILY_BY_ENGINE[engineId.toLowerCase()] : undefined;
  if (byEngine) return byEngine;
  for (const candidate of FAMILY_PATTERNS) {
    if (candidate.re.test(message)) return candidate.family;
  }
  return "unknown";
}

/** @returns {ReadonlyArray<ProviderFamily>} every family the defaults know about */
export function knownProviderFamilies() {
  return ["anthropic", "openai", "google", "xai"];
}
