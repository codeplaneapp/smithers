/**
 * The triggers (crons) surface: scheduled workflow triggers with a 5-field cron
 * pattern, a workflow path, an enabled flag, and a derived next-run hint. Ported
 * from the Swift CronTriggersView. One card and one canvas read the same seeded
 * list; create / toggle / delete are pure reducers so they unit-test without a
 * DOM (see cronsDomain.test.ts).
 *
 * Everything is deterministic: ids come from an FNV-1a `shortHash`, the next-run
 * hint comes from a pure `describeCron`, and the seed bakes no wall-clock time —
 * `nextHint` is the `describeCron` string, not a `Date.now()` timestamp.
 */

/** One scheduled trigger: a cron pattern bound to a workflow file. */
export type Cron = {
  id: string;
  /** Human name, derived from the workflow filename (e.g. `nightly`). */
  name: string;
  /** The 5-field cron pattern, e.g. `0 3 * * *`. */
  pattern: string;
  /** The workflow file the trigger launches, e.g. `.smithers/workflows/x.tsx`. */
  workflowPath: string;
  enabled: boolean;
  /** A deterministic human next-run hint from `describeCron(pattern)`. */
  nextHint: string;
  /** Last error payload, surfaced in the detail pane; absent when healthy. */
  errorJson?: string;
};

/** Headline counts for the header and the card sub. */
export function summarizeCrons(crons: Cron[]): {
  total: number;
  enabled: number;
  disabled: number;
} {
  let enabled = 0;
  let disabled = 0;
  for (const cron of crons) {
    if (cron.enabled) enabled += 1;
    else disabled += 1;
  }
  return { total: crons.length, enabled, disabled };
}

/** Map a trigger's enabled flag to its tone class: enabled reads ok, disabled idle. */
export function toneForCronEnabled(enabled: boolean): string {
  return enabled ? "tone-ok" : "tone-idle";
}

/**
 * Order the list enabled-first, then by id descending (newest-created sinks to
 * the top because fresh ids/hashes sort high among same-enabled rows). A pure,
 * deterministic order — no clock, no Set iteration.
 */
export function sortCrons(crons: Cron[]): Cron[] {
  return crons.slice().sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    if (a.id < b.id) return 1;
    if (a.id > b.id) return -1;
    return 0;
  });
}

/** FNV-1a, kept here so a new trigger gets a stable id without Math.random. */
export function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Validate ONE cron field against its allowed range. A field may be:
 *  - "*" (any),
 *  - a plain number in [min, max],
 *  - a step "asterisk-slash-n" (n a positive integer),
 *  - a range "a-b" (both numbers in range, a <= b),
 *  - a comma list of any of the above (numbers / ranges).
 * Returns true when every comma-part is well-formed.
 */
function isValidCronField(field: string, min: number, max: number): boolean {
  if (field === "") return false;
  if (field === "*") return true;

  // Step form like "*/15" — the common shape Swift formats. We accept the
  // any-step variant only (asterisk, slash, positive integer).
  if (field.startsWith("*/")) {
    const step = field.slice(2);
    return /^\d+$/.test(step) && Number(step) >= 1;
  }

  // A comma list: every part must be a number or a range, each in [min, max].
  return field.split(",").every((part) => {
    if (part === "") return false;
    if (part.includes("-")) {
      const [a, b] = part.split("-");
      if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) return false;
      const lo = Number(a);
      const hi = Number(b);
      return lo >= min && lo <= max && hi >= min && hi <= max && lo <= hi;
    }
    if (!/^\d+$/.test(part)) return false;
    const value = Number(part);
    return value >= min && value <= max;
  });
}

/**
 * Validate the 5-field `min hour dom mon dow` cron shape. Exactly five
 * space-separated fields, each within its range. Pure, so the create gate is
 * unit-testable.
 */
export function validateCronPattern(pattern: string): boolean {
  const fields = pattern.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const ranges: [number, number][] = [
    [0, 59], // minute
    [0, 23], // hour
    [1, 31], // day of month
    [1, 12], // month
    [0, 6], // day of week
  ];
  return fields.every((field, index) => isValidCronField(field, ranges[index][0], ranges[index][1]));
}

/**
 * Normalize a user-entered workflow reference to the REGISTERED workflow KEY the
 * gateway's `cronCreate` actually wants (e.g. `ralph`, `e2e-approval-probe`).
 * The gateway keys/stores crons by this key (`gateway:<key>`) and 4xxs anything
 * `this.workflows` doesn't know, so the UI must send a key — NOT a file path.
 * Forgiving of the two shapes a user is likely to paste:
 *  - a `gateway:<key>` stored form → strips the prefix,
 *  - a `.smithers/workflows/foo.tsx` file path → takes the basename, drops the
 *    `.ts`/`.tsx` extension → `foo`.
 * Returns the bare key (trimmed). Pure.
 */
export function normalizeWorkflowKey(value: string): string {
  let key = value.trim();
  if (key === "") return "";
  // Stored form: `gateway:ralph` → `ralph`.
  if (key.startsWith("gateway:")) key = key.slice("gateway:".length);
  // Path form: take the final segment, then drop a `.ts`/`.tsx` extension.
  if (key.includes("/")) key = key.split("/").pop() ?? key;
  key = key.replace(/\.(tsx|ts)$/i, "");
  return key.trim();
}

/**
 * Validate a workflow reference. The gateway keys crons by the REGISTERED
 * workflow KEY (e.g. `ralph`, `e2e-approval-probe`), not a file path —
 * `cronCreate` rejects anything `this.workflows` doesn't know. We normalize a
 * `gateway:`-prefixed or `.tsx`-path value down to its key first (see
 * `normalizeWorkflowKey`), then require a single whitespace-free token. Rejects
 * empty / whitespace-only, anything with internal whitespace, and a value that
 * STILL looks like a path after normalization (a stray slash or dot). Pure.
 */
export function isValidWorkflowPath(path: string): boolean {
  const key = normalizeWorkflowKey(path);
  if (key === "") return false;
  // A registered key is a single token: no whitespace, no path separators, no
  // dots. If a residual slash/dot survived normalization the user pasted an
  // unrecognizable path — reject so we never send a guaranteed-4xx request.
  return !/[\s/]/.test(key) && !key.includes(".");
}

/**
 * The create gate. Returns a human message when the draft is invalid (rendered
 * under the form) or `null` when it is ready to submit. Order mirrors the Swift
 * required-field message precedence, then layers the new syntactic checks.
 */
export function validateCreate(pattern: string, workflowPath: string): string | null {
  const p = pattern.trim();
  const w = workflowPath.trim();

  if (p === "" && w === "") return "Cron pattern and workflow key are required.";
  if (p === "") return "Cron pattern is required.";
  if (w === "") return "Workflow key is required.";
  if (!validateCronPattern(p)) return "Not a valid 5-field cron pattern.";
  if (!isValidWorkflowPath(w)) {
    return "Enter the registered workflow key, e.g. ralph (not a file path).";
  }
  return null;
}

/** Two-digit zero-pad for the hour/minute hints. */
function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

const WEEKDAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

/**
 * Render a deterministic human next-run hint from a cron pattern. Wall-clock
 * time is banned, so this stands in for the Swift `formatTimestamp(nextRunAtMs)`.
 * Recognizes the common shapes; falls back to echoing the pattern.
 */
export function describeCron(pattern: string): string {
  const fields = pattern.trim().split(/\s+/);
  if (fields.length !== 5) return pattern.trim();
  const [min, hour, dom, mon, dow] = fields;

  // Step-minute form like "*/15 * * * *" -> every n minutes.
  if (min.startsWith("*/") && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    const n = min.slice(2);
    return `Every ${n} minute${n === "1" ? "" : "s"}`;
  }

  // `0 * * * *` -> hourly.
  if (min === "0" && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    return "Hourly, on the hour";
  }

  // A concrete minute + hour fires once a day at that time.
  const minNum = Number(min);
  const hourNum = Number(hour);
  const exactTime = /^\d+$/.test(min) && /^\d+$/.test(hour);

  if (exactTime && dom === "*" && mon === "*") {
    const at = `${pad2(hourNum)}:${pad2(minNum)}`;
    // A specific weekday.
    if (/^\d+$/.test(dow)) {
      const day = WEEKDAYS[Number(dow) % 7];
      return `${day} at ${at}`;
    }
    if (dow === "*") return `Daily at ${at}`;
  }

  return pattern.trim();
}

/** Derive a human name from a workflow filename: `nightly.tsx` -> `nightly`. */
export function nameFromWorkflowPath(workflowPath: string): string {
  const file = workflowPath.trim().split("/").pop() ?? workflowPath.trim();
  const base = file.replace(/\.(tsx|ts)$/i, "");
  return base === "" ? "trigger" : base;
}

/**
 * Build a fresh trigger from the draft and prepend it to the list. Mints a
 * deterministic id via `shortHash(pattern|workflowPath)`, derives the name and
 * the next-run hint, defaults `enabled=true`. Returns the new list and the
 * created row. Pure: does not mutate the input.
 */
export function createCron(
  crons: Cron[],
  draft: { pattern: string; workflowPath: string },
): { crons: Cron[]; created: Cron } {
  const pattern = draft.pattern.trim();
  // Store the normalized registered KEY (not a raw path/`gateway:` form), so the
  // optimistic row matches the row `cronCreate` persists + the bridge re-pulls.
  const workflowPath = normalizeWorkflowKey(draft.workflowPath);
  const created: Cron = {
    id: `cron-${shortHash(`${pattern}|${workflowPath}`)}`,
    name: nameFromWorkflowPath(workflowPath),
    pattern,
    workflowPath,
    enabled: true,
    nextHint: describeCron(pattern),
  };
  return { crons: [created, ...crons], created };
}

/** Flip the matching trigger's enabled flag, returning a new list. */
export function toggleCron(crons: Cron[], id: string): Cron[] {
  return crons.map((cron) => (cron.id === id ? { ...cron, enabled: !cron.enabled } : cron));
}

/** Drop the matching trigger, returning a new list. */
export function deleteCron(crons: Cron[], id: string): Cron[] {
  return crons.filter((cron) => cron.id !== id);
}
