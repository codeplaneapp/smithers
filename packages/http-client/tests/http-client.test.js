import { afterEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_MAX_REDIRECTS,
  HttpClientPolicyError,
  abortableDelay,
  assertHttpUrl,
  composeAbortSignals,
  fetchWithPolicy,
  isHttpClientPolicyError,
  isNonGlobalIpLiteral,
  readResponseBytes,
  readResponseJson,
  readResponseText,
  safeUrlLabel,
} from "../src/index.js";
import { assertPublicHostname, createPublicRedirectValidator } from "../src/node.js";

const servers = [];

/**
 * @param {(request: Request) => Response | Promise<Response>} handler
 */
function startServer(handler) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: handler,
  });
  servers.push(server);
  return server;
}

/** @param {ReturnType<typeof startServer>} server */
function httpUrl(server) {
  return `http://127.0.0.1:${server.port}`;
}

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe("URL policy", () => {
  test("accepts HTTP(S) and returns a defensive URL copy", () => {
    const source = new URL("https://example.com/path?q=1");
    const copy = assertHttpUrl(source);
    copy.pathname = "/changed";
    expect(source.pathname).toBe("/path");
    expect(assertHttpUrl("http://example.com").protocol).toBe("http:");
  });

  test.each(["file:///tmp/secret", "data:text/plain,secret", "ftp://example.com/a"]) (
    "rejects unsupported protocol %s without echoing secret URL data",
    (input) => {
      try {
        assertHttpUrl(`${input}?api_key=super-secret`);
        throw new Error("expected assertHttpUrl to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(HttpClientPolicyError);
        expect(error.code).toBe("UNSUPPORTED_PROTOCOL");
        expect(`${error.message}${JSON.stringify(error.details)}`).not.toContain("super-secret");
      }
    },
  );

  test("rejects malformed URLs without retaining parser errors that include input", () => {
    const secret = "dont-print-this";
    let error;
    try {
      assertHttpUrl(`http://user:${secret}@[broken`);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(HttpClientPolicyError);
    expect(error.code).toBe("INVALID_URL");
    expect(error.cause).toBeUndefined();
    expect(`${error.message}${JSON.stringify(error.details)}`).not.toContain(secret);
  });

  test("rejects URL userinfo without retaining credentials or query data", () => {
    const secret = "userinfo-secret";
    let error;
    try {
      assertHttpUrl(`https://user:${secret}@example.com/path?token=query-secret`);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "INVALID_URL", details: { reason: "userinfo" } });
    expect(`${error.message}${JSON.stringify(error.details)}`).not.toContain(secret);
    expect(`${error.message}${JSON.stringify(error.details)}`).not.toContain("query-secret");
  });

  test("safeUrlLabel removes path credentials, userinfo, query, and fragment", () => {
    expect(safeUrlLabel(new URL("https://user:pass@example.com/path?q=secret#frag")))
      .toBe("https://example.com");
  });
});

describe("IP literal scope", () => {
  test.each([
    ["this-network lower", "0.0.0.0"],
    ["this-network upper", "0.255.255.255"],
    ["private 10/8 lower", "10.0.0.0"],
    ["private 10/8 upper", "10.255.255.255"],
    ["shared lower", "100.64.0.0"],
    ["shared upper", "100.127.255.255"],
    ["loopback lower", "127.0.0.0"],
    ["loopback upper", "127.255.255.255"],
    ["link-local lower", "169.254.0.0"],
    ["link-local upper", "169.254.255.255"],
    ["private 172/12 lower", "172.16.0.0"],
    ["private 172/12 upper", "172.31.255.255"],
    ["IETF assignments lower", "192.0.0.0"],
    ["IETF assignment before global exceptions", "192.0.0.8"],
    ["IETF assignment after global exceptions", "192.0.0.11"],
    ["IETF assignments upper", "192.0.0.255"],
    ["documentation 1 lower", "192.0.2.0"],
    ["documentation 1 upper", "192.0.2.255"],
    ["deprecated 6to4 lower", "192.88.99.0"],
    ["deprecated 6to4 upper", "192.88.99.255"],
    ["private 192/16 lower", "192.168.0.0"],
    ["private 192/16 upper", "192.168.255.255"],
    ["benchmarking lower", "198.18.0.0"],
    ["benchmarking upper", "198.19.255.255"],
    ["documentation 2 lower", "198.51.100.0"],
    ["documentation 2 upper", "198.51.100.255"],
    ["documentation 3 lower", "203.0.113.0"],
    ["documentation 3 upper", "203.0.113.255"],
    ["multicast lower", "224.0.0.0"],
    ["reserved/broadcast upper", "255.255.255.255"],
    ["integer loopback spelling", "2130706433"],
    ["octal loopback spelling", "0177.0.0.1"],
    ["hex loopback spelling", "0x7f000001"],
  ])("classifies non-global IPv4: %s", (_label, address) => {
    expect(isNonGlobalIpLiteral(address)).toBe(true);
  });

  test.each([
    ["Cloudflare", "1.1.1.1"],
    ["Google", "8.8.8.8"],
    ["just above shared address space", "100.128.0.0"],
    ["PCP anycast exception", "192.0.0.9"],
    ["TURN anycast exception", "192.0.0.10"],
    ["AS112", "192.31.196.1"],
    ["AMT", "192.52.193.1"],
    ["direct AS112", "192.175.48.1"],
    ["last ordinary unicast block", "223.255.255.255"],
  ])("classifies globally reachable IPv4: %s", (_label, address) => {
    expect(isNonGlobalIpLiteral(address)).toBe(false);
  });

  test.each([
    ["unspecified", "::"],
    ["loopback", "::1"],
    ["mapped private IPv4", "::ffff:127.0.0.1"],
    ["mapped public IPv4", "::ffff:8.8.8.8"],
    ["NAT64 translation", "64:ff9b::a9fe:a9fe"],
    ["discard-only", "100::1"],
    ["Teredo", "2001::1"],
    ["IETF assignment non-exception", "2001:1::4"],
    ["IETF assignments upper", "2001:1ff:ffff::1"],
    ["benchmarking", "2001:2::1"],
    ["documentation 1", "2001:db8::1"],
    ["6to4", "2002:7f00:1::"],
    ["documentation 2", "3fff::1"],
    ["SRv6 special", "5f00::1"],
    ["unique-local", "fc00::1"],
    ["link-local", "fe80::1"],
    ["multicast", "ff02::1"],
    ["outside current global unicast", "4000::1"],
  ])("classifies non-global IPv6: %s", (_label, address) => {
    expect(isNonGlobalIpLiteral(address)).toBe(true);
  });

  test.each([
    ["PCP anycast", "2001:1::1"],
    ["TURN anycast", "2001:1::2"],
    ["DNS-SD anycast", "2001:1::3"],
    ["AMT", "2001:3::1"],
    ["AS112", "2001:4:112::1"],
    ["ORCHIDv2", "2001:20::1"],
    ["DETs", "2001:30::1"],
    ["just above IETF assignments", "2001:200::1"],
    ["Google", "2001:4860:4860::8888"],
    ["Cloudflare", "2606:4700:4700::1111"],
  ])("classifies globally reachable IPv6: %s", (_label, address) => {
    expect(isNonGlobalIpLiteral(address)).toBe(false);
  });

  test.each(["example.com", "localhost", "api.internal.example"]) (
    "does not classify a hostname as an IP literal: %s",
    (hostname) => {
      expect(isNonGlobalIpLiteral(hostname)).toBe(false);
    },
  );
});

describe("Node hostname policy", () => {
  test("accepts global literals without DNS and all-global hostname answers", async () => {
    let lookups = 0;
    const resolveHostname = async () => {
      lookups += 1;
      return ["8.8.8.8", "2606:4700:4700::1111"];
    };
    await expect(assertPublicHostname("8.8.8.8", { resolveHostname })).resolves.toBeUndefined();
    expect(lookups).toBe(0);
    await expect(assertPublicHostname("public.example", { resolveHostname })).resolves.toBeUndefined();
    expect(lookups).toBe(1);
  });

  test("fails closed for local names, mixed private answers, and resolution errors", async () => {
    await expect(assertPublicHostname("localhost", {
      resolveHostname: async () => ["8.8.8.8"],
    })).rejects.toMatchObject({ code: "INVALID_URL", details: { reason: "non-public-destination" } });
    await expect(assertPublicHostname("alias.example", {
      resolveHostname: async () => ["8.8.8.8", "127.0.0.1"],
    })).rejects.toMatchObject({ code: "INVALID_URL", details: { reason: "dns-non-public-address" } });
    await expect(assertPublicHostname("missing.example", {
      resolveHostname: async () => { throw new Error("NXDOMAIN internal detail"); },
    })).rejects.toMatchObject({ code: "INVALID_URL", details: { reason: "dns-resolution-failed" } });
  });

  test("preserves the exact caller abort reason while DNS is pending", async () => {
    const controller = new AbortController();
    const reason = new DOMException("cancel DNS policy", "AbortError");
    const pending = assertPublicHostname("pending.example", {
      resolveHostname: async () => new Promise(() => {}),
      signal: controller.signal,
    });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  test("redirect validator trusts configured origins but rejects private untrusted hops", async () => {
    const resolveHostname = async () => ["8.8.8.8"];
    const validate = createPublicRedirectValidator("http://127.0.0.1:3000/api", {
      allowedOrigins: ["https://10.0.0.1:8443/intentional"],
      resolveHostname,
    });
    await expect(validate(new URL("http://127.0.0.1:3000/start"), { initial: true }))
      .resolves.toBeUndefined();
    await expect(validate(new URL("http://127.0.0.1:3000/redirect"), {
      initial: false,
      from: new URL("http://127.0.0.1:3000/start"),
    })).resolves.toBeUndefined();
    await expect(validate(new URL("https://10.0.0.1:8443/private"), {
      initial: false,
      from: new URL("http://127.0.0.1:3000/start"),
    })).resolves.toBeUndefined();
    await expect(validate(new URL("https://public.example/final"), {
      initial: false,
      from: new URL("http://127.0.0.1:3000/start"),
    })).resolves.toBeUndefined();
    await expect(validate(new URL("https://127.0.0.1/private"), {
      initial: false,
      from: new URL("http://127.0.0.1:3000/start"),
    })).rejects.toMatchObject({
      code: "INVALID_URL",
      details: { reason: "non-public-destination" },
    });
    const privateDnsRedirect = createPublicRedirectValidator("https://provider.example/api", {
      resolveHostname: async () => ["8.8.8.8", "10.0.0.1"],
    });
    await expect(privateDnsRedirect(new URL("https://alias.example/private"), {
      initial: false,
      from: new URL("https://provider.example/start"),
    })).rejects.toMatchObject({
      code: "INVALID_URL",
      details: { reason: "dns-non-public-address" },
    });
  });
});

describe("redirect and credential policy", () => {
  test("performs a normal request and validates the initial destination", async () => {
    const seen = [];
    const server = startServer((request) => Response.json({ url: request.url }));
    const response = await fetchWithPolicy(`${httpUrl(server)}/ok`, {}, {
      validateUrl(url, context) {
        seen.push({ url: safeUrlLabel(url), ...context });
      },
    });
    expect(await response.json()).toEqual({ url: `${httpUrl(server)}/ok` });
    expect(seen).toHaveLength(1);
    expect(seen[0].initial).toBe(true);
    expect(seen[0].from).toBeUndefined();
  });

  test("keeps the standard url/init shape for injectable Fetch transports", async () => {
    let call;
    const headers = { "X-Test-Key": "value", "Content-Type": "text/plain" };
    const response = await fetchWithPolicy("https://api.example.test/items", {
      method: "POST",
      headers,
      body: "payload",
    }, {
      fetch: async (url, init) => {
        call = { url, init };
        return new Response("ok");
      },
    });
    expect(await response.text()).toBe("ok");
    expect(call.url).toBe("https://api.example.test/items");
    expect(call.init.method).toBe("POST");
    expect(new Headers(call.init.headers).get("x-test-key")).toBe("value");
    expect(new Headers(call.init.headers).get("content-type")).toBe("text/plain");
    expect(call.init.body).toBe("payload");
    expect(call.init.redirect).toBe("manual");
  });

  test("snapshots mutable headers for the first request and redirects", async () => {
    const headers = new Headers({ "x-request-value": "before" });
    const observed = [];
    let releaseDispatch;
    const dispatched = new Promise((resolve) => {
      releaseDispatch = resolve;
    });
    let continueDispatch;
    const mayRead = new Promise((resolve) => {
      continueDispatch = resolve;
    });
    let calls = 0;
    const pending = fetchWithPolicy("https://api.example.test/start", { headers }, {
      fetch: async (_url, init) => {
        calls += 1;
        if (calls === 1) {
          releaseDispatch();
          await mayRead;
        }
        observed.push(new Headers(init.headers).get("x-request-value"));
        if (calls === 1) {
          return new Response(null, { status: 307, headers: { location: "/final" } });
        }
        return new Response("ok");
      },
    });

    await dispatched;
    headers.set("x-request-value", "after");
    continueDispatch();
    expect(await (await pending).text()).toBe("ok");
    expect(observed).toEqual(["before", "before"]);
  });

  test.each([
    {
      label: "URLSearchParams",
      make: () => new URLSearchParams({ value: "before" }),
      mutate: (body) => body.set("value", "after"),
      expected: "value=before",
    },
    {
      label: "ArrayBuffer",
      make: () => new TextEncoder().encode("before").buffer,
      mutate: (body) => new Uint8Array(body).set(new TextEncoder().encode("after!")),
      expected: "before",
    },
    {
      label: "typed-array view",
      make: () => new TextEncoder().encode("before"),
      mutate: (body) => body.set(new TextEncoder().encode("after!")),
      expected: "before",
    },
  ])("snapshots a mutable $label body for identical first-hop and redirect bytes", async ({ make, mutate, expected }) => {
    const body = make();
    const observed = [];
    let releaseFirst;
    const firstObserved = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    let continueFirst;
    const mayRedirect = new Promise((resolve) => {
      continueFirst = resolve;
    });
    let calls = 0;
    const pending = fetchWithPolicy("https://api.example.test/start", {
      method: "POST",
      body,
    }, {
      fetch: async (_url, init) => {
        calls += 1;
        if (calls === 1) {
          releaseFirst();
          await mayRedirect;
        }
        observed.push(await new Response(init.body).text());
        if (calls === 1) {
          return new Response(null, { status: 307, headers: { location: "/final" } });
        }
        return new Response("ok");
      },
    });

    await firstObserved;
    mutate(body);
    continueFirst();
    expect(await (await pending).text()).toBe("ok");
    expect(observed).toEqual([expected, expected]);
  });

  test("keeps generated multipart boundaries aligned with encoded FormData", async () => {
    const server = startServer(async (request) => {
      const form = await request.formData();
      return Response.json({
        value: form.get("value"),
        filename: form.get("document")?.name,
        text: await form.get("document")?.text(),
        apiKey: request.headers.get("x-api-key"),
      });
    });
    const form = new FormData();
    form.set("value", "ok");
    form.set("document", new File(["multipart body"], "report.txt", { type: "text/plain" }));

    const response = await fetchWithPolicy(`${httpUrl(server)}/upload`, {
      method: "POST",
      headers: { "x-api-key": "multipart-secret" },
      body: form,
    });

    expect(await response.json()).toEqual({
      value: "ok",
      filename: "report.txt",
      text: "multipart body",
      apiKey: "multipart-secret",
    });
  });

  test("preserves caller abort reason identity through a real pending fetch", async () => {
    const server = startServer(() => new Promise((resolve) => {
      setTimeout(() => resolve(new Response("too late")), 1_000);
    }));
    const controller = new AbortController();
    const reason = new DOMException("caller cancelled", "AbortError");
    const pending = fetchWithPolicy(`${httpUrl(server)}/slow`, {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(reason), 10);
    let caught;
    try {
      await pending;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(reason);
  });

  test("never enters the transport when the request is already aborted", async () => {
    const controller = new AbortController();
    const reason = new DOMException("cancelled before dispatch", "AbortError");
    controller.abort(reason);
    let calls = 0;
    let caught;
    try {
      await fetchWithPolicy("https://api.example.test/pending", {
        signal: controller.signal,
      }, {
        fetch: async () => {
          calls += 1;
          return new Response("unexpected");
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(reason);
    expect(calls).toBe(0);
  });

  test("does not dispatch when abort wins during async URL validation", async () => {
    const controller = new AbortController();
    const reason = new DOMException("cancelled during policy", "AbortError");
    let calls = 0;
    let caught;
    try {
      await fetchWithPolicy("https://api.example.test/pending", {
        signal: controller.signal,
      }, {
        async validateUrl() {
          controller.abort(reason);
          await Promise.resolve();
        },
        fetch: async () => {
          calls += 1;
          return new Response("unexpected");
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(reason);
    expect(calls).toBe(0);
  });

  test("abort preempts a URL validator that never settles", async () => {
    const controller = new AbortController();
    const reason = new DOMException("cancelled stalled policy", "AbortError");
    let calls = 0;
    const pending = fetchWithPolicy("https://api.example.test/pending", {
      signal: controller.signal,
    }, {
      validateUrl: () => new Promise(() => undefined),
      fetch: async () => {
        calls += 1;
        return new Response("unexpected");
      },
    });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(calls).toBe(0);
  });

  test("a late validator rejection cannot replace the winning abort reason", async () => {
    const controller = new AbortController();
    const reason = new DOMException("cancelled before policy rejected", "AbortError");
    let rejectValidation;
    let markStarted;
    const started = new Promise((resolve) => {
      markStarted = resolve;
    });
    const pending = fetchWithPolicy("https://api.example.test/pending", {
      signal: controller.signal,
    }, {
      validateUrl: () => new Promise((_resolve, reject) => {
        rejectValidation = reject;
        markStarted();
      }),
      fetch: async () => new Response("unexpected"),
    });
    await started;
    controller.abort(reason);
    rejectValidation(new Error("late validator failure"));
    await expect(pending).rejects.toBe(reason);
  });

  test("prefers cancellation when an adapter aborts and then resolves", async () => {
    const controller = new AbortController();
    const reason = new DOMException("adapter cancelled", "AbortError");
    let bodyCancelled = false;
    const pending = fetchWithPolicy("https://api.example.test/pending", {
      signal: controller.signal,
    }, {
      fetch: async () => {
        controller.abort(reason);
        return new Response(new ReadableStream({
          cancel() {
            bodyCancelled = true;
          },
        }));
      },
    });
    await expect(pending).rejects.toBe(reason);
    expect(bodyCancelled).toBe(true);
  });

  test("prefers cancellation when an adapter aborts and then throws", async () => {
    const controller = new AbortController();
    const reason = new DOMException("adapter cancelled", "AbortError");
    const pending = fetchWithPolicy("https://api.example.test/pending", {
      signal: controller.signal,
    }, {
      fetch: async () => {
        controller.abort(reason);
        throw new TypeError("wrapped transport error");
      },
    });
    await expect(pending).rejects.toBe(reason);
  });

  test("same-origin redirects retain sensitive headers", async () => {
    const server = startServer((request) => {
      const url = new URL(request.url);
      if (url.pathname === "/start") return Response.redirect(`${httpUrl(server)}/final`, 302);
      return Response.json({
        authorization: request.headers.get("authorization"),
        custom: request.headers.get("x-company-token"),
      });
    });
    const response = await fetchWithPolicy(`${httpUrl(server)}/start`, {
      headers: {
        Authorization: "Bearer same-origin",
        "X-Company-Token": "custom-secret",
      },
    }, { sensitiveHeaders: ["x-COMPANY-token"] });
    expect(await response.json()).toEqual({
      authorization: "Bearer same-origin",
      custom: "custom-secret",
    });
  });

  test("unauthorized cross-origin redirects strip credentials case-insensitively", async () => {
    let targetHeaders;
    let targetUrl;
    const target = startServer((request) => {
      targetHeaders = request.headers;
      targetUrl = new URL(request.url);
      return new Response("ok");
    });
    const source = startServer(() => new Response(null, {
      status: 302,
      headers: { location: `${httpUrl(target)}/final?Api_Key=query-secret&keep=yes` },
    }));

    const response = await fetchWithPolicy(`${httpUrl(source)}/start`, {
      headers: {
        "X-API-KEY": "header-secret",
        "x-CoMpAnY-ToKeN": "custom-secret",
        "x-harmless": "preserved",
        Referer: "https://internal.example/path?token=referer-secret",
        Origin: "https://internal.example",
      },
    }, {
      sensitiveHeaders: ["X-COMPANY-TOKEN"],
      sensitiveQueryParams: ["api_key"],
    });

    expect(await response.text()).toBe("ok");
    expect(targetHeaders.get("x-api-key")).toBeNull();
    expect(targetHeaders.get("x-company-token")).toBeNull();
    expect(targetHeaders.get("x-harmless")).toBe("preserved");
    expect(targetHeaders.get("referer")).toBeNull();
    expect(targetHeaders.get("origin")).toBeNull();
    expect(targetUrl.searchParams.get("Api_Key")).toBeNull();
    expect(targetUrl.searchParams.get("keep")).toBe("yes");
  });

  test("explicitly authorized origins retain credentials and replayable bodies", async () => {
    let hit = 0;
    const target = startServer(async (request) => {
      hit += 1;
      return Response.json({
        method: request.method,
        body: await request.text(),
        token: request.headers.get("x-api-key"),
      });
    });
    const source = startServer(() => new Response(null, {
      status: 307,
      headers: { location: `${httpUrl(target)}/final` },
    }));
    const response = await fetchWithPolicy(`${httpUrl(source)}/start`, {
      method: "POST",
      headers: { "x-api-key": "allowed-secret", "content-type": "text/plain" },
      body: "payload",
    }, { allowedOrigins: [`${httpUrl(target)}/any/path`] });
    expect(await response.json()).toEqual({
      method: "POST",
      body: "payload",
      token: "allowed-secret",
    });
    expect(hit).toBe(1);
  });

  test("credentials stripped on one hop are never reintroduced later", async () => {
    const observations = [];
    let source;
    const middle = startServer((request) => {
      observations.push(request.headers.get("authorization"));
      return new Response(null, {
        status: 302,
        headers: { location: `${httpUrl(source)}/final` },
      });
    });
    source = startServer((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/start") {
        return new Response(null, {
          status: 302,
          headers: { location: `${httpUrl(middle)}/middle` },
        });
      }
      observations.push(request.headers.get("authorization"));
      return new Response("done");
    });

    const response = await fetchWithPolicy(`${httpUrl(source)}/start`, {
      headers: { authorization: "Bearer must-not-return" },
    });
    expect(await response.text()).toBe("done");
    expect(observations).toEqual([null, null]);
  });

  test("validates each redirect destination before contacting it", async () => {
    let targetHits = 0;
    const target = startServer(() => {
      targetHits += 1;
      return new Response("unsafe");
    });
    const source = startServer(() => Response.redirect(`${httpUrl(target)}/blocked`, 302));
    const contexts = [];
    const blocked = new Error("private destination blocked");
    let caught;
    try {
      await fetchWithPolicy(`${httpUrl(source)}/start`, {}, {
        async validateUrl(url, context) {
          contexts.push({ url: safeUrlLabel(url), context });
          if (url.port === String(target.port)) throw blocked;
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(blocked);
    expect(targetHits).toBe(0);
    expect(contexts).toHaveLength(2);
    expect(contexts[1].context.initial).toBe(false);
    expect(contexts[1].context.from.origin).toBe(httpUrl(source));
  });

  test("rejects a non-HTTP redirect before contacting a destination", async () => {
    const server = startServer(() => new Response(null, {
      status: 302,
      headers: { location: "file:///tmp/redirect-secret?token=hidden" },
    }));
    await expect(fetchWithPolicy(`${httpUrl(server)}/start`)).rejects.toMatchObject({
      name: "HttpClientPolicyError",
      code: "UNSUPPORTED_PROTOCOL",
    });
  });

  test("rejects malformed redirect targets without echoing them", async () => {
    const secret = "redirect-secret";
    const server = startServer(() => new Response(null, {
      status: 302,
      headers: { location: `http://user:${secret}@[broken` },
    }));
    let error;
    try {
      await fetchWithPolicy(`${httpUrl(server)}/start`);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "INVALID_REDIRECT" });
    expect(error.cause).toBeUndefined();
    expect(`${error.message}${JSON.stringify(error.details)}`).not.toContain(secret);
  });

  test("rejects redirect userinfo without contacting or exposing the destination", async () => {
    const credential = "redirect-userinfo-secret";
    const querySecret = "redirect-query-secret";
    let targetHits = 0;
    const target = startServer(() => {
      targetHits += 1;
      return new Response("unsafe");
    });
    const destination = new URL(`${httpUrl(target)}/target`);
    destination.username = "user";
    destination.password = credential;
    destination.searchParams.set("token", querySecret);
    const source = startServer(() => new Response(null, {
      status: 302,
      headers: { location: destination.toString() },
    }));

    let error;
    try {
      await fetchWithPolicy(`${httpUrl(source)}/start`);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "INVALID_REDIRECT" });
    expect(error.cause).toBeUndefined();
    expect(targetHits).toBe(0);
    expect(`${error.message}${JSON.stringify(error.details)}`).not.toContain(credential);
    expect(`${error.message}${JSON.stringify(error.details)}`).not.toContain(querySecret);
  });

  test("caps redirect chains", async () => {
    const server = startServer((request) => {
      const count = Number(new URL(request.url).searchParams.get("n") ?? "0");
      return new Response(null, {
        status: 302,
        headers: { location: `${httpUrl(server)}/loop?n=${count + 1}` },
      });
    });
    await expect(fetchWithPolicy(`${httpUrl(server)}/loop?n=0`, {}, { maxRedirects: 2 }))
      .rejects.toMatchObject({ code: "TOO_MANY_REDIRECTS", details: { maxRedirects: 2 } });
    expect(DEFAULT_MAX_REDIRECTS).toBe(5);
  });

  test("uses Fetch-compatible method/body rules for 302, 303, and 307", async () => {
    for (const [status, expectedMethod, expectedBody] of [
      [302, "GET", ""],
      [303, "GET", ""],
      [307, "POST", "payload"],
    ]) {
      const server = startServer(async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/start") {
          return new Response(null, {
            status,
            headers: { location: `${httpUrl(server)}/final` },
          });
        }
        return Response.json({
          method: request.method,
          body: await request.text(),
          contentType: request.headers.get("content-type"),
        });
      });
      const response = await fetchWithPolicy(`${httpUrl(server)}/start`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "payload",
      });
      const result = await response.json();
      expect(result.method).toBe(expectedMethod);
      expect(result.body).toBe(expectedBody);
      expect(result.contentType).toBe(status === 307 ? "text/plain" : null);
      server.stop(true);
      servers.splice(servers.indexOf(server), 1);
    }
  });

  test("does not reintroduce a POST body after a 302 followed by a 307", async () => {
    const server = startServer(async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/start") return Response.redirect(`${httpUrl(server)}/middle`, 302);
      if (path === "/middle") return Response.redirect(`${httpUrl(server)}/final`, 307);
      return Response.json({ method: request.method, body: await request.text() });
    });
    const response = await fetchWithPolicy(`${httpUrl(server)}/start`, {
      method: "POST",
      body: "must-be-dropped",
    });
    expect(await response.json()).toEqual({ method: "GET", body: "" });
  });

  test("fails before replaying a one-shot stream body", async () => {
    let finalHits = 0;
    const server = startServer((request) => {
      if (new URL(request.url).pathname === "/start") {
        return Response.redirect(`${httpUrl(server)}/final`, 307);
      }
      finalHits += 1;
      return new Response("unexpected");
    });
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("one-shot"));
        controller.close();
      },
    });
    await expect(fetchWithPolicy(`${httpUrl(server)}/start`, {
      method: "POST",
      body,
      duplex: "half",
    })).rejects.toMatchObject({ code: "UNREPLAYABLE_BODY" });
    expect(finalHits).toBe(0);
  });

  test("blocks body-preserving redirects to unauthorized origins", async () => {
    let targetHits = 0;
    const target = startServer(() => {
      targetHits += 1;
      return new Response("unexpected");
    });
    const source = startServer(() => Response.redirect(`${httpUrl(target)}/final`, 308));
    await expect(fetchWithPolicy(`${httpUrl(source)}/start`, {
      method: "PUT",
      body: "sensitive payload",
    })).rejects.toMatchObject({ code: "CROSS_ORIGIN_BODY_BLOCKED" });
    expect(targetHits).toBe(0);
  });

  test("hard-fails HTTPS to HTTP downgrade redirects", async () => {
    let targetHits = 0;
    const target = startServer(() => {
      targetHits += 1;
      return new Response("unexpected");
    });
    const source = startServer(() => Response.redirect(`${httpUrl(target)}/downgrade`, 302));
    // Keep the policy URL HTTPS while routing the test transport through a real
    // local server. This avoids committing a static private key (which secret
    // scanners correctly dislike) while still exercising an actual redirect
    // response rather than fabricating one in memory.
    const localTransport = () => fetch(`${httpUrl(source)}/start`, { redirect: "manual" });
    await expect(fetchWithPolicy("https://public.example/start", {}, { fetch: localTransport }))
      .rejects.toMatchObject({ code: "INSECURE_REDIRECT" });
    expect(targetHits).toBe(0);
  });
});

describe("bounded response readers", () => {
  test("rejects declared oversize before buffering", async () => {
    const server = startServer(() => new Response("123456", {
      headers: { "content-length": "6" },
    }));
    const response = await fetch(`${httpUrl(server)}/declared`);
    await expect(readResponseBytes(response, { maxBytes: 5 })).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
      details: { maxBytes: 5, contentLength: 6 },
    });
  });

  test("rejects chunked overflow and accepts an exact-at-cap response", async () => {
    const server = startServer((request) => {
      if (new URL(request.url).pathname === "/exact") return new Response("12345");
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("123"));
          setTimeout(() => {
            controller.enqueue(new TextEncoder().encode("456"));
            controller.close();
          }, 5);
        },
      }));
    });
    const overflowing = await fetch(`${httpUrl(server)}/chunked`);
    await expect(readResponseText(overflowing, { maxBytes: 5 })).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
    });
    const exact = await fetch(`${httpUrl(server)}/exact`);
    expect(await readResponseText(exact, { maxBytes: 5 })).toBe("12345");
  });

  test("cancels the body stream on overflow", async () => {
    let cancelReason;
    const response = new Response(new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
      },
      cancel(reason) {
        cancelReason = reason;
      },
    }));
    await expect(readResponseBytes(response, { maxBytes: 3 })).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
    });
    expect(cancelReason).toMatchObject({ code: "RESPONSE_TOO_LARGE" });
  });

  test("parses bounded JSON and preserves JSON syntax errors", async () => {
    expect(await readResponseJson(new Response('{"ok":true}'), { maxBytes: 11 }))
      .toEqual({ ok: true });
    await expect(readResponseJson(new Response("{"), { maxBytes: 1 }))
      .rejects.toBeInstanceOf(SyntaxError);
  });

  test("external abort cancels a delayed real response and preserves reason identity", async () => {
    const server = startServer(() => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first"));
        setTimeout(() => {
          try {
            controller.enqueue(new TextEncoder().encode("second"));
            controller.close();
          } catch {
            // Client cancellation closes the stream before this delayed write.
          }
        }, 1_000);
      },
    })));
    const response = await fetch(`${httpUrl(server)}/slow`);
    const controller = new AbortController();
    const reason = new DOMException("stop reading", "AbortError");
    const pending = readResponseText(response, { maxBytes: 100, signal: controller.signal });
    setTimeout(() => controller.abort(reason), 10);
    let caught;
    try {
      await pending;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(reason);
  });

  test("rejects invalid byte limits with a typed policy error", async () => {
    await expect(readResponseBytes(new Response("x"), { maxBytes: -1 }))
      .rejects.toMatchObject({ code: "INVALID_OPTION" });
  });
});

describe("abort composition and delays", () => {
  test("returns no signal for no inputs and the same signal for one input", () => {
    expect(composeAbortSignals().signal).toBeUndefined();
    const controller = new AbortController();
    expect(composeAbortSignals(undefined, controller.signal).signal).toBe(controller.signal);
  });

  test("preserves the exact winning reason and detaches remaining sources", () => {
    const first = new AbortController();
    const second = new AbortController();
    const reason = new DOMException("cancelled upstream", "AbortError");
    const composed = composeAbortSignals(first.signal, second.signal);
    second.abort(reason);
    expect(composed.signal.aborted).toBe(true);
    expect(composed.signal.reason).toBe(reason);
    first.abort(new Error("late"));
    expect(composed.signal.reason).toBe(reason);
  });

  test("cleanup prevents later source aborts from propagating", () => {
    const first = new AbortController();
    const second = new AbortController();
    const composed = composeAbortSignals(first.signal, second.signal);
    composed.cleanup();
    first.abort();
    expect(composed.signal.aborted).toBe(false);
  });

  test("already-aborted source wins immediately", () => {
    const first = new AbortController();
    const reason = new Error("already done");
    first.abort(reason);
    const composed = composeAbortSignals(new AbortController().signal, first.signal);
    expect(composed.signal.aborted).toBe(true);
    expect(composed.signal.reason).toBe(reason);
  });

  test("abortableDelay caps delays and rejects with the original reason", async () => {
    const started = performance.now();
    await abortableDelay(10_000, undefined, { maxMs: 0 });
    expect(performance.now() - started).toBeLessThan(100);

    const controller = new AbortController();
    const reason = new DOMException("stop waiting", "AbortError");
    const pending = abortableDelay(10_000, controller.signal, { maxMs: 20_000 });
    controller.abort(reason);
    let caught;
    try {
      await pending;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(reason);
  });

  test("abortableDelay rejects invalid bounds as policy errors", async () => {
    await expect(abortableDelay(-1)).rejects.toMatchObject({ code: "INVALID_OPTION" });
    await expect(abortableDelay(1, undefined, { maxMs: Number.NaN }))
      .rejects.toMatchObject({ code: "INVALID_OPTION" });
    await expect(abortableDelay(2_147_483_648))
      .rejects.toMatchObject({ code: "INVALID_OPTION", details: { maxMs: 2_147_483_647 } });

    const controller = new AbortController();
    const reason = new Error("do not schedule maximum timer");
    controller.abort(reason);
    await expect(abortableDelay(2_147_483_647, controller.signal)).rejects.toBe(reason);
  });
});

test("policy error guard recognizes the stable runtime shape", () => {
  const error = new HttpClientPolicyError("INVALID_OPTION", "bad option", { option: "x" });
  expect(isHttpClientPolicyError(error)).toBe(true);
  expect(isHttpClientPolicyError(new Error("no"))).toBe(false);
});
