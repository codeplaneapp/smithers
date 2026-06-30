import {
  createBrowserHistory,
  createHashHistory,
  type RouterHistory,
} from "@tanstack/react-router";

/**
 * Electrobun (and any desktop webview) loads the app over a custom scheme with
 * no server to serve an SPA fallback, so path-based history breaks on reload.
 * Detect that case and fall back to hash history; on the web the Worker serves
 * the shell for every path and the service worker is deep-link aware, so real
 * paths are safe.
 */
function isDesktopWebview(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const httpScheme =
    window.location.protocol === "http:" ||
    window.location.protocol === "https:";
  const electrobunUa =
    typeof navigator !== "undefined" && /electrobun/i.test(navigator.userAgent);
  return electrobunUa || !httpScheme;
}

/**
 * The one place that knows which target we run on. Everything downstream reads
 * the router's location and never branches on platform.
 */
export const appHistory: RouterHistory = isDesktopWebview()
  ? createHashHistory()
  : createBrowserHistory();
