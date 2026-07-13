#!/usr/bin/env node
// Durable Smithers routing for Codex's native multi-agent spawn tool.
// Dependency-free: this file intentionally uses only Node built-ins.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, renameSync, unlinkSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const HINT_TEXT = "This machine uses Smithers (smithers.sh), a durable control plane for agent work. For multi-step, long-running, or background work, run a Smithers workflow via the smithers MCP tools (list_workflows, run_workflow, watch_run) instead of spawning ad-hoc subagents; spawn agents only for quick one-off lookups.";
export const STATE_SCHEMA = 1;
export const STATE_FILE = ".smithers-codex-routing.json";
export const FIELD_PATHS = Object.freeze([
  "features.multi_agent_v2.multi_agent_mode_hint_text",
  "features.multi_agent_v2.usage_hint_text",
]);
export const RPC_TIMEOUT_MS = 20_000;
export const PROCESS_TIMEOUT_MS = 20_000;
const ABSENT = Object.freeze({ present: false });

export function parseArgs(argv) {
  const args = { action: "preview", apply: false, replaceExistingPolicy: false, requireEffective: false, codexBin: "codex" };
  const actions = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--status") { args.action = "status"; actions.push("status"); }
    else if (arg === "--disable") { args.action = "disable"; actions.push("disable"); }
    else if (arg === "--require-effective") args.requireEffective = true;
    else if (arg === "--replace-existing-policy") args.replaceExistingPolicy = true;
    else if (arg === "--codex-bin") {
      if (!argv[i + 1]) throw new Error("--codex-bin requires a path or command");
      args.codexBin = argv[++i];
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (actions.length > 1) throw new Error("--status and --disable are mutually exclusive");
  if (args.requireEffective && args.action !== "status") throw new Error("--require-effective requires --status");
  if (args.action === "status" && (args.apply || args.replaceExistingPolicy)) throw new Error("--status cannot be combined with --apply or --replace-existing-policy");
  if (args.action === "disable" && args.replaceExistingPolicy) throw new Error("--disable cannot be combined with --replace-existing-policy");
  return args;
}

export function getNested(object, path) {
  let value = object;
  for (const part of path.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) return ABSENT;
    value = value[part];
  }
  return value === null || value === undefined ? ABSENT : value;
}

export function snapshotValue(value) { return value === ABSENT ? { present: false } : { present: true, value }; }
export function currentFields(config) { return Object.fromEntries(FIELD_PATHS.map((path) => [path, getNested(config, path)])); }
function absent(value) { return value === ABSENT || value?.present === false; }
export function fieldsEqual(actual, expected) { return absent(actual) && absent(expected) || !absent(actual) && !absent(expected) && Object.is(actual, expected); }
export function isManagedValue(value) { return typeof value === "string"; }
export function parentIsScalar(config) {
  const features = config && typeof config === "object" ? config.features : undefined;
  const multiAgent = features && typeof features === "object" ? features.multi_agent_v2 : undefined;
  return features !== undefined && (features === null || typeof features !== "object")
    || multiAgent !== undefined && (multiAgent === null || typeof multiAgent !== "object");
}

export function classifyState(userConfig, effectiveConfig, state) {
  if (parentIsScalar(userConfig) || parentIsScalar(effectiveConfig)) return "incompatible (scalar multi_agent_v2)";
  const user = currentFields(userConfig);
  const effective = currentFields(effectiveConfig);
  if (!state) return FIELD_PATHS.some((path) => !absent(user[path])) ? "user-conflict" : "not installed";
  const managed = state.managed;
  const userMatches = FIELD_PATHS.every((path) => fieldsEqual(user[path], managed[path]));
  const effectiveMatches = FIELD_PATHS.every((path) => fieldsEqual(effective[path], managed[path]));
  return userMatches && effectiveMatches ? "installed" : "drifted";
}

export function makeEdits(values) { return FIELD_PATHS.map((keyPath) => ({ keyPath, value: absent(values[keyPath]) ? null : values[keyPath], mergeStrategy: "replace" })); }
export function buildSnapshot(config, configPath, version) {
  return { schema: STATE_SCHEMA, managedBy: "smithers-codex-routing", phase: "committed", configPath, userLayerVersion: version ?? null, previous: Object.fromEntries(FIELD_PATHS.map((path) => [path, snapshotValue(getNested(config, path))])), managed: Object.fromEntries(FIELD_PATHS.map((path) => [path, HINT_TEXT])) };
}
export function mergeSnapshot(state, configPath) {
  return { ...state, configPath, managed: Object.fromEntries(FIELD_PATHS.map((path) => [path, HINT_TEXT])) };
}

function statePath(home) { return join(home, STATE_FILE); }
export function readState(codexHome) {
  const path = statePath(codexHome);
  if (!existsSync(path)) return null;
  const state = JSON.parse(readFileSync(path, "utf8"));
  if (state?.schema !== STATE_SCHEMA || state.managedBy !== "smithers-codex-routing" || !state.previous || !state.managed) throw new Error(`Invalid routing state: ${path}`);
  for (const field of FIELD_PATHS) {
    const previous = state.previous[field];
    if (!previous || typeof previous.present !== "boolean" || previous.present && !Object.hasOwn(previous, "value")) throw new Error(`Invalid routing snapshot for ${field}`);
    if (typeof state.managed[field] !== "string") throw new Error(`Invalid managed routing value for ${field}`);
  }
  return state;
}
function writeState(home, state) {
  mkdirSync(home, { recursive: true });
  const path = statePath(home); const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}
function removeState(home) { const path = statePath(home); if (existsSync(path)) unlinkSync(path); }

function withLock(home) {
  const path = `${statePath(home)}.lock`;
  try { mkdirSync(path); writeFileSync(join(path, "owner"), `${process.pid}\n`, "utf8"); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error(`Another routing operation owns ${path}`);
    throw error;
  }
  return () => { try { rmSync(path, { recursive: true, force: true }); } catch {} };
}

function findBinary(name) {
  if (name.includes("/") || name.includes("\\")) return resolve(name);
  for (const directory of (process.env.PATH || "").split(delimiter)) { const candidate = join(directory, name); if (existsSync(candidate)) return candidate; }
  throw new Error(`Codex binary is not on PATH: ${name}`);
}
export function compatibleVersion(version) {
  const match = String(version).match(/(?:^|\s)v?(\d+)\.(\d+)(?:\.(\d+))?/);
  return !!match && (Number(match[1]) > 0 || Number(match[2]) >= 144);
}
function runVersion(binary) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, ["--version"], { stdio: ["ignore", "pipe", "pipe"] }); let output = ""; let done = false;
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); if (error) reject(error); else resolvePromise(value); };
    child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", (error) => finish(error)); child.on("close", (code) => code === 0 ? finish(null, output.trim() || `exit ${code}`) : finish(new Error(output.trim() || `exit ${code}`)));
    const timer = setTimeout(() => { child.kill("SIGTERM"); setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 250); finish(new Error(`Timed out running ${binary} --version`)); }, PROCESS_TIMEOUT_MS);
  });
}

export class AppServer {
  constructor(binary) {
    this.binary = binary; this.nextId = 0; this.pending = new Map(); this.buffer = ""; this.stderr = ""; this.closed = false;
    this.child = spawn(binary, ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk; }); this.child.stdout.setEncoding("utf8"); this.child.stdout.on("data", (chunk) => this.receive(chunk));
    this.child.on("error", (error) => this.fail(error)); this.child.on("close", () => this.fail(new Error(`Codex App Server closed${this.stderr ? `: ${this.stderr.trim()}` : ""}`)));
  }
  receive(chunk) { this.buffer += chunk; let newline; while ((newline = this.buffer.indexOf("\n")) >= 0) { const line = this.buffer.slice(0, newline).trim(); this.buffer = this.buffer.slice(newline + 1); if (!line) continue; let message; try { message = JSON.parse(line); } catch (error) { this.fail(new Error(`Invalid App Server JSON: ${error.message}`)); continue; } if (message.id !== undefined && this.pending.has(message.id)) { const pending = this.pending.get(message.id); clearTimeout(pending.timer); this.pending.delete(message.id); if (message.error) pending.reject(new Error(`${pending.method} failed: ${message.error.message || "unknown error"}`)); else pending.resolve(message.result); } } }
  fail(error) { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.pending.clear(); }
  send(message) { return new Promise((resolvePromise, reject) => { if (this.closed || this.child.stdin.destroyed) return reject(new Error("Codex App Server stdin is closed")); this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => error ? reject(new Error(`Could not write to Codex App Server: ${error.message}`)) : resolvePromise()); }); }
  request(method, params) { const id = this.nextId++; return new Promise((resolvePromise, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Timed out waiting for App Server method ${method}${this.stderr ? `: ${this.stderr.trim()}` : ""}`)); }, RPC_TIMEOUT_MS); this.pending.set(id, { resolve: resolvePromise, reject, method, timer }); this.send({ method, id, params }).catch((error) => { clearTimeout(timer); this.pending.delete(id); reject(error); }); }); }
  notify(method) { return this.send({ method }); }
  async initialize() { const result = await this.request("initialize", { clientInfo: { name: "smithers_codex_routing", title: "Smithers Codex Routing", version: "1.1.0" }, capabilities: { experimentalApi: true } }); await this.notify("initialized"); this.codexHome = resolve(result.codexHome || process.env.CODEX_HOME || join(homedir(), ".codex")); this.configPath = join(this.codexHome, "config.toml"); return this; }
  close() { if (this.closed) return; this.closed = true; this.fail(new Error("Codex App Server closed by client")); this.child.kill("SIGTERM"); setTimeout(() => { if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL"); }, 250); }
}

async function readConfig(app) {
  const result = await app.request("config/read", { includeLayers: true, cwd: process.cwd() }); const layers = Array.isArray(result.layers) ? result.layers : [];
  const layer = layers.find((item) => item?.name?.type === "user" && item.name.profile == null);
  return { result, user: layer?.config ?? {}, version: typeof layer?.version === "string" ? layer.version : null, hasUserLayer: Boolean(layer), effective: result.config ?? {} };
}
async function batchWrite(app, edits, expectedVersion, { allowOverridden = false } = {}) { const result = await app.request("config/batchWrite", { edits, expectedVersion, reloadUserConfig: true }); if (result.status === "okOverridden" && !allowOverridden) { const error = new Error("Codex reported okOverridden; the managed fields are not effective"); error.writeResult = result; throw error; } if (result.status !== "ok" && result.status !== "okOverridden") { const error = new Error(`Unexpected config write status: ${result.status}`); error.writeResult = result; throw error; } if (typeof result.version !== "string") throw new Error("Codex config write did not return a version"); return result; }
function printFields(label, fields) { console.log(`${label}:`); for (const path of FIELD_PATHS) console.log(`  ${path}: ${absent(fields[path]) ? "<absent>" : JSON.stringify(fields[path])}`); }
export function restoreValues(state) { return Object.fromEntries(FIELD_PATHS.map((path) => [path, state.previous[path].present ? state.previous[path].value : ABSENT])); }
async function rollback(app, expectedVersion, values) { const result = await batchWrite(app, makeEdits(values), expectedVersion, { allowOverridden: true }); const verified = await readConfig(app); if (!restoreMatchesUser(verified.user, values)) throw new Error("Rollback validation failed; managed fields may remain."); return result; }
export function restoreMatchesUser(userConfig, values) { return FIELD_PATHS.every((path) => fieldsEqual(currentFields(userConfig)[path], values[path])); }

async function main() {
  const args = parseArgs(process.argv.slice(2)); const fallbackHome = resolve(process.env.CODEX_HOME || join(homedir(), ".codex")); const fallbackConfig = join(fallbackHome, "config.toml");
  let binary;
  try { binary = findBinary(args.codexBin); } catch (error) { if (args.action === "status") { console.log(`Config: ${fallbackConfig}\nNative policy: unavailable (${error.message})\nCodex: unavailable`); return args.requireEffective ? 1 : 0; } throw error; }
  let version;
  try { version = await runVersion(binary); } catch (error) { if (args.action === "status") { console.log(`Config: ${fallbackConfig}\nNative policy: unavailable (${error.message})\nCodex: unavailable`); return args.requireEffective ? 1 : 0; } throw error; }
  const app = new AppServer(binary);
  let releaseLock = () => {};
  try {
    await app.initialize();
    if (args.action !== "status") releaseLock = withLock(app.codexHome);
    let data = await readConfig(app); let state = readState(app.codexHome);
    if (state && resolve(state.configPath) !== resolve(app.configPath)) throw new Error("Routing state belongs to a different Codex config file");
    if (state?.phase === "pending-install") {
      const user = currentFields(data.user); const previous = restoreValues(state);
      if (FIELD_PATHS.every((path) => fieldsEqual(user[path], state.managed[path]))) {
        state = { ...state, phase: "committed" }; writeState(app.codexHome, state);
      } else if (FIELD_PATHS.every((path) => fieldsEqual(user[path], previous[path]))) {
        removeState(app.codexHome); state = null;
      } else {
        throw new Error("A previous routing write is pending recovery; user fields no longer match either the saved snapshot or the managed policy.");
      }
      data = await readConfig(app);
    }
    if (state?.phase === "pending-disable") {
      const user = currentFields(data.user); const previous = restoreValues(state);
      if (FIELD_PATHS.every((path) => fieldsEqual(user[path], previous[path]))) { removeState(app.codexHome); state = null; }
      else if (!FIELD_PATHS.every((path) => fieldsEqual(user[path], state.managed[path]))) throw new Error("A previous disable is pending recovery and managed fields were edited; refusing to clobber them.");
    }
    const stateClass = classifyState(data.user, data.effective, state); const compatible = compatibleVersion(version);
    if (args.action === "status") { console.log(`Codex: ${version}\nConfig: ${app.configPath}\nNative policy: ${stateClass}\nClient compatibility: ${compatible ? "compatible" : "incompatible (requires Codex >= 0.144)"}`); return args.requireEffective && (stateClass !== "installed" || !compatible) ? 1 : 0; }
    if (args.action !== "disable" && !compatible) throw new Error(`Codex ${version} is incompatible; requires Codex >= 0.144`);
    if (parentIsScalar(data.user) || parentIsScalar(data.effective)) throw new Error("features.multi_agent_v2 is a scalar; refusing to write fields beneath it because the change is not safely restorable.");
    if (existsSync(app.configPath) && typeof data.version !== "string") throw new Error("Codex config/read did not provide a user-layer version; refusing an unprotected write.");
    const current = currentFields(data.user);
    if (args.action === "disable") {
      if (!state) throw new Error("No Smithers snapshot found; refusing to disable user-authored fields.");
      if (!FIELD_PATHS.every((path) => fieldsEqual(current[path], state.managed[path]))) throw new Error("Managed fields were edited after setup; refusing to clobber the user edit.");
      const restore = restoreValues(state); printFields("Current values", current); printFields("Restore values", restore); if (!args.apply) { console.log("Dry run only. Re-run with --disable --apply to restore the snapshot."); return 0; }
      writeState(app.codexHome, { ...state, phase: "pending-disable" });
      try { await rollback(app, data.version, restore); removeState(app.codexHome); console.log("Native routing disabled; snapshot restored."); return 0; } catch (error) { throw new Error(`${error.message}; managed fields may remain.`); }
    }
    if (state && !FIELD_PATHS.every((path) => fieldsEqual(current[path], state.managed[path]))) throw new Error("Managed fields drifted outside this plugin; refusing to overwrite them.");
    if (!state && FIELD_PATHS.some((path) => !absent(current[path])) && !args.replaceExistingPolicy) { printFields("User-authored conflict", current); throw new Error("A user-authored managed hint exists; review it and pass --replace-existing-policy to replace and snapshot it."); }
    const nextState = state ? mergeSnapshot(state, app.configPath) : buildSnapshot(data.user, app.configPath, data.version);
    printFields("Current values", current); printFields("Proposed values", Object.fromEntries(FIELD_PATHS.map((path) => [path, HINT_TEXT]))); console.log(`Snapshot: ${JSON.stringify(nextState, null, 2)}`); if (!args.apply) { console.log("Dry run only. Re-run with --apply to install the policy."); return 0; }
    const createdState = !state;
    writeState(app.codexHome, { ...nextState, phase: "pending-install" });
    let written;
    try {
      written = await batchWrite(app, makeEdits(Object.fromEntries(FIELD_PATHS.map((path) => [path, HINT_TEXT]))), data.version);
      const verified = await readConfig(app); const verifiedClass = classifyState(verified.user, verified.effective, nextState);
      if (verifiedClass !== "installed") throw new Error(`Effective installation validation failed: ${verifiedClass}`);
      writeState(app.codexHome, { ...nextState, phase: "committed" });
      console.log("Native routing policy installed."); return 0;
    } catch (error) {
      written ||= error.writeResult;
      if (written?.version) { try { await rollback(app, written.version, createdState ? restoreValues(nextState) : Object.fromEntries(FIELD_PATHS.map((path) => [path, state.managed[path]]))); } catch (rollbackError) { throw new Error(`${error.message}; rollback also failed: ${rollbackError.message}; managed fields may remain.`); } }
      if (written?.version) {
        if (createdState) removeState(app.codexHome);
        else writeState(app.codexHome, { ...nextState, phase: "committed" });
      }
      throw error;
    }
  } catch (error) {
    if (args.action === "status") { console.log(`Config: ${app.configPath || fallbackConfig}\nNative policy: unavailable (${error.message})\nCodex: ${version || "unavailable"}`); return args.requireEffective ? 1 : 0; }
    throw error;
  } finally { releaseLock(); app.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { try { process.exitCode = await main(); } catch (error) { console.error(`Error: ${error.message}`); process.exitCode = 1; } }
