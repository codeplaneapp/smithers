import { expect, test, type Page, type Route } from "@playwright/test";

// Regression test for fix/studio-landings-stale-response-guard.
//
// Bug: selecting landing A and opening the Diff/Checks/Conflicts tab fires an
// async request. If the user switches to landing B before A's response resolves,
// A's late-arriving response used to overwrite B's freshly loaded state because
// the tab-loader effect called setDiffText/setChecksText/setConflicts
// unconditionally. The fix guards each setter with a ref to the currently
// selected landing id, dropping responses that no longer match.
//
// This spec reproduces the race deterministically by holding landing A's diff
// response open until after B's diff has loaded, then releasing A's response and
// asserting B's diff is never clobbered.

type Landing = {
  id: string;
  number: number;
  title: string;
  description: string | null;
  state: string;
  targetBranch: string;
  author: string;
  createdAt: string;
  reviewStatus: string | null;
};

const LANDING_A: Landing = {
  id: "landing-7",
  number: 7,
  title: "Alpha landing",
  description: "First landing.",
  state: "open",
  targetBranch: "main",
  author: "will",
  createdAt: "2026-05-27T12:00:00Z",
  reviewStatus: "pending",
};

const LANDING_B: Landing = {
  id: "landing-8",
  number: 8,
  title: "Beta landing",
  description: "Second landing.",
  state: "open",
  targetBranch: "main",
  author: "will",
  createdAt: "2026-05-27T13:00:00Z",
  reviewStatus: "pending",
};

const DIFF_A = "diff --git a/alpha.ts b/alpha.ts\n@@ -1 +1 @@\n-old-alpha\n+new-alpha";
const DIFF_B = "diff --git a/beta.ts b/beta.ts\n@@ -1 +1 @@\n-old-beta\n+new-beta";

async function installRoutes(page: Page, releaseLandingADiff: Promise<void>) {
  await page.route("**/__smithers_studio/workspace", async (route) => {
    await route.fulfill({ json: { cwd: "/tmp/studio", root: "/tmp/studio", hasSmithers: true } });
  });

  await page.route("**/__smithers_studio/api/**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace("/__smithers_studio/api", "");

    if (path === "/auth/status") {
      return route.fulfill({ json: { auth: { loggedIn: true, tokenSet: true, user: "studio-user" } } });
    }
    if (path === "/landings" && request.method() === "GET") {
      return route.fulfill({ json: { landings: [LANDING_A, LANDING_B] } });
    }

    const landingNumber = path.match(/^\/landings\/(\d+)(?:\/(diff|checks|conflicts))?$/);
    if (landingNumber) {
      const number = Number(landingNumber[1]);
      const sub = landingNumber[2];
      const landing = number === LANDING_A.number ? LANDING_A : LANDING_B;

      if (!sub) {
        return route.fulfill({ json: { landing } });
      }
      if (sub === "diff") {
        // Hold landing A's diff response open so it resolves AFTER B's diff has
        // loaded — this is the stale-response race the fix guards against.
        if (number === LANDING_A.number) {
          await releaseLandingADiff;
          return route.fulfill({ json: { diff: DIFF_A } });
        }
        return route.fulfill({ json: { diff: DIFF_B } });
      }
      if (sub === "checks") {
        return route.fulfill({ json: { checks: `checks for #${number}` } });
      }
      if (sub === "conflicts") {
        return route.fulfill({ json: { conflicts: { conflictStatus: "clean", hasConflicts: false, conflicts: [] } } });
      }
    }

    return route.fulfill({ status: 404, json: { error: `Unhandled fixture route ${request.method()} ${path}` } });
  });
}

test("late diff response for a deselected landing does not overwrite the newly selected landing", async ({ page }) => {
  let releaseLandingADiff!: () => void;
  const landingADiffGate = new Promise<void>((resolve) => {
    releaseLandingADiff = resolve;
  });

  await installRoutes(page, landingADiffGate);
  await page.goto("/");
  await page.getByRole("button", { name: "Landings" }).click();

  // Select landing A and open its Diff tab. A's diff request is now in flight
  // and intentionally blocked.
  await page.locator(".landing-row", { hasText: "Alpha landing" }).click();
  await page.getByRole("button", { name: "Diff" }).click();
  await expect(page.getByText("Loading diff...")).toBeVisible();

  // Switch to landing B before A's diff resolves. B's diff resolves immediately.
  await page.locator(".landing-row", { hasText: "Beta landing" }).click();
  await page.getByRole("button", { name: "Diff" }).click();
  await expect(page.locator(".diff-content")).toContainText("new-beta");

  // Now release A's stale diff response. With the guard in place it must be
  // dropped; without the guard it overwrites B's diff with A's content.
  releaseLandingADiff();

  // Give the stale response time to (incorrectly) land, then assert B's diff
  // is still shown and A's content never appears.
  await expect(page.locator(".diff-content")).toContainText("new-beta");
  await expect(page.locator(".diff-content")).not.toContainText("new-alpha");
});
