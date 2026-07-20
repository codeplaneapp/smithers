// Session-scoped dedup for the "no gateway behind this URL" notice: the first
// unavailable failure logs once at info level; every later one (any collection,
// any retry) stays silent so a gateway-less page does not fill the console.
let noticed = false;

/** Log the one-per-session gateway-unavailable notice. */
export function noteGatewayUnavailable(cause: unknown): void {
  if (noticed) return;
  noticed = true;
  const detail = cause instanceof Error ? cause.message : String(cause);
  console.info(
    `[smithers-gateway] ${detail} Collections keep their last known rows and recover automatically once a gateway appears. (Logged once per session.)`,
  );
}

/** Test seam: clear the session dedup so each test observes its own notice. */
export function resetGatewayUnavailableNotice(): void {
  noticed = false;
}
