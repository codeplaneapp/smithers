import { useLiveQuery } from "@tanstack/react-db"
import { FolderGit2, Moon, Plus, RotateCcw, Sun, X } from "lucide-react"
import { roleMenuEntries } from "../AgentRoleMenu"
import { useController } from "../ControllerContext"
import { MAIN_TAB_ID, parseRepoSelection } from "../state/AppState"
import type { TabRow, WorkingCopy } from "../state/AppState"
import { SELECT_REPO_LABEL } from "../Onboarding"

/*
 * The sidebar (docs/LOCAL-APP.md "Tabs"): vertical like Arc — Smithers pinned
 * first and never closable; then the Repos section, one row per pinned
 * repository with its tabs nested under it (a tab whose repository is not
 * pinned sits under "No repository"); then `+`; and, at the bottom, the
 * chrome that must stay visible on every tab: the theme toggle, the admin
 * reset, and "Sign in".
 * Every affordance dispatches a registered flow; the list and the `+` menu
 * are projections of the tabs collection and the session row.
 */
export function ChromeBar() {
  const controller = useController()
  const { collections } = controller.store
  const { data: tabRows } = useLiveQuery((q) => q.from({ tab: collections.tabs }).orderBy(({ tab }) => tab.ordinal))
  const { data: sessionRows } = useLiveQuery((q) =>
    q.from({ session: collections.sessions }).select(({ session }) => ({
      id: session.id,
      activeTabId: session.activeTabId,
      tabMenuOpen: session.tabMenuOpen,
      theme: session.theme,
      activeRepoKey: session.activeRepoKey
    }))
  )
  const { data: harnessRows } = useLiveQuery(collections.harnesses)
  const { data: identityRows } = useLiveQuery(collections.identitySessions)
  const { data: repoRows } = useLiveQuery(collections.repos)
  const { data: pinRows } = useLiveQuery((q) => q.from({ pin: collections.pinnedRepos }).orderBy(({ pin }) => pin.pinnedAt))
  const { data: repositoryRows } = useLiveQuery(collections.repositories)
  const { data: copyRows } = useLiveQuery(collections.workingCopies)
  const session = sessionRows[0]
  const identity = identityRows[0]
  const activeTabId = session?.activeTabId ?? MAIN_TAB_ID
  const dark = session?.theme === "dark"
  const menuOpen = session?.tabMenuOpen === true
  const available = harnessRows.filter((harness) => harness.status !== "unavailable")
  const unavailable = harnessRows.filter((harness) => harness.status === "unavailable")
  const roleEntries = roleMenuEntries(harnessRows)
  const canOpenTerminal = controller.commands.find("tab.terminal") !== undefined
  const canOpenHarnesses = controller.commands.find("tab.harness") !== undefined
  const canSignIn = controller.commands.find("auth.sign-in") !== undefined
  const canOpenRepo = controller.commands.find("repo.open") !== undefined
  const canSelectRepo = controller.commands.find("repo.select") !== undefined
  // Admin chrome follows the same capability-filtered registry as every act.
  const isAdmin = controller.commands.find("admin.devtools") !== undefined
  const canAddTab = canOpenTerminal || canOpenHarnesses

  /*
   * The Repos section is the piper tree (ADR 0001, lane piper step 3): the
   * cloud inventory grouped `org/ → repo → working copies`, and local
   * checkouts the inventory does not know as standalone rows (their repoId
   * never invents an owner). Selecting a repo row names `org/repo`; selecting
   * a copy row names `org/repo#copyId` — the legacy pin key still selects.
   * No mirror glyph: the backend has no mirror status yet (plue#445).
   */
  const activeKey = session?.activeRepoKey ?? null
  const selection = activeKey === null ? null : parseRepoSelection(activeKey)
  const activeCopyId = selection === null ? null : "repoId" in selection ? selection.copyId ?? null : selection.legacyCopyId
  const pinIds = new Set(pinRows.map((pin) => pin.id))
  const openPaths = new Set(repoRows.map((repo) => repo.path))
  const copiesByRepoId = new Map<string, ReadonlyArray<WorkingCopy>>()
  for (const copy of copyRows) {
    copiesByRepoId.set(copy.repoId, [...(copiesByRepoId.get(copy.repoId) ?? []), copy])
  }
  interface TreeRepo {
    readonly repoId: string
    readonly name: string
    readonly org: string | null
    readonly copies: ReadonlyArray<WorkingCopy>
  }
  const tree: Array<TreeRepo> = [...repositoryRows]
    .sort((left, right) => left.org.localeCompare(right.org) || left.name.localeCompare(right.name))
    .map((repository) => ({
      repoId: repository.id,
      name: repository.name,
      org: repository.org,
      copies: copiesByRepoId.get(repository.id) ?? []
    }))
  const knownRepoIds = new Set(repositoryRows.map((repository) => repository.id))
  const standalone: Array<TreeRepo> = [...copiesByRepoId.entries()]
    .filter(([repoId]) => !knownRepoIds.has(repoId))
    .map(([repoId, copies]) => ({
      repoId,
      name: copies[0]?.label ?? repoId,
      org: null,
      copies
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
  const groups = [...tree, ...standalone]
  const copyIds = new Set(copyRows.map((copy) => copy.id))
  const mainTab = tabRows.find((tab) => tab.kind === "main")
  const tabsUnder = (key: string): ReadonlyArray<TabRow> =>
    tabRows.filter((tab) => tab.kind !== "main" && tab.repoKey === key)
  const orphanTabs = tabRows.filter((tab) =>
    tab.kind !== "main" && (tab.repoKey === undefined || !copyIds.has(tab.repoKey))
  )

  const tabRow = (tab: TabRow) => (
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
        title={tab.title}
        data-flow="tab.select"
        data-tab-id={tab.id}
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
  )

  return (
    <aside className="chrome-bar" aria-label="Tabs and chrome">
      {
        /*
         * The `+` sits BESIDE the list, not inside it. The list scrolls
         * vertically (overflow-y: auto), and an overflow container clips its
         * absolutely-positioned descendants on both axes — a menu rendered
         * inside the strip once opened into a 28px box and painted nothing
         * (the trigger read aria-expanded="true" while the human saw no
         * menu). Outside the list the menu is clipped by nothing.
         */
      }
      <div className="chrome-tabs">
        <div
          className="tab-strip"
          role="tablist"
          aria-label="Tabs"
          aria-orientation="vertical"
          data-testid="tab-strip"
          onKeyDown={(event) => {
            // A vertical tablist: ArrowUp/ArrowDown (Home/End) move between tabs, across every repo group, and select the one reached.
            const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0
            if (step === 0 && event.key !== "Home" && event.key !== "End") return
            const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
            const current = tabs.findIndex((tab) => tab === document.activeElement)
            if (tabs.length === 0 || current === -1) return
            event.preventDefault()
            const next = event.key === "Home"
              ? 0
              : event.key === "End"
              ? tabs.length - 1
              : (current + step + tabs.length) % tabs.length
            const target = tabs[next]
            if (target === undefined) return
            target.focus()
            const id = target.dataset.tabId
            if (id !== undefined && id !== activeTabId) controller.runCommandArgs("tab.select", id)
          }}
        >
          {mainTab === undefined ? null : tabRow(mainTab)}
          <div className="repo-section" role="presentation" data-testid="repo-section">
            <div className="repo-section-title" aria-hidden="true">Repos</div>
            {groups.length === 0 && canOpenRepo ?
              (
                // No repository yet: the one step, bound exactly as the opening message binds it.
                <button
                  type="button"
                  className="repo-empty"
                  data-flow="repo.open"
                  data-testid="repo-empty"
                  onClick={() => controller.runCommand("repo.open")}
                >
                  <FolderGit2 size={14} aria-hidden="true" />
                  <span>{SELECT_REPO_LABEL}</span>
                </button>
              ) :
              null}
            {groups.map((group, groupIndex) => {
              /*
               * A local checkout the inventory does not know renders as the
               * flat row it always was (its copy id is the select token);
               * a cloud repository renders as the org/repo tree with its
               * working copies nested.
               */
              const single = group.org === null && group.copies.length === 1 ? group.copies[0] : undefined
              const groupKey = single?.id ?? group.repoId
              const selectToken = single?.id ?? group.repoId
              const active = single !== undefined
                ? activeCopyId === single.id
                : activeKey === group.repoId || (selection !== null && "repoId" in selection && selection.repoId === group.repoId)
              const open = single !== undefined && single.path !== undefined && openPaths.has(single.path)
              const orgHeader = group.org !== null && groups[groupIndex - 1]?.org !== group.org
              return (
                <div key={groupKey} role="presentation">
                  {orgHeader ?
                    <div className="repo-org" aria-hidden="true" data-testid={`repo-org-${group.org ?? ""}`}>{group.org}/</div> :
                    null}
                  <div
                    className="repo-group"
                    role="presentation"
                    data-active={active}
                    data-open={open}
                    data-testid={`repo-${groupKey}`}
                  >
                    <div className="repo" role="presentation">
                      <button
                        type="button"
                        className="repo-select"
                        aria-current={active ? "true" : undefined}
                        title={group.repoId}
                        data-flow="repo.select"
                        data-testid={`repo-select-${groupKey}`}
                        disabled={!canSelectRepo}
                        onClick={() => controller.runCommandArgs("repo.select", selectToken)}
                      >
                        <FolderGit2 size={14} aria-hidden="true" />
                        <span className="repo-name">{group.name}</span>
                      </button>
                      {single !== undefined && canAddTab ?
                        (
                          <button
                            type="button"
                            className="repo-add"
                            aria-label={`New tab in ${single.label}`}
                            title={`New tab in ${single.label}`}
                            data-flow="tab.menu"
                            data-testid={`repo-add-${single.id}`}
                            onClick={() => controller.runCommandArgs("tab.menu", single.id)}
                          >
                            <Plus size={12} aria-hidden="true" />
                          </button>
                        ) :
                        null}
                      {single !== undefined && canSelectRepo && pinIds.has(single.id) ?
                        (
                          <button
                            type="button"
                            className="repo-unpin"
                            aria-label={`Unpin ${single.label}`}
                            title="Unpin repository"
                            data-flow="repo.unpin"
                            data-testid={`repo-unpin-${single.id}`}
                            onClick={() => controller.runCommandArgs("repo.unpin", single.id)}
                          >
                            <X size={12} aria-hidden="true" />
                          </button>
                        ) :
                        null}
                    </div>
                    {single !== undefined ?
                      (
                        <div className="repo-tabs" role="presentation">
                          {tabsUnder(single.id).map(tabRow)}
                        </div>
                      ) :
                      (
                        <div className="repo-copies" role="presentation">
                          {group.copies.map((copy) => {
                            const copyActive = activeCopyId === copy.id
                            const copyLabel = copy.kind === "workspace"
                              ? copy.state === undefined ? copy.label : `${copy.label} · ${copy.state}`
                              : copy.ahead === undefined ? copy.label : `${copy.label} · ${copy.ahead} ahead`
                            return (
                              <div key={copy.id} className="repo-copy" role="presentation" data-testid={`copy-${copy.id}`}>
                                <button
                                  type="button"
                                  className="repo-select"
                                  aria-current={copyActive ? "true" : undefined}
                                  title={copy.path ?? copy.workspaceId ?? copy.id}
                                  data-flow="repo.select"
                                  data-testid={`copy-select-${copy.id}`}
                                  disabled={!canSelectRepo}
                                  onClick={() => controller.runCommandArgs("repo.select", `${group.repoId}#${copy.id}`)}
                                >
                                  <FolderGit2 size={12} aria-hidden="true" />
                                  <span className="repo-name">{copyLabel}</span>
                                </button>
                                {copy.kind === "local" && canAddTab ?
                                  (
                                    <button
                                      type="button"
                                      className="repo-add"
                                      aria-label={`New tab in ${copy.label}`}
                                      title={`New tab in ${copy.label}`}
                                      data-flow="tab.menu"
                                      data-testid={`repo-add-${copy.id}`}
                                      onClick={() => controller.runCommandArgs("tab.menu", copy.id)}
                                    >
                                      <Plus size={12} aria-hidden="true" />
                                    </button>
                                  ) :
                                  null}
                                {copy.kind === "local" && canSelectRepo && pinIds.has(copy.id) ?
                                  (
                                    <button
                                      type="button"
                                      className="repo-unpin"
                                      aria-label={`Unpin ${copy.label}`}
                                      title="Unpin repository"
                                      data-flow="repo.unpin"
                                      data-testid={`repo-unpin-${copy.id}`}
                                      onClick={() => controller.runCommandArgs("repo.unpin", copy.id)}
                                    >
                                      <X size={12} aria-hidden="true" />
                                    </button>
                                  ) :
                                  null}
                                <div className="repo-tabs" role="presentation">
                                  {tabsUnder(copy.id).map(tabRow)}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}
                  </div>
                </div>
              )
            })}
            {orphanTabs.length > 0 ?
              (
                <div className="repo-group" role="presentation" data-testid="repo-none">
                  <div className="repo repo-none" role="presentation">
                    <span className="repo-name">No repository</span>
                  </div>
                  <div className="repo-tabs" role="presentation">
                    {orphanTabs.map(tabRow)}
                  </div>
                </div>
              ) :
              null}
          </div>
        </div>
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
            <span>New tab</span>
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
                  {/* Agents: each configured harness launches as a subagent of this conversation, in its own tab. */}
                  {canOpenHarnesses && harnessRows.length > 0 ?
                    <div className="tab-add-group" role="presentation" data-testid="tab-add-agents">Agents</div> :
                    null}
                  {/* The named roles first (AgentRoles.ts): one model each, disabled with the reason when their harness cannot run it. */}
                  {canOpenHarnesses && harnessRows.length > 0 ? roleEntries.map((entry) => (
                    <button
                      type="button"
                      role="menuitem"
                      key={entry.role.id}
                      className="tab-add-item"
                      disabled={!entry.available}
                      title={entry.available ? entry.role.purpose : entry.reason}
                      data-flow="agent.role"
                      data-role={entry.role.id}
                      data-testid={`tab-add-role-${entry.role.id}`}
                      onClick={() => controller.runCommandArgs("agent.role", entry.role.id)}
                    >
                      <span>{entry.title}</span>
                      <span className="tab-add-account">{entry.available ? entry.account : entry.reason}</span>
                    </button>
                  )) : null}
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
      {
        /*
         * The chrome that belongs to no tab, so it stays visible in a terminal
         * or an agent exactly as in the chat. It renders LAST because DOM order
         * is focus order and these controls are chrome, not the work.
         */
      }
      <div className="chrome-actions" data-testid="chrome-actions">
        {/* The repository lives at the top of the composer (its selector and origin), not here. */}
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
        <div className="chrome-corner">
          {/* The bare reset is admin-only dev tooling (§2); users get /clear. */}
          {isAdmin ?
            (
              <button
                type="button"
                className="chrome-icon-action corner-reset-btn"
                data-flow="admin.reset.ask"
                aria-label="Reset conversation"
                title="Reset conversation"
                onClick={() => controller.runCommand("admin.reset.ask")}
              >
                <RotateCcw size={14} aria-hidden="true" />
              </button>
            ) :
            null}
          <button
            type="button"
            className="chrome-icon-action corner-theme-btn"
            data-flow="appearance.dark-mode"
            aria-label="Toggle light and dark mode"
            title="Toggle light and dark mode"
            onClick={() => controller.runCommand("appearance.dark-mode")}
          >
            {dark ? <Sun size={14} aria-hidden="true" /> : <Moon size={14} aria-hidden="true" />}
          </button>
        </div>
      </div>
    </aside>
  )
}
