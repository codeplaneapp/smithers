import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertCurrentBase,
  assertMainBase,
  assertCurrentHead,
  assertChangedFileCount,
  assertPublishablePullRequest,
  foldComments,
  currentBaseSha,
  currentHeadSha,
  parseValidatedReviewArtifact,
  parseReviewArtifactEnvelope,
  publishReviewCore,
  readReviewArtifact,
  reviewPathLabel,
  validateReviewPayload,
  publishReviewMain,
} from "../../action/src/publishReview";

const HEAD = "a".repeat(40);
const BASE = "c".repeat(40);
const files = new Set(["src/index.ts"]);

function payload() {
  return {
    commit_id: HEAD,
    event: "COMMENT",
    body: "<!-- smithers-review -->\nReview @maintainers",
    comments: [{
      path: "src/index.ts",
      line: 12,
      side: "RIGHT",
      body: "Finding for @someone",
    }],
  };
}

describe("isolated review publisher validation", () => {
  test("accepts a strictly bound review and neutralizes mentions", () => {
    const review = validateReviewPayload(payload(), HEAD, files);
    expect(review.commit_id).toBe(HEAD);
    expect(review.body).toContain("@\u200bmaintainers");
    expect(review.comments[0].body).toContain("@\u200bsomeone");
  });

  test("canonical validation is idempotent and preserves exact capability paths", () => {
    const capable = new Set(["src/@literal`name`.ts"]);
    const input = {
      ...payload(),
      body: "<!-- smithers-review -->\n@team\u000bready",
      comments: [{ ...payload().comments[0], path: "src/@literal`name`.ts", body: "@person\u000cready" }],
    };
    const once = validateReviewPayload(input, HEAD, capable);
    const twice = validateReviewPayload(once, HEAD, capable);
    expect(twice).toEqual(once);
    expect(twice.comments[0].path).toBe("src/@literal`name`.ts");
    expect(twice.body).toBe("<!-- smithers-review -->\n@\u200bteam ready");
  });

  test("accepts exact normalized body/comment limits, including multibyte text", () => {
    const marker = "<!-- smithers-review -->";
    const body = { ...payload(), body: marker + "é".repeat(60_000 - marker.length), comments: [] };
    expect(validateReviewPayload(body, HEAD, files).body.length).toBe(60_000);
    expect(() => validateReviewPayload({ ...body, body: marker + "é".repeat(60_001 - marker.length) }, HEAD, files)).toThrow(/body/);
    const comment = { ...payload(), comments: [{ ...payload().comments[0], body: "🙂".repeat(5_000) }] };
    expect(validateReviewPayload(comment, HEAD, files).comments[0].body.length).toBe(10_000);
    expect(() => validateReviewPayload({ ...comment, comments: [{ ...comment.comments[0], body: "🙂".repeat(5_001) }] }, HEAD, files)).toThrow(/body/);
  });

  test("publication requires open, non-draft pull-request metadata", () => {
    const base = { state: "open", draft: false, changed_files: 1, base: { ref: "main", sha: BASE }, head: { sha: HEAD } };
    expect(() => assertPublishablePullRequest(base, HEAD, BASE)).not.toThrow();
    expect(() => assertPublishablePullRequest({ ...base, state: "closed" }, HEAD, BASE)).toThrow(/open/);
    expect(() => assertPublishablePullRequest({ ...base, draft: true }, HEAD, BASE)).toThrow(/draft/);
    expect(() => assertPublishablePullRequest({ ...base, draft: undefined }, HEAD, BASE)).toThrow(/draft/);
    expect(() => assertChangedFileCount({ changed_files: 3_001 })).toThrow(/3,000/);
    expect(() => assertChangedFileCount({ changed_files: 3_000 })).not.toThrow();
  });

  test("publication flow performs a final guard and never posts closed or draft PRs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "review-publication-race-"));
    const eventPath = join(dir, "event.json");
    const artifactDir = join(dir, "artifact");
    mkdirSync(artifactDir);
    const event = {
      action: "opened", pull_request: {
        number: 7, draft: false, head: { sha: HEAD, repo: { id: 1, full_name: "octo/widgets" } },
        base: { sha: BASE, ref: "main", repo: { id: 1, full_name: "octo/widgets" } },
      }, repository: { id: 1, full_name: "octo/widgets" },
    };
    writeFileSync(eventPath, JSON.stringify(event));
    writeFileSync(join(artifactDir, "review.json"), JSON.stringify({
      schemaVersion: 2, repository: "octo/widgets", prNumber: 7, headSha: HEAD, baseSha: BASE,
      eventName: "pull_request", changedFiles: ["src/index.ts"], review: payload(),
    }));
    const originalFetch = globalThis.fetch;
    const originalEnv = { ...process.env };
    try {
      for (const state of ["closed", "draft"] as const) {
        let posts = 0;
        globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
          const url = String(input);
          if (init?.method === "POST") { posts += 1; return new Response("unexpected post", { status: 201 }); }
          return new Response(JSON.stringify({ state: state === "draft" ? "open" : "closed", draft: state === "draft", changed_files: 1, base: { ref: "main", sha: BASE }, head: { sha: HEAD } }), { status: 200 });
        }) as unknown as typeof fetch;
        Object.assign(process.env, { GH_TOKEN: "token", GITHUB_REPOSITORY: "octo/widgets", GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventPath, SMITHERS_REVIEW_ARTIFACT_DIR: artifactDir, GITHUB_API_URL: "https://api.github.com" });
        await expect(publishReviewMain()).rejects.toThrow(state === "closed" ? /open/ : /draft/);
        expect(posts).toBe(0);
      }
    } finally {
      globalThis.fetch = originalFetch;
      process.env = originalEnv;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("shared publisher lifecycle excludes the current and concurrently newer review", async () => {
    const calls: Array<{ method: string; url: string; body?: string }> = [];
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const url = String(input);
      calls.push({ method, url, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
      if (method === "POST") {
        return new Response(JSON.stringify({ id: 20, user: { login: "smithers-bot" }, html_url: "https://github.com/octo/widgets/pull/7#pullrequestreview-20" }), { status: 201 });
      }
      if (method === "PUT") return new Response("{}", { status: 200 });
      if (url.includes("/reviews?")) {
        return new Response(JSON.stringify([
          { id: 18, body: "Unrelated review quoting <!-- smithers-review -->", user: { login: "smithers-bot" } },
          { id: 19, body: "<!-- smithers-review -->\nOld", user: { login: "smithers-bot" } },
          { id: 20, body: "<!-- smithers-review -->\nCurrent", user: { login: "smithers-bot" } },
          { id: 21, body: "<!-- smithers-review -->\nConcurrent newer", user: { login: "smithers-bot" } },
        ]), { status: 200 });
      }
      return new Response(JSON.stringify({
        state: "open", draft: false, changed_files: 1,
        base: { ref: "main", sha: BASE }, head: { sha: HEAD },
      }), { status: 200 });
    }) as typeof fetch;
    const result = await publishReviewCore({
      repository: "octo/widgets", prNumber: 7, token: "token", expectedHead: HEAD, expectedBase: BASE,
      expectedCount: 1, payload: validateReviewPayload(payload(), HEAD, files), fetchImpl,
    });
    expect(result).toMatchObject({ folded: false, reviewId: 20, superseded: 1 });
    expect(calls.map((call) => call.method)).toEqual(["GET", "POST", "GET", "PUT"]);
    expect(calls.at(-1)?.url).toEndWith("/reviews/19");
    expect(calls.some((call) => call.url.endsWith("/reviews/18"))).toBe(false);
  });

  test("re-fetches and re-guards immediately before a folded fallback POST", async () => {
    const dir = mkdtempSync(join(tmpdir(), "review-publication-fallback-race-"));
    const eventPath = join(dir, "event.json");
    const artifactDir = join(dir, "artifact");
    mkdirSync(artifactDir);
    const event = {
      action: "opened", pull_request: {
        number: 7, draft: false, head: { sha: HEAD, repo: { id: 1, full_name: "octo/widgets" } },
        base: { sha: BASE, ref: "main", repo: { id: 1, full_name: "octo/widgets" } },
      }, repository: { id: 1, full_name: "octo/widgets" },
    };
    writeFileSync(eventPath, JSON.stringify(event));
    writeFileSync(join(artifactDir, "review.json"), JSON.stringify({
      schemaVersion: 2, repository: "octo/widgets", prNumber: 7, headSha: HEAD, baseSha: BASE,
      eventName: "pull_request", changedFiles: ["src/index.ts"], review: payload(),
    }));
    const originalFetch = globalThis.fetch;
    const originalEnv = { ...process.env };
    const calls: string[] = [];
    try {
      globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(init?.method === "POST" ? "POST" : "GET");
        if (init?.method === "POST") return new Response("too many comments", { status: 422 });
        const guardNumber = calls.filter((call) => call === "GET").length;
        return new Response(JSON.stringify({ state: "open", draft: false, changed_files: 1, base: { ref: "main", sha: BASE }, head: { sha: guardNumber === 1 ? HEAD : "b".repeat(40) } }), { status: 200 });
      }) as unknown as typeof fetch;
      Object.assign(process.env, { GH_TOKEN: "token", GITHUB_REPOSITORY: "octo/widgets", GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventPath, SMITHERS_REVIEW_ARTIFACT_DIR: artifactDir, GITHUB_API_URL: "https://api.github.com" });
      await expect(publishReviewMain()).rejects.toThrow(/head changed/);
      expect(calls).toEqual(["GET", "POST", "GET"]);
      expect(calls.filter((call) => call === "POST")).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
      process.env = originalEnv;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("changed_files is a required authoritative bounded count", () => {
    expect(() => assertChangedFileCount({})).toThrow(/3,000/);
    expect(() => assertChangedFileCount({ changed_files: 0 })).toThrow(/3,000/);
    expect(() => assertChangedFileCount({ changed_files: 3_001 })).toThrow(/3,000/);
    expect(() => assertChangedFileCount({ changed_files: 3_000 })).not.toThrow();
  });

  test("foldComments always stays bounded and reports omitted findings", () => {
    const comments = Array.from({ length: 100 }, (_, index) => ({
      path: "src/index.ts", line: index + 1, side: "RIGHT" as const,
      body: `finding ${index} ${"x".repeat(900)}`,
    }));
    const folded = foldComments(validateReviewPayload({ ...payload(), body: `<!-- smithers-review -->${"y".repeat(59_900)}`, comments }, HEAD, files));
    expect(folded.comments).toEqual([]);
    expect(folded.body.length).toBeLessThanOrEqual(60_000);
    expect(folded.body).toMatch(/omitted due to review size limits/);
    expect(folded.body).toContain("review body truncated to fit");
    expect(validateReviewPayload(folded, HEAD, new Set())).toEqual(folded);
  });

  test("foldComments counts skipped findings even when a later finding fits", () => {
    const large = { path: "src/index.ts", line: 1, side: "RIGHT" as const, body: "L".repeat(10_000) };
    const small = { path: "src/index.ts", line: 2, side: "RIGHT" as const, body: "later finding" };
    const source = validateReviewPayload({ ...payload(), body: `<!-- smithers-review -->${"x".repeat(51_000)}`, comments: [large, small] }, HEAD, files);
    const folded = foldComments(source);
    expect(folded.body).toContain("later finding");
    expect(folded.body).toContain("1 inline finding omitted");
    expect(folded.body.length).toBeLessThanOrEqual(60_000);
    expect(validateReviewPayload(folded, HEAD, new Set())).toEqual(folded);
  });

  test("foldComments preserves markdown line breaks and normalizes lone surrogates", () => {
    const source = validateReviewPayload({
      ...payload(),
      body: "<!-- smithers-review -->\nSummary\n\nDetails \ud800",
      comments: [{ path: "src/index.ts", line: 1, side: "RIGHT", body: "First line\n\nSecond line \udc00" }],
    }, HEAD, files);
    const folded = foldComments(source);
    expect(folded.body).toContain("Summary\n\nDetails �");
    expect(folded.body).toContain("First line\n\nSecond line �");
    expect(folded.body).not.toMatch(/[\ud800-\udfff]/);
  });


  test("fails closed when the live head moved or GitHub returns an invalid head", () => {
    expect(currentHeadSha({ head: { sha: HEAD } })).toBe(HEAD);
    expect(() => assertCurrentHead({ head: { sha: "b".repeat(40) } }, HEAD)).toThrow(/changed/);
    expect(() => assertCurrentHead({ head: { sha: "not-a-sha" } }, HEAD)).toThrow(/invalid/);
  });

  test("fails closed when the live base moved or GitHub returns an invalid base", () => {
    expect(currentBaseSha({ base: { sha: BASE } })).toBe(BASE);
    expect(() => assertCurrentBase({ base: { sha: "d".repeat(40) } }, BASE)).toThrow(/base changed/);
    expect(() => assertCurrentBase({ base: { sha: "not-a-sha" } }, BASE)).toThrow(/base is invalid/);
  });

  test("publishes only to pull requests that still target main", () => {
    expect(() => assertMainBase({ base: { ref: "main" } })).not.toThrow();
    expect(() => assertMainBase({ base: { ref: "release" } })).toThrow(/targets main/);
    expect(() => assertMainBase({})).toThrow(/targets main/);
  });

  test("renders hostile fallback filenames as one mention-safe code label", () => {
    const label = reviewPathLabel("src/`break`\n@maintainers\r.ts");
    expect(label).toBe("src/'break' @\u200bmaintainers .ts");
    expect(label).not.toMatch(/[\r\n`]/);
  });

  test("rejects a different commit, extra top-level fields, and non-COMMENT events", () => {
    expect(() => validateReviewPayload({ ...payload(), commit_id: "b".repeat(40) }, HEAD, files)).toThrow(/commit_id/);
    expect(() => validateReviewPayload({ ...payload(), repository: "other/repo" }, HEAD, files)).toThrow(/schema/);
    expect(() => validateReviewPayload({ ...payload(), event: "APPROVE" }, HEAD, files)).toThrow(/COMMENT/);
  });

  test("rejects comments outside the changed-file set and malformed ranges", () => {
    const outside = payload();
    outside.comments[0].path = "../../SECURITY.md";
    expect(() => validateReviewPayload(outside, HEAD, files)).toThrow(/changed file/);

    const range = payload() as any;
    range.comments[0].start_line = 20;
    range.comments[0].start_side = "RIGHT";
    expect(() => validateReviewPayload(range, HEAD, files)).toThrow(/start_line/);

    expect(() => validateReviewPayload(
      payload(),
      HEAD,
      files,
      new Map([["src/index.ts", new Set([12, 11])]]),
    )).toThrow(/noncanonical/);
  });

  test("rejects oversized bodies, too many comments, control bytes, and schema smuggling", () => {
    expect(() => validateReviewPayload({ ...payload(), body: `<!-- smithers-review -->${"x".repeat(60_001)}` }, HEAD, files)).toThrow(/body/);
    expect(() => validateReviewPayload({ ...payload(), comments: Array.from({ length: 101 }, () => payload().comments[0]) }, HEAD, files)).toThrow(/100/);
    expect(() => validateReviewPayload({ ...payload(), body: "<!-- smithers-review -->\u0000" }, HEAD, files)).toThrow(/control/);
    const smuggled = payload() as any;
    smuggled.comments[0].url = "https://attacker.invalid";
    expect(() => validateReviewPayload(smuggled, HEAD, files)).toThrow(/schema/);
  });

  test("accepts only the exact revision-bound artifact envelope", () => {
    const artifact = {
      schemaVersion: 2 as const,
      repository: "octo/widgets",
      prNumber: 7,
      headSha: HEAD,
      baseSha: BASE,
      eventName: "pull_request",
      changedFiles: ["src/index.ts"],
      review: payload(),
    };
    expect(parseReviewArtifactEnvelope(artifact)).toEqual(artifact);
    const parsed = parseValidatedReviewArtifact(artifact);
    expect(parsed).toMatchObject({
      schemaVersion: 2,
      repository: "octo/widgets",
      prNumber: 7,
      headSha: HEAD,
      baseSha: BASE,
      eventName: "pull_request",
      changedFiles: ["src/index.ts"],
    });
    expect(parsed.review.commit_id).toBe(HEAD);
    expect(parsed.review.comments[0].path).toBe("src/index.ts");
    expect(() => parseValidatedReviewArtifact({ ...artifact, summary: { publishError: "remote body" } })).toThrow(/schema/);
    expect(() => parseValidatedReviewArtifact({ ...artifact, repository: "attacker.invalid" })).toThrow(/binding/);
    expect(() => parseValidatedReviewArtifact({ ...artifact, repository: "../widgets" })).toThrow(/binding/);
    expect(() => parseValidatedReviewArtifact({ ...artifact, repository: "octo/.." })).toThrow(/binding/);
    expect(() => parseValidatedReviewArtifact({ ...artifact, changedFiles: ["src/other.ts", "src/index.ts"] })).toThrow(/binding/);
    expect(() => parseValidatedReviewArtifact({ ...artifact, review: { ...payload(), comments: [{ ...payload().comments[0], path: "src/other.ts" }] } })).toThrow(/changed file/);
  });

  test("reads one bounded regular artifact without following a final symlink", () => {
    const dir = mkdtempSync(join(tmpdir(), "review-publisher-artifact-"));
    try {
      const artifact = join(dir, "artifact.json");
      writeFileSync(artifact, JSON.stringify({ schemaVersion: 2 }));
      expect(readReviewArtifact(dir)).toEqual({ schemaVersion: 2 });
      writeFileSync(artifact, Uint8Array.from([0xff]));
      expect(() => readReviewArtifact(dir)).toThrow(/UTF-8/);
      rmSync(artifact);
      const target = join(dir, "target.txt");
      writeFileSync(target, JSON.stringify({ schemaVersion: 2 }));
      symlinkSync(target, artifact);
      expect(() => readReviewArtifact(dir)).toThrow(/exactly one/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
