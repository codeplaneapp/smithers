/**
 * The prompts EDITOR domain: the pure discovery and render functions the editor
 * canvas leans on, plus an OFFLINE fallback prompt list. The live prompts come
 * from the gateway `listPrompts` RPC (the `.smithers/prompts/**.{md,mdx}` files
 * on disk), pushed into the store by `PromptsBridge`; this module no longer
 * carries in-app seed data — `OFFLINE_SEED_PROMPTS` is a graceful-degradation
 * fallback shown ONLY when the gateway link is unreachable (see PromptsBridge),
 * not demo data.
 *
 * Inputs are NOT stored on a prompt: they are DISCOVERED from `source` by the
 * pure `discoverInputs` fn, exactly like the GUI re-discovers on every edit. The
 * preview is a pure `{props.NAME}` substitution. Everything below is pure, so
 * discovery / render / dirty-checks are unit-tested without a DOM (see
 * promptsDomain.test.ts).
 */

/** One prompt file: an id, the entry file it lives at, and its raw source text. */
export type Prompt = {
  id: string;
  entryFile: string;
  source: string;
};

/** A discovered input: a name, its declared type (default 'string'), and a default value. */
export type Input = {
  name: string;
  type: string;
  default: string;
};

/** A discovered import / MDX component tag pulled out of the source text. */
export type Import = {
  /** The imported identifier or the component tag name. */
  name: string;
  /** The module path it resolves to ('—' for a component tag with no import). */
  path: string;
};

/**
 * OFFLINE FALLBACK ONLY — a tiny, fixed set of prompts shown when the gateway
 * link is unreachable so `/prompts` degrades to a readable, browsable surface
 * instead of an empty "No prompts found" view. This is graceful degradation, NOT
 * in-app seed data: the moment the live `listPrompts` RPC resolves (even to an
 * empty list), `PromptsBridge` replaces this with the real on-disk prompts. It is
 * never written back and never merged with live rows.
 */
export const OFFLINE_SEED_PROMPTS: Prompt[] = [
  {
    id: "refactor",
    entryFile: "prompts/refactor.mdx",
    source:
      "---\n" +
      "name: Refactor\n" +
      "inputs:\n" +
      "  - name: target\n" +
      "    type: string\n" +
      "    default: src/index.ts\n" +
      "  - name: constraints\n" +
      "    type: string\n" +
      "---\n" +
      "Refactor {props.target} for clarity.\n" +
      "Keep behaviour identical; honor: {props.constraints}.\n",
  },
  {
    id: "review",
    entryFile: "prompts/review.mdx",
    source:
      'import Guidelines from "./guidelines.mdx";\n' +
      'import { Rubric } from "../components/Rubric";\n' +
      "\n" +
      "<Guidelines />\n" +
      "\n" +
      "Review the diff on {props.branch} against {props.base}.\n" +
      "<Rubric strictness={props.strictness} focus={props.focus} />\n",
  },
  {
    id: "summarize",
    entryFile: "prompts/summarize.mdx",
    source:
      "---\n" +
      "name: Summarize run\n" +
      "inputs:\n" +
      "  - name: runId\n" +
      "    type: string\n" +
      "    default: 4821a0c3\n" +
      "  - name: tone\n" +
      "    type: string\n" +
      "    default: concise\n" +
      "---\n" +
      "Summarize run {props.runId} in a { props.tone } tone for the changelog.\n",
  },
  {
    id: "triage",
    entryFile: "prompts/triage.mdx",
    source:
      "Triage incoming issue {props.issue}.\n" +
      "Assign a priority and a label; no inputs are declared in frontmatter here.\n",
  },
];

/**
 * Slice the YAML frontmatter block (between the leading `---` and the next
 * `---`), returning its body lines. Returns an empty array when the source has
 * no frontmatter, so callers can treat "no frontmatter" as "no declared inputs".
 */
function frontmatterLines(source: string): string[] {
  const lines = source.split("\n");
  if (lines[0]?.trim() !== "---") return [];
  const end = lines.indexOf("---", 1);
  if (end === -1) return [];
  return lines.slice(1, end);
}

/**
 * Parse `inputs:` list entries out of the frontmatter. Each entry is a YAML
 * list item (`- name: x`) optionally followed by indented `type:`/`default:`
 * keys, e.g.
 *
 *   inputs:
 *     - name: target
 *       type: string
 *       default: src/index.ts
 *
 * Returns one Input per `- name:` item, defaulting the type to 'string' and the
 * default value to '' when omitted.
 */
function frontmatterInputs(source: string): Input[] {
  const lines = frontmatterLines(source);
  const start = lines.findIndex((line) => line.trim() === "inputs:");
  if (start === -1) return [];
  const inputs: Input[] = [];
  let current: Input | null = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    // A top-level key (no indentation) ends the inputs block.
    if (/^\S/.test(line) && line.trim() !== "") break;
    const item = line.match(/^\s*-\s*name:\s*(.+?)\s*$/);
    if (item) {
      if (current) inputs.push(current);
      current = { name: item[1], type: "string", default: "" };
      continue;
    }
    if (!current) continue;
    const type = line.match(/^\s*type:\s*(.+?)\s*$/);
    if (type) {
      current.type = type[1];
      continue;
    }
    const def = line.match(/^\s*default:\s*(.+?)\s*$/);
    if (def) current.default = def[1];
  }
  if (current) inputs.push(current);
  return inputs;
}

/** The body of the source, i.e. everything after a (possibly absent) frontmatter block. */
function sourceBody(source: string): string {
  const lines = source.split("\n");
  if (lines[0]?.trim() !== "---") return source;
  const end = lines.indexOf("---", 1);
  if (end === -1) return source;
  return lines.slice(end + 1).join("\n");
}

/** Matches `{props.NAME}` allowing optional inner whitespace, capturing NAME. */
const INTERP = /\{\s*props\.([A-Za-z_$][\w$]*)\s*\}/g;
/** Matches an MDX prop binding `prop={props.NAME}` inside a component tag. */
const MDX_PROP = /\b([A-Za-z_$][\w$]*)\s*=\s*\{\s*props\.([A-Za-z_$][\w$]*)\s*\}/g;
/** Matches a pass-through MDX prop `prop={prop}` (no `props.` prefix). */
const MDX_PASSTHROUGH = /\b([A-Za-z_$][\w$]*)\s*=\s*\{\s*([A-Za-z_$][\w$]*)\s*\}/g;

/**
 * Discover the inputs a prompt declares, in the GUI's precedence/order:
 *   (1) YAML frontmatter `inputs:` entries (name/type/default),
 *   (2) body `{props.NAME}` interpolations,
 *   (3) MDX component props (`<Tag prop={props.NAME} />` and pass-through
 *       `prop={prop}` where the bound identifier becomes the input name).
 * De-duplicated by name, preserving first-seen order; default type is 'string'.
 *
 * Ported from `discoverPromptInputs`. Pure: the canvas re-runs it on every edit.
 */
export function discoverInputs(source: string): Input[] {
  const seen = new Set<string>();
  const inputs: Input[] = [];
  const push = (input: Input) => {
    if (seen.has(input.name)) return;
    seen.add(input.name);
    inputs.push(input);
  };

  // (1) Frontmatter declarations win first, keeping their declared type/default.
  for (const input of frontmatterInputs(source)) push(input);

  const body = sourceBody(source);

  // (2) Plain `{props.NAME}` interpolations in the body.
  for (const match of body.matchAll(INTERP)) {
    push({ name: match[1], type: "string", default: "" });
  }

  // (3) MDX component props: `prop={props.NAME}` (name = the bound props key),
  //     then pass-through `prop={prop}` (name = the bound identifier). Run the
  //     explicit-props pass first so a `props.x` binding wins over a same-named
  //     pass-through.
  for (const match of body.matchAll(MDX_PROP)) {
    push({ name: match[2], type: "string", default: "" });
  }
  for (const match of body.matchAll(MDX_PASSTHROUGH)) {
    // Skip the `props.`-prefixed form already captured by MDX_PROP / INTERP.
    if (match[2] === "props") continue;
    push({ name: match[2], type: "string", default: "" });
  }

  return inputs;
}

/** Matches an ES import statement, capturing the imported clause and the module path. */
const IMPORT = /^\s*import\s+(.+?)\s+from\s+["']([^"']+)["']/gm;
/** Matches an MDX component open/self-closing tag, capturing the (Capitalized) tag name. */
const MDX_TAG = /<([A-Z][\w]*)\b/g;

/**
 * Discover the imports a prompt pulls in: every ES `import … from "…"` plus any
 * MDX component tag (`<Component …>`). De-duplicated by name, import statements
 * first (in source order), then component tags that were not already imported.
 * A component tag with no matching import resolves its path to '—'. Pure, so the
 * Imports tab is derived entirely from the source text.
 */
export function discoverImports(source: string): Import[] {
  const seen = new Set<string>();
  const imports: Import[] = [];

  for (const match of source.matchAll(IMPORT)) {
    const clause = match[1].trim();
    const path = match[2];
    // `import Foo from`, `import { A, B } from`, `import Foo, { A } from`.
    const names = clause
      .replace(/[{}]/g, " ")
      .split(",")
      .map((part) =>
        part
          .trim()
          .split(/\s+as\s+/)
          .pop()!
          .trim(),
      )
      .filter((part) => part.length > 0);
    for (const name of names) {
      if (seen.has(name)) continue;
      seen.add(name);
      imports.push({ name, path });
    }
  }

  for (const match of source.matchAll(MDX_TAG)) {
    const name = match[1];
    if (seen.has(name)) continue;
    seen.add(name);
    imports.push({ name, path: "—" });
  }

  return imports;
}

/**
 * Render the prompt by substituting every `{props.NAME}` occurrence (optional
 * inner whitespace) with that input's current value. An unfilled input falls
 * back to its discovered default, then to a visible `{NAME}` placeholder so the
 * preview reads honestly. Pure, deterministic, and parity-correct with discovery
 * (the whitespace variant `{ props.name }` is substituted, not left raw).
 *
 * Ported from `renderPreviewAfterDebounce`'s substitution step.
 */
export function renderPreview(source: string, values: Record<string, string>): string {
  const defaults = defaultValues(discoverInputs(source));
  return source.replace(INTERP, (_match, name: string) => {
    const typed = values[name];
    if (typed != null && typed.trim() !== "") return typed;
    const def = defaults[name];
    if (def != null && def !== "") return def;
    return `{${name}}`;
  });
}

/** The default value map for a set of inputs (name → default), used to seed values. */
export function defaultValues(inputs: Input[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const input of inputs) out[input.name] = input.default;
  return out;
}

/**
 * Whether the typed input values diverge from the discovered defaults — drives
 * the amber unsaved-dot on the Inputs tab. An input counts as changed when its
 * typed value is present and differs from its default. Ported from
 * `hasInputValueChanges`.
 */
export function hasInputValueChanges(values: Record<string, string>, inputs: Input[]): boolean {
  return inputs.some((input) => {
    const typed = values[input.name];
    return typed != null && typed !== input.default;
  });
}

/** A prompt's headline counts for the surface-sub (entry file · N inputs). */
export function summarize(prompt: Prompt): { entryFile: string; inputCount: number } {
  return { entryFile: prompt.entryFile, inputCount: discoverInputs(prompt.source).length };
}
