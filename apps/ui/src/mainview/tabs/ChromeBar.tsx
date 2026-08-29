import { useLiveQuery } from "@tanstack/react-db"
import { Plus, X } from "lucide-react"
import { useController } from "../ControllerContext"
import { MAIN_TAB_ID } from "../state/AppState"

/*
 * The chrome bar (docs/LOCAL-APP.md "Tabs"): the tab strip in the upper-left
 * — main first and not closable, then tabs in creation order, then `+` — and
 * the repository chip, "Open repository", and "Sign in" on the right. Every
 * affordance dispatches a registered flow; the strip and the `+` menu are
 * projections of the tabs collection and the session row.
 */
export function ChromeBar() {
  const controller = useController()
  const { collections } = controller.store
  const { data: tabRows } = useLiveQuery((q) => q.from({ tab: collections.tabs }).orderBy(({ tab }) => tab.ordinal))
  const { data: sessionRows } = useLiveQuery((q) =>
    q.from({ session: collections.sessions }).select(({ session }) => ({
      id: session.id,
      activeTabId: session.activeTabId,
      tabMenuOpen: session.tabMenuOpen
    }))
  )
  const { data: harnessRows } = useLiveQuery(collections.harnesses)
  const { data: repoRows } = useLiveQuery(collections.repos)
  const { data: identityRows } = useLiveQuery(collections.identitySessions)
  const session = sessionRows[0]
  const identity = identityRows[0]
  const activeTabId = session?.activeTabId ?? MAIN_TAB_ID
  const menuOpen = session?.tabMenuOpen === true
  const available = harnessRows.filter((harness) => harness.status !== "unavailable")
  const unavailable = harnessRows.filter((harness) => harness.status === "unavailable")
  const repo = repoRows[0]
  const canOpenLocalRepositories = controller.commands.find("repo.open") !== undefined
  const canOpenTerminal = controller.commands.find("tab.terminal") !== undefined
  const canOpenHarnesses = controller.commands.find("tab.harness") !== undefined
  const canSignIn = controller.commands.find("auth.sign-in") !== undefined
  const canAddTab = canOpenTerminal || canOpenHarnesses

  return (
    <div className="chrome-bar">
      <div className="tab-strip" role="tablist" aria-label="Tabs" data-testid="tab-strip">
        {tabRows.map((tab) => (
          <div
            key={tab.id}
            className="tab"
            role="presentation"
            data-kind={tab.kind}
            data-active={tab.id === activeTabId}
            data-testid={`tab-${tab.id}`}
          >
            <button
              type="button"
              role="tab"
              className="tab-select"
              aria-selected={tab.id === activeTabId}
              data-flow="tab.select"
              onClick={() => controller.runCommandArgs("tab.select", tab.id)}
            >
              {tab.title}
            </button>
            {tab.kind === "main" ? null : (
              <button
                type="button"
                className="tab-close"
                aria-label={`Close ${tab.title}`}
                title="Close tab"
                data-flow="tab.close"
                data-testid={`tab-close-${tab.id}`}
                onClick={() => controller.runCommandArgs("tab.close", tab.id)}
              >
                <X size={12} aria-hidden="true" />
              </button>
            )}
          </div>
        ))}
        {canAddTab ? <div className="tab-add">
          <button
            type="button"
            className="tab-add-trigger"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="New tab"
            title="New tab"
            data-flow="tab.menu"
            data-testid="tab-add"
            onClick={() => controller.runCommand("tab.menu")}
          >
            <Plus size={14} aria-hidden="true" />
          </button>
          {menuOpen ?
            (
              <>
                {/* A press anywhere else closes the menu; the backdrop is the outside. */}
                <div
                  className="tab-add-backdrop"
                  aria-hidden="true"
                  onClick={() => controller.runCommand("tab.menu")}
                />
                <div className="tab-add-menu" role="menu" aria-label="New tab" data-testid="tab-add-menu">
                  {canOpenTerminal ? <button
                    type="button"
                    role="menuitem"
                    className="tab-add-item"
                    data-flow="tab.terminal"
                    data-testid="tab-add-terminal"
                    onClick={() => controller.runCommand("tab.terminal")}
                  >
                    <span>Terminal</span>
                  </button> : null}
                  {canOpenHarnesses ? available.map((harness) => (
                    <button
                      type="button"
                      role="menuitem"
                      key={harness.id}
                      className="tab-add-item"
                      data-flow="tab.harness"
                      data-testid={`tab-add-harness-${harness.id}`}
                      onClick={() => controller.runCommandArgs("tab.harness", harness.id)}
                    >
                      <span>{harness.displayName}</span>
                      <span className="tab-add-account">{harness.account?.email ?? harness.account?.label ?? ""}</span>
                    </button>
                  )) : null}
                  {canOpenHarnesses ? unavailable.map((harness) => (
                    <button
                      type="button"
                      role="menuitem"
                      key={harness.id}
                      className="tab-add-item"
                      disabled
                      data-flow="tab.harness"
                      data-testid={`tab-add-harness-${harness.id}`}
                      onClick={() => controller.runCommandArgs("tab.harness", harness.id)}
                    >
                      <span>{harness.displayName}</span>
                      <span className="tab-add-account">{harness.status}</span>
                    </button>
                  )) : null}
                </div>
              </>
            ) :
            null}
        </div> : null}
      </div>
      <div className="chrome-actions">
        {!canOpenLocalRepositories || repo === undefined ? null : (
          <span className="repo-chip" data-testid="repo-chip" title={repo.path}>
            {repo.name}
          </span>
        )}
        {canOpenLocalRepositories ? <button
          type="button"
          className="chrome-action"
          data-flow="repo.open"
          data-testid="chrome-open-repo"
          onClick={() => controller.runCommand("repo.open")}
        >
          Open repository
        </button> : null}
        {/* Sign-in is an option, never a gate (docs/LOCAL-APP.md); the door closes once signed in. */}
        {!canSignIn || identity?.state === "signed-in" ? null : (
          <button
            type="button"
            className="chrome-action"
            data-flow="auth.sign-in"
            data-testid="chrome-sign-in"
            onClick={() => controller.runCommand("auth.sign-in")}
          >
            Sign in with GitHub
          </button>
        )}
      </div>
    </div>
  )
}
