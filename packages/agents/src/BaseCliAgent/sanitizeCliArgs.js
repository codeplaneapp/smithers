const SENSITIVE_FLAG = /(?:^|[-_])(api[-_]?key|token|secret|password)(?:$|[-_=])/i;

/** @param {string[]} args @returns {string[]} */
export function sanitizeCliArgs(args) {
  const sanitized = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const equals = arg.indexOf("=");
    const flag = equals >= 0 ? arg.slice(0, equals) : arg;
    if (SENSITIVE_FLAG.test(flag)) {
      sanitized.push(equals >= 0 ? `${flag}=[REDACTED]` : arg);
      if (equals < 0 && index + 1 < args.length) { sanitized.push("[REDACTED]"); index += 1; }
    } else sanitized.push(arg);
  }
  return sanitized;
}

/** @param {unknown} cause @returns {unknown} */
export function sanitizeCliErrorCause(cause) {
  if (!(cause instanceof Error)) return cause;
  const safe = new Error(cause.message);
  safe.name = cause.name;
  if (cause.stack) safe.stack = cause.stack;
  for (const key of Object.keys(cause)) {
    if (key !== "spawnargs") safe[key] = cause[key];
  }
  return safe;
}
