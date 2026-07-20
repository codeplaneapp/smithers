import { AUTH_REFACTOR_LOG, type LogLine } from "./logLines";
import { useLogsPrefsStore } from "./logsPrefsStore";

function renderText(line: LogLine, redact: boolean) {
  if (redact && line.secret) {
    const masked = line.text.replace(line.secret, "•••••");
    return masked;
  }
  return line.text;
}

/**
 * The transcript surface: the agent's stream with quiet toggle chips. Follow,
 * Hide noise and Redact persist across reloads (logs prefs store); redact is on
 * by default so secrets stay masked.
 */
export function LogsCanvas() {
  const follow = useLogsPrefsStore((state) => state.follow);
  const hideNoise = useLogsPrefsStore((state) => state.hideNoise);
  const redact = useLogsPrefsStore((state) => state.redact);
  const toggleFollow = useLogsPrefsStore((state) => state.toggleFollow);
  const toggleHideNoise = useLogsPrefsStore((state) => state.toggleHideNoise);
  const toggleRedact = useLogsPrefsStore((state) => state.toggleRedact);

  const lines = AUTH_REFACTOR_LOG.filter(
    (line) => !(hideNoise && line.role === "noise"),
  );

  return (
    <section className="surface" data-testid="logs-canvas">
      <header className="surface-head logs-toolbar">
        <button
          type="button"
          className={follow ? "chip is-on" : "chip"}
          onClick={toggleFollow}
        >
          Follow {follow ? "▾" : "▸"}
        </button>
        <button
          type="button"
          className={hideNoise ? "chip is-on" : "chip"}
          onClick={toggleHideNoise}
        >
          Hide noise
        </button>
        <button
          type="button"
          className={redact ? "chip is-on" : "chip"}
          onClick={toggleRedact}
        >
          Redact
        </button>
        <span className="logs-search">search transcript</span>
      </header>
      <div className="logs-stream">
        {lines.map((line, index) => (
          <div className={`log-line role-${line.role}`} key={index}>
            {line.role !== "noise" ? (
              <span className="log-role">{line.role} ›</span>
            ) : (
              <span className="log-role">›</span>
            )}{" "}
            {renderText(line, redact)}
          </div>
        ))}
      </div>
    </section>
  );
}
