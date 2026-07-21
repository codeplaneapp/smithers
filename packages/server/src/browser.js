import { createRequire } from "node:module";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { randomUUID } from "node:crypto";

const requireFromServer = createRequire(new URL("../package.json", import.meta.url));
const DEFAULTS = { idleTtlMs: 10 * 60_000, hardLifetimeMs: 2 * 60 * 60_000, maxConcurrent: 2, artifactRetentionMs: 7 * 24 * 60 * 60_000, screencastFps: 8 };
const INCLUDE = new Set(["visible-text", "accessibility", "interactive-elements", "screenshot", "selections", "recent-actions", "console-summary", "network-summary"]);
const MAX = { text: 20_000, elements: 200, journal: 100, console: 100, network: 100 };

class BrowserError extends Error {
  constructor(code, message, details) { super(message); this.name = "BrowserError"; this.code = code; this.details = details; }
}

function privateAddress(address) {
  const value = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (value.startsWith("::ffff:")) return privateAddress(value.slice(7));
  if (isIP(value) === 4) {
    const parts = value.split(".").map(Number);
    return parts[0] === 0 || parts[0] === 10 || parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127 || parts[0] === 127 || parts[0] === 169 && parts[1] === 254 || parts[0] === 192 && parts[1] === 0 && parts[2] === 0 || parts[0] === 192 && parts[1] === 168 || parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31;
  }
  return value === "::1" || value === "0:0:0:0:0:0:0:0" || value === "::" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb");
}

async function assertDestination(raw, policy) {
  let parsed;
  try { parsed = new URL(raw); } catch { throw new BrowserError("SSRF_BLOCKED", "Navigation URL is not allowed."); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:" || parsed.username || parsed.password) throw new BrowserError("SSRF_BLOCKED", "Only public http and https destinations are allowed.");
  const host = parsed.hostname.toLowerCase();
  if (policy.devPort !== undefined) {
    if (parsed.protocol !== "http:" || host !== "127.0.0.1" || (parsed.port || "80") !== String(policy.devPort)) throw new BrowserError("SSRF_BLOCKED", "The dev-server session may only use its declared loopback port.");
    return parsed.toString();
  }
  if (host === "localhost" || host === "metadata.google.internal" || privateAddress(host)) throw new BrowserError("SSRF_BLOCKED", "Private and loopback destinations are not allowed.");
  let addresses;
  try { addresses = isIP(host) ? [host] : (await (policy.resolveHost || lookup)(host, { all: true })).map((entry) => typeof entry === "string" ? entry : entry.address); } catch { throw new BrowserError("SSRF_BLOCKED", "Destination DNS resolution failed."); }
  if (addresses.some(privateAddress)) throw new BrowserError("SSRF_BLOCKED", "Destination resolves to a private address.");
  return parsed.toString();
}

async function sourceUrl(source, resolveHost) {
  if (source?.kind === "dev-server") {
    if (!Number.isInteger(source.port) || source.port < 1 || source.port > 65535 || typeof source.path !== "undefined" && (!source.path.startsWith("/") || source.path.includes("@"))) throw new BrowserError("INVALID_REQUEST", "Invalid dev-server source.");
    const path = source.path || "/";
    return { url: await assertDestination(`http://127.0.0.1:${source.port}${path}`, { devPort: source.port, resolveHost }), policy: { devPort: source.port } };
  }
  if (source?.kind !== "url") throw new BrowserError("INVALID_REQUEST", "source must be a url or dev-server.");
  return { url: await assertDestination(source.url, { resolveHost }), policy: {} };
}

function redact(text) { return { redacted: true, length: text.length }; }
function trim(value, max = MAX.text) { return String(value ?? "").slice(0, max); }
function sourceCopy(source) { return source.kind === "url" ? { kind: "url", url: trim(source.url) } : { kind: "dev-server", port: source.port, path: trim(source.path || "/") }; }
function sensitiveField(info) { return /password|passcode|otp|one[-_ ]?time|token|secret|credit|card|cvv|cvc|ssn/i.test(info); }
function resolveLocator(page, locator) {
  if (locator?.testId) return page.getByTestId(locator.testId);
  if (locator?.css) return page.locator(locator.css);
  if (locator?.role) return page.getByRole(locator.role, { name: locator.name });
  throw new BrowserError("INVALID_REQUEST", "A supported locator is required.");
}

/** Create the gateway-local Playwright browser session registry. */
export function createBrowserSessionRegistry(options = {}) {
  const limits = { ...DEFAULTS, ...options.limits };
  const sessions = new Map();
  const artifacts = new Map();
  const listeners = { activity: new Set(), frame: new Set() };
  let playwright;
  let frameSeq = 0;
  let creating = 0;
  let timer;
  const getPlaywright = () => { if (options.playwright) return options.playwright; if (!playwright) playwright = requireFromServer("playwright"); return playwright; };
  const emit = (kind, payload) => { for (const listener of listeners[kind]) void listener(payload); };
  const stopScreencast = async (session) => { const cdp = session.cdp; if (!cdp) return; session.cdp = null; await cdp.send("Page.stopScreencast").catch(() => {}); if (cdp.detach) await cdp.detach().catch(() => {}); };
  const startScreencast = async (session) => {
    if (session.cdp || session.screencastStarting || !session.frameSubscribers || !session.page) return;
    session.screencastStarting = true;
    let cdp;
    try {
      cdp = await session.context.newCDPSession(session.page);
      session.cdp = cdp;
      cdp.on("Page.screencastFrame", async (event) => {
        await cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
        const now = Date.now();
        if (!session.frameSubscribers || !event.data || now - session.lastFrameAt < 1000 / limits.screencastFps) return;
        session.lastFrameAt = now;
        emit("frame", { sessionId: session.sessionId, seq: ++frameSeq, jpegBase64: event.data, viewport: session.viewport });
      });
      if (!session.frameSubscribers) { await stopScreencast(session); return; }
      await cdp.send("Page.startScreencast", { format: "jpeg", quality: 55, maxWidth: Math.min(session.viewport.width, 1280), maxHeight: Math.min(session.viewport.height, 720), everyNthFrame: 1 });
      if (!session.frameSubscribers) await stopScreencast(session);
    } catch { if (session.cdp === cdp) session.cdp = null; if (cdp?.detach) await cdp.detach().catch(() => {}); } finally { session.screencastStarting = false; }
  };
  const sanitize = (session, value, max = MAX.text) => {
    if (typeof value === "string") {
      let result = value;
      for (const secret of session ? session.sensitiveValues : []) if (secret) result = result.split(secret).join("[REDACTED]");
      return trim(result, max);
    }
    if (Array.isArray(value)) return value.slice(0, MAX.elements).map((item) => sanitize(session, item, max));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(session, item, max)]));
    return value;
  };
  const pageInfo = async (session) => session.page ? { url: sanitize(session, session.page.url()), title: sanitize(session, await session.page.title().catch(() => "")), canGoBack: Boolean(await session.page.evaluate(() => history.length > 1).catch(() => false)), canGoForward: false } : null;
  const snapshot = async (session) => ({ sessionId: session.sessionId, source: sanitize(session, sourceCopy(session.source)), status: session.status, revision: session.revision, page: await pageInfo(session), viewport: session.viewport, control: { owner: session.owner } });
  const armTimer = (session) => { clearTimeout(session.timer); const remaining = Math.max(1, Math.min(limits.idleTtlMs - (Date.now() - session.lastUsed), limits.hardLifetimeMs - (Date.now() - session.createdAt))); session.timer = setTimeout(() => void reap(), remaining); session.timer.unref?.(); };
  const close = async (sessionId) => { const session = sessions.get(sessionId); if (!session) return { closed: true }; sessions.delete(sessionId); session.status = "closed"; clearTimeout(session.timer); await stopScreencast(session); await session.context.close().catch(() => {}); await session.browser.close().catch(() => {}); return { closed: true, sessionId }; };
  const reap = async () => { const now = Date.now(); for (const [ref, value] of artifacts) if (value.expiresAt <= now) artifacts.delete(ref); for (const session of [...sessions.values()]) { if (now - session.lastUsed >= limits.idleTtlMs || now - session.createdAt >= limits.hardLifetimeMs) await close(session.sessionId); else armTimer(session); } };
  const settle = async (session, actionId, actor, action, result) => {
    session.revision += 1; session.lastUsed = Date.now();
    const textSensitive = action.kind === "type" && session.sensitiveActions.has(actionId);
    const wireAction = action.kind === "type" && textSensitive ? { ...action, text: redact(action.text) } : action;
    const entry = { actionId, actor: actor === "user" ? "user" : "agent", revision: session.revision, action: sanitize(session, wireAction), result: sanitize(session, result) };
    session.journal.push(entry);
    if (session.journal.length > MAX.journal) session.journal.shift();
    const outcome = { revision: session.revision, page: await pageInfo(session), outcome: sanitize(session, result) };
    session.ledger.set(actionId, { value: outcome });
    emit("activity", { sessionId: session.sessionId, ...entry });
    return outcome;
  };
  const create = async ({ source, viewport = { width: 1280, height: 720 } }) => {
    await reap(); if (sessions.size + creating >= limits.maxConcurrent) throw new BrowserError("QUOTA_EXCEEDED", "Browser session quota reached.");
    creating += 1;
    if (!Number.isInteger(viewport.width) || !Number.isInteger(viewport.height) || viewport.width < 1 || viewport.height < 1 || viewport.width > 3840 || viewport.height > 2160) throw new BrowserError("INVALID_REQUEST", "Viewport is outside the supported bounds.");
    let destination; let browser; let context;
    try { destination = await sourceUrl(source, options.resolveHost); browser = await getPlaywright().chromium.launch({ headless: true }); context = await browser.newContext({ viewport, acceptDownloads: false }); } finally { creating -= 1; }
    const session = { sessionId: randomUUID(), source, status: "starting", revision: 0, viewport, owner: null, context, browser, page: null, createdAt: Date.now(), lastUsed: Date.now(), ledger: new Map(), journal: [], artifacts: new Map(), sensitiveActions: new Set(), sensitiveValues: new Set(), queue: Promise.resolve(), policy: destination.policy, console: [], network: [], timer: null, cdp: null, frameSubscribers: 0, lastFrameAt: 0, screencastStarting: false, screencastTransition: Promise.resolve() };
    sessions.set(session.sessionId, session);
    const validateRequest = async (route) => { try { await assertDestination(route.request().url(), session.policy); await route.continue(); } catch { await route.abort(); } };
    await context.route("**/*", validateRequest);
    session.page = await context.newPage();
    session.page.on?.("dialog", (dialog) => { session.dialog = dialog; });
    session.page.on?.("download", (download) => void download.cancel().catch(() => {}));
    session.page.on?.("console", (message) => { session.console.push({ type: trim(message.type(), 80), text: sanitize(session, message.text(), 1000) }); if (session.console.length > MAX.console) session.console.shift(); });
    session.page.on?.("request", (request) => { session.network.push({ method: trim(request.method(), 80), url: sanitize(session, request.url(), 2000) }); if (session.network.length > MAX.network) session.network.shift(); });
    context.on?.("page", (popup) => { if (popup !== session.page) void popup.close().catch(() => {}); });
    try { await session.page.goto(destination.url, { waitUntil: "domcontentloaded" }); session.status = "ready"; } catch { session.status = "failed"; }
    armTimer(session);
    return snapshot(session);
  };
  const get = (id) => { const session = sessions.get(id); if (!session || session.status === "closed") throw new BrowserError("InvalidRequest", "Browser session not found."); if (Date.now() - session.createdAt >= limits.hardLifetimeMs) { void close(id); throw new BrowserError("InvalidRequest", "Browser session lifetime expired."); } session.lastUsed = Date.now(); armTimer(session); return session; };
  const act = async (params) => { const session = get(params.sessionId); const prior = session.ledger.get(params.actionId); if (prior) return prior.value; const run = session.queue.catch(() => {}).then(async () => { const queuedPrior = session.ledger.get(params.actionId); if (queuedPrior) return queuedPrior.value;
    if (params.expectedRevision !== undefined && params.expectedRevision !== session.revision) throw new BrowserError("REVISION_CONFLICT", "Browser session revision is stale.", { revision: session.revision });
    const action = params.action; let result;
    if (action.kind === "type" && sensitiveField(`${action.locator?.role || ""} ${action.locator?.name || ""} ${action.locator?.testId || ""} ${action.locator?.css || ""}`)) session.sensitiveActions.add(params.actionId);
    try {
      if (action.kind === "navigate") await session.page.goto(await assertDestination(action.url, session.policy), { waitUntil: "domcontentloaded" });
      else if (action.kind === "back") await session.page.goBack(); else if (action.kind === "forward") await session.page.goForward(); else if (action.kind === "reload") await session.page.reload(); else if (action.kind === "stop") await session.page.evaluate(() => window.stop());
      else if (action.kind === "click") { if (!action.locator && !action.point) throw new BrowserError("INVALID_REQUEST", "click requires locator or point."); const beforeUrl = session.page.url(); if (action.locator) await resolveLocator(session.page, action.locator).click({ button: action.button, modifiers: action.modifiers }); else await session.page.mouse.click(action.point.x, action.point.y, { button: action.button, modifiers: action.modifiers }); const afterUrl = session.page.url(); result = afterUrl !== beforeUrl ? { ok: true, redirectedTo: trim(afterUrl, 2_000) } : { ok: true }; }
      else if (action.kind === "type") { const locator = resolveLocator(session.page, action.locator); let info = ""; try { info = await locator.evaluate((element) => `${element.getAttribute("type") || ""} ${element.getAttribute("name") || ""} ${element.getAttribute("autocomplete") || ""}`); } catch {} if (sensitiveField(info) || sensitiveField(`${action.locator?.role || ""} ${action.locator?.name || ""} ${action.locator?.testId || ""} ${action.locator?.css || ""}`)) session.sensitiveActions.add(params.actionId); if (session.sensitiveActions.has(params.actionId)) session.sensitiveValues.add(action.text); if (action.replace === false) await locator.pressSequentially(action.text); else await locator.fill(action.text); result = { ok: true, ...(session.sensitiveActions.has(params.actionId) ? { redacted: true, length: action.text.length } : {}) }; }
      else if (action.kind === "press") await session.page.keyboard.press([...(action.modifiers || []), action.key].join("+"));
      else if (action.kind === "scroll") await session.page.mouse.wheel(action.deltaX, action.deltaY);
      else if (action.kind === "dialog") { if (!session.dialog) throw new BrowserError("INVALID_REQUEST", "No dialog is pending."); if (action.decision === "accept") await session.dialog.accept(action.promptText); else await session.dialog.dismiss(); session.dialog = null; }
      else throw new BrowserError("INVALID_REQUEST", "Unsupported browser action.");
      session.status = "ready"; return settle(session, params.actionId, params.actor, action, result || { ok: true });
    } catch (error) { const failure = { ok: false, code: error.code || "ACTION_FAILED", message: error.message || "Browser action failed" }; return settle(session, params.actionId, params.actor, action, failure, true); }
  }); session.queue = run.catch(() => {}); return run; };
  const contextSlice = async ({ sessionId, sinceRevision, include = [] }) => { const session = get(sessionId); await session.queue.catch(() => {}); const capturedRevision = session.revision; const selected = include.length ? include.filter((value) => INCLUDE.has(value)).slice(0, INCLUDE.size) : ["visible-text", "accessibility", "interactive-elements", "screenshot", "recent-actions"]; const response = { fresh: true, snapshot: await snapshot(session), revision: capturedRevision, include: selected };
    if (sinceRevision !== undefined && sinceRevision > capturedRevision) { response.fresh = false; response.reason = "REVISION_AHEAD"; }
    if (selected.includes("visible-text")) { try { const text = await session.page.locator("body").innerText(); response.visibleText = trim(text); response.visibleTextTruncated = text.length > MAX.text; } catch { response.fresh = false; response.reason = "CAPTURE_FAILED"; } }
    if (selected.includes("interactive-elements")) { try { const all = await session.page.locator("button,a,input,textarea,select,[role]").evaluateAll((els) => els.map((el) => { const role = (el.getAttribute("role") || ({ A: "link", BUTTON: "button", INPUT: el.getAttribute("type") === "submit" ? "button" : "textbox", TEXTAREA: "textbox", SELECT: "combobox" }[el.tagName] || el.tagName.toLowerCase())).slice(0, 80); const name = (el.getAttribute("aria-label") || el.textContent || el.getAttribute("placeholder") || "").trim().slice(0, 120); const testId = el.getAttribute("data-testid")?.slice(0, 200); return { role, name, locator: testId ? { testId } : { role, name } }; })); response.interactiveElements = all.slice(0, MAX.elements); response.interactiveElementsTruncated = all.length > MAX.elements; } catch { response.fresh = false; response.reason = "CAPTURE_FAILED"; } }
    if (selected.includes("accessibility")) { try { response.accessibility = (await session.page.locator("body").ariaSnapshot?.())?.slice(0, MAX.text) ?? null; } catch { response.fresh = false; response.reason = "CAPTURE_FAILED"; } }
    if (selected.includes("recent-actions")) response.recentActions = sanitize(session, session.journal.slice(-20));
    if (selected.includes("console-summary")) response.consoleSummary = sanitize(session, session.console.slice(-MAX.console)); if (selected.includes("network-summary")) response.networkSummary = sanitize(session, session.network.slice(-MAX.network));
    if (selected.includes("screenshot")) { try { response.screenshot = await artifact(session, await session.page.screenshot({ type: "jpeg", quality: 60 })); } catch { response.fresh = false; response.reason = "CAPTURE_FAILED"; } }
    if (session.revision !== capturedRevision) { response.fresh = false; response.reason = "REVISION_CHANGED"; }
    return sanitize(session, response);
  };
  const artifact = async (_session, bytes) => { if (!bytes) return null; const ref = `artifact_${randomUUID()}`; artifacts.set(ref, { bytes, expiresAt: Date.now() + limits.artifactRetentionMs }); return { ref, mediaType: "image/jpeg" }; };
  const pick = async ({ sessionId, point }) => { const session = get(sessionId); const result = await session.page.evaluate(({ x, y }) => { const el = document.elementFromPoint(x, y); if (!el) return null; const rect = el.getBoundingClientRect(); const role = (el.getAttribute("role") || ({ A: "link", BUTTON: "button", INPUT: "textbox", TEXTAREA: "textbox", SELECT: "combobox" }[el.tagName] || el.tagName.toLowerCase())).slice(0, 80); const name = (el.getAttribute("aria-label") || el.textContent || el.getAttribute("placeholder") || "").trim().slice(0, 120); let css = el.id ? `#${CSS.escape(el.id)}` : el.tagName.toLowerCase(); if (!el.id) { let node = el; const parts = []; while (node && node.nodeType === 1 && parts.length < 20) { let part = node.tagName.toLowerCase(); if (node.parentElement) { const same = [...node.parentElement.children].filter((child) => child.tagName === node.tagName); if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`; } parts.unshift(part); node = node.parentElement; } css = parts.join(" > "); } return { role, name, text: (el.textContent || "").trim().slice(0, 500), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, testId: el.getAttribute("data-testid")?.slice(0, 200), css: css.slice(0, 500) }; }, point); if (!result) throw new BrowserError("INVALID_REQUEST", "No element at point."); const testIdCount = result.testId ? await session.page.getByTestId(result.testId).count().catch(() => 0) : 0; const roleCount = await session.page.getByRole(result.role, { name: result.name, exact: true }).count().catch(() => 0); const cssCount = await session.page.locator(result.css).count().catch(() => 0); if (testIdCount !== 1 && roleCount !== 1 && cssCount !== 1) throw new BrowserError("INVALID_REQUEST", "The element does not have a unique stable locator."); const locator = testIdCount === 1 ? { testId: result.testId } : roleCount === 1 ? { role: result.role, name: result.name } : { css: result.css }; const shot = await session.page.screenshot({ type: "jpeg", quality: 70, clip: result.rect }).catch(() => null); return { locator, role: trim(result.role, 80), name: trim(result.name, 120), text: trim(result.text, 500), fingerprint: `${result.role}:${result.name}:${result.rect.x}:${result.rect.y}`, rect: result.rect, viewport: session.viewport, screenshot: await artifact(session, shot) }; };
  timer = setInterval(() => void reap(), Math.min(limits.idleTtlMs, 60_000)); timer.unref?.();
  const setFrameSubscribers = async (sessionId, count) => { const session = sessions.get(sessionId); if (!session) return; session.screencastTransition = session.screencastTransition.then(async () => { session.frameSubscribers = Math.max(0, count); if (session.frameSubscribers > 0) await startScreencast(session); else await stopScreencast(session); }); await session.screencastTransition; };
  return { create, act, context: contextSlice, pick, close, list: async () => { await reap(); return Promise.all([...sessions.values()].map(snapshot)); }, subscribe: (kind, listener) => { listeners[kind]?.add(listener); return () => listeners[kind]?.delete(listener); }, setFrameSubscribers, get, getArtifact: (ref) => artifacts.get(ref)?.bytes ?? null, shutdown: async () => { clearInterval(timer); await Promise.all([...sessions.keys()].map(close)); }, BrowserError };
}
