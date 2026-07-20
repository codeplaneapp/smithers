# jjhub ↔ Swift GUI — Missing Functionality Report

**Date:** 2026-04-20
**Scope:** Gaps between `jjhub` CLI/web UI (at `/Users/williamcory/jjhub`) and the Swift app (at `/Users/williamcory/gui`).
**Integration model (current):** Swift shells out to the `jjhub` CLI and parses JSON; a small number of paths also hit the dev HTTP server or SQLite directly.

---

## 1. What the Swift app already covers

| Domain | Coverage |
| --- | --- |
| Workflows | list, run (with ref) |
| Changes | list, show, diff |
| Bookmarks | create, delete |
| Landings (PRs) | list, view, create, review, land, checks |
| Issues | list, view, create, close, reopen |
| Workspaces | list, view, create, delete, suspend, resume, fork |
| Workspace snapshots | list, view, create, delete |
| Search | code / issues / repos (CLI-first, API fallback) |
| Repo metadata | `repo view`, status |

Domain models present: `JJHubWorkflow`, `JJHubWorkflowRun`, `JJHubRepo`, `JJHubChange`, `JJHubAuthor`, `JJHubBookmark`, `Landing`, `SmithersIssue`, `Workspace`, `WorkspaceSnapshot`.

---

## 2. Missing functionality — by domain

### 2.1 Repository lifecycle — **largely missing**
Swift only calls `repo view`. jjhub CLI exposes a full repo admin surface:

- `repo create` (with privacy + description)
- `repo list` (owned/accessible repos)
- `repo clone` (jj or git, protocol choice)
- `repo fork`
- `repo transfer`
- `repo archive` / `unarchive`
- `repo delete`
- `repo edit` (rename, description, settings)
- `repo star` / `unstar`
- `repo watch` / `unwatch`

**Impact:** Swift users cannot create, fork, archive, transfer, delete, or manage social state of repos from the app.

### 2.2 Issues — CRUD is partial, collaboration is absent
Present: list, view, create, close, reopen.
Missing:

- `issue edit` (title/body)
- `issue comment` (add a comment)
- `issue react` (emoji reactions)
- `issue pin` / `lock`
- `issue link` (dependencies: blocks, depends-on, relates-to)
- Label management on issues (model has `labels` but no UI to set them)
- Assignee management (model has `assignees` but no UI to change them)
- Milestones (not modeled)

### 2.3 Landings — missing editing, discussion, conflicts
Present: list, view, create, review, land, checks.
Missing:

- `land edit` (title/body)
- `land comment`
- `land conflicts` (UI tab exists for Checks — conflicts view is absent)
- Stack-awareness beyond `--stack` on create

### 2.4 Changes — read-only, no deeper inspection
Present: list, show, diff.
Missing:

- `change files` (per-change file list)
- `change conflicts` (per-change conflict list)
- jj operation history (rebase/abandon/undo) not surfaced

### 2.5 Bookmarks — CRUD-minus
Present: create, delete.
Missing:

- `bookmark list` (no UI; dashboard shows bookmarks embedded in changes only)
- Protected-bookmark rules / branch protection

### 2.6 Workflow runs — **entirely missing**
Swift has workflow **definitions** and can trigger, but there is no runs surface:

- `run list` (history with status/page)
- `run view` (detail + logs)
- `run logs` (live stream)
- `run watch`
- `run rerun`
- `run cancel`
- `artifact list` / `artifact download`
- `cache list` / `cache stats` / `cache clear`

**Impact:** Users can fire off a workflow but can't see whether it succeeded, tail logs, rerun failures, or grab artifacts — the entire CI feedback loop.

### 2.7 Releases — **entirely missing**
- `release create` / `list` / `view` / `delete`
- `release upload` (assets)

### 2.8 Wiki — **entirely missing**
- `wiki list` / `view` / `create` / `edit` / `delete`

### 2.9 Notifications — **entirely missing**
- `notification list` (including `--unread`)
- `notification read` (single + `--all`)
- No inbox view; no unread badge.

### 2.10 Webhooks — **entirely missing**
- `webhook create` / `list` / `view` / `update` / `delete`
- `webhook deliveries` (with cursor pagination)

### 2.11 Secrets & variables — **entirely missing**
- `secret list` / `set` / `delete`
- `variable list` / `get` / `set` / `delete`

### 2.12 SSH keys — **entirely missing**
- `ssh-key add` / `list` / `delete`

### 2.13 Labels — **entirely missing as a management surface**
- `label create` / `list` / `delete`
(Labels appear on issues as read-only strings only.)

### 2.14 Organizations & teams — **entirely missing**
A large surface with no Swift coverage:

- `org create` / `list` / `view` / `edit` / `delete`
- `org member add` / `remove` / `list`
- `org team create` / `list` / `view` / `edit` / `delete`
- `org team:member add` / `remove` / `list`
- `org team:repo add` / `remove` / `list`

### 2.15 Auth / session management — partial
Swift assumes an authenticated CLI. Missing surfaces:

- `auth login` (browser or token flow in-app)
- `auth logout`
- `auth status`
- `auth token` (display/rotate)
- `auth push` (push creds to workspace)
- `config get` / `set` / `list` (api_url, git_protocol)

### 2.16 Agent sessions — **entirely missing**
jjhub exposes remote agent orchestration:

- `agent ask` (local helper)
- `agent session list` / `view` / `run` / `chat`

The jjhub web UI has `/:owner/:repo/sessions` and `/session-replay`. The Swift app has no equivalent — a large feature given Smithers is agent-adjacent.

### 2.17 Daemon — **entirely missing**
- `daemon start` / `stop` / `status`
- `daemon sync` (including `--full`)
- `daemon conflicts`
- `daemon connect` / `disconnect`

### 2.18 Extensions — **entirely missing**
- `extension install` / `list` / `remove` / `sync`

### 2.19 Admin surface — **entirely missing**
- `admin user list` / `create` / `disable` / `delete`
- `admin runner list`
- `admin workflow list` (cross-repo)
- `admin health`

Likely out-of-scope for a desktop client, but worth deciding explicitly.

### 2.20 Beta/waitlist — **entirely missing**
- `beta waitlist join` / `list` / `approve`
- `beta whitelist add` / `list` / `remove`

### 2.21 Escape hatch — **missing**
- `api <METHOD> <path>` — raw API passthrough. Useful for features that ship in jjhub before getting first-class Swift UI.

### 2.22 TUI / completion / health — not app-relevant
- `tui`, `completion`, top-level `health` — shell-only; safe to skip.

---

## 3. Web-UI features with no Swift analog

These are jjhub web routes that imply user-facing features the Swift app does not expose today:

- **Code explorer** (`/:owner/:repo/code`) — file tree, syntax highlighting, blame.
- **Repository graph** (`/graph`) — visual commit/bookmark graph.
- **Conflict resolution** (`/conflicts`) — interactive resolution UI.
- **Deploy keys** (`/keys`) — repo-scoped SSH keys for CI.
- **Repository settings** (`/settings`) — privacy, default branch, webhooks, deploy keys.
- **In-browser terminal** (`/terminal`).
- **Landing queue** (`/queue`) and **Readout** (`/readout`) dashboards.
- **Inbox** (`/inbox`) — consolidated notifications.
- **User/org profile pages** (`/:owner`, `/users/:username`) — followers, public repos.
- **Account settings** — emails, SSH keys, API tokens, OAuth apps, notification prefs, connected accounts, secrets, variables.
- **Tool policies & skills** (`/tools/*`) — LLM policy management (flagged).
- **Integrations** — GitHub mirror, Notion, Linear (flagged).

---

## 4. Domain entities unmodeled in Swift

Present only as untyped JSON (or not at all):

- `Milestone`, `Reaction`, `IssueArtifact`, `IssueDependency`, `PinnedIssue`
- `LandingReview`, `LandingComment`, `Conflict`
- `Release`, `ReleaseAsset`, `WorkflowArtifact`
- `WorkflowRun` exists as a struct but is not rendered anywhere
- `Webhook`, `WebhookDelivery`
- `Secret`, `Variable`
- `SSHKey`, `DeployKey`, `AuthToken`, `OAuth2Application`, `ConnectedAccount`
- `Organization`, `Team`, `Member`
- `Notification`, `Mention`, `AuditLog`, `SocialFollowing`
- `Label`, `Topic`, `Star`, `Watch`, `ProtectedBookmark`
- Agent-session entities

---

## 5. Suggested prioritization

The biggest leverage gaps — features users will notice immediately — roughly in order:

1. **Workflow runs + logs + artifacts** — completing the CI loop; Swift can trigger but not observe.
2. **Notifications inbox** — every multi-user workflow needs this.
3. **Landing comments + conflicts tab** — the review flow is half-finished without them.
4. **Issue comments / reactions / labels / assignees** — same reason; the model already hints at this.
5. **Repo lifecycle (create/fork/clone/archive/delete)** — so the app is useful on day one of a new repo.
6. **Agent sessions** — given the product posture, this is likely strategic, not optional.
7. **Auth + config management in-app** — remove the "open a terminal first" prerequisite.
8. **Releases + wiki** — standard platform table stakes.
9. **Webhooks / secrets / variables / SSH keys / deploy keys** — repo admin surface; lower frequency but expected.
10. **Orgs & teams** — heavier lift; deprioritize unless multi-user orgs are in scope now.
11. **`jjhub api` raw passthrough** — cheap escape hatch; ship early to de-risk feature lag.

---

## 6. Reference: full jjhub CLI command tree

Top-level commands (34): `auth`, `repo`, `issue`, `land`, `change`, `bookmark`, `release`, `workflow`, `run`, `workspace`, `search`, `label`, `secret`, `variable`, `ssh-key`, `config`, `status`, `completion`, `agent`, `org`, `wiki`, `notification`, `webhook`, `admin`, `beta`, `api`, `artifact`, `cache`, `daemon`, `extension`, `health`, `tui`.

Currently invoked from Swift (`SmithersClient.swift`): `repo view`, `change list|show|diff`, `bookmark create|delete`, `land list|view|create|land|review|checks`, `issue list|view|create|close|reopen`, `workflow list|run`, `workspace list|view|create|delete|suspend|resume|fork`, `workspace snapshot list|view|create|delete`, `search`, `status`, `api` (fallback only).
