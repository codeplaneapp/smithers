/*
 * The composer boundary: slash argument text in, a flow's typed payload out.
 *
 * Under the old `Command` interface every handler re-parsed its own `args?:
 * string` — the same trailing-`owner/repo` split written out dozens of times,
 * each free to drift. Flows take DECODED payloads, so the text-shaped step
 * happens exactly once: here, at the edge where a human's `/name <text>` (or
 * an agent's single argument string) becomes the record the flow's input
 * schema validates.
 *
 * A parse either produces the payload or an honest error naming what is
 * missing. The error never reaches the flow: an invocation that cannot be
 * parsed is refused before the handler runs, which is why no handler below the
 * boundary contains an argument check.
 */
import { splitTrailingRepo } from "../state/RepoContext"

/** A parsed invocation, or the honest refusal that names what is missing. */
export type Parsed =
  | { readonly payload: Record<string, unknown> }
  | { readonly error: string }

const ok = (payload: Record<string, unknown>): Parsed => ({ payload })
const no = (error: string): Parsed => ({ error })

/** The empty payload every no-argument flow takes. */
const NONE: Parsed = { payload: {} }

const trimmed = (args: string | undefined): string => (args ?? "").trim()

/** A required single-value payload, refused by name when the text is blank. */
const required = (field: string, args: string | undefined, reason: string): Parsed => {
  const value = trimmed(args)
  return value === "" ? no(reason) : ok({ [field]: value })
}

/** An optional single-value payload: blank text means the field is absent. */
const optional = (field: string, args: string | undefined): Parsed => {
  const value = trimmed(args)
  return ok(value === "" ? {} : { [field]: value })
}

/** A repo-scoped flow that takes nothing but its optional `owner/repo` target. */
const repoOnly = (name: string, args: string | undefined): Parsed => {
  const { rest, repo } = splitTrailingRepo(args)
  if (rest !== "") return no(`${name} takes just an owner/repo name`)
  return ok(repo === undefined ? {} : { repo })
}

/** A positive issue or pull-request number beside its optional repo. */
const numbered = (args: string | undefined, reason: string): Parsed => {
  const { rest, repo } = splitTrailingRepo(args)
  const number = Number(rest)
  if (!Number.isInteger(number) || number <= 0) return no(reason)
  return ok(repo === undefined ? { number } : { number, repo })
}

const tokensOf = (args: string | undefined): Array<string> =>
  trimmed(args)
    .split(/\s+/)
    .filter((token) => token !== "")

/** A repository id followed by a target label (`//pkg:name`). */
const targetRef = (name: string, args: string | undefined): Parsed => {
  const [repoId, ...rest] = tokensOf(args)
  const label = rest.join(" ")
  if (repoId === undefined || repoId === "" || label === "") return no(`${name} needs a repository id and a target label`)
  return ok({ repoId, label })
}

/*
 * The grammar, one entry per flow that accepts arguments. A flow absent from
 * this table takes the empty payload — which is also what a flow with no args
 * hint gets, since `parseSubmit` routes `/name <text>` for such a flow to the
 * agent as a prompt rather than to the flow.
 */
const GRAMMAR: Readonly<Record<string, (args: string | undefined) => Parsed>> = {
  theme: (args) => ok({ palette: args ?? "" }),
  send: (args) => required("text", args, "send needs the text to submit"),
  "repos.watch": (args) => optional("repo", args),
  "repos.watch.toggle": (args) => required("fullName", args, "repos.watch.toggle needs a repository name"),
  browser: (args) => required("url", args, "browser needs a URL: /browser https://example.com"),
  /*
   * The description keeps the trailing `owner/repo` token: createWorkflow
   * applies its OWN split, which (unlike splitTrailingRepo) leaves a lone
   * repo-shaped word as the description. Splitting here would change which
   * inputs name a target.
   */
  "flow.create": (args) => ok({ description: trimmed(args) }),
  "flow.repo.choose": (args) => required("repo", args, "flow.repo.choose needs a repository name"),
  "flow.run.stop": (args) => required("cardId", args, "flow.run.stop needs the card id"),
  "flow.run.retry": (args) => required("cardId", args, "flow.run.retry needs the card id"),
  "flow.run": (args) => {
    const tokens = tokensOf(args)
    if (tokens.length > 2) return no("flow.run takes a workflow name and optionally an owner/repo")
    const [name, repo] = tokens
    if (name === undefined) {
      return no("flow.run needs a workflow name: /flow.run create-workflow")
    }
    return ok(repo === undefined ? { name } : { name, repo })
  },
  "card.maximize": (args) => required("cardId", args, "card.maximize needs the card id"),
  // The clipboard text is taken verbatim: trimming would silently rewrite what
  // the human asked to copy.
  "copy-message": (args) => (args ?? "") === "" ? no("copy-message needs the text to copy") : ok({ text: args ?? "" }),
  "approval.approve": (args) => required("cardId", args, "approval.approve needs the card id"),
  "approval.deny": (args) => required("cardId", args, "approval.deny needs the card id"),
  "connector.add": (args) => {
    const access = trimmed(args)
    if (access !== "read" && access !== "read-write") {
      return no("connector.add needs an access level: read or read-write")
    }
    return ok({ access })
  },
  "connector.downgrade": (args) => required("connectorId", args, "connector.downgrade needs the connector id"),
  "connector.remove": (args) => required("connectorId", args, "connector.remove needs the connector id"),
  "world.select": (args) => required("documentId", args, "world.select needs the document id"),
  "world.delete": (args) => required("documentId", args, "world.delete needs the document id"),
  "toast.dismiss": (args) => required("toastId", args, "toast.dismiss needs the toast id"),
  "repos.import": (args) => repoOnly("repos.import", args),
  "issues.list": (args) => {
    const { rest, repo } = splitTrailingRepo(args)
    const filter = rest === "" ? "open" : rest
    if (filter !== "open" && filter !== "closed" && filter !== "all") {
      return no("issues.list takes open, closed, or all")
    }
    return ok(repo === undefined ? { filter } : { filter, repo })
  },
  "issues.view": (args) => numbered(args, "issues.view needs an issue number"),
  "issues.create": (args) => {
    const { rest, repo } = splitTrailingRepo(args)
    if (rest === "") return no("issues.create needs a title")
    return ok(repo === undefined ? { title: rest } : { title: rest, repo })
  },
  "issues.close": (args) => numbered(args, "issues.close needs an issue number"),
  "issues.reopen": (args) => numbered(args, "issues.reopen needs an issue number"),
  "issues.comment": (args) => {
    const { rest, repo } = splitTrailingRepo(args)
    const [head, ...tail] = rest.split(/\s+/)
    const number = Number(head)
    const text = tail.join(" ").trim()
    if (!Number.isInteger(number) || number <= 0) return no("issues.comment needs an issue number")
    if (text === "") return no("issues.comment needs the comment text")
    return ok(repo === undefined ? { number, text } : { number, text, repo })
  },
  "prs.list": (args) => repoOnly("prs.list", args),
  "prs.view": (args) => numbered(args, "prs.view needs a pull request number"),
  "prs.create": (args) => {
    const { rest, repo } = splitTrailingRepo(args)
    // The source bookmark rides as a `from:<name>` token anywhere in the text;
    // /branches.list shows the choices.
    const tokens = rest.split(/\s+/).filter((token) => token !== "")
    const fromToken = tokens.find((token) => token.startsWith("from:"))
    const from = fromToken?.slice("from:".length)
    const title = tokens.filter((token) => !token.startsWith("from:")).join(" ")
    if (title === "") return no("prs.create needs a title")
    if (fromToken !== undefined && (from === undefined || from === "")) {
      return no("prs.create's from: token needs a bookmark name — see /branches.list")
    }
    return ok({
      title,
      ...(from === undefined || from === "" ? {} : { from }),
      ...(repo === undefined ? {} : { repo })
    })
  },
  "prs.land": (args) => numbered(args, "prs.land needs a pull request number"),
  "prs.review": (args) => {
    const { rest, repo } = splitTrailingRepo(args)
    const [head, verdict, ...tail] = rest.split(/\s+/)
    const number = Number(head)
    if (!Number.isInteger(number) || number <= 0) return no("prs.review needs a pull request number")
    const type = verdict === "approve"
      ? "approve"
      : verdict === "request-changes"
      ? "request_changes"
      : verdict === "comment"
      ? "comment"
      : undefined
    if (type === undefined) {
      return no("prs.review needs a verdict: approve, request-changes, or comment")
    }
    const text = tail.join(" ").trim()
    return ok(repo === undefined ? { number, verdict: type, text } : { number, verdict: type, text, repo })
  },
  "billing.upgrade": (args) => optional("plan", args),
  "keys.remove": (args) => required("provider", args, "keys.remove needs the provider name"),
  "env.view": (args) => repoOnly("env.view", args),
  "env.set": (args) => {
    const { rest, repo } = splitTrailingRepo(args)
    if (rest === "") return no("env.set needs a NAME=value pair")
    return ok(repo === undefined ? { assignment: rest } : { assignment: rest, repo })
  },
  "branches.list": (args) => repoOnly("branches.list", args),
  "files.list": (args) => {
    const tokens = tokensOf(args)
    if (tokens.length > 2) return no("files.list takes a path and optionally an owner/repo")
    const [path, repo] = tokens
    return ok(repo === undefined ? { path: path ?? "" } : { path: path ?? "", repo })
  },
  "files.read": (args) => {
    const tokens = tokensOf(args)
    const [path, repo] = tokens
    if (path === undefined || path === "") return no("files.read needs a file path")
    if (tokens.length > 2) return no("files.read takes a path and optionally an owner/repo")
    return ok(repo === undefined ? { path } : { path, repo })
  },
  "repos.app": (args) => repoOnly("repos.app", args),
  "debug.backend": (args) => ok({ backend: args ?? "" }),
  "admin.allowlist.add": (args) => required("login", args, "admin.allowlist.add needs a login"),
  "admin.allowlist.remove": (args) => required("login", args, "admin.allowlist.remove needs a login"),
  "admin.grant": (args) => {
    const tokens = tokensOf(args)
    if (tokens.length > 2) return no("admin.grant takes an amount in dollars and a login")
    const [amountRaw, login] = tokens
    const amountUsd = Number(amountRaw)
    if (
      amountRaw === undefined ||
      !Number.isFinite(amountUsd) ||
      amountUsd <= 0 ||
      login === undefined ||
      login === ""
    ) {
      return no("admin.grant needs an amount in dollars and a login: /admin.grant 25 octocat")
    }
    return ok({ amountUsd, login })
  },
  "admin.grant.confirm": (args) => required("cardId", args, "admin.grant.confirm needs the card id"),
  "admin.grant.cancel": (args) => required("cardId", args, "admin.grant.cancel needs the card id"),
  "admin.queue.approve": (args) => required("login", args, "admin.queue.approve needs a login"),
  "tab.harness": (args) => required("harnessId", args, "tab.harness needs a harness id"),
  "tab.card": (args) => required("cardId", args, "tab.card needs the card id"),
  "tab.select": (args) => required("tab", args, "tab.select needs a tab id or a position 1-9"),
  "tab.close": (args) => optional("tabId", args),
  "target.run": (args) => targetRef("target.run", args),
  "target.open": (args) => targetRef("target.open", args),
  /*
   * The target-graph commands (docs/LOCAL-APP.md "Cards: target graph"). The
   * repo id may go unnamed — the controller resolves the one open repository
   * — so a lone `//…` token is the LABEL, anything else the repo id.
   */
  "target.graph": (args) => {
    const tokens = tokensOf(args)
    if (tokens.length === 0) return ok({})
    if (tokens.length === 1) {
      const [only] = tokens
      return only !== undefined && only.startsWith("//") ? ok({ label: only }) : ok({ repoId: only })
    }
    const [repoId, ...rest] = tokens
    return ok({ repoId, label: rest.join(" ") })
  },
  /* Same shape as target.graph: a lone `//…` token is the label to pin, none clears the focus. */
  "target.graph.focus": (args) => {
    const tokens = tokensOf(args)
    if (tokens.length === 0) return ok({})
    if (tokens.length === 1) {
      const [only] = tokens
      return only !== undefined && only.startsWith("//") ? ok({ label: only }) : ok({ repoId: only })
    }
    const [repoId, ...rest] = tokens
    return ok({ repoId, label: rest.join(" ") })
  },
  "target.timeline": (args) => {
    const tokens = tokensOf(args)
    if (tokens.length > 2) return no("target.timeline takes a run id and optionally a repository id")
    const [first, second] = tokens
    if (first === undefined) return ok({})
    return second === undefined ? ok({ runId: first }) : ok({ repoId: first, runId: second })
  },
  "target.history": (args) => optional("repoId", args),
  "target.affected": (args) => optional("repoId", args),
  "target.ci": (args) => optional("repoId", args),
  "target.runs.select": (args) => {
    const tokens = tokensOf(args)
    if (tokens.length > 2) return no("target.runs.select takes a run id and optionally a repository id")
    const [first, second] = tokens
    if (first === undefined) return no("target.runs.select needs a run id")
    return second === undefined ? ok({ runId: first }) : ok({ repoId: first, runId: second })
  },
  "target.run.scrub": (args) => {
    const [runId, cursorRaw] = tokensOf(args)
    const cursor = Number(cursorRaw)
    if (runId === undefined || cursorRaw === undefined || !Number.isFinite(cursor)) {
      return no("target.run.scrub needs a run id and a cursor (epoch ms)")
    }
    return ok({ runId, cursor })
  },
  "target.source.open": (args) => {
    const [repoId, file] = tokensOf(args)
    if (repoId === undefined || file === undefined) return no("target.source.open needs a repository id and a file")
    return ok({ repoId, file })
  }
}

/**
 * Turns one flow's slash argument text into its typed payload.
 *
 * @category conversions
 */
export const payloadFor = (name: string, args: string | undefined): Parsed => {
  const parse = GRAMMAR[name]
  return parse === undefined ? NONE : parse(args)
}
