#!/usr/bin/env node
// Durable Smithers routing for Codex's native multi-agent spawn tool.
// Dependency-free: this file intentionally uses only Node built-ins.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

export const HINT_TEXT =
  "This machine uses Smithers (smithers.sh), a durable control plane for agent work. For multi-step, long-running, or background work, run a Smithers workflow via the smithers MCP tools (list_workflows, run_workflow, watch_run) instead of spawning ad-hoc subagents; spawn agents only for quick one-off lookups.";
export const STATE_SCHEMA = 1;
export const STATE_FILE = ".smithers-codex-routing.json";
export const FIELD_PATHS = Object.freeze([
  "features.multi_agent_v2.multi_agent_mode_hint_text",
  "features.multi_agent_v2.usage_hint_text",
]);
const ABSENT = Object.freeze({ present: false });

export function parseArgs(argv) {
  const args = { action: "preview", apply: false, replaceExistingPolicy: false, requireEffective: false, codexBin: "codex" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--status") args.action = "status";
    else if (arg === "--disable") args.action = "disable";
    else if (arg === "--require-effective") args.requireEffective = true;
    else if (arg === "--replace-existing-policy") args.replaceExistingPolicy = true;
    else if (arg === "--codex-bin") {
      if (!argv[i + 1]) throw new Error("--codex-bin requires a path or command");
      args.codexBin = argv[++i];
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.requireEffective && args.action !== "status") throw new Error("--require-effective requires --status");
  if (args.action === "status" && (args.apply || args.replaceExistingPolicy)) throw new Error("--status cannot be combined with --apply or --replace-existing-policy");
  return args;
}

export function getNested(object, path) {
  let value = object;
  for (const part of path.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) return ABSENT;
    value = value[part];
  }
  // config/read represents a deleted TOML key as null in some client versions;
  // treat that as the same explicit absent marker used by the snapshot.
  return value === null ? ABSENT : value;
}

export function snapshotValue(value) {
  return value === ABSENT ? { present: false } : { present: true, value };
}

export function currentFields(config) {
  return Object.fromEntries(FIELD_PATHS.map((path) => [path, getNested(config, path)]));
}

function fieldsEqual(actual, expected) {
  const actualAbsent = actual === ABSENT || actual?.present === false;
  const expectedAbsent = expected === ABSENT || expected?.present === false;
  return actualAbsent && expectedAbsent || !actualAbsent && !expectedAbsent && Object.is(actual, expected);
}

export function isManagedValue(value) {
  return value === HINT_TEXT;
}

export function classifyState(userConfig, effectiveConfig, state) {
  const user = currentFields(userConfig);
  const effective = currentFields(effectiveConfig);
  const hasUserValues = FIELD_PATHS.some((path) => user[path] !== ABSENT);
  if (!state) return hasUserValues ? "user-conflict" : "not installed";
  const managed = state.managed;
  const userMatches = FIELD_PATHS.every((path) => user[path] === managed[path]);
  const effectiveMatches = FIELD_PATHS.every((path) => effective[path] === managed[path]);
  return userMatches && effectiveMatches ? "installed" : "drifted";
}

export function makeEdits(values) {
  return FIELD_PATHS.map((path) => ({
    keyPath: path,
    value: values[path] === ABSENT || values[path]?.present === false ? null : values[path],
    mergeStrategy: "replace",
  }));
}

export function buildSnapshot(config, configPath, version) {
  const fields = currentFields(config);
  return {
    schema: STATE_SCHEMA,
    managedBy: "smithers-codex-routing",
    configPath,
    userLayerVersion: version ?? null,
    previous: Object.fromEntries(FIELD_PATHS.map((path) => [path, snapshotValue(fields[path])])),
    managed: Object.fromEntries(FIELD_PATHS.map((path) => [path, HINT_TEXT])),
  };
}

function statePath(codexHome) { return join(codexHome, STATE_FILE); }

function readState(codexHome) {
  const path = statePath(codexHome);
  if (!existsSync(path)) return null;
  const state = JSON.parse(readFileSync(path, "utf8"));
  if (state?.schema !== STATE_SCHEMA || state.managedBy !== "smithers-codex-routing" || !state.previous || !state.managed) throw new Error(`Invalid routing state: ${path}`);
  for (const field of FIELD_PATHS) {
    if (!Object.hasOwn(state.previous, field) || state.previous[field].present && !Object.hasOwn(state.previous[field], "value")) throw new Error(`Invalid routing snapshot for ${field}`);
    if (state.managed[field] !== HINT_TEXT) throw new Error(`Invalid managed routing value for ${field}`);
  }
  return state;
}

function writeState(codexHome, state) {
  mkdirSync(codexHome, { recursive: true });
  const path = statePath(codexHome);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

function removeState(codexHome) {
  const path = statePath(codexHome);
  if (existsSync(path)) unlinkSync(path);
}

function findBinary(name) {
  if (name.includes("/") || name.includes("\\")) return resolve(name);
  for (const directory of (process.env.PATH || "").split(delimiter)) {
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Codex binary is not on PATH: ${name}`);
}

function runVersion(binary) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolvePromise(output.trim() || `exit ${code}`) : reject(new Error(output.trim() || `exit ${code}`)));
  });
}

export class AppServer {
  constructor(binary) {
    this.binary = binary;
    this.nextId = 0;
    this.pending = new Map();
    this.buffer = "";
    this.child = spawn(binary, ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
    this.stderr = "";
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk; });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.receive(chunk));
    this.child.on("error", (error) => this.fail(error));
    this.child.on("close", () => this.fail(new Error(`Codex App Server closed stdout${this.stderr ? `: ${this.stderr.trim()}` : ""}`)));
  }
  receive(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch (error) { this.fail(new Error(`Invalid App Server JSON: ${error.message}`)); continue; }
      if (message.id !== undefined && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${pending.method} failed: ${message.error.message || "unknown error"}`));
        else pending.resolve(message.result);
      }
    }
  }
  fail(error) { for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); }
  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject, method });
      this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }
  notify(method) { this.child.stdin.write(`${JSON.stringify({ method })}\n`); }
  async initialize() {
    const result = await this.request("initialize", { clientInfo: { name: "smithers_codex_routing", title: "Smithers Codex Routing", version: "1.0.0" }, capabilities: { experimentalApi: true } });
    this.notify("initialized");
    this.codexHome = resolve(result.codexHome || process.env.CODEX_HOME || join(homedir(), ".codex"));
    this.configPath = join(this.codexHome, "config.toml");
    return this;
  }
  close() { if (!this.child.killed) this.child.kill(); }
}

async function readConfig(app) {
  const result = await app.request("config/read", { includeLayers: true, cwd: process.cwd() });
  const layers = Array.isArray(result.layers) ? result.layers : [];
  const layer = layers.find((item) => item?.name?.type === "user" && item.name.profile == null);
  return { result, user: layer?.config && typeof layer.config === "object" ? layer.config : {}, version: typeof layer?.version === "string" ? layer.version : null, effective: result.config && typeof result.config === "object" ? result.config : {} };
}

async function batchWrite(app, edits, expectedVersion) {
  return app.request("config/batchWrite", { edits, expectedVersion, reloadUserConfig: true });
}

function printFields(label, fields) {
  console.log(`${label}:`);
  for (const path of FIELD_PATHS) console.log(`  ${path}: ${fields[path] === ABSENT ? "<absent>" : JSON.stringify(fields[path])}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let binary;
  try { binary = findBinary(args.codexBin); } catch (error) {
    if (args.action === "status") {
      console.log(`Codex: unavailable (${error.message})`);
      return args.requireEffective ? 1 : 0;
    }
    throw error;
  }
  let version;
  try { version = await runVersion(binary); } catch (error) { if (args.action === "status") { console.log(`Codex: unavailable (${error.message})`); return args.requireEffective ? 1 : 0; } throw error; }
  if (args.action === "status") console.log(`Codex: ${version}`);
  const app = new AppServer(binary);
  try {
    await app.initialize();
    const data = await readConfig(app);
    const state = readState(app.codexHome);
    if (state && resolve(state.configPath) !== resolve(app.configPath)) throw new Error("Routing state belongs to a different Codex config file");
    const stateClass = classifyState(data.user, data.effective, state);
    if (args.action === "status") {
      console.log(`Config: ${app.configPath}`);
      console.log(`Native policy: ${stateClass}`);
      const compatible = /(?:^|\s)0\.(?:14[4-9]|1[5-9]\d|[2-9]\d\d)(?:\.|\s|$)/.test(version);
      if (!compatible) console.log("Client compatibility: incompatible (requires Codex >= 0.144)");
      else console.log("Client compatibility: compatible");
      return args.requireEffective && (stateClass !== "installed" || !compatible) ? 1 : 0;
    }
    if (args.action === "disable") {
      if (!state) throw new Error("No Smithers snapshot found; refusing to disable user-authored fields.");
      const current = currentFields(data.user);
      if (!FIELD_PATHS.every((path) => current[path] === state.managed[path])) throw new Error("Managed fields were edited after setup; refusing to clobber the user edit.");
      const restore = Object.fromEntries(FIELD_PATHS.map((path) => [path, state.previous[path].present ? state.previous[path].value : ABSENT]));
      printFields("Current values", current);
      printFields("Restore values", restore);
      if (!args.apply) { console.log("Dry run only. Re-run with --disable --apply to restore the snapshot."); return 0; }
      const written = await batchWrite(app, makeEdits(restore), data.version);
      if (!String(written.status || "").startsWith("ok")) throw new Error(`Unexpected config write status: ${written.status}`);
      const verified = await readConfig(app);
      const verifiedFields = currentFields(verified.user);
      if (!FIELD_PATHS.every((path) => fieldsEqual(verifiedFields[path], restore[path]))) {
        throw new Error("Rollback validation failed; managed fields may remain.");
      }
      removeState(app.codexHome);
      console.log("Native routing disabled; snapshot restored.");
      return 0;
    }
    const current = currentFields(data.user);
    const existingState = state;
    if (existingState && !FIELD_PATHS.every((path) => current[path] === existingState.managed[path])) throw new Error("Managed fields drifted outside this plugin; refusing to overwrite them.");
    if (!existingState && FIELD_PATHS.some((path) => current[path] !== ABSENT && !isManagedValue(current[path])) && !args.replaceExistingPolicy) {
      printFields("User-authored conflict", current);
      throw new Error("A user-authored managed hint exists; review it and pass --replace-existing-policy to replace and snapshot it.");
    }
    const nextState = existingState || buildSnapshot(data.user, app.configPath, data.version);
    printFields("Current values", current);
    printFields("Proposed values", Object.fromEntries(FIELD_PATHS.map((path) => [path, HINT_TEXT])));
    console.log(`Snapshot: ${JSON.stringify(nextState, null, 2)}`);
    if (!args.apply) { console.log("Dry run only. Re-run with --apply to install the policy."); return 0; }
    const proposed = Object.fromEntries(FIELD_PATHS.map((path) => [path, HINT_TEXT]));
    const written = await batchWrite(app, makeEdits(proposed), data.version);
    if (!String(written.status || "").startsWith("ok")) throw new Error(`Unexpected config write status: ${written.status}`);
    writeState(app.codexHome, nextState);
    console.log("Native routing policy installed.");
    return 0;
  } catch (error) {
    if (args.action === "status") {
      console.log(`Native policy: unavailable (${error.message})`);
      return args.requireEffective ? 1 : 0;
    }
    throw error;
  } finally { app.close(); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { process.exitCode = await main(); } catch (error) { console.error(`Error: ${error.message}`); process.exitCode = 1; }
}
