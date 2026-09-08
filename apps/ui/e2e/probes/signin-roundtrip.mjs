// Real signed-in probe against a deployed host using the persistent test profile.
// Usage: node apps/ui/e2e/probes/signin-roundtrip.mjs [https://smithers.sh] [owner/repo]
//
// Proves the GitHub OAuth round trip: start the sign-in at the host, land back on it, open the
// repository page, and read "Account · @<user>" from the Account card. Never prints credentials:
// the password is read from a notes file outside the repository and only the redacted URL and the
// verdict reach stdout. Re-logs the saved GitHub test account in when the persistent session expired.
//
// The defaults below are overridable only through the environment (never through argv):
//   SMITHERS_E2E_PROFILE  persistent Chromium profile directory (default ~/.multi-e2e-profile)
//   SMITHERS_E2E_NOTES    notes file outside the repo holding a `password: <value>` line
//                         (default the multi-test-github-account memory file)
//   SMITHERS_E2E_USER     GitHub login of the test account (default codeplanesmithers)
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const base = process.argv[2] ?? "https://smithers.sh";
const repo = process.argv[3] ?? "smithersai/smithers";
const home = homedir();
const profile = process.env.SMITHERS_E2E_PROFILE ?? join(home, ".multi-e2e-profile");
const notes = process.env.SMITHERS_E2E_NOTES
  ?? join(home, ".claude/projects/-Users-williamcory-multi/memory/multi-test-github-account.md");
const user = process.env.SMITHERS_E2E_USER ?? "codeplanesmithers";
const readPassword = () => {
  try { return (readFileSync(notes, "utf8").match(/password\s*[:=]\s*`?([^`\s]+)`?/i) || [])[1]; } catch { return undefined; }
};
const pass = readPassword();
const redact = (url) => url.replace(/state=[^&]+/, "state=…").replace(/code=[^&]+/, "code=…");
const ctx = await chromium.launchPersistentContext(profile, { headless: true, viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const fail = async (why) => { console.log("FAIL:", why, "at", redact(page.url())); await ctx.close(); process.exit(1); };
await page.goto(`${base}/api/auth/github/start`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(2500);
if (/github\.com\/(login|session)/.test(page.url())) {
  if (!pass) await fail("saved GitHub session expired and no password line in the notes file (SMITHERS_E2E_NOTES)");
  await page.fill("#login_field", user); await page.fill("#password", pass);
  await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {}), page.click('input[type="submit"][name="commit"]')]);
  await page.waitForTimeout(3000);
  const body = await page.evaluate(() => document.body.innerText);
  if (/github\.com/.test(page.url()) && /device verification|verification code|two-factor|Verify your device/i.test(body)) await fail("GitHub asks for a device or 2FA code; complete it once in the profile");
  if (/Incorrect username or password|does not support password/i.test(body)) await fail("GitHub refused the test account's credentials");
}
for (let i = 0; i < 3; i++) {
  const auth = page.getByRole("button", { name: /^authorize/i }).first();
  if (!(await auth.count())) break;
  await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {}), auth.click()]);
  await page.waitForTimeout(3000);
}
await page.waitForTimeout(4000);
const landed = page.url();
if (!landed.startsWith(base)) await fail(`OAuth did not return to ${base}`);
await page.goto(`${base}/${repo}`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(7000);
const text = await page.evaluate(() => document.body.innerText);
if (/sign in with github/i.test(text)) await fail("app page still shows the sign-in door");
const acct = page.getByRole("button", { name: /^account$/i }).first();
if (!(await acct.count())) await fail("no Account chrome button");
await acct.click(); await page.waitForTimeout(3000);
const t2 = await page.evaluate(() => document.body.innerText);
if (!new RegExp(`Account · @${user}`, "i").test(t2)) await fail("Account card does not name the test user");
console.log(`OK: OAuth returned to ${redact(landed)}; ${repo} signed in as @${user}`);
await ctx.close();
