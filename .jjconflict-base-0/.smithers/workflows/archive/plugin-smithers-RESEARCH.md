# ElizaOS Plugin Architecture — Authoritative Reference

> **Scope & version framing.** This reference leads with the **current stable runtime, `@elizaos/core` v1.x** (npm `latest` = **`1.7.2`**, the line essentially every shipping plugin targets). Type signatures marked "verbatim" come from the published `1.7.2` `dist/types/*.d.ts`. Where the in-development **v2 / 2.0.x line** (`@elizaos/core@2.0.x-alpha`/`-beta`, the GitHub `main`/`develop` branches; dist-tags `next`/`alpha`/`beta`) differs, it is flagged explicitly as *unreleased — do not target unless you have pinned a 2.0 pre-release*. Legacy **v0.x** (`@ai16z/eliza`) differences are called out at the end of each topic.
>
> **Terminology trap.** The elizaOS team historically branded the *1.x rewrite itself* as the framework's "V2." So "the 1.0 / V2 runtime" in most docs means `@elizaos/core` **1.x**. The brand-new **`2.0` semver major** (alpha/beta) is a separate, even-newer line. Throughout this doc, "v1" = stable `@elizaos/core` 1.x.
>
> **Package scope history (corrected).** The core package was renamed **directly** from `@ai16z/eliza` (v0.x) to `@elizaos/core`. There was **never an `@elizaos/eliza` package** (the npm registry returns 404 for it). `@elizaos/core` is **not** a v1-only scope — it debuted in late v0.x (`0.1.7-alpha.1`, 2024-12-22; `0.1.7` stable 2025-01-04), long before `1.0.0` (2025-05-30). So `@elizaos/core` spans late-v0.x → all of v1.x → the 2.0.x betas. `@ai16z/eliza` itself only ever published `0.1.1`–`0.1.6` (`latest` = `0.1.6`).

---

## 1. What is an ElizaOS plugin? (mental model)

A **plugin is a bundle of capabilities packaged as a single object literal** that conforms to the `Plugin` interface from `@elizaos/core`. It is the **only** extension unit in elizaOS — *everything* an agent can do beyond the bare runtime comes from a plugin ("everything is a plugin"). elizaOS's own first-party packages follow this rule: `@elizaos/plugin-bootstrap` ships the default actions/providers/evaluators and the core message loop; `@elizaos/plugin-sql` ships the database adapter.

A single plugin can contribute any mix of:

- **actions** — things the agent *does* (tool-like behaviors the LLM selects by name)
- **providers** — read-only context injected into the prompt during state composition
- **evaluators** — post-response / reflection work (fact extraction, goals, memory formation)
- **services** — long-lived singletons (platform connectors, SDK clients, background loops)
- **models** — LLM/embedding/image handlers keyed by model type
- **events** — handlers for runtime lifecycle/message events
- **routes** — HTTP endpoints the agent server mounts (webhooks, APIs, plugin UIs)
- a database **adapter** (+ a Drizzle **schema** it migrates)
- **componentTypes** — custom entity-component schemas
- **tests**, plus metadata (`dependencies`, `priority`, `config`)

**How it all binds together:** a `Character` declares plugins *by name* (`Character.plugins: string[]`) → the loader/`AgentRuntime` resolves names to actual `Plugin` objects (expanding `dependencies`, ordering by `priority`) → for each plugin the runtime calls `init(config, runtime)` and registers its components into the runtime's registries. The live `IAgentRuntime` is the object every component receives as its first argument. (Programmatic embedding can also pass `Plugin[]` directly, but the canonical character-file path uses string names.)

### The `Plugin` interface at a glance (published `1.7.2`)

| Field | Type | What it contributes |
|---|---|---|
| `name` *(req)* | `string` | Unique id (usually the npm package name). Dedup, dependency resolution, logging. |
| `description` *(req)* | `string` | Human-readable summary. |
| `init?` | `(config: Record<string,string>, runtime: IAgentRuntime) => Promise<void>` | Load-time hook; runs **before** component registration. Validate env, build adapters. |
| `config?` | `{ [k]: string \| number \| boolean \| null \| undefined }` | Plugin-scoped static config (primitives). Stringified and passed to `init`. |
| `services?` | `(typeof Service)[]` | Service **classes** (not instances). Long-lived singletons. |
| `componentTypes?` | `{ name; schema; validator? }[]` | Custom entity-component type declarations. |
| `actions?` | `Action[]` | Agent abilities selected by the LLM. |
| `providers?` | `Provider[]` | Read-only context suppliers. |
| `evaluators?` | `Evaluator[]` | Post-response reflection hooks. |
| `adapter?` | `IDatabaseAdapter` | Database adapter instance (one plugin per agent). |
| `models?` | `{ [K in keyof ModelParamsMap]?: (runtime, params) => Promise<PluginModelResult<K>> }` | Model handlers keyed by `ModelType`. |
| `events?` | `PluginEvents` | Map of `EventType` → array of typed handlers. |
| `routes?` | `Route[]` | HTTP endpoints the agent server mounts. |
| `tests?` | `TestSuite[]` | Suites run by `elizaos test`. |
| `dependencies?` | `string[]` | Plugin names that must load first. |
| `testDependencies?` | `string[]` | Extra deps only for running tests. |
| `priority?` | `number` | Load-order weight (**higher loads earlier**) + model-handler tie-breaker. |
| `schema?` | `Record<string, unknown>` | Drizzle schema the plugin contributes for auto-migration. |

> ⚠️ Do not confuse `Plugin.priority` (higher = earlier) with `Provider.position` (lower = rendered first). They are different fields on different interfaces with **opposite** directionality. See §3 and §8.

---

## 2. The `Plugin` interface — deep

### Verbatim (published `1.7.2`)

```ts
export interface Plugin {
  name: string;
  description: string;
  init?: (config: Record<string, string>, runtime: IAgentRuntime) => Promise<void>;
  config?: { [key: string]: string | number | boolean | null | undefined };
  services?: (typeof Service)[];
  componentTypes?: {
    name: string;
    schema: Record<string, unknown>;
    validator?: (data: unknown) => boolean;
  }[];
  actions?: Action[];
  providers?: Provider[];
  evaluators?: Evaluator[];
  adapter?: IDatabaseAdapter;
  models?: {
    [K in keyof ModelParamsMap]?: (
      runtime: IAgentRuntime,
      params: ModelParamsMap[K],
    ) => Promise<PluginModelResult<K>>;
  };
  events?: PluginEvents;
  routes?: Route[];
  tests?: TestSuite[];
  dependencies?: string[];
  testDependencies?: string[];
  priority?: number;
  schema?: Record<string, unknown>;
}
```

### Field-by-field notes (beyond the table)

- **`init`** — receives the plugin's own stringified `config` (not character settings) and the live runtime. Used for validation/setup and special registration (e.g. `@elizaos/plugin-sql` builds its DB adapter here and calls `runtime.registerDatabaseAdapter(...)`). See §8 for exact ordering.
- **`config`** — published type is **primitives only**. The docs reference page loosely shows `{ [k]: any }`; the published `.d.ts` is authoritative.
- **`services`** — array of Service **classes**; the runtime calls the static `Service.start(runtime)` to instantiate. (In v0.x this role was filled by the now-removed `clients` field.)
- **`adapter`** — only one plugin per agent should provide it (canonical: `@elizaos/plugin-sql`). On `main`/v2 this changes to an **`AdapterFactory`** function (see below).
- **`priority`** — per the architecture docs, **higher priority loads earlier**; it is also the tie-breaker when multiple plugins register a handler for the same model type. `@elizaos/plugin-sql` ships `priority: 0`. (Note the apparent tension: SQL must initialize early yet uses `priority: 0`; in practice the adapter is special-cased to load earliest via the `init`/factory path, somewhat outside the normal priority ordering. The exact numeric convention for non-SQL plugins is documented per-page and is easy to misread.)
- **`schema`** — a Drizzle-style schema the plugin contributes for automatic migrations (used with `@elizaos/plugin-sql`). See §8.

### The `Character` that loads plugins

```ts
export interface Character {
  id?: UUID;
  name: string;
  username?: string;
  system?: string;                              // system prompt
  templates?: { [key: string]: TemplateType };
  bio: string | string[];
  messageExamples?: MessageExample[][];
  postExamples?: string[];
  topics?: string[];
  adjectives?: string[];
  knowledge?: (string | { path: string; shared?: boolean } | DirectoryItem)[];
  plugins?: string[];                           // list of plugin NAMES (not objects)
  settings?: { [key: string]: string | boolean | number | Record<string, unknown> };
  secrets?: { [key: string]: string | boolean | number };
  style?: { all?: string[]; chat?: string[]; post?: string[] };
}
```

### Registration / component-wiring order

When a plugin is registered, the runtime validates `name`, dedups, pushes it, calls `init()`, then registers components in this sequence:

1. Database **adapter** (if provided)
2. **Actions**
3. **Evaluators**
4. **Providers**
5. **Models**
6. **Routes**
7. **Events**
8. **Services** (deferred/queued if the runtime isn't fully initialized yet)

### Minimal complete plugin

```ts
// src/index.ts
import {
  type Plugin,
  type Action,
  type IAgentRuntime,
  type Memory,
  type State,
  type HandlerCallback,
  type ActionResult,
  logger,
} from '@elizaos/core';

const helloWorldAction: Action = {
  name: 'HELLO_WORLD',
  similes: ['SAY_HELLO', 'GREET'],
  description: 'Greets the user.',
  validate: async (_runtime: IAgentRuntime, _message: Memory, _state?: State) => true,
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const text = 'Hello, world!';
    if (callback) await callback({ text, actions: ['HELLO_WORLD'] });
    return { success: true, text, data: { greeted: true } };
  },
  examples: [
    [
      { name: '{{user}}', content: { text: 'say hi' } },
      { name: '{{agent}}', content: { text: 'Hello, world!', actions: ['HELLO_WORLD'] } },
    ],
  ],
};

export const helloPlugin: Plugin = {
  name: 'hello-world',
  description: 'A minimal example plugin.',
  init: async (_config, runtime) => {
    logger.info(`hello-world plugin initialized for agent ${runtime.agentId}`);
  },
  actions: [helloWorldAction],
  providers: [],
  services: [],
  routes: [
    { name: 'hello-route', path: '/helloworld', type: 'GET',
      handler: async (_req, res) => { res.json({ message: 'Hello World!' }); } },
  ],
};

export default helloPlugin;
```

A character then loads it by name: `{ "name": "Eliza", "bio": "...", "plugins": ["hello-world"] }`.

### Unreleased `main`/v2 superset (do NOT treat as current)

The `main` branch carries a larger `Plugin` with newer optional fields beyond `1.7.2` — emerging and subject to change:

- `mode?: PluginMode` (`"direct" | "remote"`) + `remote?: RemotePluginConfig` — out-of-process/remote plugins.
- `dispose?(runtime)` and `applyConfig?(config, runtime)` — unload + hot-config lifecycle hooks.
- `shortcuts?: ShortcutDefinition[]` — pre-LLM slash/`!` command shortcuts.
- `responseHandlerEvaluators?` / `responseHandlerFieldEvaluators?` — Stage-1 response-handler evaluators.
- `app?`, `appBridge?`, `views?`, `widgets?` — plugin-contributed UI surfaces.
- `contexts?: AgentContext[]`, `autoEnable?: { envKeys?; connectorKeys?; shouldEnable? }`.
- Tightened field types: `services?: ServiceClass[]`, `adapter?: AdapterFactory` (factory vs instance), `componentTypes?: ComponentTypeDefinition[]`, `schema?: Record<string, JsonValue | object>`.

### v0.x → v1.x

- **Package scope:** `@ai16z/eliza` → `@elizaos/core` (renamed directly at v0.1.7; no intermediate `@elizaos/eliza`).
- **`clients` field removed:** v0.x had a top-level `clients` array (Discord/Twitter as `Client` objects). v1.x has **no `clients`** — connectors are `Service` classes registered via `services`.
- **`Character.plugins` is `string[]`** (names) in v1.x; v0.x commonly inlined `Plugin` objects.
- Actions return structured **`ActionResult`**; evaluators return **`Evaluator` objects** (v0 returned a string array of evaluator names).
- **Entity model:** v1 replaced v0's User/Participant with an Entity/Room/World model (`entityId`/`roomId`/`worldId`).

---

## 3. Actions — the `Action` API

Actions are the executable capabilities an agent invokes in response to a message. They are registered on `plugin.actions`, surfaced to the LLM through the `ACTIONS` provider, gated by `validate`, run by `handler`, report back via `ActionResult`, and stream user-visible output through a `HandlerCallback`.

### The `Action` interface (verbatim, `1.7.2`)

```ts
export interface Action {
  /** Similar action descriptions */
  similes?: string[];
  /** Detailed description */
  description: string;
  /** Example usages */
  examples?: ActionExample[][];
  /** Handler function */
  handler: Handler;
  /** Action name */
  name: string;
  /** Validation function */
  validate: Validator;
  /** Allow extensions and custom options */
  [key: string]: unknown;
}
```

Only four fields are mandatory: **`name`**, **`description`**, **`handler`**, **`validate`**. `similes`/`examples` are optional in v1 (they were *required* in v0). The trailing index signature lets you attach arbitrary metadata.

- **`name`** — unique id, conventionally SCREAMING_SNAKE_CASE (`"REPLY"`, `"SEND_TOKEN"`). The string the LLM emits; appears in response `content.actions`.
- **`similes`** — alias phrases that widen fuzzy matching (REPLY's are `["GREET","REPLY_TO_MESSAGE","SEND_REPLY","RESPOND","RESPONSE"]`).
- **`description`** — natural-language explanation of *what* and *when*; injected into the prompt and the primary driver of selection.
- **`examples`** — few-shot conversations teaching the trigger pattern.
- **`validate`** — availability gate.
- **`handler`** — execution logic.

### Core handler/validator/callback types

> **Corrected signatures.** The exact shapes differ between the **published `1.7.2`** tarball and the `main`/v2 source. Lead with `1.7.2` (what ships today), with the one mandatory correction applied: **`HandlerCallback` always has a second optional parameter** — it is never `(response: Content) => Promise<Memory[]>` alone.

**Published `1.7.2`:**

```ts
/** Handler function type for processing messages */
export type Handler = (
  runtime: IAgentRuntime,
  message: Memory,
  state?: State,
  options?: HandlerOptions,
  callback?: HandlerCallback,
  responses?: Memory[],
) => Promise<ActionResult | void | undefined>;

/** Validator function type for actions/evaluators */
export type Validator = (
  runtime: IAgentRuntime,
  message: Memory,
  state?: State,
) => Promise<boolean>;

/** Callback type — second param exists in every version */
export type HandlerCallback = (
  response: Content,
  files?: any,            // published v1.x second param (see v2 delta below)
) => Promise<Memory[]>;
```

**`main`/v2 deltas (unreleased):**

```ts
export type Handler = (
  runtime, message, state?,
  options?: HandlerOptions | Record<string, JsonValue | undefined>,
  callback?: HandlerCallback,
  responses?: Memory[],
) => Promise<ActionResult | undefined>;   // '| void' dropped in source

export type Validator = (
  runtime, message, state?,
  options?: HandlerOptions | Record<string, JsonValue | undefined>,  // 4th param added (recent)
) => Promise<boolean>;

export type HandlerCallback = (
  response: Content,
  actionName?: string,      // 'files?: any' replaced by 'actionName?'
) => Promise<Memory[]>;
```

> Notes on the corrections: (1) `Handler`'s source return on `main` is `ActionResult | undefined` (no `| void`), though the published `1.7.2` `.d.ts` does carry `| void | undefined`. (2) `Validator` gained a 4th optional `options?` param recently on `main`; the 3-arg form matches `1.7.2`/v0.x. (3) `HandlerCallback`'s second optional arg is **always** present — `files?: any` in published v1.x, `actionName?: string` on `main` — so the bare one-arg form the docs sometimes show is incorrect.

### Result + options types (verbatim, `1.7.2`)

```ts
export interface ActionResult {
  text?: string;                       // human/diagnostic summary
  values?: Record<string, unknown>;    // merged into state.values (feeds chaining)
  data?: Record<string, unknown>;      // structured payload for later actions
  success: boolean;                    // required; JSDoc: "defaults to true"
  error?: string | Error;
}

export interface HandlerOptions {
  actionContext?: ActionContext;
  actionPlan?: {
    totalSteps: number;
    currentStep: number;               // 1-based
    steps: Array<{
      action: string;
      status: 'pending' | 'completed' | 'failed';
      result?: ActionResult;
      error?: string;
    }>;
    thought: string;                   // the planner's reasoning
  };
  [key: string]: unknown;
}

export interface ActionContext {
  previousResults: ActionResult[];
  getPreviousResult?: (actionName: string) => ActionResult | undefined;
}

export interface ActionExample {
  name: string;       // user/template placeholder, e.g. {{name1}}
  content: Content;
}
```

`Content` (payload of messages and callbacks): `text?`, `thought?` (internal reasoning, not shown), `actions?: string[]`, `providers?: string[]`, `source?`, `inReplyTo?: UUID`, `attachments?: Media[]`, `channelType?`, plus open `[key: string]: unknown`.

### Handler parameters

- **`runtime`** — gateway to everything: `useModel`, `composeState`, `getService`, `getSetting`, memory/DB, `character`, `agentId`.
- **`message`** — the triggering `Memory` (`entityId` sender, `roomId`, `content`, …). User text is `message.content.text`.
- **`state`** — composed context `{ values, data, text, … }`. `state.text` is the rendered provider block; `state.values` holds provider values + prior actions' `ActionResult.values`.
- **`options`** — chaining/plan context: `actionContext.previousResults`, `getPreviousResult('OTHER_ACTION')`, `actionPlan`.
- **`callback`** — emit user-visible `Content` *now* (streaming/intermediate). Returns the created `Memory[]`.
- **`responses`** *(v1)* — the agent's own draft response message(s) generated before actions run (e.g. REPLY harvests requested providers via `responses?.flatMap(r => r.content?.providers ?? [])`).

### Selection & execution flow

1. **State composition** runs providers, including `ACTIONS`, which calls each action's `validate(runtime, message, state)` and formats only the valid ones (name + description + examples) into the prompt. **`validate` is the availability gate.**
2. **LLM selection** — the model emits chosen action names (ordered) in `content.actions`.
3. **Sequential execution** of the chosen handlers. `REPLY` is the default "just talk" action; convention is REPLY at the start of a chain (acknowledgement) and/or end (final response).
4. **Chaining** — each handler's `ActionResult.values` merge into `state.values`; its `ActionResult` is exposed to later actions via `options.actionContext.previousResults` / `getPreviousResult(name)`.

**Stream vs return:** call `await callback({ text, actions: ['MY_ACTION'] })` for user-facing/intermediate output; `return { success, text, values, data, error }` for the machine-facing result (not auto-shown to the user).

### Worked example (token transfer)

```ts
import {
  type Action, type ActionResult, type IAgentRuntime, type Memory, type State,
  type HandlerCallback, type HandlerOptions, ModelType, logger,
} from '@elizaos/core';

export const sendTokenAction: Action = {
  name: 'SEND_TOKEN',
  similes: ['TRANSFER_TOKEN', 'SEND_CRYPTO', 'PAY', 'TRANSFER_FUNDS'],
  description:
    'Transfers tokens from the agent wallet to a recipient address. ' +
    'Use when the user explicitly asks to send/transfer a specific amount of a token to an address.',

  validate: async (runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<boolean> =>
    Boolean(runtime.getSetting('WALLET_PRIVATE_KEY')),   // gate on configured wallet

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
    _responses?: Memory[],
  ): Promise<ActionResult> => {
    try {
      const extraction = await runtime.useModel(ModelType.OBJECT_SMALL, {
        prompt:
          `Extract the transfer request from: "${message.content.text}".\n` +
          `Return JSON: { "amount": number, "token": string, "recipient": string }`,
      });
      const { amount, token, recipient } = extraction as {
        amount: number; token: string; recipient: string;
      };

      if (callback) {
        await callback({
          thought: `User wants to send ${amount} ${token} to ${recipient}.`,
          text: `Sending ${amount} ${token} to ${recipient}…`,
          actions: ['SEND_TOKEN'],
        });
      }

      const wallet = runtime.getService('wallet') as any;
      const txHash: string = await wallet.transfer({ amount, token, recipient });

      if (callback) {
        await callback({ text: `Sent ${amount} ${token}. Transaction: ${txHash}`, actions: ['SEND_TOKEN'] });
      }

      return {
        success: true,
        text: `Transferred ${amount} ${token} to ${recipient} (tx ${txHash})`,
        values: { lastTransferTx: txHash, lastTransferAmount: amount },
        data: { actionName: 'SEND_TOKEN', txHash, amount, token, recipient },
      };
    } catch (error) {
      logger.error({ error }, 'SEND_TOKEN failed');
      if (callback) {
        await callback({ text: `Transfer failed: ${(error as Error).message}`, actions: ['SEND_TOKEN'] });
      }
      return {
        success: false,
        text: 'Token transfer failed',
        error: error instanceof Error ? error : new Error(String(error)),
        data: { actionName: 'SEND_TOKEN' },
      };
    }
  },

  examples: [
    [
      { name: '{{name1}}', content: { text: 'Send 10 USDC to 0xABC…123' } },
      { name: '{{name2}}', content: { text: 'Sending 10 USDC to 0xABC…123 now.', actions: ['SEND_TOKEN'] } },
    ],
    [
      { name: '{{name1}}', content: { text: 'Transfer 0.5 ETH to alice.eth please' } },
      { name: '{{name2}}', content: { text: 'On it — transferring 0.5 ETH to alice.eth.', actions: ['SEND_TOKEN'] } },
    ],
  ],
};
```

`examples` is **`ActionExample[][]`** — an array of example conversations, each a sequence of `{ name, content }` turns; the assistant turn that should trigger the action lists it in `content.actions`.

### Canonical reference: the built-in `REPLY` action (`@elizaos/plugin-bootstrap` 1.7.2)

```ts
const replyAction = {
  name: 'REPLY',
  similes: ['GREET', 'REPLY_TO_MESSAGE', 'SEND_REPLY', 'RESPOND', 'RESPONSE'],
  description:
    'Replies to the current conversation with the text from the generated message. ' +
    'Default if the agent is responding with a message and no other action. Use REPLY at the ' +
    'beginning of a chain as an acknowledgement, and at the end as a final response.',
  validate: async (_runtime) => true,
  handler: async (runtime, message, state, _options, callback, responses) => {
    const allProviders = responses?.flatMap((res) => res.content?.providers ?? []) ?? [];
    state = await runtime.composeState(message, [...(allProviders ?? []), 'RECENT_MESSAGES', 'ACTION_STATE']);
    const prompt = composePromptFromState({
      state,
      template: runtime.character.templates?.replyTemplate || replyTemplate,
    });
    const response = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
    const parsedXml = parseKeyValueXml(response);
    const responseContent = { thought: parsedXml?.thought ?? '', text: parsedXml?.text ?? '', actions: ['REPLY'] };
    if (callback) await callback(responseContent);   // streams the reply
    return {
      text: `Generated reply: ${responseContent.text}`,
      values: { success: true, responded: true, lastReply: responseContent.text, lastReplyTime: Date.now() },
      data: { actionName: 'REPLY', response: responseContent, messageGenerated: true },
      success: true,
    };
  },
  examples: [[
    { name: '{{name1}}', content: { text: 'Hello there!' } },
    { name: '{{name2}}', content: { text: 'Hi! How can I help you today?', actions: ['REPLY'] } },
  ]],
};
```

### v0 → v1 action changes

| Aspect | v0.x (`@ai16z/eliza`) | v1.x (`@elizaos/core`) |
|---|---|---|
| Import scope | `@ai16z/eliza` | `@elizaos/core` |
| `similes` / `examples` | required | optional |
| `ActionExample` field | `user: string` | renamed to `name: string` |
| `Handler` args | no `responses`, untyped `options` | added `responses?: Memory[]`, typed `options` |
| Handler return | `Promise<unknown>` (often `boolean`/`void`) | `Promise<ActionResult \| void \| undefined>` |
| `ActionResult` | did not exist | new; `success` required |
| `HandlerCallback` 2nd arg | `files?: any` | `files?: any` (v1.x published); `actionName?` on `main` |
| Action chaining | none | `previousResults` / `getPreviousResult`, `values` merged into state |

### v2 (`main`, beta) action additions

Same four core fields plus many optional planner/routing fields: `descriptionCompressed?`, `priority?`, `tags?`, `private?`, `routingHint?`, `parameters?: ActionParameter[]`, gating (`contexts?`/`contextGate?`/`roleGate?`/`connectorAccountPolicy?`), hierarchical planning (`subActions?`/`subPlanner?`), `mode?: ActionMode` + `modePriority?`, `modelClass?`, cache hints. `ActionResult` gains `userFacingText?`, `verifiedUserFacing?`, `continueChain?`, `cleanup?`. Treat all as optional/beta — a v1-style action still works on 2.0.

---

## 4. Providers — the read side

Providers inject dynamic context into the agent's prompt during state composition. Where actions *do* and evaluators run *after*, providers *supply information* during state composition. Every turn the runtime calls registered providers, collects their output, and folds it into the `State` templates render against.

### The `Provider` interface (v1.x)

```ts
interface Provider {
  /** Provider name — the key used to select/aggregate this provider */
  name: string;
  /** Human-readable description of what data it provides */
  description?: string;
  /** If true, only runs when explicitly requested (not in default state) */
  dynamic?: boolean;
  /** Position in the provider list. See ordering note below. */
  position?: number;
  /** If true, excluded from the default list; must be called explicitly */
  private?: boolean;
  /** Data retrieval — called during composeState */
  get: (runtime: IAgentRuntime, message: Memory, state: State) => Promise<ProviderResult>;
}
```

Only `name` and `get` are required. The real source's JSDoc for `position` reads *"Position of the provider in the provider list, positive or negative."* (The `main`/v2 source adds extra optional fields you can ignore for plain v1 plugins: `descriptionCompressed`/`compressedDescription`, `relevanceKeywords`, `contexts`, `contextGate`, `cacheStable`, `cacheScope`, `alwaysInResponseState`, `roleGate`, `subActions`, `subPlanner`, `companionProviders`.)

### `ProviderResult`

```ts
interface ProviderResult {
  /** Human-readable text concatenated into the prompt context */
  text?: string;
  /** Flat key/values merged into State.values; usable as {{key}} in templates */
  values?: Record<string, ProviderValue>;
  /** Structured data merged into State.data; NOT injected into prompt text */
  data?: ProviderDataRecord;
}
```

All three fields are optional in the real source. `ProviderValue` is a broad JSON-serializable union; `ProviderDataRecord` is `{ [key: string]: ProviderValue }`.

### The `State` it feeds

```ts
interface State {
  values: StateValues;   // merged ProviderResult.values from every provider
  data: StateData;       // merged ProviderResult.data (+ a providers cache, room/world/entity, actionPlan…)
  text: string;          // the assembled provider text block
  [key: string]: StateValue | StateValues | StateData | undefined;
}
```

`StateData.providers?: Record<string, ProviderCacheEntry>` is a per-provider result cache keyed by name, letting `composeState` skip re-running stable providers.

### When providers run: `composeState` and the ordering model

> **Corrected execution model.** This is the single most-misunderstood part of providers. `position` does **not** order *execution*. **Every selected provider's `.get()` is invoked concurrently** via `await Promise.all(providersToRun.map(...))`, regardless of `position`. `position` only orders how results are **assembled** into the composed state text/output.

What actually happens inside `runtime.composeState(message, …)`:

1. **Select** the providers to run (default: all **non-private, non-dynamic**; opt in dynamic/private by name).
2. **Run them all in parallel** — `Promise.all` over the selected set. This is true of *all* selected providers, not just ones that share a `position`.
3. **Sort the results for assembly** by `position`, ascending, with ties broken alphabetically by name. In the current v1.x runtime the sort is:
   ```ts
   providersToGet.sort(
     (a, b) => (a.position || 0) - (b.position || 0) || a.name.localeCompare(b.name)
   );
   ```
   So **lower `position` is rendered first**, a missing value defaults to **0**, and equal positions are broken **deterministically by `a.name.localeCompare(b.name)`** — there is no special parallel/sequential behavior triggered by equal positions.
4. **Aggregate** every `ProviderResult` into one `State` (`values` merged, `data` merged, `text` concatenated in sorted order) and cache it.

The runtime then renders templates against that `State`.

> **Convention vs. enforcement.** The `-100` (first) … `0` (default) … `100` (last) range is only a **documented convention** (the runtime docs say "-100 to 100, lower runs first"); it is **not enforced**. The type is simply `position?: number`. Use it to control where your provider's text lands in the prompt and so later providers can read earlier providers' merged `values`/`data` from the in-progress state.

> **Do not confuse with `Plugin.priority`.** `position` is a field on the **Provider** interface; **Plugins** use `priority`, where **higher loads first** — the opposite direction. `position` is also a **v1.x** Provider addition: the legacy v0.x Provider had no `position` field.

Common call shapes:

```ts
const state = await runtime.composeState(message);                                  // defaults only
const state = await runtime.composeState(message, ['CUSTOM_DATA']);                  // + opt-in by name
const state = await runtime.composeState(message, ['RECENT_MESSAGES', 'CHARACTER'], true); // only this subset
```

(The exact positional parameter names/order — `includeList`, `onlyInclude`/filter, cache-skip flags — have shifted across releases; confirm against your installed version. The selection model itself is stable.)

### Static vs. dynamic vs. private

- **Static/standard** (`dynamic` & `private` falsy): runs automatically every turn. For cheap, broadly useful context (character info, recent messages, time).
- **Dynamic** (`dynamic: true`): excluded from default composition; runs only when its `name` is passed to `composeState`. For expensive/situational data.
- **Private** (`private: true`): hidden from the regular list entirely; must be called explicitly. For internal/sensitive context.

### Real provider (`CURRENT_TIME`, built into `@elizaos/core`)

```ts
import type { IAgentRuntime, Memory, Provider, State } from '@elizaos/core';

export const currentTimeProvider: Provider = {
  name: 'CURRENT_TIME',
  description: 'Provides the current date and time in various formats',
  dynamic: true,
  get: async (runtime: IAgentRuntime, _message: Memory, _state: State) => {
    const now = new Date();
    const setting = runtime.getSetting('TIMEZONE');
    const timeZone = (typeof setting === 'string' ? setting : 'UTC') || 'UTC';

    const isoTimestamp = now.toISOString();
    const unixTimestamp = Math.floor(now.getTime() / 1000);
    const dateOnly = now.toLocaleDateString('en-CA', { timeZone });
    const timeOnly = now.toLocaleTimeString('en-GB', { timeZone, hour12: false });
    const dayOfWeek = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone }).format(now);
    const humanReadable = new Intl.DateTimeFormat('en-US', {
      timeZone, dateStyle: 'full', timeStyle: 'long',
    }).format(now);

    const contextText = `# Current Time
- Date: ${dateOnly}
- Time: ${timeOnly} ${timeZone}
- Day: ${dayOfWeek}
- Full: ${humanReadable}
- ISO: ${isoTimestamp}`;

    return {
      text: contextText,
      values: { currentTime: isoTimestamp, currentDate: dateOnly, dayOfWeek, unixTimestamp },
      data: { iso: isoTimestamp, date: dateOnly, time: timeOnly, dayOfWeek, humanReadable, unixTimestamp },
    };
  },
};
```

A provider hitting a service follows the same pattern and **must never throw** — return an empty result on failure so state composition cannot break:

```ts
const customDataProvider: Provider = {
  name: 'CUSTOM_DATA',
  description: 'Custom data from external source',
  dynamic: true,
  position: 150,
  get: async (runtime, message, state) => {
    try {
      const svc = runtime.getService('customService');
      const customData = await svc?.getData();
      if (!customData) return { values: {}, data: {}, text: '' };
      return {
        values: { customData: customData.summary },
        data: { customData },
        text: `Custom data: ${customData.summary}`,
      };
    } catch (error) {
      runtime.logger.error('Error in custom provider:', error);
      return { values: {}, data: {}, text: '' };
    }
  },
};
```

### v0 → v1 provider change

v0 (`@ai16z/eliza@0.1.6`) `Provider` had **only `get`** (returning `Promise<any>`, in practice a string); the v0 runtime simply `join("\n")`-ed non-empty strings into `{{providers}}`. v1 introduced the structured `ProviderResult { text, values, data }`, provider metadata (`name`, `description`, `dynamic`, `position`, `private`), and `composeState` selection/filtering/caching. Migrating a v0 provider: give it a `name`, and return `{ text, values, data }` (old string → `text`).

---

## 5. Evaluators — post-interaction reflection

Evaluators run **after** the agent finishes handling a message, extracting structured information (facts, relationships, goals, sentiment) into long-term memory. Actions *do* during a turn; evaluators *learn* from it afterward.

### The `Evaluator` interface (verbatim, `1.7.2`)

```ts
export interface Evaluator {
  /** Whether to always run */
  alwaysRun?: boolean;
  /** Detailed description */
  description: string;
  /** Similar evaluator descriptions */
  similes?: string[];
  /** Example evaluations */
  examples: EvaluationExample[];
  /** Handler function */
  handler: Handler;
  /** Evaluator name */
  name: string;
  /** Validation function */
  validate: Validator;
}
```

- **`name`** — unique id (e.g. `"REFLECTION"`); used for registration, logging, and the `EVALUATORS` provider.
- **`similes`** — synonyms.
- **`description`** — surfaced to the LLM via the evaluators provider.
- **`examples`** (`EvaluationExample[]`, required) — few-shot input-context → expected-outcome.
- **`validate`** — gate; the idiomatic place for throttling.
- **`handler`** — analyze, call a model, write memories/relationships.
- **`alwaysRun`** — if `true`, considered even when the agent did **not** respond this turn; otherwise skipped when `didRespond` is false.

### Supporting types (verbatim, `1.7.2`)

```ts
export interface EvaluationExample {
  prompt: string;                  // evaluation context
  messages: Array<ActionExample>;  // example messages
  outcome: string;                 // expected outcome
}

export interface ActionExample { name: string; content: Content; }
```

`Handler`, `Validator`, and `HandlerCallback` are the **same types Actions use** (see §3, including the correction that `HandlerCallback` always carries a second optional param). An Evaluator's `handler`/`validate` have the exact signatures an Action uses.

> **Version note — Handler/Validator sharing.** In the **current stable v1.x** (`@elizaos/core@1.7.2`), `Handler` and `Validator` are standalone exported type aliases referenced by **both** `Action` (`handler: Handler; validate: Validator;`) **and** `Evaluator` (`handler: Handler; validate: Validator;`) — so the "shared types" claim is **confirmed** here. In the **v2 beta line** (`@elizaos/core@2.0.x-beta`, `main`), the `Evaluator` interface was **redesigned and no longer uses `Handler`/`Validator`** (see below); the types remain exported but only `Action` still consumes them.

### When evaluators run (runtime flow, `1.7.2`)

Evaluators fire at the **end** of message processing. The bootstrap handler calls `runtime.evaluate(message, state, didRespond, callback, responses)`. Core implementation:

```js
async evaluate(message, state, didRespond, callback, responses) {
  const evaluatorPromises = this.evaluators.map(async (evaluator) => {
    if (!evaluator.handler) return null;
    if (!didRespond && !evaluator.alwaysRun) return null;          // gate 1: alwaysRun
    const result = await evaluator.validate(this, message, state); // gate 2: validate()
    return result ? evaluator : null;
  });
  const evaluators = (await Promise.all(evaluatorPromises)).filter(Boolean);
  if (evaluators.length === 0) return [];

  state = await this.composeState(message, ["RECENT_MESSAGES", "EVALUATORS"]);
  await Promise.all(evaluators.map(async (evaluator) => {
    await evaluator.handler(this, message, state, {}, callback, responses);
    this.adapter.log({ /* type: "evaluator", body: { evaluator: evaluator.name, ... } */ });
  }));
  return evaluators;
}
```

Precise behavior: (1) **two-stage gating** — runs only if the agent responded OR `alwaysRun === true`, **and** `validate()` returns `true`; (2) **select then recompose** state with `RECENT_MESSAGES` + `EVALUATORS`; (3) **parallel handlers** (`Promise.all`); (4) each run **logged** to the adapter with `type: "evaluator"`. ("Non-blocking" is relative to the response already being sent before `evaluate()` is invoked — handlers themselves are awaited.)

### Actions vs Evaluators

| Aspect | Action | Evaluator |
|---|---|---|
| When | **During** the turn | **After** the turn |
| Purpose | *Do* (API, DM, mute, image) | *Learn* (facts, goals, memories) |
| Selection | Model picks; gated by `validate` | Auto-considered; gated by `alwaysRun` + `validate` |
| Output | User-visible response/side effect | Background memory/relationship writes |
| Examples type | `ActionExample[][]` | `EvaluationExample[]` |

### Typical uses

Fact extraction → `facts` table; relationship/graph building; goal/task tracking; memory formation/self-reflection; sentiment/quality scoring, filtering, analytics.

### Real example: `REFLECTION` (`@elizaos/plugin-bootstrap@1.7.2`)

The only evaluator bootstrap ships (`plugin.evaluators = [reflectionEvaluator]`) — self-reflection + fact + relationship extraction:

```js
var reflectionEvaluator = {
  name: "REFLECTION",
  similes: ["REFLECT", "SELF_REFLECT", "EVALUATE_INTERACTION", "ASSESS_SITUATION"],
  validate: async (runtime, message) => {
    // throttle: only reflect once every ~conversationLength/4 new messages
    const lastMessageId = await runtime.getCache(`${message.roomId}-reflection-last-processed`);
    const messages = await runtime.getMemories({
      tableName: "messages", roomId: message.roomId, count: runtime.getConversationLength(),
    });
    if (lastMessageId) {
      const idx = messages.findIndex((m) => m.id === lastMessageId);
      if (idx !== -1) messages.splice(0, idx + 1);
    }
    const reflectionInterval = Math.ceil(runtime.getConversationLength() / 4);
    return messages.length > reflectionInterval;
  },
  description:
    "Generate a self-reflective thought on the conversation, then extract " +
    "facts and relationships between entities in the conversation.",
  handler,
  examples: [
    {
      prompt: `Agent Name: Sarah
Agent Role: Community Manager
Room Type: group
Current Room: general-chat
Message Sender: John (user-123)`,
      messages: [
        { name: "John",  content: { text: "Hey everyone, I'm new here!" } },
        { name: "Sarah", content: { text: "Welcome John! How did you find our community?" } },
        { name: "John",  content: { text: "Through a friend who's really into AI" } },
      ],
      outcome: `<response>
  <thought>I'm engaging appropriately with a new community member...</thought>
  <facts>
    <fact><claim>John is new to the community</claim><type>fact</type>
      <in_bio>false</in_bio><already_known>false</already_known></fact>
  </facts>
  <relationships>
    <relationship><sourceEntityId>sarah-agent</sourceEntityId>
      <targetEntityId>user-123</targetEntityId><tags>group_interaction</tags></relationship>
  </relationships>
</response>`,
    },
  ],
};

async function handler(runtime, message, state) {
  const knownFacts = await runtime.getMemories({ tableName: "facts", roomId: message.roomId /* … */ });
  const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt: /* reflectionTemplate */ });
  const createdMemoryId = await runtime.createMemory(factMemory, "facts", true);
  await runtime.createRelationship({ sourceEntityId, targetEntityId, tags /* … */ });
  await runtime.setCache(`${message.roomId}-reflection-last-processed`, message?.id || "");
}
```

Takeaways: `validate` implements **throttling** keyed off a `${roomId}-reflection-last-processed` cache entry; the handler calls `useModel` for structured XML then writes via `createMemory(..., "facts", ...)` and `createRelationship(...)`; `alwaysRun` is omitted so reflection only runs on turns the agent responded.

### Forward-looking: v2 `Evaluator` redesign (`main`, alpha/beta — not yet stable)

The `main` branch replaces the imperative `validate`/`handler` with a declarative model-call pipeline:

```ts
export interface Evaluator<TOutput = JsonValue, TPrepared = unknown> {
  name: string;
  description: string;
  similes?: string[];
  priority?: number;
  providers?: string[];
  schema: JSONSchema;            // structured-output schema
  modelType?: ModelTypeName;
  shouldRun(context: EvaluatorRunContext): Promise<boolean>;           // replaces validate
  prepare?(context: EvaluatorRunContext & { state: State }): Promise<TPrepared>;
  prompt(context: EvaluatorPromptContext<TPrepared>): string;          // builds the prompt
  parse?(output: unknown): TOutput | null;
  processors?: Array<EvaluatorProcessor<TOutput, TPrepared>>;          // replaces handler side-effects
}
```

`validate → shouldRun`, `handler → prompt + processors`, `examples`/`alwaysRun` dropped, `schema`/`modelType` formalize structured output. **If writing against published `1.7.2`, use the classic `validate`/`handler`/`examples`/`alwaysRun` interface.** Only target the new shape if pinned to a 2.0 pre-release.

### v0.x note

v0.x is nearly identical to classic v1.x but with two field renames: `EvaluationExample.context` → `prompt`, and the example messages' `user` → `name` (the same renames as Action examples).

---

## 6. Services — long-lived integrations

A **Service** is the runtime's mechanism for long-lived, stateful integrations: anything holding an open connection, SDK client, cache, or background loop for the agent's lifetime (Discord/Telegram gateways, a browser, a wallet/RPC client, a scheduler). Actions/providers/evaluators/routes reach these singletons via `runtime.getService(type)`. Services start when their plugin loads and stop on shutdown.

### The `Service` abstract class (verbatim from core)

```ts
export abstract class Service {
  protected runtime!: IAgentRuntime;

  constructor(runtime?: IAgentRuntime) {
    if (runtime) { this.runtime = runtime; }
  }

  abstract stop(): Promise<void>;

  static serviceType: string;

  abstract capabilityDescription: string;

  config?: Metadata;

  static async start(_runtime: IAgentRuntime): Promise<Service> {
    throw new Error("Service.start() must be implemented by subclass");
  }

  static stopRuntime?(_runtime: IAgentRuntime): Promise<void>;

  static registerSendHandlers?(runtime: IAgentRuntime, service: Service): void;
}
```

Members:

- **`static serviceType: string`** — the lookup key the runtime registers under and callers pass to `getService`. Subclasses set a literal, e.g. `static serviceType = "starter";`.
- **`abstract capabilityDescription: string`** — required **instance** property; human-readable capability description.
- **`static start(runtime): Promise<Service>`** — the factory the runtime calls; the base throws, so every concrete service **must override it** and return a started instance.
- **`abstract stop(): Promise<void>`** — instance teardown.
- **`protected runtime`** — set by the base constructor when given a runtime; use `this.runtime`.
- **`config?: Metadata`**, **`static stopRuntime?`**, **`static registerSendHandlers?`** — optional.

### `ServiceType` and the typed registry

In the **current** API `ServiceType` is a **`const` object** (not a TS `enum`), paired with `ServiceTypeRegistry` that plugins extend via module augmentation:

```ts
export const ServiceType = {
  TRANSCRIPTION: "transcription", VIDEO: "video", BROWSER: "browser", PDF: "pdf",
  REMOTE_FILES: "aws_s3", WEB_SEARCH: "web_search", EMAIL: "email", TEE: "tee",
  TASK: "task", APPROVAL: "approval", TOOL_POLICY: "tool_policy", WALLET: "wallet",
  LP_POOL: "lp_pool", TOKEN_DATA: "token_data", MESSAGE_SERVICE: "message_service",
  MESSAGE: "message", POST: "post", HOOKS: "hooks", PAIRING: "pairing",
  CONNECTOR_ACCOUNT: "connector_account", CONNECTOR_ACCOUNT_STORAGE: "connector_account_storage",
  AGENT_EVENT: "agent_event", NOTIFICATION: "notification", MEDIA_GENERATION: "media_generation",
  VOICE_CACHE: "voice_cache", OPTIMIZED_PROMPT: "optimized_prompt", CHANNEL_TOPICS: "channel_topics",
  UNKNOWN: "unknown",
} as const;

export type ServiceTypeName = ServiceTypeRegistry[keyof ServiceTypeRegistry];
```

Augment to add your own (keeps `getService` type-aware):

```ts
declare module '@elizaos/core' {
  interface ServiceTypeRegistry {
    DISCORD: 'discord';
    TELEGRAM: 'telegram';
  }
}
```

You are **not required** to use a `ServiceType` constant — `serviceType` is just a `string`; many plugins define their own literal (e.g. `BROWSER_SERVICE_TYPE = "browser"`).

### Storage & retrieval (singleton-per-type)

```ts
services: Map<ServiceTypeName, Service[]>;

getService<T extends Service>(service: ServiceTypeName | string): T | null;
getServicesByType<T extends Service>(service: ServiceTypeName | string): T[];
getAllServices(): Map<ServiceTypeName, Service[]>;
registerService(service: ServiceClass): Promise<void>;
```

`getService` returns the **first** registered instance of that type, or `null`:

```ts
getService<T extends Service = Service>(serviceName: ServiceTypeName | string): T | null {
  if (!this.isNativeFeatureServiceEnabled(serviceName)) return null;
  const key = this.resolveServiceTypeAlias(serviceName) as ServiceTypeName;
  const instances = this.services.get(key);
  if (instances && instances.length > 0) return instances[0] as T;
  return null;
}
```

Consequences: `getService('starter')` always returns **the same instance** (singleton). It returns `null` (never throws) when nothing is registered, so **null-check** (`runtime.getService(...)?.method()`). For multiple registrations of one type use `getServicesByType()`. (It also gates on `isNativeFeatureServiceEnabled` / `resolveServiceTypeAlias`, so it can return `null` for a disabled native feature even when a class is registered.)

### Lifecycle

1. **Registration** — plugin lists service *classes* in `services: [...]`; the runtime calls `registerService(ServiceClass)`.
2. **Start** — runtime invokes static `ServiceClass.start(runtime)`, which constructs/initializes and returns the instance, stored in `services: Map<type, Service[]>`.
3. **Running** — handlers fetch the live instance with `runtime.getService(type)`; same instance reused.
4. **Stop/cleanup** — on shutdown the runtime calls each instance's `stop()`.

### Minimal example — the official `plugin-starter`

```ts
import { logger, ModelType, Service } from "@elizaos/core";

class StarterService extends Service {
  static serviceType = "starter";
  capabilityDescription =
    "This is a starter service which is attached to the agent through the starter plugin.";

  static async start(runtime: IAgentRuntime): Promise<StarterService> {
    return new StarterService(runtime);
  }

  async stop(): Promise<void> { logger.debug("StarterService stopped"); }
}

export const starterPlugin: Plugin = {
  name: "plugin-starter",
  description: "Plugin starter for elizaOS",
  services: [StarterService],     // registers + auto-starts
};
```

Retrieve-and-stop (null-safe):

```ts
await runtime.getService<StarterService>(StarterService.serviceType)?.stop();
```

### External-system wrapper consumed by an action

```ts
export const BROWSER_SERVICE_TYPE = "browser";

export class BrowserService extends Service {
  static override readonly serviceType = BROWSER_SERVICE_TYPE;
  override capabilityDescription = "Controls headless browser targets for navigation and scraping";

  private readonly targets = new Map<string, BrowserTarget>();

  static async start(runtime: IAgentRuntime): Promise<BrowserService> {
    return new BrowserService(runtime);   // launch/connect external client here
  }
  async stop(): Promise<void> { /* close every open target */ }
}
```

```ts
// action consuming a service (typed cast + null-check)
const service = runtime.getService(PREDICTION_MARKET_SERVICE_TYPE) as PredictionMarketService | null;
if (!service) { /* graceful bail-out */ }
// const markets = await service.getMarkets(...);

// idiomatic generic form when the type is augmented into the registry:
const browser = runtime.getService<BrowserService>("browser");
await browser?.open(url);
```

### v0.x → v1.x service differences (corrected)

| Concern | Legacy v0.x (`@ai16z/eliza@0.1.6`) | Current v1.x (`@elizaos/core`) |
|---|---|---|
| `ServiceType` | a TS **`enum`** | a **`const` object** + augmentable `ServiceTypeRegistry`; `serviceType` is a plain `string` |
| Service identity | **two concrete (non-abstract) getters**: a STATIC getter `static get serviceType(): ServiceType` (the canonical override point, returning a `ServiceType` **enum** value) plus an instance `get serviceType(): ServiceType` delegating to the static one | **`static serviceType: string`** plain property |
| Init / teardown | `abstract initialize(runtime): Promise<void>` (+ a `getInstance()` singleton helper in many services) | **`static start(runtime): Promise<Service>`** factory + `abstract stop()`; runtime owns the singleton |
| Description | none | required **`capabilityDescription: string`** |
| Retrieval | `runtime.getService<T>(ServiceType.X)` (enum) | `runtime.getService<T>(serviceName): T \| null` (string or registry-typed key) |

> **Correction to a common misstatement:** v0.x did **not** use `abstract get serviceType(): ServiceType`. It used **two concrete getters** — a static getter (the real override point) and a delegating instance getter — neither marked `abstract`. v0.x also used `abstract initialize(runtime)` rather than `stop`. The net v0→v1 change was: a static `ServiceType`-enum getter became a plain `static serviceType: string` property.

If you see `get serviceType()`, `initialize(runtime)`, `getInstance()`, or `ServiceType` used as a TS enum, that is the old API.

---

## 7. The `IAgentRuntime` / `AgentRuntime` API surface

`IAgentRuntime` **extends `IDatabaseAdapter`** — memory/cache/entity/room CRUD live directly on `runtime` (no `runtime.databaseAdapter.*` indirection like v0.x). `AgentRuntime` is the concrete class. Signatures below are the verified **`1.7.2`** `.d.ts`; v2/v0 deltas are flagged.

### Core properties a handler reads

```ts
interface IAgentRuntime extends IDatabaseAdapter {
  agentId: UUID;
  character: Character;
  providers: Provider[];
  actions: Action[];
  evaluators: Evaluator[];
  services: Map<ServiceTypeName, Service[]>;
  adapter: IDatabaseAdapter;
  // v2 main also exposes: plugins, routes, logger, fetch, events, stateCache, etc.
}
```

### Models — `useModel` and the LLM abstraction

```ts
useModel(modelType: TextGenerationModelType, params: GenerateTextParams, provider?: string): Promise<string>;
useModel<T extends keyof ModelParamsMap, R = ModelResultMap[T]>(
  modelType: T, params: ModelParamsMap[T], provider?: string
): Promise<R>;

generateText(input: string, options?: GenerateTextOptions): Promise<GenerateTextResult>;
registerModel(
  modelType: ModelTypeName | string,
  handler: (runtime: IAgentRuntime, params: Record<string, unknown>) => Promise<unknown>,
  provider: string,
  priority?: number
): void;
getModel(modelType: ModelTypeName | string): ((runtime, params) => Promise<unknown>) | undefined;
```

`useModel` is the single inference entry point, **type-driven**: `modelType` selects both the param (`ModelParamsMap[T]`) and result (`ModelResultMap[T]`) types. The runtime owns no model code — provider plugins register a handler per `ModelType` (via the `models` field or `registerModel`); the runtime dispatches to the highest-`priority` handler (optionally narrowed by `provider`). Param precedence: direct `useModel()` args > model-specific character settings (e.g. `TEXT_SMALL_TEMPERATURE`) > defaults (e.g. `DEFAULT_TEMPERATURE`).

### `ModelType` (v1.x, verbatim)

```ts
export const ModelType = {
  SMALL: "TEXT_SMALL",          // alias
  MEDIUM: "TEXT_LARGE",         // MEDIUM maps to TEXT_LARGE in v1.x
  LARGE: "TEXT_LARGE",
  TEXT_SMALL: "TEXT_SMALL",
  TEXT_LARGE: "TEXT_LARGE",
  TEXT_EMBEDDING: "TEXT_EMBEDDING",
  TEXT_TOKENIZER_ENCODE: "TEXT_TOKENIZER_ENCODE",
  TEXT_TOKENIZER_DECODE: "TEXT_TOKENIZER_DECODE",
  TEXT_REASONING_SMALL: "REASONING_SMALL",
  TEXT_REASONING_LARGE: "REASONING_LARGE",
  TEXT_COMPLETION: "TEXT_COMPLETION",
  IMAGE: "IMAGE",
  IMAGE_DESCRIPTION: "IMAGE_DESCRIPTION",
  TRANSCRIPTION: "TRANSCRIPTION",
  TEXT_TO_SPEECH: "TEXT_TO_SPEECH",
  AUDIO: "AUDIO",
  VIDEO: "VIDEO",
  OBJECT_SMALL: "OBJECT_SMALL",
  OBJECT_LARGE: "OBJECT_LARGE",
} as const;
export type ModelTypeName = (typeof ModelType)[keyof typeof ModelType] | string;
```

String values are **UPPERCASE** (`"TEXT_SMALL"`); doc pages showing lowercase (`'text_small'`) or colon-delimited (`'text:large'`) are outdated/incorrect. `ModelParamsMap` maps `TEXT_*`→`GenerateTextParams`, `TEXT_EMBEDDING`→`TextEmbeddingParams | string | null`, `OBJECT_*`→`ObjectGenerationParams`, `IMAGE`→`ImageGenerationParams`. `ModelResultMap` returns `string` for text, `number[]` for embeddings.

### `GenerateTextParams` (version-dependent — corrected)

> **Accurate for `1.7.2` only.** In `@elizaos/core@1.7.2` (`dist/types/model.d.ts`), `GenerateTextParams` is a **`type` alias** with **required `prompt: string`** and these optionals:

```ts
export type GenerateTextParams = {
  prompt: string;                       // REQUIRED in 1.x
  maxTokens?: number;
  minTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  seed?: number;
  repetitionPenalty?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stopSequences?: string[];
  user?: string | null;                 // note: string | null
  responseFormat?: { type: 'json_object' | 'text' } | string;
  stream?: boolean;
  onStreamChunk?: (chunk: string, messageId?: string) => void | Promise<void>;
};
```

(`ObjectGenerationParams`: `prompt`, `schema?: JSONSchema`, `output?: 'object'|'array'|'enum'`, `enumValues?`, `modelType?`, `temperature?`, `stopSequences?`. `TextEmbeddingParams`: `{ text: string }`.)

> **v2/2.0 delta:** on `main`, `GenerateTextParams` becomes an **`interface`** and **`prompt` becomes optional** (`prompt?: string`, a legacy concatenated-prompt field; v2 paths emit `messages?: ChatMessage[]`). It adds ~18 optional fields: `omitMaxTokens`, `system`, `attachments`, `messages`, `tools`, `toolChoice`, `responseSchema`, `promptSegments`, `providerOptions`, `model`, `signal`, `prefill`, `responseSkeleton`, `grammar`, `streamStructured`, `spanSamplerPlan`, `voiceOutput`, `onStreamChunk`.

> **v2 `ModelType` delta:** adds `NANO`/`MEGA` tiers and a *distinct* `MEDIUM` (`TEXT_NANO`/`TEXT_MEDIUM`/`TEXT_MEGA`), plus `RESPONSE_HANDLER`, `ACTION_PLANNER`, `TEXT_EMBEDDING_BATCH`, `RESEARCH`; and **drops `OBJECT_SMALL`/`OBJECT_LARGE`** (structured output moves into `GenerateTextParams.responseSchema`/`responseFormat`).

### Services

```ts
getService<T extends Service>(service: ServiceTypeName | string): T | null;
getServicesByType<T extends Service>(service: ServiceTypeName | string): T[];
getAllServices(): Map<ServiceTypeName, Service[]>;
registerService(service: typeof Service): Promise<void>;   // takes the CLASS, returns a Promise
getServiceLoadPromise(serviceType: ServiceTypeName): Promise<Service>;
getRegisteredServiceTypes(): ServiceTypeName[];
hasService(serviceType: ServiceTypeName | string): boolean;
```

### State / actions / evaluators

```ts
composeState(message: Memory, includeList?: string[], onlyInclude?: boolean, skipCache?: boolean): Promise<State>;
processActions(message: Memory, responses: Memory[], state?: State, callback?: HandlerCallback, options?: {...}): Promise<void>;
evaluate(message: Memory, state?: State, didRespond?: boolean, callback?: HandlerCallback, responses?: Memory[]): Promise<Evaluator[] | null>;
registerAction(action: Action): void;
registerProvider(provider: Provider): void;
registerEvaluator(evaluator: Evaluator): void;
getConversationLength(): number;
```

Pair `composeState` with `composePromptFromState({ state, template })` (v1's replacement for v0's `composeContext`). **v2:** `processActions` → `runActionsByMode(mode, message, state?, options?)`.

### Settings

```ts
getSetting(key: string): string | boolean | number | null;   // v1.x return type
// v2 adds: setSetting(key, value, secret?): void; hasSetting(key): boolean;
```

`getSetting` is the unified accessor over env vars + character `settings`/`secrets`. (v0.x returned `string | undefined`.) See §8 for the precise resolution order.

### Events

```ts
emitEvent<T extends keyof EventPayloadMap>(event: T | T[], params: EventPayloadMap[T]): Promise<void>;
emitEvent(event: string | string[], params: EventPayload): Promise<void>;
registerEvent<T extends keyof EventPayloadMap>(event: T, handler: EventHandler<T>): void;
getEvent<T extends keyof EventPayloadMap>(event: T): EventHandler<T>[] | undefined;
```

### Memory (inherited from `IDatabaseAdapter`)

```ts
createMemory(memory: Memory, tableName: string, unique?: boolean): Promise<UUID>;
getMemories(params: {
  tableName: string;
  roomId?: UUID; entityId?: UUID; worldId?: UUID; agentId?: UUID;
  count?: number; offset?: number; unique?: boolean; start?: number; end?: number;
}): Promise<Memory[]>;
searchMemories(params: {
  embedding: number[]; tableName: string;
  match_threshold?: number; count?: number; unique?: boolean;
  query?: string; roomId?: UUID; worldId?: UUID; entityId?: UUID;
}): Promise<Memory[]>;
getMemoryById(id: UUID): Promise<Memory | null>;
getMemoriesByRoomIds(params: { tableName: string; roomIds: UUID[]; limit?: number }): Promise<Memory[]>;
updateMemory(memory: Partial<Memory> & { id: UUID; metadata?: MemoryMetadata }): Promise<boolean>;
addEmbeddingToMemory(memory: Memory): Promise<Memory>;
queueEmbeddingGeneration(memory: Memory, priority?: 'high'|'normal'|'low'): Promise<void>;
```

Common `tableName`s: `"messages"`, `"facts"`, `"documents"`. In v1, `Memory` uses `entityId` (v0's `userId` renamed).

### Cache (inherited)

```ts
getCache<T>(key: string): Promise<T | undefined>;
setCache<T>(key: string, value: T): Promise<boolean>;
deleteCache(key: string): Promise<boolean>;
```

### Rooms / entities / connections

```ts
ensureConnection(opts: {
  entityId: UUID; roomId: UUID; worldId?: UUID;
  userName?: string; name?: string; worldName?: string; source?: string;
  channelId?: string; messageServerId?: UUID; type?: ChannelType | string;
  userId?: UUID; metadata?: Record<string, unknown>;
}): Promise<void>;
ensureConnections(entities: Entity[], rooms: Room[], source: string, world: World): Promise<void>;
getRoomsForParticipant(entityId: UUID): Promise<UUID[]>;
getParticipantsForRoom(roomId: UUID): Promise<UUID[]>;
getRoom(roomId: UUID): Promise<Room | null>;
getEntityById(entityId: UUID): Promise<Entity | null>;
addParticipant(entityId: UUID, roomId: UUID): Promise<boolean>;
```

### Run / lifecycle

`createRunId(): UUID`, `startRun(roomId?): UUID`, `endRun(): void`, `getCurrentRunId(): UUID`, `stop(): Promise<void>`, `registerSendHandler(source, handler)`, `sendMessageToTarget(target, content)`.

### Usage snippets

```ts
import {
  type Action, type IAgentRuntime, type Memory, type State, type HandlerCallback,
  ModelType, composePromptFromState,
} from '@elizaos/core';

const replyAction: Action = {
  name: 'REPLY',
  validate: async () => true,
  handler: async (runtime, message, state, _opts, callback) => {
    state = await runtime.composeState(message, ['RECENT_MESSAGES']);
    const prompt = composePromptFromState({ state, template: 'You are {{agentName}}. Reply to: {{recentMessages}}' });
    const text = await runtime.useModel(ModelType.TEXT_LARGE, { prompt, temperature: 0.7, stopSequences: [] });
    await callback({ text, actions: ['REPLY'] });
    return { success: true, text };
  },
};

// semantic recall
const embedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, { text: message.content.text });
const hits = await runtime.searchMemories({
  embedding, tableName: 'messages', roomId: message.roomId, count: 5, match_threshold: 0.8,
});

await runtime.createMemory(
  { entityId: message.entityId, agentId: runtime.agentId, roomId: message.roomId, content: { text: 'noted' } },
  'messages', false,
);

const discord = runtime.getService<DiscordService>('discord');
const apiKey = runtime.getSetting('OPENAI_API_KEY');
```

### v0.x → v1.x runtime deltas

- Scope `@ai16z/eliza` → `@elizaos/core`.
- `ModelClass` → `ModelType`; standalone `generateText/generateObject/generateMessageResponse` → `runtime.useModel(ModelType.X, params)`.
- Memory managers gone (`messageManager`/`descriptionManager`/`documentsManager`/`loreManager`, `databaseAdapter.*`) → unified `createMemory`/`getMemories`/`searchMemories` directly on the runtime.
- `composeContext` → `composePromptFromState`; `composeState` signature changed; `State` became `{ values, data, text }`.
- `userId` → `entityId`.
- `getSetting` return widened to `string | boolean | number | null`; `registerService` takes the class and returns a Promise.

---

## 8. Plugin lifecycle, configuration, dependencies, load order

### `init(config, runtime)` — when it runs and what `config` is

From the real `registerPlugin`, `init` is invoked **inside `registerPlugin`, right after the plugin is pushed to `this.plugins`, and BEFORE its components are registered**:

```ts
async registerPlugin(plugin: Plugin): Promise<void> {
  if (!plugin.name) throw new Error("registerPlugin: Plugin or plugin name is undefined");

  const existingPlugin = this.plugins.find((p) => p.name === plugin.name);
  if (existingPlugin) { /* warn + return — idempotent, name-deduped */ return; }

  (this.plugins as Plugin[]).push(pluginToRegister);

  if (pluginToRegister.init) {
    const config: Record<string, string> = {};
    if (pluginToRegister.config) {
      for (const [key, value] of Object.entries(pluginToRegister.config)) {
        if (value !== null && value !== undefined) config[key] = String(value);
      }
    }
    await pluginToRegister.init(config, this);   // init runs here
  }
  // ...then: adapter → actions → evaluators → providers → models → routes → events → services
}
```

Two load-bearing facts:

1. **The `config` argument is the plugin's own static `Plugin.config`, stringified** (each value `String(value)`, `null`/`undefined` skipped) — **not** character settings. To read character settings/env/secrets inside `init`, call `runtime.getSetting(...)`.
2. `registerPlugin` is **idempotent by `name`** (second registration skipped with a warning); a missing `name` throws.

The per-plugin lifecycle is: **validate name → dedupe → push → `init()` → register components** (adapter → actions → evaluators → providers → models → routes → events → services; services deferred/queued if the runtime isn't fully initialized yet). (Note: a simplified "Core Runtime" docs snippet shows `init` *after* action registration — that contradicts the authoritative `runtime.ts` and the Architecture page; **init-first is correct**.)

### Configuration flow: `getSetting`, character.settings, env

```ts
getSetting(key: string): string | boolean | number | null {
  const value =
    secrets?.[key] ??                   // 1. character.secrets[key]
    settings?.[key] ??                  // 2. character.settings[key]
    extraSettings?.[key] ??             // 3. character.settings.extra[key]
    nestedSecrets?.[key] ??             // 4. character.settings.secrets[key]
    this.getCharacterEnvSetting(key) ?? // 5. character-scoped env (.env)
    this.settings[key];                 // 6. global/process settings

  if (value == null) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    const decrypted = decryptSecret(value, getSalt());  // secrets auto-decrypted
    if (decrypted === "true")  return true;
    if (decrypted === "false") return false;
    return decrypted;
  }
  return null;
}
```

- **Precedence:** `character.secrets` → `character.settings` → `character.settings.extra` → `character.settings.secrets` → character `.env` → global/process. First non-null wins.
- Returns `string | boolean | number | null`; coerces `"true"`/`"false"` to booleans; returns **`null`** (not `undefined`) when missing.
- Secrets are **auto-decrypted** via `decryptSecret(value, getSalt())`.

Character JSON:

```json
{
  "name": "Eliza",
  "plugins": ["@elizaos/plugin-sql", "@elizaos/plugin-openai", "@elizaos/plugin-bootstrap"],
  "settings": {
    "secrets": { "OPENAI_API_KEY": "sk-..." },
    "model": "gpt-4o"
  }
}
```

### Validating required env/secrets in `init`

```ts
export const myPlugin: Plugin = {
  name: 'my-plugin',
  description: 'Example',
  config: { defaultTimeout: 5000, retryAttempts: 3 },   // static defaults → stringified into init's config
  init: async (config, runtime) => {
    const apiKey = runtime.getSetting('MY_API_KEY');     // reads character/env/secrets
    if (!apiKey) throw new Error('MY_API_KEY not configured');
    // config.defaultTimeout here is "5000" (string)
  },
};
```

Complementary pattern — conditionally include a plugin only when its key is present:

```ts
const plugins = [
  '@elizaos/plugin-bootstrap',
  ...(process.env.ANTHROPIC_API_KEY ? ['@elizaos/plugin-anthropic'] : []),
  ...(process.env.OPENAI_API_KEY ? ['@elizaos/plugin-openai'] : []),
  ...(process.env.DISCORD_API_TOKEN ? ['@elizaos/plugin-discord'] : []),
];
```

The newer `autoEnable` field (source/`main`) formalizes this: `autoEnable.envKeys` / `connectorKeys` / `shouldEnable(env, config)`.

### Dependencies, priority, load-order

```ts
export const myPlugin: Plugin = {
  name: 'my-plugin',
  dependencies: ['@elizaos/plugin-sql', '@elizaos/plugin-bootstrap'],
  testDependencies: ['@elizaos/plugin-test-utils'],
  priority: 100,
};
```

- **`dependencies`** — listed plugin names are guaranteed loaded/registered first.
- **`testDependencies`** — extra deps only when running tests.
- **`priority`** — *"Higher priority plugins are loaded first"*; also the tie-breaker for model handlers (`registerModel(modelType, handler, plugin.name, plugin.priority)` → highest-priority provider wins). `@elizaos/plugin-sql` ships `priority: 0`.

The runtime's `_initializeCore` registers in three awaited groups: built-in `basic-capabilities` → enabled native features → character plugins **in array order**. The runtime itself iterates `characterPlugins` in array order — dependency expansion + priority ordering happen **upstream** in the CLI/server plugin loader, and the DB adapter is special-cased to load earliest (its factory is called before runtime construction). Effective order is roughly: **database/SQL → model providers → core (bootstrap/basic-capabilities) → feature plugins → platform plugins**.

### Database `schema` migrations

A plugin ships Drizzle table definitions on `schema`; elizaOS migrates them automatically:

```ts
import { pgTable, uuid, jsonb, timestamp, index } from 'drizzle-orm/pg-core';

export const userPreferencesTable = pgTable(
  'user_preferences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    preferences: jsonb('preferences').default({}).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [ index('idx_user_preferences_user_id').on(table.userId) ]
);

export const customSchema = { userPreferencesTable };

export const myPlugin: Plugin = {
  name: 'my-plugin',
  description: 'My custom plugin',
  dependencies: ['@elizaos/plugin-sql'],   // SQL adapter must load first
  schema: customSchema,
};
```

Mechanics: `@elizaos/plugin-sql` provides the adapter (Drizzle + PGlite/Postgres) and migration machinery. The runtime collects every plugin with a `schema` and runs `runPluginMigrations()` → `adapter.runPluginMigrations(pluginsWithSchemas, { verbose, force, dryRun })`, **after the adapter is registered**, during startup — developers don't invoke migrations manually. Multi-tenant: **omit `agentId`** to share rows across agents; **include it** to scope per agent.

### `Plugin` source vs docs (and `main` superset)

The live `main` source carries more than the docs reference: `init` may be **sync or async** (`Promise<void> | void`), `config` values are **primitives** (`string | number | boolean | null`), and there are extra hooks `dispose(runtime)` (cleanup on unload) and `applyConfig(config, runtime)` (config-only hot update). On `main`, `adapter` is an **`AdapterFactory`** (called before runtime construction with the agentId and basic settings), not a ready instance. Treat these as ahead of the pinned published release.

### Quick reference: lifecycle order (v1.x)

1. Plugin list assembled + ordered upstream (deps expanded, priority applied, SQL/adapter first).
2. Adapter factory called before runtime construction; runtime built.
3. `_initializeCore`: register `basic-capabilities` → native features → character plugins (array order).
4. Per plugin: validate `name` → dedupe → push → **`init(stringifiedConfig, runtime)`** → register adapter/actions/evaluators/providers/models/routes/events/services.
5. `runPluginMigrations()` applies each plugin's `schema`.
6. Services start (deferred ones flushed once ready).
7. On shutdown/unload: `dispose(runtime)`; for live config changes: `applyConfig(config, runtime)`.

### v0.x note

v0.x `Plugin` was a small `type` with `name`, `description`, `actions`, `providers`, `evaluators`, `services`, and a `clients` array — **no** `init`, `config`, `dependencies`, `priority`, `schema`, `routes`, `events`, or `models`, and **no** Drizzle auto-migration.

---

## 9. Advanced extension points: models, events, routes, adapter

### `models` — handlers keyed by `ModelType`

`models` is a **map (object), not an array** — keys are `ModelType` values, values are async handlers `(runtime, params) => Promise<result>`. (The docs `runtime/models` page shows an array `[{type, handler, provider, priority}]` shape — that reflects the imperative `runtime.registerModel(...)` call, not the declarative `Plugin.models` map.)

Real registration — how `@elizaos/plugin-openai` registers handlers:

```ts
import { ModelType, type Plugin } from "@elizaos/core";

export const openaiPlugin: Plugin = {
  name: "openai",
  description: "OpenAI plugin",
  config: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_LARGE_MODEL: process.env.OPENAI_LARGE_MODEL,   // defaults gpt-4o
    OPENAI_SMALL_MODEL: process.env.OPENAI_SMALL_MODEL,   // defaults gpt-4o-mini
    OPENAI_EMBEDDING_MODEL: process.env.OPENAI_EMBEDDING_MODEL,
  },
  async init(_config, runtime) { initializeOpenAI(_config, runtime); },
  models: {
    [ModelType.TEXT_EMBEDDING]:        async (runtime, params) => handleTextEmbedding(runtime, params),
    [ModelType.TEXT_TOKENIZER_ENCODE]: async (runtime, params) => handleTokenizerEncode(runtime, params),
    [ModelType.TEXT_TOKENIZER_DECODE]: async (runtime, params) => handleTokenizerDecode(runtime, params),
    [ModelType.TEXT_SMALL]:            async (runtime, params) => handleTextSmall(runtime, params),
    [ModelType.TEXT_LARGE]:            async (runtime, params) => handleTextLarge(runtime, params),
    [ModelType.IMAGE]:                 async (runtime, params) => handleImageGeneration(runtime, params),
    [ModelType.IMAGE_DESCRIPTION]:     async (runtime, params) => handleImageDescription(runtime, params),
    [ModelType.TRANSCRIPTION]:         async (runtime, input)  => handleTranscription(runtime, input),
    [ModelType.TEXT_TO_SPEECH]:        async (runtime, input)  => handleTextToSpeech(runtime, input),
    [ModelType.OBJECT_SMALL]:          async (runtime, params) => handleObjectSmall(runtime, params),
    [ModelType.OBJECT_LARGE]:          async (runtime, params) => handleObjectLarge(runtime, params),
  },
};
```

Consuming (provider-agnostic): `await runtime.useModel(ModelType.TEXT_LARGE, { prompt: "Hello" })`; `await runtime.useModel(ModelType.TEXT_EMBEDDING, { text: "embed me" })`. When multiple plugins register a handler for the same type, the highest `priority` wins (the 4th `registerModel` arg; ties broken by registration order); `useModel`'s optional `provider` arg forces a specific provider. (`main` adds `NANO`/`MEGA`/`RESPONSE_HANDLER`/`ACTION_PLANNER`/`TEXT_EMBEDDING_BATCH`/`RESEARCH`, and `ModelHandler` becomes an interface `{ handler; provider; priority?; registrationOrder? }`.)

### `events` — the plugin event-handler map

```ts
export type PluginEvents = { [K in keyof EventPayloadMap]?: EventHandler<K>[] };
export type EventHandler<T extends keyof EventPayloadMap> = (payload: EventPayloadMap[T]) => Promise<void>;
```

`EventType` (published `1.7.2`) — a string enum whose values equal their names:

```ts
export declare enum EventType {
  WORLD_JOINED = "WORLD_JOINED", WORLD_CONNECTED = "WORLD_CONNECTED", WORLD_LEFT = "WORLD_LEFT",
  ENTITY_JOINED = "ENTITY_JOINED", ENTITY_LEFT = "ENTITY_LEFT", ENTITY_UPDATED = "ENTITY_UPDATED",
  ROOM_JOINED = "ROOM_JOINED", ROOM_LEFT = "ROOM_LEFT",
  MESSAGE_RECEIVED = "MESSAGE_RECEIVED", MESSAGE_SENT = "MESSAGE_SENT", MESSAGE_DELETED = "MESSAGE_DELETED",
  CHANNEL_CLEARED = "CHANNEL_CLEARED",
  VOICE_MESSAGE_RECEIVED = "VOICE_MESSAGE_RECEIVED", VOICE_MESSAGE_SENT = "VOICE_MESSAGE_SENT",
  REACTION_RECEIVED = "REACTION_RECEIVED", POST_GENERATED = "POST_GENERATED", INTERACTION_RECEIVED = "INTERACTION_RECEIVED",
  RUN_STARTED = "RUN_STARTED", RUN_ENDED = "RUN_ENDED", RUN_TIMEOUT = "RUN_TIMEOUT",
  ACTION_STARTED = "ACTION_STARTED", ACTION_COMPLETED = "ACTION_COMPLETED",
  EVALUATOR_STARTED = "EVALUATOR_STARTED", EVALUATOR_COMPLETED = "EVALUATOR_COMPLETED",
  MODEL_USED = "MODEL_USED",
  EMBEDDING_GENERATION_REQUESTED = "EMBEDDING_GENERATION_REQUESTED",
  EMBEDDING_GENERATION_COMPLETED = "EMBEDDING_GENERATION_COMPLETED",
  EMBEDDING_GENERATION_FAILED = "EMBEDDING_GENERATION_FAILED",
  CONTROL_MESSAGE = "CONTROL_MESSAGE",
}
```

Payloads via `EventPayloadMap` (e.g. `MESSAGE_*`/`VOICE_MESSAGE_RECEIVED`/`REACTION_RECEIVED`/`INTERACTION_RECEIVED` → `MessagePayload`; `WORLD_*` → `WorldPayload`; `ENTITY_*` → `EntityPayload`; `RUN_*` → `RunEventPayload`; `ACTION_*` → `ActionEventPayload`; `MODEL_USED` → `ModelEventPayload`):

```ts
export interface EventPayload { runtime: IAgentRuntime; source: string; onComplete?: () => void; }
export interface MessagePayload extends EventPayload { message: Memory; callback?: HandlerCallback; }
```

Declaring handlers:

```ts
import { EventType, type Plugin, type MessagePayload } from "@elizaos/core";

export const myPlugin: Plugin = {
  name: "my-plugin",
  description: "...",
  events: {
    [EventType.MESSAGE_RECEIVED]: [
      async (payload: MessagePayload) => { payload.runtime.logger.info(`got message ${payload.message.id}`); },
      async (payload) => { /* second handler also runs */ },
    ],
    [EventType.WORLD_JOINED]: [ async ({ runtime, world, rooms, entities }) => { /* sync members */ } ],
  },
};
```

This is how `@elizaos/plugin-bootstrap` wires the core message loop (it registers the `MESSAGE_RECEIVED` handler that runs the action/provider pipeline). Imperative APIs: `registerEvent`, `emitEvent` (the `T[]` overload emits to multiple names at once; string overloads allow custom events). (`main` adds `VOICE_*`, `FORM_*`, `VIEW_SWITCHED`, `SLASH_COMMAND_INVOKED`, `SHORTCUT_FIRED`, and a `HOOK_*` family.)

### `routes` — HTTP endpoints via the agent server

```ts
export type Route = {
  type: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'STATIC';
  path: string;
  filePath?: string;        // for STATIC: file/dir to serve
  public?: boolean;         // expose publicly (true => discoverable / served as a UI tab)
  name?: string;            // required for public routes (UI label)
  handler?: (req: RouteRequest, res: RouteResponse, runtime: IAgentRuntime) => Promise<void>;
  isMultipart?: boolean;    // multipart/form-data file uploads
};

export interface RouteRequest {
  body?: Record<string, JsonValue>;
  rawBody?: string;         // raw bytes, for webhook HMAC verification
  params?: Record<string, string>;
  query?: Record<string, string | string[]>;
  headers?: Record<string, string | string[] | undefined>;
  method?: string; path?: string; url?: string;
}
export interface RouteResponse {
  status: (code: number) => RouteResponse;
  json: (data: unknown) => RouteResponse;
  send: (data: unknown) => RouteResponse;
  end: () => RouteResponse;
  setHeader?: (name: string, value: string | string[]) => RouteResponse;
  sendFile?: (path: string) => RouteResponse;
}
```

Example — an API route plus a webhook that posts a message as the agent:

```ts
export const myPlugin: Plugin = {
  name: "my-plugin",
  description: "...",
  routes: [
    { name: "status", path: "/status", type: "GET", public: true,
      handler: async (req, res, runtime) => { res.json({ ok: true, agentId: runtime.agentId }); } },
    { name: "send-message-webhook", path: "/send-agent-message", type: "POST",
      handler: async (req, res, runtime) => {
        const { channelId, message } = req.body!;
        const baseUrl = runtime.getSetting("SERVER_URL") || "http://localhost:3000";
        await fetch(`${baseUrl}/api/messaging/submit`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            channel_id: channelId, server_id: "00000000-0000-0000-0000-000000000000",
            author_id: runtime.agentId, content: message,
            source_type: "agent_response", raw_message: { text: message },
            metadata: { agent_id: runtime.agentId },
          }),
        });
        res.json({ success: true });
      } },
  ],
};
```

Plugin UIs: a `STATIC` route with `filePath` + `public: true` serves a built frontend (the plugin-starter "frontend" template ships a React/Vite app this way); `public` named routes surface as dashboard tabs. Routes are reachable at `http://localhost:3000{path}?agentId=YOUR_AGENT_ID` (namespaced under the plugin name unless overridden). Webhook security is the author's responsibility — validate input, check auth headers, verify signatures against `rawBody`. (`main`: `Route` becomes a discriminated union `PublicRoute | PrivateRoute`, gains a canonical `routeHandler` with SSE `stream`, a `rawPath` escape hatch, and `x402` micropayment fields.)

### `adapter` — database-adapter extension

`Plugin.adapter?: IDatabaseAdapter` is a ready adapter instance; `IDatabaseAdapter` is the storage contract:

```ts
export interface IDatabaseAdapter {
  db: unknown;
  initialize(config?: Record<string, string | number | boolean | null>): Promise<void>;
  init(): Promise<void>;
  isReady(): Promise<boolean>;
  close(): Promise<void>;
  getConnection(): Promise<unknown>;
  runPluginMigrations?(plugins: Array<{ name: string; schema?: Record<string, unknown> }>,
    options?: { verbose?: boolean; force?: boolean; dryRun?: boolean }): Promise<void>;
  runMigrations?(migrationsPaths?: string[]): Promise<void>;
  // ...plus the full memory/entity/room/relationship/embedding CRUD the runtime calls
}
```

In practice the canonical `@elizaos/plugin-sql` registers the adapter **imperatively in `init()`** and drives migrations via `schema`:

```ts
export const plugin: Plugin = {
  name: "@elizaos/plugin-sql",
  description: "A plugin for SQL database access with dynamic schema migrations",
  priority: 0,
  schema: exports_schema,
  init: async (_config, runtime) => {
    if (await runtime.isReady().then(() => true).catch(() => false)) return; // skip if adapter present
    const dbAdapter = createDatabaseAdapter(
      { dataDir: runtime.getSetting("PGLITE_DATA_DIR"), postgresUrl: runtime.getSetting("POSTGRES_URL") },
      runtime.agentId,
    );
    runtime.registerDatabaseAdapter(dbAdapter);
  },
};
```

Two ways to supply storage: set `Plugin.adapter`, or call `runtime.registerDatabaseAdapter(adapter)` from `init()`. Only one plugin per agent should provide it (default: `@elizaos/plugin-sql` — PGlite locally, Postgres in production). The `schema` field lets *any* plugin contribute Drizzle tables that `runPluginMigrations` applies. (`main`: `adapter?: AdapterFactory = (agentId, settings) => IDatabaseAdapter | Promise<...>`, called before runtime construction.)

### Quick reference

| Capability | `Plugin` field | Type | Runtime API |
|---|---|---|---|
| Models | `models` | `{ [ModelType]?: (runtime, params) => Promise<R> }` (map) | `useModel`, `registerModel`, `getModel` |
| Events | `events` | `PluginEvents` = `{ [EventType]?: EventHandler[] }` | `registerEvent`, `emitEvent` |
| HTTP routes | `routes` | `Route[]` | mounted at `{path}?agentId=…` |
| DB adapter | `adapter` (+ `schema`) | `IDatabaseAdapter` | `registerDatabaseAdapter` |

### v0.x note

v0.x `Plugin` had `name`, `description`, `actions`, `evaluators`, `providers`, `services`, `clients` — **no `models`, `events`, `routes`, `adapter`, or `schema`**. Model selection went through the character's `modelProvider` (`ModelProviderName` enum) + a global `models.ts`, not plugins.

---

## 10. Integration patterns for external systems

### Recommended architecture

To connect an agent to an external orchestration/control plane, build **one plugin** bundling four cooperating components: "Service holds the connection, Actions expose operations, Providers surface state, Evaluators capture outcomes."

| Component | Role | Lifetime |
|---|---|---|
| **Service** | Owns the long-lived client/connection (HTTP/WS/SDK), auth/token, in-memory registry of in-flight work. Singleton. | Whole agent process (`start()`→`stop()`). |
| **Action** | A discrete operation the LLM can invoke ("kick off a run", "cancel"). Talks to the Service. | Per turn, when selected. |
| **Provider** | Injects live external state into the prompt before the model responds. | Per turn, read-only. |
| **Evaluator** | Post-response reflection: records outcomes/facts about completed ops. | After the response. |

> **v0.x → v1 note (corrected scope history).** In old `@ai16z/eliza`, platform connectors were a separate first-class concept called **Clients** (`character.clients`, a `Client` interface with `start`/`stop`). v1 collapsed everything into the unified plugin model — a connector is now just a **Service** inside a plugin that emits `MESSAGE_RECEIVED`. The package scope moved `@ai16z/eliza` → `@elizaos/core` directly (no `@elizaos/eliza` ever existed).

### Service holds the external connection

The same pattern as the real `@elizaos/plugin-discord` / `@elizaos/plugin-telegram`:

```ts
class DiscordService extends Service {
  static serviceType = 'discord' as const;
  capabilityDescription = 'Discord bot integration';
  private client: Discord.Client;

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new DiscordService(runtime);
    await service.initialize();
    return service;
  }
  private async initialize() {
    const token = this.runtime.getSetting("DISCORD_API_TOKEN");
    this.client = new Discord.Client({ intents: [/* … */] });
    this.setupEventHandlers();
    await this.client.login(token);   // long-lived connection established
  }
  async stop() { await this.client?.destroy(); }
}
```

For an HTTP/RPC control plane, the Service holds a `fetch`/SDK client + base URL + auth token from `runtime.getSetting(...)` and exposes typed methods Actions/Providers call.

### Bridging turn-based agents to long-running ops

Three composable mechanisms:

**(a) `HandlerCallback` to stream updates.** `callback(content)` injects a new agent message into the conversation at any time — once on kick-off, again later (from a task/event handler) when status changes.

**(b) Service tracks in-flight work** in a `Map<runId, {roomId, status}>`. Actions register entries; pollers/webhooks update them; Providers read them.

**(c) Poll (Task system) or receive webhooks (route).** Poll example:

```ts
runtime.registerTaskWorker({
  name: 'POLL_ORCHESTRATION_RUNS',
  execute: async (runtime) => {
    const svc = runtime.getService<OrchestratorService>('orchestrator')!;
    for (const [runId, info] of svc.inFlight()) {
      const run = await svc.getRun(runId);
      if (run.status !== info.status) {
        info.status = run.status;
        await runtime.emitEvent(EventType.MESSAGE_RECEIVED, { runtime, message: /* status memory */, callback });
        if (run.status === 'completed') svc.untrack(runId);
      }
    }
  },
});
await runtime.createTask({ name: 'POLL_ORCHESTRATION_RUNS', metadata: { updateInterval: 15000 } });
```

Or expose a plugin **route** the control plane POSTs status callbacks to; the handler looks up the tracked `roomId` and emits `MESSAGE_RECEIVED`.

### Custom message source / platform client

A connector Service converts each inbound external message to a `Memory` and emits `EventType.MESSAGE_RECEIVED` with a `callback` that routes the reply back out. `plugin-bootstrap` (subscribed to `MESSAGE_RECEIVED`) drives the think/respond loop, so a new platform "just works" once it emits that event:

```ts
const memory: Memory = { /* entityId, roomId, content: { text, source: 'orchestrator-chat' }, ... */ };
const callback: HandlerCallback = async (response) => {
  await this.sendToExternalPlatform(externalChatId, response);
  return [];
};
await this.runtime.emitEvent(EventType.MESSAGE_RECEIVED, { runtime: this.runtime, message: memory, callback });
```

### Concrete skeleton — external control-plane plugin

```ts
import {
  type Plugin, type Action, type Provider, type IAgentRuntime, type Memory,
  type State, type HandlerCallback, type ActionResult, Service, EventType,
} from '@elizaos/core';

declare module '@elizaos/core' {
  interface ServiceTypeRegistry { ORCHESTRATOR: 'orchestrator'; }
}

interface RunInfo { id: string; roomId: string; status: string; }

export class OrchestratorService extends Service {
  static serviceType = 'orchestrator';
  capabilityDescription = 'Connection to the external orchestration control plane';
  private base!: string; private token!: string;
  private runs = new Map<string, RunInfo>();

  static async start(runtime: IAgentRuntime): Promise<OrchestratorService> {
    const svc = new OrchestratorService(runtime);
    svc.base = String(runtime.getSetting('ORCH_API_URL'));
    svc.token = String(runtime.getSetting('ORCH_API_TOKEN'));
    runtime.registerTaskWorker({ name: 'POLL_RUNS', execute: (rt) => svc.poll(rt) });
    await runtime.createTask({ name: 'POLL_RUNS', metadata: { updateInterval: 15000 } });
    return svc;
  }
  private hdrs() { return { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }; }
  async startRun(body: unknown) {
    const r = await fetch(`${this.base}/runs`, { method: 'POST', headers: this.hdrs(), body: JSON.stringify(body) });
    return (await r.json()) as { runId: string };
  }
  async getRun(id: string) {
    const r = await fetch(`${this.base}/runs/${id}`, { headers: this.hdrs() });
    return (await r.json()) as { status: string };
  }
  track(id: string, roomId: string) { this.runs.set(id, { id, roomId, status: 'started' }); }
  untrack(id: string) { this.runs.delete(id); }
  snapshot() { return [...this.runs.values()]; }
  private async poll(_runtime: IAgentRuntime) {
    for (const info of this.runs.values()) {
      const { status } = await this.getRun(info.id);
      if (status !== info.status) info.status = status;
      if (status === 'completed' || status === 'failed') this.untrack(info.id);
    }
    return undefined;
  }
  async stop() { this.runs.clear(); }
}

const startRunAction: Action = {
  name: 'START_RUN',
  similes: ['LAUNCH_WORKFLOW', 'KICK_OFF_RUN'],
  description: 'Start a long-running workflow on the control plane',
  validate: async (rt) => !!rt.getService('orchestrator'),
  handler: async (rt, msg, _s, _o, cb): Promise<ActionResult> => {
    const svc = rt.getService<OrchestratorService>('orchestrator')!;
    const { runId } = await svc.startRun({ prompt: msg.content.text });
    svc.track(runId, msg.roomId);
    await cb?.({ text: `Started run \`${runId}\`. I'll report progress here.` });
    return { success: true, data: { runId } };
  },
  examples: [],
};

const runsProvider: Provider = {
  name: 'CONTROL_PLANE_STATE',
  description: 'In-flight control-plane runs',
  dynamic: true,
  get: async (rt) => {
    const svc = rt.getService<OrchestratorService>('orchestrator')!;
    const runs = svc.snapshot();
    return { text: runs.map(r => `${r.id}: ${r.status}`).join('\n') || 'no active runs', data: { runs } };
  },
};

export const orchestratorPlugin: Plugin = {
  name: 'orchestrator',
  description: 'Connect the agent to the external orchestration control plane',
  dependencies: ['@elizaos/plugin-sql'],
  services: [OrchestratorService],
  actions: [startRunAction],
  providers: [runsProvider],
  evaluators: [],
  events: { [EventType.RUN_ENDED]: [ async () => { /* optional reflection */ } ] },
  routes: [
    { type: 'POST', path: '/orchestrator/callback', handler: async (req, res, runtime) => { /* lookup roomId + emit MESSAGE_RECEIVED */ } },
  ],
  init: async (config, runtime) => { /* validate ORCH_API_URL / ORCH_API_TOKEN */ },
};

export default orchestratorPlugin;
```

> Note: `TaskWorker` gating differs by version (published docs show `validate?`; `main` shows `shouldRun?`/`canExecute?`). The `develop`/v2 `Evaluator` is the schema/`shouldRun`/`prompt`/`processors` redesign (§5) — target the published-1.x handler/validate shape unless pinned to a pre-release. Confirm `Route`, `TaskWorker`, `createTask`, and the `Memory`/`Content` fields you populate against your installed `.d.ts`.

### Real plugins to copy from

- `@elizaos/plugin-bootstrap` — default message-handling; subscribes to `MESSAGE_RECEIVED`.
- `@elizaos/plugin-sql` — adapter/Service pattern for a persistent backend; common `dependencies` entry.
- `@elizaos/plugin-telegram` / `@elizaos/plugin-discord` — canonical "Service holds bot client + emits `MESSAGE_RECEIVED` + callback sends reply out."

---

## 11. Packaging, structure, publishing, CLI & testing

A plugin is a plain object implementing `Plugin`, exported (named + default) from `src/index.ts`. The current `elizaos create --type plugin` scaffold is tagged `2.0.0-beta.0` with `agentConfig.pluginType: "elizaos:plugin:1.0.0"`.

### Standard repo layout

The scaffold puts the `Plugin` object and inline components in **`src/plugin.ts`**, using **`src/index.ts`** as a re-export barrel:

```
plugin-my-plugin/
├── src/
│   ├── index.ts        # re-exports the Plugin (named + default)
│   ├── plugin.ts       # the Plugin object + actions/providers/services
│   ├── actions/ providers/ services/   # split out as the plugin grows
│   ├── __tests__/      # component tests (vitest)
│   ├── e2e/            # e2e tests: *.e2e.ts (a TestSuite)
│   └── frontend/       # optional React UI (Vite)
├── package.json
├── build.ts            # Bun-based build (current scaffold)  — or tsup.config.ts
├── tsconfig.json / tsconfig.build.json
├── vite.config.ts      # only if shipping a frontend
└── README.md
```

`src/index.ts` is literally:

```ts
import { starterPlugin } from "./plugin.ts";
export { starterPlugin } from "./plugin.ts";
export default starterPlugin;
```

(The older docs layout defines the `Plugin` directly in `src/index.ts` with sibling `src/actions|providers|services`. Both are valid.)

### `package.json`

```json
{
  "name": "@yourscope/plugin-foo",
  "description": "Foo integration for elizaOS agents",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "module": "dist/index.js",
  "types": "dist/index.d.ts",
  "packageType": "plugin",
  "platform": "node",
  "license": "MIT",
  "keywords": ["plugin", "elizaos"],
  "exports": {
    "./package.json": "./package.json",
    ".": { "import": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } }
  },
  "files": ["dist", "README.md", "package.json"],
  "dependencies": {
    "@elizaos/core": "^1.0.0",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@types/node": "^25.0.3",
    "typescript": "^6.0.3",
    "vitest": "^4.1.4"
  },
  "scripts": {
    "dev": "bun run build:watch",
    "build": "bun run build.ts",
    "typecheck": "tsc --noEmit",
    "test:component": "vitest run src/__tests__",
    "test:e2e": "vitest run src/e2e",
    "test": "bun run test:component && bun run test:e2e"
  },
  "publishConfig": { "access": "public" },
  "agentConfig": {
    "pluginType": "elizaos:plugin:1.0.0",
    "pluginParameters": {
      "API_KEY": { "type": "string", "description": "Secret API key. Required at runtime; do not commit values." },
      "BASE_URL": { "type": "string", "description": "Base URL of the service.", "defaultValue": "https://api.example.com" }
    }
  }
}
```

#### Naming rules (corrected)

> **The third-party registry validator requires only (a) a valid npm package name and (b) that it must NOT use the reserved `@elizaos/*` scope. It does NOT require the name to contain `plugin-`.**

- **CONFIRMED:** the `@elizaos/*` scope is reserved for first-party and is **rejected** by the registry validator. The JSON Schema (`registry-entry.schema.json`) sets `"not": { "pattern": "^@elizaos\\/" }`, and the code validator (`src/schema.ts`) does `else if (pkg.startsWith("@elizaos/")) errors.push("package must not use the reserved @elizaos/* scope")`.
- **REFUTED:** there is **no** "must contain `plugin-`" requirement. The schema's only name pattern is a generic npm-name regex `^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$`, with no substring/prefix check. A live accepted counterexample: `blackwall-eliza-guardrail` (no `plugin-` anywhere). The README frames `elizaos-plugin-*` as a **convention**, not a rule, and the runtime auto-discovers any npm package whose `keywords` include `elizaos` regardless of name.
- **Version-dependent nuance (likely source of the myth):** the separate **`elizaos publish` CLI** *does* require the plugin name to **start with `plugin-`** (per the publish docs) — but that is a "start with" check on the publish CLI's own-plugin path, not the third-party registry validator.

So practical guidance: publish under your own scope (`@yourscope/plugin-foo`) or unscoped (`plugin-foo` / `elizaos-plugin-foo`); never `@elizaos/*`. If you intend to use `elizaos publish`, name it `plugin-*` to satisfy that command's own check.

#### `@elizaos/core` dependency placement (corrected)

> **Both the current scaffold AND the historical convention declare `@elizaos/core` under `dependencies`. `peerDependencies` on `@elizaos/core` is an uncommon minority pattern, not "the older/common convention."**

- The current scaffold (`templates/plugin/package.json`) declares `"@elizaos/core": "__ELIZAOS_VERSION__"` under `dependencies` with empty `peerDependencies`; published `@elizaos/plugin-starter@1.7.2` has it under `dependencies`; docs tell you to `bun add @elizaos/core`.
- There is **no** "older/common" peerDependencies convention: v0.x official plugins (`@elizaos/plugin-bootstrap@0.1.9`, `@0.25.9`) used `dependencies`; the v0→v1 migration guide recommends `dependencies` and never mentions peerDependencies. Across ~12 official v1.x plugins, all use `dependencies`; only `@elizaos/plugin-solana` uses `peerDependencies`.
- **The bundler externalizes `@elizaos/core` regardless of where it is declared, so it is never bundled into `dist/`** — the current scaffold's `build.ts` calls `Bun.build` with `external: ["dotenv", "node:*", "@elizaos/core", "zod"]`; tsup-based community plugins use `external: ['@elizaos/core']`.

> **Docs discrepancy:** the `cli-reference/publish` docs show an alternate `agentConfig` listing capability arrays (`{ actions, providers, evaluators, models, services }`). The live scaffold instead uses `{ pluginType, pluginParameters }` — treat that as current source of truth.

### Build

**Current scaffold — `build.ts` (Bun-native), NOT tsup:**

```ts
const result = await Bun.build({
  entrypoints: ["./src/index.ts"],
  outdir: "./dist",
  target: "node",
  format: "esm",
  sourcemap: true,
  external: ["dotenv", "node:*", "@elizaos/core", "zod"],
  naming: { entry: "[dir]/[name].[ext]" },
});
// + `tsc --emitDeclarationOnly --noCheck --project ./tsconfig.build.json`
```

**Classic / widely documented — `tsup`** (still valid):

```ts
import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: ['@elizaos/core'],
});
```

Either is fine; what matters is ESM output to `dist/`, emitted `.d.ts`, and `@elizaos/core` (plus `zod`) externalized.

### CLI commands (`@elizaos/cli`, install `bun install -g @elizaos/cli`)

| Command | Purpose |
|---|---|
| `elizaos create --type plugin my-plugin` (alias `-t`) | Scaffold from template. |
| `elizaos dev` | Dev mode + hot reload. |
| `elizaos start` | Run the agent (default UI at `http://localhost:3000`). |
| `elizaos test [--type component\|e2e] [--name "<suite>"]` | Run tests. |
| `elizaos plugins add <name>` (alias `install`) | Add a plugin + prompt for `pluginParameters`. Flags: `-s/--skip-env-prompt`, `--skip-verification`, `-b/--branch`, `-T/--tag`. |
| `elizaos plugins list` / `installed-plugins` / `remove` | List / inspect / remove. |
| `elizaos plugins submit . --dry-run` | Generate the registry entry JSON. |
| `elizaos publish` | One-shot **initial** release: validate → `bun run build` → publish to npm → create GitHub repo → open registry PR. Flags `-t/--test`, `--npm`, `-d/--dry-run`, `--skip-registry`. Requires npm login + `GITHUB_TOKEN`. Initial-release only — for updates, bump version and `bun publish`/push tags. |

`plugins add` name resolution: short names auto-resolve to `@elizaos/plugin-*`; full names work as-is; GitHub via HTTPS URL or `github:user/repo#branch`.

### The plugin registry

> The standalone `github.com/elizaos-plugins/registry` repo is **archived/read-only**; the registry now lives in-monorepo at **`packages/registry`**.

- `entries/third-party/<package>.json` — one source entry per community package (source of truth).
- `schema/registry-entry.schema.json` — JSON Schema for an entry.
- `generated-registry.json` — the wire format the runtime fetches (built by `generate.ts`; never hand-edited).

Discovery is automatic (keyword `elizaos`), so a listing is for discoverability/curation, not required to run. To get listed: publish to npm (own scope or `elizaos-plugin-*`, not `@elizaos/*`) → `elizaos plugins submit . --dry-run` → add `entries/third-party/<package>.json` (filename: `/`→`__`, drop `@`) → `bun run --cwd packages/registry validate` and `… generate` → open a PR.

A source entry (required `package`, `repository`, `kind`):

```json
{
  "package": "elizaos-plugin-echo",
  "repository": "github:elizaOS/eliza",
  "kind": "plugin",
  "description": "Reference third-party elizaOS plugin: an ECHO action that repeats a message back.",
  "homepage": "https://github.com/elizaOS/eliza/tree/main/packages/examples/plugin-echo",
  "version": "2.0.0-beta.0",
  "directory": "packages/examples/plugin-echo",
  "tags": ["example", "utility", "reference"]
}
```

`repository` must be `github:owner/repo`; `kind` ∈ `plugin | connector | app`; `package` must not use the `@elizaos/` scope.

### Testing: component vs e2e

`@elizaos/core` defines:

```ts
export interface TestCase { name: string; fn: (runtime: IAgentRuntime) => Promise<void> | void; }
export interface TestSuite { name: string; tests: TestCase[]; }
```

**Component tests** — fast, isolated, under **vitest** in `src/__tests__/`; import the `Plugin` and exercise a component against a lightweight runtime helper:

```ts
import { starterPlugin } from "../index";
import { createTestRuntime } from "./test-utils";
const action = starterPlugin.actions?.find(a => a.name === "HELLO_WORLD");
await action.handler(runtime, mockMessage, mockState, {}, callbackFn, []);
expect(firstCall[0].text).toBe("Hello world!");
```

Run: `vitest run src/__tests__` or `elizaos test --type component`.

**E2E tests** — a `TestSuite` exported from `src/e2e/*.e2e.ts` and **registered on the plugin via `tests: [MyTestSuite]`**. Each `fn` receives a **real `IAgentRuntime`** (the agent is booted), so you assert on live state and **signal failure by throwing**:

```ts
export const StarterPluginTestSuite: TestSuite = {
  name: "plugin_starter_test_suite",
  tests: [
    { name: "should_have_hello_world_action",
      fn: async (runtime: IAgentRuntime) => {
        if (!runtime.actions.some(a => a.name === "HELLO_WORLD"))
          throw new Error("Hello world action not found in runtime actions");
      } },
  ],
};
```

Run: `elizaos test --type e2e` (or `--name "<suite>"`). In multi-agent projects a suite runs once per agent.

> Note: which test runner ships is version-dependent — the current scaffold wires **vitest** (component) + `elizaos test` (e2e); some docs describe `bun:test`. Confirm against your generated scaffold.

### v0.x → current packaging differences

- Scope `@ai16z/eliza` → `@elizaos/core`.
- `Plugin.clients`/`adapters` removed → Services/connectors + single `adapter?` factory.
- `agentConfig` now centers on `pluginType` + `pluginParameters`.
- Registry moved out of the archived standalone repo into monorepo `packages/registry`; discovery is keyword-based.
- Scaffold default build moved from `tsup` to a Bun `build.ts` (tsup still works).

---

## 12. Version notes (consolidated)

### Timeline (verified on npm + repo)

| Era | Package(s) | npm state (checked 2026-06) | Notes |
|---|---|---|---|
| **v0.x** | `@ai16z/eliza` (single mega-package) | `latest` = `0.1.6` (publishes `0.1.1`–`0.1.6`; last 2024-12-21) | ai16z era; runtime + clients + adapters in one package. |
| **scope rename** | `@ai16z/eliza` → `@elizaos/core` (direct) | `@elizaos/core` first publish `0.1.7-alpha.1` (2024-12-22); `0.1.7` stable (2025-01-04) | Org renamed ai16z → elizaOS. **No `@elizaos/eliza` package ever existed.** |
| **v1.x ("V2 runtime")** | `@elizaos/core`, `@elizaos/cli`, `@elizaos/plugin-*` | core `1.0.0` (2025-05-30) → **`1.7.2`** `latest` (2026-01-19); cli `1.7.2` | **Current recommended.** |
| **2.0 (in progress)** | `@elizaos/core@2.x` | `next` `2.0.0-alpha.32`, `alpha` `2.0.0-alpha.537`, `beta` `2.0.3-beta.7` | `main`/`develop` branches; pre-release; types still churning. |

`@elizaos/core` thus spans **late-v0.x → all of v1.x → the 2.0.x betas** — the `@elizaos/*` scope is **not** unique to v1.

### What changed v0 → v1 (don't copy v0 patterns)

- **Clients → Services:** the v0 `Client` type / `character.clients` / `plugin.clients` is gone; connectors are `Service` classes registered via `services`.
- **Actions:** handlers return structured **`ActionResult`** (with `success`) instead of `boolean`/`unknown`; handler gained `options`/`callback`/`responses`; `ActionExample.user` → `name`.
- **Providers:** `get` returns structured **`ProviderResult`** (was a bare string); providers gained `name`/`description`/`dynamic`/`position`/`private`.
- **Evaluators:** `runtime.evaluate()` yields `Evaluator` **objects** (was a `string[]` of names).
- **Models:** `ModelClass`/standalone `generateText/generateObject` → `runtime.useModel(ModelType.X, params)` + per-plugin `models` map.
- **Events:** a first-class typed event bus (`EventType`, `PluginEvents`, `emitEvent`/`registerEvent`) — new in v1.
- **Entity model:** User/Participant → Entity/Room/World (`userId` → `entityId`).
- **Memory managers gone:** unified `createMemory`/`getMemories`/`searchMemories` directly on the runtime.
- **Tooling:** the `elizaos` CLI + registry; per-plugin Drizzle `schema` auto-migration.

### What's changing v1 → v2 (alpha/beta — don't depend on it for a 1.x plugin)

- `Plugin` gains `mode`/`remote`, `dispose`/`applyConfig`, `shortcuts`, `views`/`widgets`/`app`/`appBridge`, `contexts`, `autoEnable`, `responseHandlerEvaluators`; `adapter` becomes an `AdapterFactory`; `services`/`componentTypes` get named types.
- **`Evaluator` redesigned** to `schema`/`shouldRun`/`prepare`/`prompt`/`parse`/`processors` — no longer uses `Handler`/`Validator` (only `Action` still does).
- `ModelType` adds `NANO`/`MEDIUM`/`MEGA`/`RESEARCH`/`ACTION_PLANNER`/`RESPONSE_HANDLER`/`TEXT_EMBEDDING_BATCH`; **drops `OBJECT_SMALL`/`OBJECT_LARGE`**.
- `GenerateTextParams` → `interface` with **optional `prompt`** + ~18 new fields (`messages`, `tools`, `responseSchema`, streaming, …).
- `ActionResult` gains `userFacingText`/`verifiedUserFacing`/`continueChain`/`cleanup`; `Handler` return loses `| void`; `HandlerCallback`'s 2nd arg is `actionName?` (was `files?`); `Validator` gains a 4th `options?` param.
- `EventType` adds `VOICE_*`/`FORM_*`/`VIEW_SWITCHED`/`SLASH_COMMAND_INVOKED`/`SHORTCUT_FIRED`/`HOOK_*`; `Route` becomes a `PublicRoute | PrivateRoute` union with SSE + `x402`.
- Runtime: `processActions` → `runActionsByMode`; adds `setSetting`/`hasSetting`, pipeline hooks, autonomy toggles.

**Recommendation for a new plugin in 2026:** target `@elizaos/core@^1.x` (`1.7.2`) and `@elizaos/cli@^1.x`; scaffold with `elizaos create --type plugin`. Pin a specific `@elizaos/core` version and check its `.d.ts` before relying on any advanced/`main`-only field.

### Things that remain genuinely uncertain across sections

- **Exact `priority` numeric ordering** for non-SQL plugins (the docs assert higher-first, but the database adapter loads earliest via a special-cased path; the band values like "database -100 / model -50 / core 0" appear in a docs illustration and may be illustrative, not literal).
- **Exact dependency-resolution/topological-sort location** — the runtime iterates `characterPlugins` in array order; ordering/expansion happens upstream in the CLI/server loader, but the precise function was not pinned to a primary source.
- **Precise `composeState` positional parameter names/order** (`includeList`/`onlyInclude`/`skipCache`) have shifted across releases — confirm against your installed version.
- **Published-`1.7.2` vs `main` signature drift** for `Handler` (`| void`), `Validator` (4th param), `HandlerCallback` (2nd param name), `GenerateTextParams` (`prompt` optionality), and `Plugin.adapter` (instance vs factory). Where this doc shows a published `1.7.2` shape and a `main` delta, the `main` shape is unreleased.
- **`agentConfig` shape** — live scaffold uses `{ pluginType, pluginParameters }`; the publish docs show a capabilities-array form. Whether both are supported/merged is unconfirmed.
- **Whether `elizaos publish`'s registry PR now targets the in-monorepo `packages/registry`** (vs. the archived standalone repo) — the move is confirmed but the publish command's updated target was not read from code.
- **Exact verbatim v0.x field lists** (e.g. whether the v0 `Plugin` had `adapters?: Adapter[]`) — the migration-doc facts (clients→services, scope change) are confirmed, but some precise v0 field sets are from prior knowledge, not freshly fetched source (v0 git tags returned 404).

---

## Sources

- ElizaOS Docs — Plugin Architecture: https://docs.elizaos.ai/plugins/architecture
- ElizaOS Docs — Plugin Reference: https://docs.elizaos.ai/plugins/reference
- ElizaOS Docs — Plugin Components: https://docs.elizaos.ai/plugins/components
- ElizaOS Docs — Plugin Patterns: https://docs.elizaos.ai/plugins/patterns
- ElizaOS Docs — Plugin Development: https://docs.elizaos.ai/plugins/development
- ElizaOS Docs — Plugin Migration (v0→v1): https://docs.elizaos.ai/plugins/migration
- ElizaOS Docs — Database Schema: https://docs.elizaos.ai/plugins/schemas
- ElizaOS Docs — Webhooks and Routes: https://docs.elizaos.ai/plugins/webhooks-and-routes
- ElizaOS Docs — Core Runtime: https://docs.elizaos.ai/runtime/core
- ElizaOS Docs — Providers: https://docs.elizaos.ai/runtime/providers
- ElizaOS Docs — Services: https://docs.elizaos.ai/runtime/services
- ElizaOS Docs — Model Management: https://docs.elizaos.ai/runtime/models
- ElizaOS Docs — Events: https://docs.elizaos.ai/runtime/events
- ElizaOS Docs — Types Reference: https://docs.elizaos.ai/runtime/types-reference
- ElizaOS Docs — Plugin System Overview: https://docs.elizaos.ai/plugin-registry/overview
- ElizaOS Docs — Create a Plugin: https://docs.elizaos.ai/guides/create-a-plugin
- ElizaOS Docs — Test a Project: https://docs.elizaos.ai/guides/test-a-project
- ElizaOS Docs — CLI Reference Overview: https://docs.elizaos.ai/cli-reference/overview
- ElizaOS Docs — `elizaos publish`: https://docs.elizaos.ai/cli-reference/publish
- ElizaOS Docs — `elizaos plugins`: https://docs.elizaos.ai/cli-reference/plugins
- ElizaOS Docs — Telegram Plugin Developer Guide: https://docs.elizaos.ai/plugin-registry/platform/telegram/developer-guide
- GitHub — elizaOS/eliza (monorepo): https://github.com/elizaOS/eliza
- GitHub — packages/core/src/types/plugin.ts: https://github.com/elizaOS/eliza/blob/main/packages/core/src/types/plugin.ts
- GitHub — packages/core/src/types/components.ts: https://github.com/elizaOS/eliza/blob/main/packages/core/src/types/components.ts
- GitHub — packages/core/src/types/service.ts: https://github.com/elizaOS/eliza/blob/main/packages/core/src/types/service.ts
- GitHub — packages/core/src/types/runtime.ts: https://github.com/elizaOS/eliza/blob/main/packages/core/src/types/runtime.ts
- GitHub — packages/core/src/types/model.ts: https://github.com/elizaOS/eliza/blob/main/packages/core/src/types/model.ts
- GitHub — packages/core/src/types/events.ts: https://github.com/elizaOS/eliza/blob/main/packages/core/src/types/events.ts
- GitHub — packages/core/src/types/state.ts: https://github.com/elizaOS/eliza/blob/main/packages/core/src/types/state.ts
- GitHub — packages/core/src/types/evaluator.ts (v2 redesign): https://github.com/elizaOS/eliza/blob/main/packages/core/src/types/evaluator.ts
- GitHub — packages/core/src/types/testing.ts: https://github.com/elizaOS/eliza/blob/main/packages/core/src/types/testing.ts
- GitHub — packages/core/src/types/task.ts: https://github.com/elizaOS/eliza/blob/develop/packages/core/src/types/task.ts
- GitHub — packages/core/src/runtime.ts (registerPlugin, getSetting, composeState, getService, runPluginMigrations): https://github.com/elizaOS/eliza/blob/main/packages/core/src/runtime.ts
- GitHub — packages/core/src/actions.ts: https://github.com/elizaOS/eliza/blob/main/packages/core/src/actions.ts
- GitHub — packages/core/src/features/basic-capabilities/providers/currentTime.ts: https://github.com/elizaOS/eliza/blob/main/packages/core/src/features/basic-capabilities/providers/currentTime.ts
- GitHub — packages/elizaos/templates/plugin (package.json, src/index.ts, src/plugin.ts, build.ts): https://github.com/elizaOS/eliza/tree/main/packages/elizaos/templates/plugin
- GitHub — packages/registry (README, entries, schema, generated-registry.json): https://github.com/elizaOS/eliza/tree/main/packages/registry
- GitHub — registry schema/registry-entry.schema.json: https://github.com/elizaOS/eliza/blob/develop/packages/registry/schema/registry-entry.schema.json
- GitHub — registry src/schema.ts: https://github.com/elizaOS/eliza/blob/develop/packages/registry/src/schema.ts
- GitHub — registry entries/third-party/blackwall-eliza-guardrail.json: https://github.com/elizaOS/eliza/blob/develop/packages/registry/entries/third-party/blackwall-eliza-guardrail.json
- GitHub — plugins/plugin-browser (BrowserService): https://github.com/elizaOS/eliza/blob/main/plugins/plugin-browser/src/browser-service.ts
- GitHub — plugins/plugin-polymarket actions: https://github.com/elizaOS/eliza/blob/main/plugins/plugin-polymarket/src/actions.ts
- GitHub — elizaOS/eliza#8173 (registry moved in-repo): https://github.com/elizaOS/eliza/issues/8173
- GitHub — elizaos-plugins/registry (archived): https://github.com/elizaos-plugins/registry
- GitHub — elizaos-plugins/plugin-bootstrap (REFLECTION evaluator): https://github.com/elizaos-plugins/plugin-bootstrap
- npm — @elizaos/core (dist-tags: latest 1.7.2, beta 2.0.3-beta.7, alpha 2.0.0-alpha.537, next 2.0.0-alpha.32): https://www.npmjs.com/package/@elizaos/core
- npm — @elizaos/core@1.7.2 runtime.d.ts: https://cdn.jsdelivr.net/npm/@elizaos/core@1.7.2/dist/types/runtime.d.ts
- npm — @elizaos/core@1.7.2 model.d.ts: https://cdn.jsdelivr.net/npm/@elizaos/core@1.7.2/dist/types/model.d.ts
- npm — @elizaos/core@1.7.2 database.d.ts: https://cdn.jsdelivr.net/npm/@elizaos/core@1.7.2/dist/types/database.d.ts
- npm — @elizaos/core@1.7.2 plugin.d.ts: https://cdn.jsdelivr.net/npm/@elizaos/core@1.7.2/dist/types/plugin.d.ts
- npm — @elizaos/core 1.7.2 tarball (dist/types/components.d.ts, service.d.ts, events.d.ts): https://registry.npmjs.org/@elizaos/core/-/core-1.7.2.tgz
- npm — @elizaos/cli (latest 1.7.2): https://www.npmjs.com/package/@elizaos/cli
- npm — @elizaos/plugin-bootstrap: https://www.npmjs.com/package/@elizaos/plugin-bootstrap
- npm — @elizaos/plugin-openai (1.6.0): https://www.npmjs.com/package/@elizaos/plugin-openai
- npm — @elizaos/plugin-sql (1.7.2): https://www.npmjs.com/package/@elizaos/plugin-sql
- npm — @elizaos/plugin-starter: https://www.npmjs.com/package/@elizaos/plugin-starter
- npm — @elizaos/plugin-solana: https://registry.npmjs.org/@elizaos/plugin-solana
- npm — @elizaos/plugin-telegram: https://www.npmjs.com/package/@elizaos/plugin-telegram
- npm registry — @elizaos/core (404 check for @elizaos/eliza): https://registry.npmjs.org/@elizaos%2Fcore
- npm registry — @ai16z/eliza (legacy v0, latest 0.1.6): https://registry.npmjs.org/@ai16z%2Feliza