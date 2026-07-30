/**
 * Minimal standard 5-field cron expander (minute hour day-of-month month
 * day-of-week), evaluated in the host's local timezone to match how the
 * server computes `next_run_at_ms`. Supports `*`, `?`, `*`/`n`, `a`, `a-b`,
 * `a-b/n`, `a/n`, comma lists, and JAN-DEC / SUN-SAT names (case-insensitive;
 * 7 also maps to Sunday). Day-of-month and day-of-week follow Vixie cron OR
 * semantics when both are restricted.
 *
 * Hand-rolled on purpose: `cron-parser` is a server/cli dependency and is not
 * resolvable from this package (pnpm strict node_modules; the
 * gateway-react-direction architecture rule also bars importing other
 * smithers packages here).
 */
import type { GatewayCronRow } from "@smithers-orchestrator/gateway-client";

/**
 * Structural mirror of `@smithers-orchestrator/ui/calendar`'s CalendarEvent.
 * gateway-react may not import UI packages (architecture rule), so the type
 * is redeclared; assignment to CalendarEvent is checked structurally at the
 * gateway-ui boundary.
 */
export type CronScheduleEvent = {
  id: string;
  title: string;
  start: number;
  end?: number;
  allDay?: boolean;
  rrule?: string;
  source?: string;
  status?: string;
  href?: string;
  color?: string;
};

/** Hard cap on day iterations so a pathological window cannot hang the tab. */
const MAX_DAY_ITERATIONS = 5000;
export const DEFAULT_PER_CRON_LIMIT = 250;

const MONTH_NAMES: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const DOW_NAMES: Readonly<Record<string, number>> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

type CronFieldSpec = {
  /** True for a bare `*`/`?` (no step) — the field places no restriction. */
  any: boolean;
  values: Set<number>;
};

export type ParsedCronPattern = {
  minute: CronFieldSpec;
  hour: CronFieldSpec;
  dayOfMonth: CronFieldSpec;
  month: CronFieldSpec;
  dayOfWeek: CronFieldSpec;
};

function fieldValue(
  token: string,
  min: number,
  max: number,
  names: Readonly<Record<string, number>> | undefined,
): number {
  const named = names?.[token.toLowerCase()];
  const value = named ?? (/^\d+$/.test(token) ? Number.parseInt(token, 10) : Number.NaN);
  if (Number.isNaN(value)) throw new Error(`Invalid cron value "${token}"`);
  if (value < min || value > max) throw new Error(`Cron value "${token}" is outside ${min}-${max}`);
  return value;
}

function parseField(text: string, min: number, max: number, names?: Readonly<Record<string, number>>): CronFieldSpec {
  const values = new Set<number>();
  let any = true;
  for (const part of text.split(",")) {
    const [baseRaw, stepRaw] = part.split("/");
    if (baseRaw === undefined || baseRaw === "" || part.split("/").length > 2) {
      throw new Error(`Invalid cron field part "${part}"`);
    }
    const step = stepRaw === undefined ? 1 : Number.parseInt(stepRaw, 10);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid cron step "${stepRaw}" in "${part}"`);
    const base = baseRaw.trim();
    let lo: number;
    let hi: number;
    if (base === "*" || base === "?") {
      lo = min;
      hi = max;
      if (stepRaw !== undefined) any = false;
    } else if (base.includes("-")) {
      const [fromRaw, toRaw] = base.split("-", 2);
      lo = fieldValue(fromRaw!, min, max, names);
      hi = fieldValue(toRaw!, min, max, names);
      // In a DOW range, a named Sunday at the upper bound is the same endpoint
      // as numeric 7 (for example fri-sun === 5-7). Standalone Sunday remains 0.
      if (min === 0 && max === 7 && hi === 0 && toRaw?.toLowerCase() === "sun" && lo > 0) hi = 7;
      if (hi < lo) throw new Error(`Invalid cron range "${base}"`);
      any = false;
    } else {
      lo = fieldValue(base, min, max, names);
      // "a/n" means a-max/n; a bare "a" is exactly a.
      hi = stepRaw === undefined ? lo : max;
      any = false;
    }
    for (let value = lo; value <= hi; value += step) values.add(value === 7 && min === 0 && max === 7 ? 0 : value);
  }
  if (values.size === 0) throw new Error(`Cron field "${text}" matches nothing`);
  return { any, values };
}

/** Parse a standard 5-field cron expression; throws on invalid input. */
export function parseCronPattern(pattern: string): ParsedCronPattern {
  const fields = pattern.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Cron pattern must have 5 fields, got ${fields.length}: "${pattern}"`);
  return {
    minute: parseField(fields[0]!, 0, 59),
    hour: parseField(fields[1]!, 0, 23),
    dayOfMonth: parseField(fields[2]!, 1, 31),
    month: parseField(fields[3]!, 1, 12, MONTH_NAMES),
    dayOfWeek: parseField(fields[4]!, 0, 7, DOW_NAMES),
  };
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function addDays(ms: number, days: number): number {
  const d = new Date(ms);
  return new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() + days,
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
    d.getMilliseconds(),
  ).getTime();
}

function dayMatches(parsed: ParsedCronPattern, dayMs: number): boolean {
  const d = new Date(dayMs);
  if (!parsed.month.values.has(d.getMonth() + 1)) return false;
  const domMatch = parsed.dayOfMonth.values.has(d.getDate());
  const dowMatch = parsed.dayOfWeek.values.has(d.getDay());
  const domRestricted = !parsed.dayOfMonth.any;
  const dowRestricted = !parsed.dayOfWeek.any;
  if (domRestricted && dowRestricted) return domMatch || dowMatch;
  return domMatch && dowMatch;
}

/**
 * Every occurrence of `pattern` in `[windowStart, windowEnd)` as epoch ms,
 * ascending, capped at `limit`. Throws on an invalid pattern.
 */
export function expandCron(
  pattern: string,
  windowStart: number,
  windowEnd: number,
  limit = DEFAULT_PER_CRON_LIMIT,
): number[] {
  const parsed = parseCronPattern(pattern);
  const hours = [...parsed.hour.values].sort((a, b) => a - b);
  const minutes = [...parsed.minute.values].sort((a, b) => a - b);
  const occurrences: number[] = [];
  let day = startOfDay(windowStart);
  for (let guard = 0; day < windowEnd && guard < MAX_DAY_ITERATIONS; guard += 1, day = addDays(day, 1)) {
    if (!dayMatches(parsed, day)) continue;
    const d = new Date(day);
    for (const hour of hours) {
      for (const minute of minutes) {
        const ts = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute).getTime();
        if (ts >= windowStart && ts < windowEnd) {
          occurrences.push(ts);
          if (occurrences.length >= limit) return occurrences;
        }
      }
    }
  }
  return occurrences;
}

/** The chip status a cron row carries: last-error, paused, or scheduled. */
export function cronStatus(cron: GatewayCronRow): string {
  if (cron.errorJson) return "failed";
  if (!cron.enabled) return "paused";
  return "queued";
}

/**
 * Expand one cron row into calendar events over the window. An unparseable
 * pattern degrades to the server-computed `nextRunAtMs` when it lands inside
 * the window instead of vanishing silently.
 */
export function cronToCalendarEvents(
  cron: GatewayCronRow,
  windowStart: number,
  windowEnd: number,
  limit = DEFAULT_PER_CRON_LIMIT,
): CronScheduleEvent[] {
  let occurrences: number[];
  try {
    occurrences = expandCron(cron.pattern, windowStart, windowEnd, limit);
  } catch {
    occurrences =
      typeof cron.nextRunAtMs === "number" && cron.nextRunAtMs >= windowStart && cron.nextRunAtMs < windowEnd
        ? [cron.nextRunAtMs]
        : [];
  }
  const title = cron.workflow || cron.workflowPath || cron.pattern;
  const status = cronStatus(cron);
  return occurrences.map((start) => ({
    id: `${cron.cronId}:${start}`,
    title,
    start,
    rrule: cron.pattern,
    source: cron.workflow || undefined,
    status,
  }));
}
