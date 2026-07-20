import type { Diff } from "./Diff";

/**
 * The seeded diff for the auth-refactor run. A real build would assemble this
 * from the run's DiffBundle; the shape is the same. This bundle is hand-built to
 * exercise every diff-surface feature deterministically (no Math.random, no
 * Date): a modified file with two hunks and dual old/new gutters, a plain
 * modified file, an added "New file", a deleted file, a renamed file with a
 * mode change, and a binary blob.
 *
 * `@@ … @@` headers ride along as `context` lines so `groupHunks` can split a
 * file's flat lines back into hunks. Each line carries `lnOld` (old-file number,
 * blank on additions) and `ln` (new-file number, blank on deletions) to feed the
 * dual gutter.
 */
export const AUTH_REFACTOR_DIFF: Diff = {
  id: "auth",
  title: "Changes · auth refactor",
  totalAdd: 67,
  totalDel: 234,
  files: [
    // (1) modified — two hunks, so the content pane shows two @@ headers.
    {
      path: "auth/session.ts",
      status: "modified",
      add: 22,
      del: 8,
      sizeBytes: 4_210,
      lines: [
        { kind: "context", text: "@@ -41,5 +41,6 @@ export function createSession(user: User) {" },
        { kind: "context", lnOld: 41, ln: 41, text: "export function createSession(user: User) {" },
        { kind: "del", lnOld: 42, text: "  const token = sign(user.id)" },
        { kind: "add", ln: 42, text: "  const token = sign(user.id, { ttl: ROTATE_TTL })" },
        { kind: "add", ln: 43, text: "  schedule(rotate, ROTATE_TTL)" },
        { kind: "context", lnOld: 43, ln: 44, text: "  return { token, user }" },
        { kind: "context", lnOld: 44, ln: 45, text: "}" },
        { kind: "context", text: "@@ -88,4 +89,5 @@ export function revokeSession(id: string) {" },
        { kind: "context", lnOld: 88, ln: 89, text: "export function revokeSession(id: string) {" },
        { kind: "del", lnOld: 89, text: "  store.delete(id)" },
        { kind: "add", ln: 90, text: "  store.delete(id)" },
        { kind: "add", ln: 91, text: "  audit('session.revoke', { id })" },
        { kind: "context", lnOld: 90, ln: 92, text: "}" },
      ],
    },
    // (2) modified — single hunk, the existing token change.
    {
      path: "auth/token.ts",
      status: "modified",
      add: 31,
      del: 9,
      sizeBytes: 5_880,
      lines: [
        { kind: "context", text: "@@ -12,4 +12,5 @@ export function sign(id: string, opts: SignOpts = {}) {" },
        { kind: "context", lnOld: 12, ln: 12, text: "export function sign(id: string, opts: SignOpts = {}) {" },
        { kind: "del", lnOld: 13, text: "  return jwt.sign({ id })" },
        { kind: "add", ln: 13, text: "  const ttl = opts.ttl ?? DEFAULT_TTL" },
        { kind: "add", ln: 14, text: "  return jwt.sign({ id }, { expiresIn: ttl })" },
        { kind: "context", lnOld: 14, ln: 15, text: "}" },
      ],
    },
    // (3) added — a brand-new file; the body shows a "New file" notice.
    {
      path: "auth/index.ts",
      status: "added",
      add: 6,
      del: 2,
      sizeBytes: 240,
      lines: [
        { kind: "context", text: "@@ -0,0 +1,4 @@" },
        { kind: "add", ln: 1, text: 'export { createSession, revokeSession } from "./session"' },
        { kind: "add", ln: 2, text: 'export { sign, verify } from "./token"' },
        { kind: "add", ln: 3, text: 'export { rotate } from "./rotate"' },
        { kind: "add", ln: 4, text: 'export { authMiddleware } from "./middleware"' },
      ],
    },
    // (4) deleted — 0 add / 212 del; the body shows a "File deleted" notice.
    {
      path: "auth/legacy-session.ts",
      status: "deleted",
      add: 0,
      del: 212,
      sizeBytes: 9_640,
      lines: [
        { kind: "context", text: "@@ -1,4 +0,0 @@" },
        { kind: "del", lnOld: 1, text: "// Legacy cookie-session store, superseded by token rotation." },
        { kind: "del", lnOld: 2, text: "export class LegacySessionStore {" },
        { kind: "del", lnOld: 3, text: "  private map = new Map<string, Session>()" },
        { kind: "del", lnOld: 4, text: "}" },
      ],
    },
    // (5) renamed — from auth/auth-mw.ts, plus an executable mode change.
    {
      path: "auth/middleware.ts",
      status: "renamed",
      oldPath: "auth/auth-mw.ts",
      add: 8,
      del: 3,
      sizeBytes: 3_120,
      modeChanges: ["old mode 100644", "new mode 100755"],
      lines: [
        { kind: "context", text: "@@ -1,4 +1,5 @@" },
        { kind: "context", lnOld: 1, ln: 1, text: "import { verify } from \"./token\"" },
        { kind: "del", lnOld: 2, text: "export function authMw(req, res, next) {" },
        { kind: "add", ln: 2, text: "export function authMiddleware(req: Req, res: Res, next: Next) {" },
        { kind: "add", ln: 3, text: "  const ok = verify(req.headers.authorization)" },
        { kind: "context", lnOld: 3, ln: 4, text: "  if (!ok) return res.status(401).end()" },
        { kind: "context", lnOld: 4, ln: 5, text: "  next()" },
      ],
    },
    // (6) binary — a generated avatar asset; the body shows a sized placeholder.
    {
      path: "auth/assets/avatar-default.png",
      status: "modified",
      isBinary: true,
      add: 0,
      del: 0,
      sizeBytes: 18_944,
      lines: [{ kind: "context", text: "Binary files a/auth/assets/avatar-default.png and b/auth/assets/avatar-default.png differ" }],
    },
  ],
};
