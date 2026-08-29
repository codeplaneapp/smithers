import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { AppBootstrap } from "smithers-shared/AppBootstrap"
import type { NativeAgent, NativeRepositories } from "../native/NativeBridge"
import { createAppController } from "../state/AppController"
import { PALETTES } from "../state/AppState"
import { createAppStore } from "../state/AppStore"
import { executeAgentToolCall } from "./agentTools"
import { visibleItems } from "./Commands"
import { canonical, matches, parseSubmit, recommendedNames, SLASH_MENU_CAP, slashItems } from "./registry"
import type { CommandState } from "./registry"

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const unavailableAgent: NativeAgent = {
  available: false,
  startTurn: async () => ({ status: "error", message: "unavailable" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}

const unavailableRepositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({
    status: "error",
    code: "native-required",
    message: "Local repositories can only be connected from the Smithers native app."
  })
}

const freshController = async (bootstrap?: AppBootstrap) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  return {
    store,
    controller: createAppController(store, unavailableRepositories, unavailableAgent, { bootstrap })
  }
}

const chatState: CommandState = {
  surface: "chat",
  typing: false,
  hasConnectors: false,
  admin: false,
  needsSelection: false,
  signedOut: false
}

describe("command registry pure model", () => {
  test("connect leads the recommendations until work is connected", () => {
    expect(recommendedNames(chatState)[0]).toBe("connect")
    expect(recommendedNames({ ...chatState, hasConnectors: true })[0]).toBe("world")
    expect(recommendedNames({ ...chatState, surface: "world" })[0]).toBe("chat")
    expect(recommendedNames({ ...chatState, typing: true })).toEqual(["chat.stop"])
  })

  test("an unmade watched-repos selection leads; signed-out, sign-in is the only step", () => {
    expect(recommendedNames({ ...chatState, needsSelection: true })[0]).toBe("repos.watch")
    expect(recommendedNames({ ...chatState, signedOut: true })).toEqual(["auth.sign-in"])
    // Typing still outranks everything.
    expect(recommendedNames({ ...chatState, signedOut: true, typing: true })).toEqual(["chat.stop"])
  })

  test("aliases resolve to their canonical target", () => {
    const commands = [{ name: "theme", summary: "" }, { name: "dark-mode", summary: "", aliasOf: "theme" }]
    expect(canonical("dark-mode", commands)).toBe("theme")
    expect(canonical("theme", commands)).toBe("theme")
    expect(canonical("unknown", commands)).toBe("unknown")
  })

  test("slash filtering matches name and summary, case-insensitively", () => {
    const command = { name: "connect", summary: "Connect work to Smithers" }
    expect(matches(command, "con")).toBe(true)
    expect(matches(command, "WORK")).toBe(true)
    expect(matches(command, "zzz")).toBe(false)
    expect(matches(command, "")).toBe(true)
  })

  test("a needle that names a flow exactly leads the listing, ahead of a summary match", () => {
    // The shape of the real defect: /flows listed flow.list first, because
    // its summary reads "List the workflows on your workspace" and it is
    // declared earlier in the registry than the flow actually named `flows`.
    const commands = [
      { name: "flow.list", summary: "List the workflows on your workspace" },
      { name: "flows", summary: "List everything Smithers can do" }
    ]
    const items = slashItems(chatState, "flows", commands)
    expect(items.map((item) => item.flow.name)).toEqual(["flows", "flow.list"])
  })

  test("a name match outranks a summary-only match, even when the summary match is recommended", () => {
    const commands = [
      // `connect` is chatState's leading recommendation, and its summary
      // happens to carry the needle. A name match still leads.
      { name: "connect", summary: "Connect the repos you work in" },
      { name: "repos.watch", summary: "Choose what to watch" },
      { name: "repos.list", summary: "Show them" }
    ]
    expect(slashItems(chatState, "repos", commands).map((item) => item.flow.name)).toEqual([
      "repos.watch",
      "repos.list",
      "connect"
    ])
  })

  test("an exact name outranks the recommendation, which still leads a bare /", () => {
    const commands = [
      { name: "connect", summary: "Connect work to Smithers" },
      { name: "keys", summary: "Your connected keys" }
    ]
    // connect is chatState's recommendation; naming keys beats it.
    expect(slashItems(chatState, "", commands)[0]?.flow.name).toBe("connect")
    const named = slashItems(chatState, "keys", commands)
    expect(named[0]?.flow.name).toBe("keys")
    expect(named[0]?.recommended).toBe(false)
    // Naming the recommendation itself keeps it flagged as one.
    expect(slashItems(chatState, "connect", commands)[0]).toEqual({
      flow: commands[0],
      recommended: true
    })
  })

  test("the exact match is never listed twice", () => {
    const commands = [
      { name: "connect", summary: "Connect work to Smithers" },
      { name: "connectors", summary: "Manage connectors" }
    ]
    const items = slashItems(chatState, "connect", commands)
    expect(items.map((item) => item.flow.name)).toEqual(["connect", "connectors"])
  })

  test("the slash listing puts the recommended command first", () => {
    const commands = [
      { name: "world", summary: "w" },
      { name: "connect", summary: "c" }
    ]
    const items = slashItems(chatState, "", commands)
    expect(items[0]?.flow.name).toBe("connect")
    expect(items[0]?.recommended).toBe(true)
    expect(items.filter((item) => item.recommended)).toHaveLength(2)
  })

  /*
   * §1.2: signed out, the listing offers only what works signed out. The
   * flows that need a session stay INVOKABLE — typing one defers through
   * sign-in (§6.2) — they are just not presented as available.
   */
  test("the signed-out listing offers nothing that needs a session", () => {
    const commands = [
      { name: "auth.sign-in", summary: "Sign in with GitHub" },
      { name: "auth.sign-out", summary: "Sign out", requires: ["signed-in"] },
      { name: "issues.create", summary: "Create an issue", requires: ["signed-in"] },
      { name: "world", summary: "What Smithers understands" }
    ]
    const signedOut = slashItems({ ...chatState, signedOut: true }, "", commands)
    expect(signedOut.map((item) => item.flow.name)).toEqual(["auth.sign-in", "world"])
    const signedIn = slashItems(chatState, "", commands)
    expect(signedIn.map((item) => item.flow.name)).toContain("issues.create")
  })

  describe("the slash menu caps at SLASH_MENU_CAP", () => {
    // 20 flows named a0..a19, all prefix-matching "a" and all containing "a".
    const many = Array.from({ length: 20 }, (_, index) => ({
      name: `a${index}`,
      summary: `Flow number ${index}`
    }))

    test("a bare / lists at most the cap, not every registered flow", () => {
      expect(many.length).toBeGreaterThan(SLASH_MENU_CAP)
      expect(slashItems(chatState, "", many).length).toBe(SLASH_MENU_CAP)
    })

    test("a prefix query is capped too — a prefix names a set, not a flow", () => {
      expect(slashItems(chatState, "a", many).length).toBe(SLASH_MENU_CAP)
    })

    test("a flow named outright is never cut", () => {
      const named = slashItems(chatState, "a19", many)
      expect(named.length).toBeLessThanOrEqual(SLASH_MENU_CAP)
      expect(named[0]?.flow.name).toBe("a19")
    })

    test("a recommendation survives the cap and still leads a bare /", () => {
      const withRecommendation = [{ name: "connect", summary: "Connect work to Smithers" }, ...many]
      const items = slashItems(chatState, "", withRecommendation)
      expect(items.length).toBe(SLASH_MENU_CAP)
      expect(items[0]?.flow.name).toBe("connect")
      expect(items[0]?.recommended).toBe(true)
    })

    test("recency ranks the remainder that gets in", () => {
      const recent = slashItems({ ...chatState, recent: ["a19", "a18"] }, "", many)
      expect(recent.length).toBe(SLASH_MENU_CAP)
      expect(recent.map((item) => item.flow.name)).toContain("a19")
      expect(recent.map((item) => item.flow.name)).toContain("a18")
    })
  })

  /*
   * §6.4 vs §5.7: `data-flows` on the app shell is the whole registry
   * manifest — hidden id-scoped actions included, because the agent's tool
   * catalog is not a secret — while `/flows` is what a person can ask for.
   * The two lists differ by exactly the hidden set and by nothing else.
   */
  test("/flows and the data-flows manifest differ by exactly the hidden set", async () => {
    const { controller } = await freshController()
    const manifest = controller.commands.all().map((command) => command.name)
    const listed = visibleItems(controller.commands).map((command) => command.name)
    const hidden = controller.commands
      .all()
      .filter((command) => command.hidden === true)
      .map((command) => command.name)
    expect(hidden.length).toBeGreaterThan(0)
    expect(listed).toEqual(manifest.filter((name) => !hidden.includes(name)))
    expect(listed.some((name) => hidden.includes(name))).toBe(false)
  })

  test("parseSubmit resolves empty, bare command, args command, and prompt", () => {
    const commands = [
      { name: "world", summary: "w" },
      { name: "browser", summary: "b", args: "<url>" }
    ]
    expect(parseSubmit("", commands)).toEqual({ kind: "empty" })
    expect(parseSubmit("/", commands)).toEqual({ kind: "empty" })
    expect(parseSubmit("/world", commands)).toEqual({ kind: "command", name: "world" })
    expect(parseSubmit("/browser https://example.com", commands)).toEqual({
      kind: "command",
      name: "browser",
      args: "https://example.com"
    })
    expect(parseSubmit("/world with trailing text", commands)).toEqual({
      kind: "prompt",
      text: "/world with trailing text"
    })
    expect(parseSubmit("hello there", commands)).toEqual({ kind: "prompt", text: "hello there" })
  })

  describe("parseSubmit command boundary", () => {
    const commands = [
      { name: "goal", summary: "Set the goal", args: "<text>" },
      { name: "goal.show", summary: "Show the goal" },
      { name: "no-args", summary: "No arguments" }
    ]

    test.each(
      [
        ["", { kind: "empty" }],
        ["   \t\n", { kind: "empty" }],
        ["/", { kind: "empty" }],
        ["  /  ", { kind: "empty" }],
        ["/goal", { kind: "command", name: "goal" }],
        ["  /goal  ", { kind: "command", name: "goal" }],
        ["/goal.show", { kind: "command", name: "goal.show" }],
        ["/goal ship it", { kind: "command", name: "goal", args: "ship it" }],
        ["/goal\tship it", { kind: "command", name: "goal", args: "ship it" }],
        ["/goal\nship it", { kind: "command", name: "goal", args: "ship it" }],
        ["/goal\r\nship it", { kind: "command", name: "goal", args: "ship it" }],
        ["/goal\u00a0ship it", { kind: "command", name: "goal", args: "ship it" }],
        ["/goal   ship it   ", { kind: "command", name: "goal", args: "ship it" }],
        ["/goal first\nsecond", { kind: "command", name: "goal", args: "first\nsecond" }]
      ] as const
    )("parses %j", (input, expected) => {
      expect(parseSubmit(input, commands)).toEqual(expected)
    })

    test.each([
      "goal",
      "hello /goal",
      "//goal",
      "/Goal",
      "/GOAL",
      "/goal!",
      "/goal/child",
      "/goal..show",
      "/no-args surprise"
    ])("keeps %j as an agent prompt", (input) => {
      expect(parseSubmit(input, commands)).toEqual({ kind: "prompt", text: input.trim() })
    })

    /*
     * §23.5: flow SYNTAX that names no registered flow is the app's to
     * answer. Handing it to the model as prose is what made `/reset` on a
     * non-admin session run `retry`.
     */
    test.each([
      ["/unknown", "unknown"],
      ["/unknown words", "unknown"],
      ["/goal.show.more", "goal.show.more"],
      ["/reset", "reset"]
    ])("refuses %j by name instead of improvising", (input, name) => {
      expect(parseSubmit(input, commands)).toEqual({ kind: "unknown-command", name })
    })

    test("does not mutate the registry or depend on command order", () => {
      const reversed = [...commands].reverse()
      expect(parseSubmit("/goal.show", commands)).toEqual(parseSubmit("/goal.show", reversed))
      expect(commands.map((command) => command.name)).toEqual(["goal", "goal.show", "no-args"])
    })
  })
})

describe("§17.4 — no checkout is exposed to an MVP account", () => {
  test("an MVP session has no billing.upgrade or billing.portal at all", async () => {
    const { store, controller } = await freshController()
    store.dispatch({
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-in",
      login: "codeplanesmithers",
      allowlisted: true,
      admin: false,
      scopesPlain: null
    })
    const names = controller.commands.all().map((command) => command.name)
    expect(names).not.toContain("billing.upgrade")
    expect(names).not.toContain("billing.portal")
    // Absent, not hidden: invoking by name resolves exactly like a typo.
    expect((await controller.commands.run("billing.upgrade", "pro")).status).toBe("unknown-command")
    // The balance READ stays — knowing what you have is not a checkout.
    expect(names).toContain("billing.balance")
  })

  test("an admin session still has them, so the seam stays testable", async () => {
    const { store, controller } = await freshController()
    store.dispatch({
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-in",
      login: "will",
      allowlisted: true,
      admin: true,
      scopesPlain: null
    })
    const names = controller.commands.all().map((command) => command.name)
    expect(names).toContain("billing.upgrade")
    expect(names).toContain("billing.portal")
  })
})

describe("command registry bindings", () => {
  test("bootstrap capabilities are the single registration gate for local and cloud flows", async () => {
    const local = await freshController({
      apiVersion: 1,
      host: "local",
      version: "test",
      buildSha: "local",
      capabilities: ["local.repositories", "local.targets", "local.terminal", "local.harnesses"],
      authFlow: "none",
      sandbox: { platform: "darwin", mode: "enforced" }
    })
    const localNames = local.controller.commands.all().map((command) => command.name)
    expect(localNames).toContain("repo.open")
    expect(localNames).toContain("target.run")
    expect(localNames).toContain("tab.terminal")
    expect(localNames).not.toContain("auth.sign-in")
    expect(localNames).not.toContain("issues.list")
    expect(localNames).not.toContain("flow.run")
    expect(localNames).not.toContain("browser")

    const cloud = await freshController({
      apiVersion: 1,
      host: "cloud",
      version: "test",
      buildSha: "cloud",
      capabilities: ["agent", "identity", "jjhub"],
      authFlow: "redirect",
      sandbox: null
    })
    const cloudNames = cloud.controller.commands.all().map((command) => command.name)
    expect(cloudNames).toContain("auth.sign-in")
    expect(cloudNames).toContain("issues.list")
    expect(cloudNames).toContain("flow.run")
    expect(cloudNames).toContain("browser")
    expect(cloudNames).not.toContain("repo.open")
    expect(cloudNames).not.toContain("target.run")
    expect(cloudNames).not.toContain("tab.terminal")
    expect(cloudNames).not.toContain("keys.list")
  })

  test("every registered action executes through the one run path", async () => {
    const { store, controller } = await freshController()
    const names = controller.commands.all().map((command) => command.name)
    expect(names).toEqual([
      "connect",
      "world",
      "theme",
      "surfaces",
      "dark-mode",
      "chat",
      "retry",
      "chat.stop",
      "stop",
      "send",
      "repos.watch",
      "repos.watch.toggle",
      "repos.watch.all",
      "repos.watch.none",
      "repos.watch.confirm",
      "clear",
      "browser",
      "flow.create",
      "flow.repo.choose",
      "flow.run.stop",
      "flow.run.retry",
      "flow.list",
      "flow.run",
      "card.maximize",
      "card.minimize",
      "frame.back",
      "frame.forward",
      "frame.fork",
      "copy-message",
      "approval.approve",
      "approval.deny",
      "connector.add",
      "connector.downgrade",
      "connector.remove.ask",
      "connector.remove",
      "connector.remove.cancel",
      "world.new-note",
      "world.select",
      "world.delete",
      "world.delete.confirm",
      "world.delete.cancel",
      "auth.sign-in",
      "auth.prompt",
      "auth.sign-out",
      "auth.request-access",
      "toast.dismiss",
      "billing.balance",
      "repos.import",
      "issues.list",
      "issues.view",
      "issues.create",
      "issues.close",
      "issues.reopen",
      "issues.comment",
      "prs.list",
      "prs.view",
      "prs.create",
      "prs.land",
      "prs.review",
      // §17.4: billing.upgrade / billing.portal register in the ADMIN plugin
      // only — no checkout is exposed to an MVP account.
      "keys.list",
      "keys.remove",
      "notifications.list",
      "notifications.read",
      "env.view",
      "env.set",
      "branches.list",
      "files.list",
      "files.read",
      "repos.app",
      "reload",
      "flows",
      "tab.terminal",
      "tab.harness",
      "tab.card",
      "tab.select",
      "tab.close",
      "tab.close.confirm",
      "tab.close.cancel",
      "tab.menu",
      "repo.open",
      "target.run",
      "target.open",
      // The target-graph cards (docs/LOCAL-APP.md "Cards: target graph").
      "target.graph",
      "target.graph.focus",
      "target.timeline",
      "target.history",
      "target.runs.select",
      "target.run.scrub",
      "target.affected",
      "target.ci",
      "target.source.open"
    ])

    expect((await controller.commands.run("connect")).status).toBe("executed")
    expect(store.session().surface).toBe("connectors")
    // Toggles toggle (§2c): invoking the open pane's command returns to chat.
    expect((await controller.commands.run("connect")).status).toBe("executed")
    expect(store.session().surface).toBe("chat")
    expect((await controller.commands.run("world")).status).toBe("executed")
    expect(store.session().surface).toBe("world")
    expect((await controller.commands.run("world")).status).toBe("executed")
    expect(store.session().surface).toBe("chat")
    expect((await controller.commands.run("world")).status).toBe("executed")
    expect(store.session().surface).toBe("world")
    expect((await controller.commands.run("chat")).status).toBe("executed")
    expect(store.session().surface).toBe("chat")

    const before = store.session().theme
    expect((await controller.commands.run("dark-mode")).status).toBe("executed")
    expect(store.session().theme).not.toBe(before)

    expect((await controller.commands.run("world.new-note")).status).toBe("executed")
    const note = [...store.collections.worldDocuments.values()].find((document) => document.path.startsWith("Untitled"))
    expect(note).toBeDefined()
    // §10.6: deleting ASKS. The question is the flow's whole effect; the
    // answer is an act of its own, from the composer as from the trash button.
    expect((await controller.commands.run("world.delete", note?.id ?? "")).status).toBe("executed")
    expect(store.session().pendingWorldDeleteId).toBe(note?.id ?? "")
    expect(store.collections.worldDocuments.get(note?.id ?? "")).toBeDefined()
    expect((await controller.commands.run("world.delete.cancel")).status).toBe("executed")
    expect(store.session().pendingWorldDeleteId).toBeNull()
    expect(store.collections.worldDocuments.get(note?.id ?? "")).toBeDefined()
    expect((await controller.commands.run("world.delete", note?.id ?? "")).status).toBe("executed")
    expect((await controller.commands.run("world.delete.confirm")).status).toBe("executed")
    expect(store.collections.worldDocuments.get(note?.id ?? "")).toBeUndefined()
    expect(store.session().pendingWorldDeleteId).toBeNull()
    // Nothing waiting: answering is refused rather than guessing a target.
    expect((await controller.commands.run("world.delete.confirm")).status).toBe("failed")

    expect((await controller.commands.run("does-not-exist")).status).toBe("unknown-command")
    const failed = await controller.commands.run("connector.remove")
    expect(failed.status).toBe("failed")
  })

  test("admin commands are ABSENT for a non-admin session, present for an admin", async () => {
    const { store, controller } = await freshController()
    const names = controller.commands.all().map((command) => command.name)
    // Not hidden — absent. A non-admin session's enumeration surface has no trace.
    expect(names.some((name) => name.startsWith("admin."))).toBe(false)
    expect((await controller.commands.run("admin.health")).status).toBe("unknown-command")
    // The bare reset refresh affordance is admin-only too (§2): /reset for a
    // non-admin renders the same unknown-command state as any typo, and no
    // registry surface carries it.
    expect(names).not.toContain("reset")
    expect((await controller.commands.run("reset")).status).toBe("unknown-command")
    expect(controller.slashItems("reset")).toHaveLength(0)
    // The agent tool's list carries no trace either.
    const listed = await executeAgentToolCall(controller.commands, {
      name: "commands",
      arguments: JSON.stringify({ action: "list" })
    })
    expect(listed).not.toContain("admin.")
    expect(listed).not.toContain("\"reset\"")

    // Flip the session to admin (as a validated identity.session.loaded would).
    store.dispatch({
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-in",
      login: "will",
      allowlisted: true,
      admin: true,
      scopesPlain: null
    })
    const adminNames = controller.commands.all().map((command) => command.name)
    expect(adminNames).toContain("admin.allowlist.add")
    expect(adminNames).toContain("admin.allowlist.remove")
    expect(adminNames).toContain("admin.grant")
    expect(adminNames).toContain("admin.requests")
    expect(adminNames).toContain("admin.health")
    expect(adminNames).toContain("reset")
    expect(adminNames).toContain("admin.reset.ask")
    expect(adminNames).toContain("admin.reset.cancel")
    expect(adminNames).toContain("admin.devtools")
    expect((await controller.commands.run("admin.reset.ask")).status).toBe("executed")
    expect(store.session().resetConfirmOpen).toBe(true)
    expect((await controller.commands.run("admin.reset.cancel")).status).toBe("executed")
    expect(store.session().resetConfirmOpen).toBe(false)
    // The debug reads compose the admin-only registry + trigger axis.
    expect(adminNames).toContain("debug.snapshot")
    expect(adminNames).toContain("debug.events")
    expect(adminNames).toContain("debug.seams")
  })

  test("the trigger axis: user-only commands are invisible to and uncallable by the agent", async () => {
    const { controller } = await freshController()
    const listed = await executeAgentToolCall(controller.commands, {
      name: "commands",
      arguments: JSON.stringify({ action: "list" })
    })
    const parsed = JSON.parse(listed) as { commands: Array<{ name: string }> }
    const agentNames = parsed.commands.map((command) => command.name)
    // Browser mechanics never appear in the agent's tool catalog.
    for (
      const userOnly of [
        "auth.sign-in",
        "auth.sign-out",
        "theme",
        "dark-mode",
        "chat.stop",
        "send",
        "card.maximize"
      ]
    ) {
      expect(agentNames).not.toContain(userOnly)
    }
    expect(agentNames).toContain("connect")
    expect(agentNames).toContain("repos.watch")
    expect(agentNames).toContain("browser")

    // Asking for one anyway gets an honest tool-result error naming the
    // visible alternative — never a silent refusal, never an execution.
    const signIn = await executeAgentToolCall(controller.commands, {
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "auth.sign-in" })
    })
    expect(signIn).toContain("user-only")
    expect(signIn).toContain("button the human clicks")

    const theme = await executeAgentToolCall(controller.commands, {
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "theme" })
    })
    expect(theme).toContain("user-only")

    // The user-only guard never leaks into the user path: the human's own
    // invocation still executes.
    expect((await controller.commands.run("theme")).status).toBe("executed")
  })

  /*
   * Two commands, two axes: /theme wears a color palette and /dark-mode
   * flips light and dark. Neither is the other's alias — the toggle used to
   * hide behind /theme, and repurposing the name without promoting the
   * toggle would have left the light/dark control unreachable by name.
   */
  test("the color theme and the light/dark toggle are independent commands", async () => {
    const { store, controller } = await freshController()
    const registered = controller.commands.all()
    expect(canonical("theme", registered)).toBe("theme")
    expect(canonical("dark-mode", registered)).toBe("dark-mode")
    const toggle = controller.commands.find("dark-mode")
    expect(toggle?.metadata.aliasOf).toBeUndefined()
    expect(toggle?.metadata.hidden).toBeUndefined()
    // Listed, so the human can find the toggle in the slash menu.
    expect(controller.slashItems("dark-mode").map((item) => item.flow.name)).toContain("dark-mode")
    // The args hint is what makes `/theme <palette>` parse as an invocation.
    expect(controller.commands.find("theme")?.metadata.args).toBeDefined()

    // The default palette is night-owl, and every key round-trips.
    expect(store.session().palette).toBe("night-owl")
    for (const palette of PALETTES) {
      expect((await controller.commands.run("theme", palette)).status).toBe("executed")
      expect(store.session().palette).toBe(palette)
    }
    const last = PALETTES[PALETTES.length - 1]
    expect(store.session().palette).toBe(last)

    // An unknown key never rounds to the nearest palette: it fails honestly,
    // opens the picker (the list of valid answers IS the interface), and
    // leaves the current palette alone.
    const unknown = await controller.commands.run("theme", "dracula")
    expect(unknown.status).toBe("failed")
    if (unknown.status === "failed") expect(unknown.error).toContain("night-owl")
    expect(store.session().palette).toBe(last)
    const picker = () => store.collections.cards.get("theme-picker")
    expect(picker()?.kind).toBe("theme-picker")
    if (picker()?.kind === "theme-picker") {
      expect(picker()?.payload).toEqual({ selected: last })
    }

    // Bare /theme surfaces the picker card with the current palette marked.
    expect((await controller.commands.run("theme")).status).toBe("executed")
    expect(picker()?.kind).toBe("theme-picker")
    if (picker()?.kind === "theme-picker") {
      expect(picker()?.payload).toEqual({ selected: last })
    }

    // Choosing from the picker keeps its "current" mark honest.
    expect((await controller.commands.run("theme", PALETTES[0] ?? "night-owl")).status).toBe("executed")
    if (picker()?.kind === "theme-picker") {
      expect(picker()?.payload).toEqual({ selected: PALETTES[0] })
    }
    expect((await controller.commands.run("theme", last ?? "night-owl")).status).toBe("executed")

    // The axes never touch: the toggle flips the theme and nothing else.
    const before = store.session().theme
    expect((await controller.commands.run("dark-mode")).status).toBe("executed")
    expect(store.session().theme).not.toBe(before)
    expect(store.session().palette).toBe(last)
  })

  test("a bare /name typed into the composer runs the command, not a prompt", async () => {
    const { store, controller } = await freshController()
    controller.changeDraft("/world")
    controller.send(store.session().draft)
    expect(store.session().surface).toBe("world")
    expect(store.session().draft).toBe("")
    expect([...store.collections.messages.values()].some((m) => m.text === "/world")).toBe(false)
  })

  test("slashItems surfaces the recommended command first for a bare /", async () => {
    const { controller } = await freshController()
    const items = controller.slashItems("")
    expect(items[0]?.flow.name).toBe("connect")
    expect(items[0]?.recommended).toBe(true)
  })

  /*
   * The registered catalog, not a fixture: typing a whole flow name and
   * pressing Enter runs THAT flow. The composer's Enter takes the first item
   * of this listing, so first-ness is the whole contract. Every registered
   * name is checked, because the defect this pins was one name whose text
   * happened to appear inside another flow's summary.
   */
  test("every registered flow leads its own name's listing", async () => {
    const { controller } = await freshController()
    const listed = controller.commands.all().filter((command) => command.hidden !== true)
    // Not a vacuous pass: the whole registered catalog is under test.
    expect(listed.length).toBeGreaterThan(40)
    const misdirected = listed
      .map((command) => ({ typed: command.name, leads: controller.slashItems(command.name)[0]?.flow.name }))
      .filter((row) => row.leads !== row.typed)
    expect(misdirected).toEqual([])
  })

  test("the agent tool lists commands and executes them through the same path", async () => {
    const { controller } = await freshController()
    const listed = await executeAgentToolCall(controller.commands, {
      name: "commands",
      arguments: JSON.stringify({ action: "list" })
    })
    const parsed = JSON.parse(listed) as {
      state: { surface: string }
      commands: Array<{ name: string }>
    }
    expect(parsed.state.surface).toBe("chat")
    expect(parsed.commands.some((command) => command.name === "connect")).toBe(true)
    expect(parsed.commands.some((command) => command.name === "connector.remove")).toBe(false)

    const executed = await executeAgentToolCall(controller.commands, {
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "connect" })
    })
    expect(executed).toBe("executed /connect")

    // The recovery is in the error: the dead-end "unknown-command: nope"
    // left the live model telling the USER to run the command instead of
    // retrying with a listed name in the same turn.
    const unknown = await executeAgentToolCall(controller.commands, {
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "nope" })
    })
    expect(unknown).toBe(
      "unknown-command: nope — no command has that name; use the list action for every command callable right now"
    )
  })

  test("the model may spell a command the way the catalog does — /name resolves to name", async () => {
    /*
     * The generated capability section spells every command "/name", and
     * live on canary the model echoed that spelling into the tool call:
     * execute {"name":"/browser"} died as unknown-command and the turn
     * degraded into asking permission for the act it had been asked to do.
     * The agent boundary strips the catalog's slash exactly as the
     * composer's parseSubmit strips the human's; the registry's names stay
     * bare.
     */
    const { store, controller } = await freshController()
    const executed = await executeAgentToolCall(controller.commands, {
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "/connect" })
    })
    expect(executed).toBe("executed /connect")
    expect(store.session().surface).toBe("connectors")

    // The user-only guard holds under the slash spelling too.
    const theme = await executeAgentToolCall(controller.commands, {
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "/theme" })
    })
    expect(theme).toContain("user-only")

    // A bare "/" names nothing.
    const empty = await executeAgentToolCall(controller.commands, {
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "/" })
    })
    expect(empty).toBe("failed: the execute action requires a command name")
  })
})
