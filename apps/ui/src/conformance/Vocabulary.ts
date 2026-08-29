/*
 * The vocabularies the application owns, derived from the application.
 *
 * Every set here is computed from product source or from the running app. None
 * is hand-listed: a hand-listed expectation goes stale at exactly the rename
 * this pin exists to catch, so it would reintroduce the defect one level up.
 */
import type { StorageApi } from "@tanstack/db"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Card } from "smithers-shared/Cards"
import { CardSchema } from "smithers-shared/Cards"
import ts from "typescript"
import { adminFlows, baseFlows, type CommandActions } from "../mainview/flows/Flows"
import { nameOf } from "../mainview/flows/registry"
import type { NativeAgent, NativeRepositories } from "../mainview/native/NativeBridge"
import { createAppController } from "../mainview/state/AppController"
import { createAppStore } from "../mainview/state/AppStore"
import { DOTTED_IDENTIFIER, extractLiterals, ID_PREFIX, segmentsOf, sourceFiles } from "./Literals"

const from = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url))

/** `apps/ui`. */
export const UI_APP = from("../../")
/** `apps/ui/src`. */
export const UI_SRC = from("../")
/** `apps/ui/scripts` — the standalone e2e and live-check runners. */
export const SCRIPTS = from("../../scripts")
/** `apps/ui/e2e` — the hermetic harness and its suites. */
export const E2E = from("../../e2e")
/** `apps/ui/src/launch-checklist` — the canary checklist's probes and rows. */
export const LAUNCH_CHECKLIST = from("../launch-checklist")
/** This directory. */
export const CONFORMANCE = from(".")
/** `apps/shared/src` — the wire model both halves of the app share. */
export const SHARED_SRC = from("../../../shared/src")
/** The shipped component library the app renders through. */
export const COMPONENT_LIBRARY = from("../../node_modules/@smthrs/ui/src")

/**
 * Product source: everything the app is built from, minus the trees under
 * test. Excluding the checklist and this directory is what makes the presence
 * rule mean "the app still uses this name" rather than "some test still
 * mentions it".
 */
export const productSourceFiles = (): ReadonlyArray<string> =>
  [
    // The app's own top-level config (electrobun.config.ts, vite.config.ts)
    // declares product identity, the macOS bundle id included, so it counts
    // as product source for "does the app own this name".
    ...readdirSync(UI_APP, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => join(UI_APP, entry.name)),
    ...sourceFiles(UI_SRC),
    ...sourceFiles(SHARED_SRC)
  ].filter((file) => !file.startsWith(LAUNCH_CHECKLIST) && !file.startsWith(CONFORMANCE))

/**
 * The words card kinds and card-id prefixes are built from. A runner's own id
 * prefix borrows none of them; an id the app is meant to recognise borrows at
 * least one.
 */
export const idVocabularySegments = (): ReadonlySet<string> => {
  const segments = new Set<string>()
  for (const name of [...cardKinds(), ...cardIdPrefixes()]) {
    for (const segment of segmentsOf(name)) segments.add(segment)
  }
  return segments
}

/*
 * Card kinds, straight off the discriminated union the wire model declares.
 * `Card` is `z.infer<typeof CardSchema>`, so the runtime options and the
 * compile-time union are the same declaration read two ways; the type-level
 * assertion below refuses to compile if that ever stops being true.
 */
type DerivedCardKind = (typeof CardSchema.options)[number]["shape"]["kind"]["value"]
const _derivedKindsAreExactlyCardKinds: DerivedCardKind extends Card["kind"]
  ? Card["kind"] extends DerivedCardKind ? true
  : never
  : never = true
void _derivedKindsAreExactlyCardKinds

/** Every card kind the wire model declares. */
export const cardKinds = (): ReadonlySet<Card["kind"]> =>
  new Set(CardSchema.options.map((option) => option.shape.kind.value))

/**
 * The property names every card in the wire model carries besides `kind`.
 *
 * `kind` is not a card's word. A stream delta has one, a store config has one,
 * half the wire model has one, so a literal under a `kind:` property is only a
 * card kind when the object around it looks like a card. These are the names
 * that decide it, and they come off `CardSchema` so the test that reads them
 * cannot drift from the model the way a hand-written list would.
 */
export const cardObjectFields = (): ReadonlySet<string> => {
  const shared = CardSchema.options.map((option) => new Set(Object.keys(option.shape)))
  const [first, ...rest] = shared
  if (first === undefined) return new Set()
  return new Set(
    [...first].filter((field) => field !== "kind" && rest.every((option) => option.has(field)))
  )
}

/*
 * Flow names, twice over.
 *
 * `declaredFlowNames` reads the declarations, including the admin plugin that
 * registers only for an admin session. `manifestFlowNames` boots the real
 * store and controller and reads `controller.commands.all()` — the same
 * expression `App.tsx` renders into `data-flows`, so it is literally what the
 * DOM contains. The manifest is the stronger source; the declarations are the
 * superset a suite driving an admin session may legitimately assert against.
 */
const declarationStub = (): CommandActions => new Proxy({}, { get: () => () => undefined }) as unknown as CommandActions

export const declaredFlowNames = (): ReadonlySet<string> =>
  new Set([...baseFlows(declarationStub()), ...adminFlows(declarationStub())].map(nameOf))

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const absentAgent: NativeAgent = {
  available: false,
  startTurn: async () => ({ status: "error", message: "no native agent in the conformance pin" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}

const absentRepositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({
    status: "error",
    code: "native-required",
    message: "no native bridge in the conformance pin"
  })
}

/** The command manifest `App.tsx` renders into `data-flows`, read the same way. */
export const manifestFlowNames = async (): Promise<ReadonlySet<string>> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, absentRepositories, absentAgent)
  return new Set(controller.commands.all().map((command) => command.name))
}

/**
 * Every `data-*` attribute the rendered DOM can carry. There are three ways to
 * put one there and all three are read: a JSX attribute, a `setAttribute`
 * call, and a `dataset` property write. Sources are the app's own components
 * and the component library the app renders through — a CDP selector naming
 * anything else matches nothing, which is exactly what seventeen stale
 * `data-command` selectors did after the rename.
 */
export const emittedDataAttributes = (): ReadonlySet<string> => {
  const emitted = new Set<string>()
  for (const file of [...sourceFiles(UI_SRC), ...sourceFiles(COMPONENT_LIBRARY)]) {
    const parsed = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.ESNext,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    )
    const visit = (node: ts.Node): void => {
      if (ts.isJsxAttribute(node)) {
        // TypeScript keeps a hyphenated JSX attribute name as an
        // identifier node, so the source text is the attribute name.
        const name = node.name.getText(parsed)
        if (name.startsWith("data-")) emitted.add(name)
      }
      if (
        ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === "setAttribute"
      ) {
        const first = node.arguments[0]
        if (first !== undefined && ts.isStringLiteral(first) && first.text.startsWith("data-")) {
          emitted.add(first.text)
        }
      }
      // `element.dataset.toastStatus = x` renders as `data-toast-status`.
      if (
        ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isPropertyAccessExpression(node.left)
        && ts.isPropertyAccessExpression(node.left.expression)
        && node.left.expression.name.text === "dataset"
      ) {
        emitted.add(`data-${node.left.name.text.replace(/[A-Z]/g, (upper) => `-${upper.toLowerCase()}`)}`)
      }
      ts.forEachChild(node, visit)
    }
    visit(parsed)
  }
  return emitted
}

/**
 * The `data-*` attributes a suite stamps onto the page itself.
 *
 * A browser suite may mark the elements it found (`owner.setAttribute(
 * "data-e2e-ring", …)`) and read them back a step later. Those markers are the
 * suite's own, so they belong in the attribute vocabulary — but only because
 * the suite is seen writing them. A selector for an attribute nobody writes,
 * which is what seventeen `data-command` selectors were, still fails.
 *
 * The scan is over raw text because the writes live inside CDP expression
 * strings, where there is no AST to walk.
 */
export const stampedDataAttributes = (trees: ReadonlyArray<string>): ReadonlySet<string> => {
  const stamped = new Set<string>()
  const write = /(?:setAttribute\(\s*\\?["']|dataset\.)([A-Za-z][\w-]*)/g
  for (const file of trees.flatMap((tree) => [...sourceFiles(tree)])) {
    for (const match of readFileSync(file, "utf8").matchAll(write)) {
      const name = match[1] ?? ""
      const attribute = name.startsWith("data-")
        ? name
        : `data-${name.replace(/[A-Z]/g, (upper) => `-${upper.toLowerCase()}`)}`
      if (name.startsWith("data-") || !name.includes("-")) stamped.add(attribute)
    }
  }
  return stamped
}

/**
 * Every dotted identifier the product source spells as a literal: flow names,
 * transition types, stream frame types, toast keys. A dotted literal in a test
 * tree that is in no product source file names nothing — `workflow.create`
 * after the rename.
 */
export const productDottedIdentifiers = (): ReadonlySet<string> => {
  const owned = new Set<string>()
  for (const file of productSourceFiles()) {
    for (const literal of extractLiterals(file, readFileSync(file, "utf8"))) {
      if (literal.form === "string" && DOTTED_IDENTIFIER.test(literal.value)) owned.add(literal.value)
    }
  }
  return owned
}

/**
 * The card-id prefixes the app builds. A card id is assembled as
 * `` `flow-run-${runId}` `` (AppController), so the prefix is the static head
 * of a template in product source.
 */
export const cardIdPrefixes = (): ReadonlySet<string> => {
  const prefixes = new Set<string>()
  for (const file of productSourceFiles()) {
    for (const literal of extractLiterals(file, readFileSync(file, "utf8"))) {
      if (literal.form === "template-head" && ID_PREFIX.test(literal.value)) prefixes.add(literal.value)
    }
  }
  return prefixes
}
