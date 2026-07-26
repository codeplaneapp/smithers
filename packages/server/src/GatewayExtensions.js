// Gateway extensions registry. Lets a workflow (or a Smithers UI host like
// apps/smithers) declare a namespaced surface of typed resources, actions, and
// streams that flow through the existing gateway transport — same auth pipe,
// same payload bounds, same backpressure rules — without each call site
// hand-rolling RPC plumbing or stale-update handling.
//
// Wire format: extension methods are addressed as
//   ext.<namespace>.<key>            for resources (read) and actions (write)
//   ext.stream.<namespace>.<key>     for streams (subscribe)
// where <namespace> and <key> are kebab/camel identifiers (1..64 chars,
// `[a-z][a-zA-Z0-9_-]*`). The dotted shape gives us a single byte-prefix
// (`ext.`) for cheap routing checks and keeps the canonical RPC dispatcher
// untouched for built-ins.
//
// Namespace ownership is one-shot per registry: re-registering a namespace
// throws so two extensions cannot silently overwrite each other's keys.

import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";

const EXTENSION_METHOD_PREFIX = "ext.";
const EXTENSION_STREAM_METHOD_PREFIX = "ext.stream.";
const EXTENSION_IDENTIFIER_PATTERN = /^[a-z][a-zA-Z0-9_-]*$/;
const EXTENSION_IDENTIFIER_MAX_LENGTH = 64;
/**
 * Hard ceiling on a single extension response payload byte size after JSON
 * serialization. Keeps a runaway extension from blowing through the gateway's
 * inbound `maxPayload` on the wire and from monopolizing the per-connection
 * outbound buffer. Mirrors the spirit of `NODE_OUTPUT_MAX_BYTES` (8 MiB) but is
 * a hair smaller so a misbehaving extension surfaces an `ExtensionPayloadTooLarge`
 * before it pegs the WS backpressure limit and gets the connection killed.
 */
export const EXTENSION_PAYLOAD_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Per-stream outbound event queue ceiling. Mirrors the devtools slow-consumer
 * guard. Once the queue grows beyond this size the gateway raises a typed
 * `BackpressureDisconnect` and tears the stream down so a single chatty
 * extension cannot starve other consumers on the same socket.
 */
export const EXTENSION_STREAM_OUTBOUND_QUEUE_LIMIT = 1_000;

/**
 * Outbound WebSocket buffer high-water threshold. Same constant the devtools
 * stream uses — when the underlying ws.bufferedAmount exceeds this, we pause
 * the per-stream drain and back off via a microtask + timer.
 */
export const EXTENSION_WS_BUFFERED_HIGH_WATER_BYTES = 8 * 1024 * 1024;

/**
 * Typed error codes the gateway emits for extension-RPC routing failures.
 * Keeps METHOD_NOT_FOUND reserved for builtin RPCs so a UI can tell "the
 * extension namespace/key was wrong" apart from "the builtin route was
 * misnamed" without parsing the message text.
 */
export const EXTENSION_METHOD_NOT_FOUND_CODE = "EXTENSION_METHOD_NOT_FOUND";
export const EXTENSION_BACKPRESSURE_DISCONNECT_CODE = "BackpressureDisconnect";

/** @typedef {"run:read" | "run:write" | "run:admin" | "approval:submit" | "signal:submit" | "cron:read" | "cron:write" | "observability:read"} GatewayScope */

// Runtime check backing the GatewayScope typedef above (the typedef is the
// wire contract); the two must stay in lockstep.
const KNOWN_GATEWAY_SCOPES = [
  "run:read",
  "run:write",
  "run:admin",
  "approval:submit",
  "signal:submit",
  "cron:read",
  "cron:write",
  "observability:read",
];

/**
 * @typedef {object} GatewayExtensionContext
 * @property {string} namespace
 * @property {string} key
 * @property {"resource" | "action" | "stream"} kind
 * @property {readonly string[]} scopes  Scopes granted to the calling connection.
 * @property {string | null} userId
 * @property {string | null} tokenId
 * @property {string | null} connectionId
 * @property {AbortSignal} signal  Aborted when the connection drops or the
 *   stream is unsubscribed. Resource/action handlers should respect it on long
 *   work so a stale request cannot stomp a fresh one.
 */

/**
 * @typedef {object} GatewayExtensionStreamContext
 * @property {string} namespace
 * @property {string} key
 * @property {"stream"} kind
 * @property {string} streamId  Stable per-subscription id (used to fence stale
 *   replies on reconnect / fast-toggle).
 * @property {readonly string[]} scopes
 * @property {string | null} userId
 * @property {string | null} tokenId
 * @property {string | null} connectionId
 * @property {AbortSignal} signal
 * @property {(payload: unknown) => void} send  Push a frame to this subscriber.
 *   Drops silently if the connection has closed; backpressure on the underlying
 *   WS is enforced by the existing slow-consumer guard in Gateway.
 */

/**
 * @typedef {object} GatewayExtensionResource
 * @property {GatewayScope=} scope  Required scope; defaults to namespace
 *   `defaultScope`, then `run:read`.
 * @property {string=} title         Human-readable label (for diagnostics).
 * @property {(params: Record<string, unknown>, ctx: GatewayExtensionContext) => Promise<unknown> | unknown} handler
 */

/**
 * @typedef {object} GatewayExtensionAction
 * @property {GatewayScope=} scope  Defaults to namespace `defaultScope`, then `run:write`.
 * @property {string=} title
 * @property {(params: Record<string, unknown>, ctx: GatewayExtensionContext) => Promise<unknown> | unknown} handler
 */

/**
 * @typedef {object} GatewayExtensionStream
 * @property {GatewayScope=} scope  Defaults to namespace `defaultScope`, then `run:read`.
 * @property {string=} title
 * @property {(params: Record<string, unknown>, ctx: GatewayExtensionStreamContext) =>
 *   Promise<{ initial?: unknown; cleanup?: () => void | Promise<void> } | (() => void | Promise<void>) | void>} subscribe
 *   Called once when a subscriber attaches. Returns either a `cleanup` callable
 *   (no replay frame) or an `{initial, cleanup}` envelope where `initial` is
 *   the first frame delivered to the subscriber (replay snapshot used for
 *   resume after a reconnect).
 */

/**
 * @typedef {object} GatewayExtensionDefinition
 * @property {string=} title
 * @property {string=} description
 * @property {GatewayScope=} defaultScope
 * @property {Record<string, GatewayExtensionResource>=} resources
 * @property {Record<string, GatewayExtensionResource>=} queries
 *   Alias for `resources`; both surfaces route the same way. Useful when an
 *   extension wants to draw a read/write line in code.
 * @property {Record<string, GatewayExtensionAction>=} actions
 * @property {Record<string, GatewayExtensionStream>=} streams
 */

/**
 * @typedef {object} ResolvedExtension
 * @property {"resource" | "action" | "stream"} kind
 * @property {string} namespace
 * @property {string} key
 * @property {GatewayScope} scope
 * @property {GatewayExtensionResource | GatewayExtensionAction | GatewayExtensionStream} entry
 */

/**
 * @param {string} value
 * @param {string} field
 */
function assertExtensionIdentifier(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new SmithersError("INVALID_INPUT", `Gateway extension ${field} is required.`);
  }
  if (value.length > EXTENSION_IDENTIFIER_MAX_LENGTH) {
    throw new SmithersError(
      "INVALID_INPUT",
      `Gateway extension ${field} exceeds ${EXTENSION_IDENTIFIER_MAX_LENGTH} chars.`,
      { [field]: value },
    );
  }
  if (!EXTENSION_IDENTIFIER_PATTERN.test(value)) {
    throw new SmithersError("INVALID_INPUT", `Gateway extension ${field} must match /^[a-z][a-zA-Z0-9_-]*$/.`, {
      [field]: value,
    });
  }
}

/**
 * @param {string} namespace
 * @param {string} kindLabel
 * @param {Record<string, { handler?: unknown; subscribe?: unknown }>} entries
 */
function assertHandlersCallable(namespace, kindLabel, entries) {
  for (const [key, entry] of Object.entries(entries)) {
    assertExtensionIdentifier(key, `${kindLabel} key`);
    const callable = kindLabel === "stream" ? entry.subscribe : entry.handler;
    if (typeof callable !== "function") {
      throw new SmithersError(
        "INVALID_INPUT",
        `Gateway extension ${namespace}.${kindLabel}.${key} must define a ${kindLabel === "stream" ? "subscribe" : "handler"} function.`,
      );
    }
  }
}

export class GatewayExtensions {
  constructor() {
    /** @type {Map<string, GatewayExtensionDefinition>} */
    this.namespaces = new Map();

    // Track resource + action keys per namespace so namespaced collisions are
    // caught at register time.
    /** @type {Map<string, Set<string>>} */
    this.invocableKeys = new Map();
    /** @type {Map<string, Set<string>>} */
    this.streamKeys = new Map();
  }

  /**
   * @param {string} namespace
   * @param {GatewayExtensionDefinition} definition
   */
  register(namespace, definition) {
    assertExtensionIdentifier(namespace, "namespace");
    if (this.namespaces.has(namespace)) {
      throw new SmithersError("INVALID_INPUT", `Gateway extension namespace already registered: ${namespace}`, {
        namespace,
      });
    }
    if (!definition || typeof definition !== "object") {
      throw new SmithersError("INVALID_INPUT", `Gateway extension definition is required: ${namespace}`);
    }
    if (definition.defaultScope !== undefined) {
      assertScope(definition.defaultScope, `${namespace}.defaultScope`);
    }
    const invocable = new Set();
    const streams = new Set();
    const resources = { ...definition.resources, ...definition.queries };
    assertHandlersCallable(namespace, "resource", resources);
    for (const [key, entry] of Object.entries(resources)) {
      if (entry.scope !== undefined) {
        assertScope(entry.scope, `${namespace}.resources.${key}.scope`);
      }
      invocable.add(key);
    }
    assertHandlersCallable(namespace, "action", definition.actions ?? {});
    for (const [key, entry] of Object.entries(definition.actions ?? {})) {
      if (invocable.has(key)) {
        throw new SmithersError(
          "INVALID_INPUT",
          `Gateway extension ${namespace}.${key} is declared as both a resource and an action.`,
          { namespace, key },
        );
      }
      if (entry.scope !== undefined) {
        assertScope(entry.scope, `${namespace}.actions.${key}.scope`);
      }
      invocable.add(key);
    }
    assertHandlersCallable(namespace, "stream", definition.streams ?? {});
    for (const [key, entry] of Object.entries(definition.streams ?? {})) {
      if (entry.scope !== undefined) {
        assertScope(entry.scope, `${namespace}.streams.${key}.scope`);
      }
      streams.add(key);
    }
    // Replace the loose resources/queries pair with the merged `resources` map
    // so resolution below has one source of truth.
    const stored = {
      title: definition.title,
      description: definition.description,
      defaultScope: definition.defaultScope,
      resources,
      actions: definition.actions ?? {},
      streams: definition.streams ?? {},
    };
    this.namespaces.set(namespace, stored);
    this.invocableKeys.set(namespace, invocable);
    this.streamKeys.set(namespace, streams);
    return this;
  }

  /**
   * @param {string} method
   * @returns {ResolvedExtension | undefined}
   */
  resolve(method) {
    if (typeof method !== "string" || !method.startsWith(EXTENSION_METHOD_PREFIX)) {
      return undefined;
    }
    if (method.startsWith(EXTENSION_STREAM_METHOD_PREFIX)) {
      const rest = method.slice(EXTENSION_STREAM_METHOD_PREFIX.length);
      const splitAt = rest.indexOf(".");
      if (splitAt <= 0 || splitAt === rest.length - 1) {
        return undefined;
      }
      const namespace = rest.slice(0, splitAt);
      const key = rest.slice(splitAt + 1);
      const definition = this.namespaces.get(namespace);
      const entry = definition?.streams[key];
      if (!definition || !entry) {
        return undefined;
      }
      return {
        kind: "stream",
        namespace,
        key,
        scope: entry.scope ?? definition.defaultScope ?? "run:read",
        entry,
      };
    }
    const rest = method.slice(EXTENSION_METHOD_PREFIX.length);
    const splitAt = rest.indexOf(".");
    if (splitAt <= 0 || splitAt === rest.length - 1) {
      return undefined;
    }
    const namespace = rest.slice(0, splitAt);
    const key = rest.slice(splitAt + 1);
    const definition = this.namespaces.get(namespace);
    if (!definition) {
      return undefined;
    }
    const resource = definition.resources[key];
    if (resource) {
      return {
        kind: "resource",
        namespace,
        key,
        scope: resource.scope ?? definition.defaultScope ?? "run:read",
        entry: resource,
      };
    }
    const action = definition.actions[key];
    if (action) {
      return {
        kind: "action",
        namespace,
        key,
        scope: action.scope ?? definition.defaultScope ?? "run:write",
        entry: action,
      };
    }
    return undefined;
  }

  /**
   * Pre-flight scope lookup for a method name, used by `requiredScopeForMethod`
   * in the gateway so the standard auth pipeline can refuse an unauthorized
   * extension RPC before the handler runs.
   * @param {string} method
   * @returns {GatewayScope | undefined}
   */
  requiredScopeForMethod(method) {
    return this.resolve(method)?.scope;
  }

  /**
   * Enumerate registered extensions (for diagnostics / introspection).
   */
  list() {
    const result = [];
    for (const [namespace, definition] of this.namespaces.entries()) {
      result.push({
        namespace,
        title: definition.title,
        description: definition.description,
        defaultScope: definition.defaultScope,
        resources: Object.keys(definition.resources),
        actions: Object.keys(definition.actions),
        streams: Object.keys(definition.streams),
      });
    }
    return result;
  }
}

/**
 * @param {unknown} scope
 * @param {string} field
 */
function assertScope(scope, field) {
  if (typeof scope !== "string" || !KNOWN_GATEWAY_SCOPES.includes(scope)) {
    throw new SmithersError("INVALID_INPUT", `Gateway extension ${field} must be a known GatewayScope.`, {
      field,
      scope,
    });
  }
}

/**
 * Build the canonical extension method name. Useful in tests and tooling.
 * @param {string} namespace
 * @param {"resource" | "action" | "stream"} kind
 * @param {string} key
 */
export function extensionMethodName(namespace, kind, key) {
  assertExtensionIdentifier(namespace, "namespace");
  assertExtensionIdentifier(key, `${kind} key`);
  if (kind === "stream") {
    return `${EXTENSION_STREAM_METHOD_PREFIX}${namespace}.${key}`;
  }
  return `${EXTENSION_METHOD_PREFIX}${namespace}.${key}`;
}

/**
 * @param {string} method
 */
export function isExtensionMethod(method) {
  return typeof method === "string" && method.startsWith(EXTENSION_METHOD_PREFIX);
}

export { EXTENSION_METHOD_PREFIX, EXTENSION_STREAM_METHOD_PREFIX };
