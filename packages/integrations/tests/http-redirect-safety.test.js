import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { makeGitHubClient } from "../src/github/GitHubClient.js";
import { makeLinearClient } from "../src/linear/LinearClient.js";
import { makeTelegramClient } from "../src/telegram/TelegramClient.js";

let source;
let origin;
let requests = 0;

beforeAll(() => {
  source = Bun.serve({
    port: 0,
    fetch: () => {
      requests += 1;
      return new Response(null, {
        status: 302,
        headers: { location: "https://127.0.0.1/private" },
      });
    },
  });
  origin = `http://127.0.0.1:${source.port}`;
});

afterAll(() => source?.stop(true));

describe("integration redirect destination policy", () => {
  test("GitHub blocks a redirect into a private destination before contact", async () => {
    requests = 0;
    const client = makeGitHubClient({ token: "github-secret", apiBaseUrl: origin, maxRetries: 0 });
    await expect(Effect.runPromise(client.request("GET", "/redirect"))).rejects.toThrow();
    expect(requests).toBe(1);
  });

  test("Linear blocks a redirect into a private destination before contact", async () => {
    requests = 0;
    const client = makeLinearClient({ apiKey: "linear-secret", apiBaseUrl: `${origin}/graphql` });
    await expect(Effect.runPromise(client.getIssue("ENG-1"))).rejects.toThrow();
    expect(requests).toBe(1);
  });

  test("Telegram blocks a redirect into a private destination before contact", async () => {
    requests = 0;
    const client = makeTelegramClient({ botToken: "123456:telegram-secret", apiBaseUrl: origin });
    await expect(Effect.runPromise(client.call("getMe"))).rejects.toThrow();
    expect(requests).toBe(1);
  });
});
