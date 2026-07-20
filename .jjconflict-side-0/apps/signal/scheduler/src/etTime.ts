const ET_PARTS_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  minute: "numeric",
  hourCycle: "h23",
});
const ET_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export type EtClock = { hour: number; minute: number; dateEt: string };

/** DST-correct America/New_York wall-clock hour/minute + calendar date for `at`. */
export function etClock(at: Date): EtClock {
  const parts = ET_PARTS_FORMATTER.formatToParts(at);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  const dateEt = ET_DATE_FORMATTER.format(at);
  return { hour, minute, dateEt };
}
