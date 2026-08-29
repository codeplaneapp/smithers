/**
 * Epoch ms of the next moment the wall clock reads `hour:minute` in `timeZone`,
 * at or after `fromMs`. Turns a provider reset hint like
 * "resets 1:30am (America/New_York)" into an absolute wake time. Returns null
 * when `timeZone` is not a valid IANA zone name.
 *
 * @param {{ hour: number; minute: number; timeZone: string; fromMs: number }} params
 * @returns {number | null}
 */
export function nextWallClockInZone({ hour, minute, timeZone, fromMs }) {
  let dateParts;
  try {
    dateParts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(fromMs));
  } catch {
    return null; // invalid time zone
  }
  // Offset (ms) the zone is ahead of UTC at a given instant. Two passes with
  // this correct the DST edge case where the naive guess lands in the wrong
  // offset window.
  const offsetAt = (epochMs) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(epochMs));
    const map = {};
    for (const part of parts) map[part.type] = part.value;
    const asUtc = Date.UTC(
      Number(map.year),
      Number(map.month) - 1,
      Number(map.day),
      Number(map.hour === "24" ? "0" : map.hour),
      Number(map.minute),
      Number(map.second),
    );
    return asUtc - epochMs;
  };
  const resolve = (year, month, day) => {
    const guessUtc = Date.UTC(year, month - 1, day, hour, minute);
    return guessUtc - offsetAt(guessUtc - offsetAt(guessUtc));
  };
  const map = {};
  for (const part of dateParts) map[part.type] = part.value;
  const year = Number(map.year);
  const month = Number(map.month);
  const day = Number(map.day);
  let epoch = resolve(year, month, day);
  if (epoch <= fromMs) {
    // The target time already passed today in the zone; roll to tomorrow.
    const next = new Date(Date.UTC(year, month - 1, day + 1));
    epoch = resolve(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
  }
  return epoch;
}
