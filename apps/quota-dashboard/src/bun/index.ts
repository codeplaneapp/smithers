import Electrobun, { BrowserWindow } from "electrobun/bun";
import { PAGE_HTML } from "./page";
import { readSnapshot } from "./usage";

/**
 * Smithers Quota — a desktop view of subscription headroom across every
 * registered Claude Code and Codex account.
 *
 * The window loads a local Bun.serve origin instead of static `html`, because
 * the page re-polls on a timer: serving `/api/usage` makes refresh a plain
 * fetch, and each poll re-runs `smithers usage` in the bun process where the
 * account registry and OAuth sessions already resolve.
 */

const server = Bun.serve({
  // Port 0 asks the OS for a free port, so the app never collides with a dev
  // server or a second copy of itself.
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/api/usage") {
      return Response.json(readSnapshot(), {
        headers: { "cache-control": "no-store" },
      });
    }
    return new Response(PAGE_HTML, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
});

const win = new BrowserWindow({
  title: "Smithers Quota",
  url: `http://127.0.0.1:${server.port}/`,
  frame: { x: 120, y: 120, width: 1080, height: 820 },
  titleBarStyle: "default",
});

export default { server, win, Electrobun };
