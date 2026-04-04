const FULL_USAGE = [
  "Burns CLI",
  "",
  "Usage:",
  "  burns start [--host <host>] [--port <port>] [--open] [--web-url <url>]",
  "  burns daemon",
  "  burns web [--host <host>] [--port <port>] [--open]",
  "  burns ui [run <run-id> | node <run-id>/<node-id> | approvals] [--host <host>] [--port <port>] [--no-open]",
  "",
  "Commands:",
  "  start   Start daemon and web UI server, optionally open the web URL in a browser.",
  "  daemon  Start daemon only.",
  "  web     Serve prebuilt web assets from dist/web.",
  "  ui      Open or print deep links into the web UI.",
].join("\n")

const START_USAGE = [
  "Usage:",
  "  burns start [--host <host>] [--port <port>] [--open] [--web-url <url>]",
  "",
  "Options:",
  "  --host <host>    Host/interface to bind web UI server. Default: 127.0.0.1",
  "  --port <port>    Port to bind web UI server. Default: 4173",
  "  --open            Open the web URL in your browser after daemon startup.",
  "  --web-url <url>   URL to open with --open. Default: http://127.0.0.1:4173",
].join("\n")

const DAEMON_USAGE = [
  "Usage:",
  "  burns daemon",
].join("\n")

const WEB_USAGE = [
  "Usage:",
  "  burns web [--host <host>] [--port <port>] [--open]",
  "",
  "Options:",
  "  --host <host>   Host/interface to bind. Default: 127.0.0.1",
  "  --port <port>   Port to bind. Default: 4173",
  "  --open          Open the served URL in your browser.",
].join("\n")

const UI_USAGE = [
  "Usage:",
  "  burns ui",
  "  burns ui run <run-id>",
  "  burns ui node <run-id>/<node-id>",
  "  burns ui approvals",
  "",
  "Options:",
  "  --host <host>   Web host to target. Default: 127.0.0.1",
  "  --port <port>   Web port to target. Default: 4173",
  "  --open          Force browser open (default behavior).",
  "  --no-open       Only print URL; do not launch browser.",
].join("\n")

export function renderUsage(topic?: "start" | "daemon" | "web" | "ui") {
  if (topic === "start") {
    return START_USAGE
  }

  if (topic === "daemon") {
    return DAEMON_USAGE
  }

  if (topic === "web") {
    return WEB_USAGE
  }

  if (topic === "ui") {
    return UI_USAGE
  }

  return FULL_USAGE
}
