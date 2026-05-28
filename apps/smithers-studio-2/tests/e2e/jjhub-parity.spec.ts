import { expect, test, type Page, type Route } from "@playwright/test";

type ApiState = {
  auth: { loggedIn: boolean; tokenSet: boolean; user?: string };
  issues: Array<{ id: string; number: number; title: string; body: string | null; state: string; labels: string[]; assignees: string[]; commentCount: number }>;
  landings: Array<{ id: string; number: number; title: string; description: string | null; state: string; targetBranch: string; author: string; createdAt: string; reviewStatus: string | null }>;
  workspaces: Array<{ id: string; name: string; status: string; createdAt: string }>;
  snapshots: Array<{ id: string; workspaceId: string; name: string; createdAt: string }>;
};

function defaultState(): ApiState {
  return {
    auth: { loggedIn: true, tokenSet: true, user: "studio-user" },
    issues: [
      { id: "issue-11", number: 11, title: "Fix panel refresh", body: "Use workspace routes.", state: "open", labels: ["bug"], assignees: ["will"], commentCount: 2 },
      { id: "issue-12", number: 12, title: "Closed issue", body: null, state: "closed", labels: [], assignees: [], commentCount: 0 },
    ],
    landings: [
      { id: "landing-7", number: 7, title: "Ship parity panels", description: "Land issues, workspaces, and landings.", state: "open", targetBranch: "main", author: "will", createdAt: "2026-05-27T12:00:00Z", reviewStatus: "pending" },
    ],
    workspaces: [
      { id: "ws-1", name: "studio-main", status: "running", createdAt: "2026-05-27T12:00:00Z" },
      { id: "ws-2", name: "studio-paused", status: "suspended", createdAt: "2026-05-26T12:00:00Z" },
    ],
    snapshots: [
      { id: "snap-1", workspaceId: "ws-1", name: "before-restore", createdAt: "2026-05-27T12:30:00Z" },
    ],
  };
}

async function installWorkspaceApi(page: Page, state: ApiState) {
  await page.route("**/__smithers_studio/workspace", async (route) => {
    await route.fulfill({ json: { cwd: "/tmp/studio", root: "/tmp/studio", hasSmithers: true } });
  });
  await page.route("**/__smithers_studio/api/**", async (route) => handleApi(route, state));
}

async function handleApi(route: Route, state: ApiState) {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname.replace("/__smithers_studio/api", "");
  let body: Record<string, string | null> = {};
  try {
    body = request.postDataJSON() as Record<string, string | null>;
  } catch {}

  if (path === "/auth/status") return route.fulfill({ json: { auth: state.auth } });

  if (path === "/issues" && request.method() === "GET") {
    const filter = url.searchParams.get("state");
    const issues = filter ? state.issues.filter((issue) => issue.state === filter) : state.issues;
    return route.fulfill({ json: { issues } });
  }
  if (path === "/issues" && request.method() === "POST") {
    const issue = { id: "issue-21", number: 21, title: String(body.title), body: body.body ?? null, state: "open", labels: [], assignees: [], commentCount: 0 };
    state.issues.unshift(issue);
    return route.fulfill({ json: { issue } });
  }
  const issueClose = path.match(/^\/issues\/(\d+)\/close$/);
  if (issueClose) {
    const issue = state.issues.find((entry) => entry.number === Number(issueClose[1]))!;
    issue.state = "closed";
    return route.fulfill({ json: { issue } });
  }
  const issueReopen = path.match(/^\/issues\/(\d+)\/reopen$/);
  if (issueReopen) {
    const issue = state.issues.find((entry) => entry.number === Number(issueReopen[1]))!;
    issue.state = "open";
    return route.fulfill({ json: { issue } });
  }
  const issueDetail = path.match(/^\/issues\/(\d+)$/);
  if (issueDetail) {
    return route.fulfill({ json: { issue: state.issues.find((entry) => entry.number === Number(issueDetail[1])) } });
  }

  if (path === "/landings" && request.method() === "POST") {
    const landing = { id: "landing-8", number: 8, title: String(body.title), description: body.body ?? null, state: "open", targetBranch: body.target ?? "main", author: "will", createdAt: "2026-05-27T13:00:00Z", reviewStatus: null };
    state.landings.unshift(landing);
    return route.fulfill({ json: { landing } });
  }
  if (path === "/landings" && request.method() === "GET") return route.fulfill({ json: { landings: state.landings } });
  const landingNumber = path.match(/^\/landings\/(\d+)(?:\/(diff|checks|conflicts|review|land))?$/);
  if (landingNumber) {
    const landing = state.landings.find((entry) => entry.number === Number(landingNumber[1]))!;
    if (!landingNumber[2]) return route.fulfill({ json: { landing } });
    if (landingNumber[2] === "diff") return route.fulfill({ body: JSON.stringify({ diff: "diff --git a/app.tsx b/app.tsx\n@@ -1 +1 @@\n-old\n+new" }), contentType: "application/json" });
    if (landingNumber[2] === "checks") return route.fulfill({ json: { checks: "typecheck: success\nbuild: success" } });
    if (landingNumber[2] === "conflicts") return route.fulfill({ json: { conflicts: { conflictStatus: "conflicts", hasConflicts: true, conflicts: [{ filePath: "src/App.tsx", conflictType: "content", resolved: false }] } } });
    if (landingNumber[2] === "review") {
      landing.reviewStatus = String(body.action);
      return route.fulfill({ json: { landing } });
    }
    landing.state = "merged";
    return route.fulfill({ json: { landing } });
  }

  if (path === "/workspaces" && request.method() === "GET") return route.fulfill({ json: { workspaces: state.workspaces } });
  if (path === "/workspaces" && request.method() === "POST") {
    const workspace = { id: `ws-${state.workspaces.length + 1}`, name: String(body.name), status: "running", createdAt: "2026-05-27T14:00:00Z" };
    state.workspaces.unshift(workspace);
    return route.fulfill({ json: { workspace } });
  }
  if (path === "/workspaces/snapshots" && request.method() === "GET") return route.fulfill({ json: { snapshots: state.snapshots } });
  if (path === "/workspaces/snapshots" && request.method() === "POST") {
    const snapshot = { id: `snap-${state.snapshots.length + 1}`, workspaceId: String(body.workspaceId), name: String(body.name), createdAt: "2026-05-27T14:30:00Z" };
    state.snapshots.unshift(snapshot);
    return route.fulfill({ json: { snapshot } });
  }
  const snapshotDelete = path.match(/^\/workspaces\/snapshots\/([^/]+)$/);
  if (snapshotDelete && request.method() === "DELETE") {
    state.snapshots = state.snapshots.filter((entry) => entry.id !== snapshotDelete[1]);
    return route.fulfill({ json: { ok: true } });
  }
  const workspaceAction = path.match(/^\/workspaces\/([^/]+)\/(suspend|resume|fork)$/);
  if (workspaceAction) {
    const workspace = state.workspaces.find((entry) => entry.id === workspaceAction[1])!;
    if (workspaceAction[2] === "suspend") workspace.status = "suspended";
    if (workspaceAction[2] === "resume") workspace.status = "running";
    if (workspaceAction[2] === "fork") {
      const forked = { id: "ws-fork", name: String(body.name), status: "running", createdAt: "2026-05-27T15:00:00Z" };
      state.workspaces.unshift(forked);
      return route.fulfill({ json: { workspace: forked } });
    }
    return route.fulfill({ json: { ok: true } });
  }
  const workspaceDelete = path.match(/^\/workspaces\/([^/]+)$/);
  if (workspaceDelete && request.method() === "DELETE") {
    state.workspaces = state.workspaces.filter((entry) => entry.id !== workspaceDelete[1]);
    return route.fulfill({ json: { ok: true } });
  }

  return route.fulfill({ status: 404, json: { error: `Unhandled fixture route ${request.method()} ${path}` } });
}

test("issues use real workspace routes for auth, list, create, detail, close, reopen, and refresh", async ({ page }) => {
  await installWorkspaceApi(page, defaultState());
  await page.goto("/");
  await page.getByRole("button", { name: "Issues" }).click();
  await expect(page.getByText("Fix panel refresh")).toBeVisible();

  await page.getByRole("button", { name: "New Issue" }).click();
  await page.getByPlaceholder("Issue title").fill("New route issue");
  await page.getByPlaceholder("Issue description (optional)").fill("Created through API");
  await page.getByRole("button", { name: "Create Issue" }).click();
  await expect(page.getByText("Created issue #21.")).toBeVisible();

  await page.locator(".issue-row", { hasText: "New route issue" }).click();
  await page.getByRole("button", { name: "Close Issue" }).first().click();
  await page.getByRole("button", { name: "Close Issue" }).last().click();
  await expect(page.getByText("Closed issue #21.")).toBeVisible();
  await page.getByRole("button", { name: "Reopen Issue" }).click();
  await expect(page.getByText("Reopened issue #21.")).toBeVisible();
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByText("Loaded")).toBeVisible();
});

test("landings expose filters, detail tabs, unified diffs, checks, conflicts, review, and land actions", async ({ page }) => {
  await installWorkspaceApi(page, defaultState());
  await page.goto("/");
  await page.getByRole("button", { name: "Landings" }).click();
  await page.getByRole("combobox").selectOption("open");
  await expect(page.locator(".landing-row", { hasText: "Ship parity panels" })).toBeVisible();

  await page.locator(".landing-row", { hasText: "Ship parity panels" }).click();
  await page.getByRole("button", { name: "Diff" }).click();
  await expect(page.locator(".diff-content")).toContainText("diff --git");
  await page.getByRole("button", { name: "Checks" }).click();
  await expect(page.getByText("typecheck: success")).toBeVisible();
  await page.getByRole("button", { name: "Conflicts" }).click();
  await expect(page.getByText("src/App.tsx")).toBeVisible();
  await page.getByRole("button", { name: "Info" }).click();
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Review submitted: approve.")).toBeVisible();
  await page.locator(".landing-actions").getByRole("button", { name: "Land" }).click();
  await expect(page.locator(".modal-content")).toContainText("Land #7");
  await page.locator(".modal-content").getByRole("button", { name: "Land" }).click();
  await expect(page.getByText("Landed #7.")).toBeVisible();
});

test("workspaces support CRUD, suspend/resume, fork, snapshot, delete, and restore naming with snapshot selection", async ({ page }) => {
  await installWorkspaceApi(page, defaultState());
  await page.goto("/");
  await page.getByRole("button", { name: "Workspaces" }).click();
  await expect(page.getByText("studio-main")).toBeVisible();

  await page.getByRole("button", { name: "New Workspace" }).click();
  await page.getByPlaceholder("Workspace name").fill("created-ws");
  await page.getByRole("button", { name: "Create Workspace" }).click();
  await expect(page.getByText("Created workspace created-ws.")).toBeVisible();

  const studioMain = page.locator(".workspace-item", { hasText: "studio-main" });
  await studioMain.click();
  await studioMain.getByRole("button", { name: "Suspend" }).click();
  await expect(page.getByText("Suspended workspace studio-main.")).toBeVisible();
  await page.getByRole("button", { name: "Resume" }).first().click();
  await expect(page.getByText("Resumed workspace studio-main.")).toBeVisible();

  await page.getByRole("button", { name: "Fork" }).first().click();
  await page.getByPlaceholder("Fork name").fill("forked-ws");
  await page.getByRole("button", { name: "Fork" }).last().click();
  await expect(page.getByText("Forked workspace to forked-ws.")).toBeVisible();

  await page.getByRole("combobox").selectOption("snapshots");
  await page.getByRole("button", { name: "New Snapshot" }).click();
  await page.getByPlaceholder("Snapshot name").fill("snapshot-from-ui");
  await page.getByRole("button", { name: "Create Snapshot" }).click();
  await expect(page.getByText("Created snapshot snapshot-from-ui.")).toBeVisible();

  await page.getByRole("button", { name: "Restore" }).first().click();
  await page.getByPlaceholder("Restored workspace name").fill("restored-from-ui");
  await page.getByRole("combobox").last().selectOption("snap-1");
  await page.locator(".modal-content").getByRole("button", { name: "Restore" }).click();
  await page.getByRole("button", { name: "Create Workspace" }).click();
  await expect(page.getByText("Created workspace restored-from-ui.")).toBeVisible();

  await page.getByRole("button", { name: "Delete" }).first().click();
  await page.getByRole("button", { name: "Delete" }).last().click();
  await expect(page.getByText(/Deleted workspace|Deleted snapshot/)).toBeVisible();
});

test("JJHub missing-token states are visible", async ({ page }) => {
  const state = defaultState();
  state.auth = { loggedIn: false, tokenSet: false };
  await installWorkspaceApi(page, state);
  await page.goto("/");
  await page.getByRole("button", { name: "Issues" }).click();
  await expect(page.getByText("JJHub Authentication Required")).toBeVisible();
  await expect(page.getByText("Please authenticate with JJHub to access issues.")).toBeVisible();
});
