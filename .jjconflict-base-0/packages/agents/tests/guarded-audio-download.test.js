import { describe, expect, test } from "bun:test";
import { guardedAudioDownload } from "../src/transcription/guardedAudioDownload.js";

/** @param {Record<string, Array<{ address: string, family?: number }>>} records */
function resolverFor(records) {
  const calls = [];
  return {
    calls,
    resolver: async (hostname, options) => {
      calls.push({ hostname, signal: options.signal });
      const answers = records[hostname];
      if (!answers) throw new Error(`No test DNS record for ${hostname}`);
      return answers;
    },
  };
}

/** @param {(request: { url: URL, address: string, family: 4 | 6, signal?: AbortSignal }) => Response | Promise<Response>} respond */
function transportFor(respond) {
  const calls = [];
  return {
    calls,
    transport: async (request) => {
      calls.push(request);
      return respond(request);
    },
  };
}

/**
 * Encode an IPv4 address with each RFC 6052 Network-Specific Prefix layout.
 * The arbitrary prefix starts in public 2606::/16 space, keeps the required u
 * octet zero, and otherwise uses public-looking non-zero bytes.
 *
 * @param {32 | 40 | 48 | 56 | 64 | 96} prefixLength
 * @param {string} ipv4
 * @param {number[]} [suffix]
 */
function rfc6052Address(prefixLength, ipv4, suffix = []) {
  const bytes = new Uint8Array(16);
  const prefix = Uint8Array.from([
    0x26, 0x06, 0x47, 0x00, 0x12, 0x34, 0x56, 0x78,
    0x00, 0xbc, 0xde, 0xf0,
  ]);
  bytes.set(prefix.slice(0, prefixLength / 8));
  const v4 = ipv4.split(".").map(Number);

  if (prefixLength === 32) bytes.set(v4, 4);
  if (prefixLength === 40) {
    bytes.set(v4.slice(0, 3), 5);
    bytes[9] = v4[3];
  }
  if (prefixLength === 48) {
    bytes.set(v4.slice(0, 2), 6);
    bytes.set(v4.slice(2), 9);
  }
  if (prefixLength === 56) {
    bytes[7] = v4[0];
    bytes.set(v4.slice(1), 9);
  }
  if (prefixLength === 64) bytes.set(v4, 9);
  if (prefixLength === 96) bytes.set(v4, 12);

  const suffixStart = { 32: 9, 40: 10, 48: 11, 56: 12, 64: 13, 96: 16 }[prefixLength];
  for (let index = suffixStart; index < bytes.length && suffix.length > 0; index += 1) {
    bytes[index] = suffix[(index - suffixStart) % suffix.length];
  }
  const groups = [];
  for (let index = 0; index < bytes.length; index += 2) {
    groups.push(((bytes[index] << 8) | bytes[index + 1]).toString(16));
  }
  return groups.join(":");
}

describe("guardedAudioDownload", () => {
  test("pins one address from the complete validated answer set", async () => {
    const controller = new AbortController();
    const dns = resolverFor({
      "audio.example.com": [
        { address: "93.184.216.34", family: 4 },
        { address: "2606:4700:808:808:8:808:808:808", family: 6 },
      ],
    });
    const network = transportFor(() => new Response("audio", { status: 200 }));

    const response = await guardedAudioDownload("https://audio.example.com/clip.mp3", {
      resolver: dns.resolver,
      transport: network.transport,
      signal: controller.signal,
    });

    expect(await response.text()).toBe("audio");
    expect(dns.calls).toEqual([{ hostname: "audio.example.com", signal: controller.signal }]);
    expect(network.calls).toHaveLength(1);
    expect(network.calls[0].url.href).toBe("https://audio.example.com/clip.mp3");
    expect(network.calls[0].address).toBe("93.184.216.34");
    expect(network.calls[0].family).toBe(4);
    expect(network.calls[0].signal).toBe(controller.signal);
  });

  const blockedAnswers = [
    ["private IPv4", "10.4.5.6", 4],
    ["loopback IPv4", "127.0.0.1", 4],
    ["metadata/link-local IPv4", "169.254.169.254", 4],
    ["reserved IPv4", "240.0.0.1", 4],
    ["multicast IPv4", "224.0.0.1", 4],
    ["documentation IPv4", "198.51.100.7", 4],
    ["loopback IPv6", "::1", 6],
    ["unique-local IPv6", "fd00::1", 6],
    ["link-local IPv6", "fe80::1", 6],
    ["multicast IPv6", "ff02::1", 6],
    ["reserved IPv6", "100::1", 6],
    ["documentation IPv6", "2001:db8::1", 6],
    ["non-global IPv6 encoding", "4000::1", 6],
    ["NAT64 IPv6", "64:ff9b::7f00:1", 6],
    ["6to4 IPv6", "2002:7f00:1::", 6],
    ["IPv4-compatible private IPv6", "::127.0.0.1", 6],
    ["IPv4-mapped private IPv6", "::ffff:127.0.0.1", 6],
    ["IPv4-mapped metadata IPv6", "::ffff:a9fe:a9fe", 6],
  ];

  for (const [label, address, family] of blockedAnswers) {
    test(`rejects ${label} DNS answers before transport`, async () => {
      const dns = resolverFor({
        "audio.example.com": [{ address: String(address), family: Number(family) }],
      });
      const network = transportFor(() => new Response("leaked"));

      await expect(
        guardedAudioDownload("https://audio.example.com/clip.mp3", {
          resolver: dns.resolver,
          transport: network.transport,
        }),
      ).rejects.toThrow(/private, loopback, or link-local address/i);
      expect(network.calls).toHaveLength(0);
    });
  }

  for (const prefixLength of /** @type {const} */ ([32, 40, 48, 56, 64, 96])) {
    for (const [label, embeddedIpv4] of [
      ["private", "10.0.0.1"],
      ["metadata", "169.254.169.254"],
    ]) {
      test(`rejects RFC 6052 /${prefixLength} ${label} IPv4 embeddings`, async () => {
        const embedded = rfc6052Address(prefixLength, embeddedIpv4);
        const dns = resolverFor({
          "translated.example.com": [{ address: embedded, family: 6 }],
        });
        const network = transportFor(() => new Response("leaked"));

        await expect(
          guardedAudioDownload("https://translated.example.com/audio", {
            resolver: dns.resolver,
            transport: network.transport,
          }),
        ).rejects.toThrow(/private, loopback, or link-local address/i);
        expect(network.calls).toHaveLength(0);
      });
    }

    test(`allows an RFC 6052 /${prefixLength} public IPv4 embedding`, async () => {
      // Fill every suffix byte with public-looking data so each alternative
      // RFC 6052 layout is also non-blocked under the fail-closed policy.
      const embedded = rfc6052Address(prefixLength, "8.8.8.8", [8]);
      const dns = resolverFor({
        "translated.example.com": [{ address: embedded, family: 6 }],
      });
      const network = transportFor(() => new Response("audio"));

      const response = await guardedAudioDownload("https://translated.example.com/audio", {
        resolver: dns.resolver,
        transport: network.transport,
      });

      expect(await response.text()).toBe("audio");
      expect(network.calls).toHaveLength(1);
      expect(network.calls[0].address).toBe(embedded);
    });
  }

  for (const prefixLength of /** @type {const} */ ([32, 40, 48, 56, 64])) {
    test(`rejects an RFC 6052 /${prefixLength} private embedding with a non-zero suffix`, async () => {
      const embedded = rfc6052Address(prefixLength, "10.0.0.1", [8, 8, 8, 8]);
      const dns = resolverFor({
        "translated.example.com": [{ address: embedded, family: 6 }],
      });
      const network = transportFor(() => new Response("leaked"));

      await expect(
        guardedAudioDownload("https://translated.example.com/audio", {
          resolver: dns.resolver,
          transport: network.transport,
        }),
      ).rejects.toThrow(/private, loopback, or link-local address/i);
      expect(network.calls).toHaveLength(0);
    });
  }

  test("rejects an RFC 6052 /96 all-zero IPv4 embedding without discarding it", async () => {
    const dns = resolverFor({
      "translated.example.com": [{ address: rfc6052Address(96, "0.0.0.0"), family: 6 }],
    });
    const network = transportFor(() => new Response("leaked"));

    await expect(
      guardedAudioDownload("https://translated.example.com/audio", {
        resolver: dns.resolver,
        transport: network.transport,
      }),
    ).rejects.toThrow(/private, loopback, or link-local address/i);
    expect(network.calls).toHaveLength(0);
  });

  test("rejects a private translation even when DNS64 would reveal a different Pref64", async () => {
    const dns = resolverFor({
      "translated.example.com": [{ address: "2606:4700:aaaa:aaaa::a00:1", family: 6 }],
      // RFC 7050 can expose Internet prefix B while private IPv4 uses prefix A.
      "ipv4only.arpa": [{ address: "2606:4700:bbbb:bbbb::c000:aa", family: 6 }],
    });
    const network = transportFor(() => new Response("leaked"));

    await expect(
      guardedAudioDownload("https://translated.example.com/audio", {
        resolver: dns.resolver,
        transport: network.transport,
      }),
    ).rejects.toThrow(/private, loopback, or link-local address/i);
    expect(network.calls).toHaveLength(0);
    expect(dns.calls.map((call) => call.hostname)).toEqual(["translated.example.com"]);
  });

  test("rejects an RFC 6052 private IPv6 literal without DNS or transport", async () => {
    let resolverCalled = false;
    let transportCalled = false;

    await expect(
      guardedAudioDownload("https://[2606:4700:aaaa:aaaa::a00:1]/audio", {
        resolver: async () => {
          resolverCalled = true;
          return [{ address: "2606:4700:aaaa:aaaa::a00:1", family: 6 }];
        },
        transport: () => {
          transportCalled = true;
          return new Response("leaked");
        },
      }),
    ).rejects.toThrow(/private, loopback, or link-local address/i);

    expect(resolverCalled).toBe(false);
    expect(transportCalled).toBe(false);
  });

  test("allows non-ambiguous ordinary global IPv6 addresses", async () => {
    const addresses = [
      // Every RFC 6052 extraction is 8.8.8.8.
      "2606:4700:808:808:8:808:808:808",
      // A non-zero u octet is not an RFC 6052 address.
      "2606:4700:4700:4700:1234:5678:9abc:def0",
    ];
    for (const address of addresses) {
      const dns = resolverFor({
        "ipv6.example.com": [{ address, family: 6 }],
      });
      const network = transportFor(() => new Response("audio"));

      await guardedAudioDownload("https://ipv6.example.com/audio", {
        resolver: dns.resolver,
        transport: network.transport,
      });
      expect(network.calls[0].address).toBe(address);
    }
  });

  test("conservatively rejects an ambiguous ordinary global IPv6 address", async () => {
    const dns = resolverFor({
      "ambiguous.example.com": [{ address: "2606:4700:4700::1", family: 6 }],
    });
    const network = transportFor(() => new Response("leaked"));

    await expect(
      guardedAudioDownload("https://ambiguous.example.com/audio", {
        resolver: dns.resolver,
        transport: network.transport,
      }),
    ).rejects.toThrow(/private, loopback, or link-local address/i);
    expect(network.calls).toHaveLength(0);
  });

  test("allows a trusted ambiguous global IPv6 host through the explicit allowlist escape hatch", async () => {
    const dns = resolverFor({
      "trusted.example.com": [{ address: "2606:4700:4700::1", family: 6 }],
    });
    const network = transportFor(() => new Response("audio"));

    const response = await guardedAudioDownload("https://trusted.example.com/audio", {
      resolver: dns.resolver,
      transport: network.transport,
      allowedAudioHosts: ["trusted.example.com"],
    });

    expect(await response.text()).toBe("audio");
    expect(network.calls[0].address).toBe("2606:4700:4700::1");
  });

  test("rejects mixed public and private DNS answers instead of pinning only the public answer", async () => {
    const dns = resolverFor({
      "mixed.example.com": [
        { address: "93.184.216.34", family: 4 },
        { address: "fd00::8", family: 6 },
      ],
    });
    const network = transportFor(() => new Response("leaked"));

    await expect(
      guardedAudioDownload("https://mixed.example.com/audio.wav", {
        resolver: dns.resolver,
        transport: network.transport,
      }),
    ).rejects.toThrow(/fd00::8/);
    expect(network.calls).toHaveLength(0);
  });

  test("rejects mixed private and public DNS answers regardless of resolver ordering", async () => {
    const dns = resolverFor({
      "mixed.example.com": [
        { address: "fd00::8", family: 6 },
        { address: "93.184.216.34", family: 4 },
      ],
    });
    const network = transportFor(() => new Response("leaked"));

    await expect(
      guardedAudioDownload("https://mixed.example.com/audio.wav", {
        resolver: dns.resolver,
        transport: network.transport,
      }),
    ).rejects.toThrow(/fd00::8/);
    expect(network.calls).toHaveLength(0);
  });

  for (const status of [301, 302, 303, 307, 308]) {
    test(`manually follows a ${status} response`, async () => {
      const dns = resolverFor({
        "audio.example.com": [{ address: "93.184.216.34", family: 4 }],
      });
      const network = transportFor(({ url }) =>
        url.pathname === "/start"
          ? new Response(null, { status, headers: { location: "/final" } })
          : new Response("audio"),
      );

      const response = await guardedAudioDownload("https://audio.example.com/start", {
        resolver: dns.resolver,
        transport: network.transport,
      });

      expect(await response.text()).toBe("audio");
      expect(network.calls.map((call) => call.url.pathname)).toEqual(["/start", "/final"]);
    });
  }

  test("re-resolves and re-pins each relative or absolute redirect hop", async () => {
    const dns = resolverFor({
      "one.example.com": [{ address: "93.184.216.1", family: 4 }],
      "two.example.com": [{ address: "93.184.216.2", family: 4 }],
    });
    const network = transportFor(({ url }) => {
      if (url.href === "https://one.example.com/start") {
        return new Response(null, { status: 302, headers: { location: "/middle" } });
      }
      if (url.href === "https://one.example.com/middle") {
        return new Response(null, { status: 307, headers: { location: "https://two.example.com/final" } });
      }
      return new Response("final audio", { status: 200 });
    });

    const response = await guardedAudioDownload("https://one.example.com/start", {
      resolver: dns.resolver,
      transport: network.transport,
    });

    expect(await response.text()).toBe("final audio");
    expect(dns.calls.map((call) => call.hostname)).toEqual([
      "one.example.com",
      "one.example.com",
      "two.example.com",
    ]);
    expect(network.calls.map((call) => [call.url.href, call.address])).toEqual([
      ["https://one.example.com/start", "93.184.216.1"],
      ["https://one.example.com/middle", "93.184.216.1"],
      ["https://two.example.com/final", "93.184.216.2"],
    ]);
  });

  test("does not make a second connection when a public URL redirects to metadata", async () => {
    const dns = resolverFor({
      "public.example.com": [{ address: "93.184.216.34", family: 4 }],
    });
    const network = transportFor(() =>
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      }),
    );

    await expect(
      guardedAudioDownload("https://public.example.com/audio", {
        resolver: dns.resolver,
        transport: network.transport,
      }),
    ).rejects.toThrow(/169\.254\.169\.254/);
    expect(network.calls).toHaveLength(1);
    expect(dns.calls).toHaveLength(1);
  });

  test("does not make a second connection when a redirect hostname resolves privately", async () => {
    const dns = resolverFor({
      "public.example.com": [{ address: "93.184.216.34", family: 4 }],
      "internal.example.com": [{ address: "192.168.1.10", family: 4 }],
    });
    const network = transportFor(() =>
      new Response(null, { status: 301, headers: { location: "https://internal.example.com/secret" } }),
    );

    await expect(
      guardedAudioDownload("https://public.example.com/audio", {
        resolver: dns.resolver,
        transport: network.transport,
      }),
    ).rejects.toThrow(/192\.168\.1\.10/);
    expect(network.calls).toHaveLength(1);
    expect(dns.calls.map((call) => call.hostname)).toEqual(["public.example.com", "internal.example.com"]);
  });

  test("re-resolves a same-host redirect and blocks public-to-private DNS rebinding", async () => {
    let resolution = 0;
    const resolverCalls = [];
    const network = transportFor(() => new Response(null, { status: 302, headers: { location: "/next" } }));

    await expect(
      guardedAudioDownload("https://changing.example.com/start", {
        resolver: async (hostname, options) => {
          resolverCalls.push({ hostname, signal: options.signal });
          resolution += 1;
          return resolution === 1
            ? [{ address: "93.184.216.34", family: 4 }]
            : [{ address: "10.0.0.9", family: 4 }];
        },
        transport: network.transport,
      }),
    ).rejects.toThrow(/10\.0\.0\.9/);

    expect(resolverCalls).toHaveLength(2);
    expect(network.calls).toHaveLength(1);
  });

  test("cancels every discarded redirect response body", async () => {
    const dns = resolverFor({
      "audio.example.com": [{ address: "93.184.216.34", family: 4 }],
    });
    let cancelled = 0;
    const redirectBody = new ReadableStream({
      cancel() {
        cancelled += 1;
      },
    });
    const network = transportFor(({ url }) =>
      url.pathname === "/start"
        ? new Response(redirectBody, { status: 302, headers: { location: "/final" } })
        : new Response("audio"),
    );

    await guardedAudioDownload("https://audio.example.com/start", {
      resolver: dns.resolver,
      transport: network.transport,
    });

    expect(cancelled).toBe(1);
  });

  test("does not wait for a redirect body's never-settling cancellation promise", async () => {
    const dns = resolverFor({
      "audio.example.com": [{ address: "93.184.216.34", family: 4 }],
    });
    let cancelCalled = false;
    const redirectBody = new ReadableStream({
      cancel() {
        cancelCalled = true;
        return new Promise(() => {});
      },
    });
    const network = transportFor(({ url }) =>
      url.pathname === "/start"
        ? new Response(redirectBody, { status: 302, headers: { location: "/final" } })
        : new Response("audio"),
    );

    const result = await Promise.race([
      guardedAudioDownload("https://audio.example.com/start", {
        resolver: dns.resolver,
        transport: network.transport,
      }).then(() => "completed"),
      new Promise((resolve) => setTimeout(() => resolve("timed out"), 100)),
    ]);

    expect(result).toBe("completed");
    expect(cancelCalled).toBe(true);
    expect(network.calls).toHaveLength(2);
  });

  test("detects redirect loops after canonicalizing away fragments", async () => {
    const dns = resolverFor({
      "audio.example.com": [{ address: "93.184.216.34", family: 4 }],
    });
    const network = transportFor(() => new Response(null, { status: 302, headers: { location: "/clip#a-new-hash" } }));

    await expect(
      guardedAudioDownload("https://audio.example.com/clip#original-hash", {
        resolver: dns.resolver,
        transport: network.transport,
      }),
    ).rejects.toThrow(/redirect loop/i);
    expect(network.calls).toHaveLength(1);
  });

  for (const [label, location, expected] of [
    ["missing Location", undefined, /missing a Location/i],
    ["malformed Location", "http://[", /Invalid audioUrl redirect Location/i],
    ["non-http Location", "file:///etc/passwd", /must be an http\(s\) URL/i],
  ]) {
    test(`rejects a redirect with ${label}`, async () => {
      const dns = resolverFor({
        "audio.example.com": [{ address: "93.184.216.34", family: 4 }],
      });
      const headers = location === undefined ? undefined : { location: String(location) };
      const network = transportFor(() => new Response(null, { status: 302, headers }));

      await expect(
        guardedAudioDownload("https://audio.example.com/clip", {
          resolver: dns.resolver,
          transport: network.transport,
        }),
      ).rejects.toThrow(expected);
      expect(network.calls).toHaveLength(1);
    });
  }

  test("enforces the configured redirect hop limit", async () => {
    const dns = resolverFor({
      "audio.example.com": [{ address: "93.184.216.34", family: 4 }],
    });
    const network = transportFor(({ url }) =>
      new Response(null, {
        status: 302,
        headers: { location: `/hop-${Number(url.pathname.split("-").at(-1) || 0) + 1}` },
      }),
    );

    await expect(
      guardedAudioDownload("https://audio.example.com/hop-0", {
        resolver: dns.resolver,
        transport: network.transport,
        maxRedirects: 1,
      }),
    ).rejects.toThrow(/1-redirect limit/i);
    expect(network.calls).toHaveLength(2);
  });

  test("allowedAudioHosts remains a strict per-hop allowlist and permits its private host", async () => {
    const dns = resolverFor({
      "internal.example.com": [{ address: "10.0.0.5", family: 4 }],
    });
    const network = transportFor(() => new Response("internal audio"));

    const response = await guardedAudioDownload("https://internal.example.com/audio", {
      resolver: dns.resolver,
      transport: network.transport,
      allowedAudioHosts: ["INTERNAL.EXAMPLE.COM."],
    });

    expect(await response.text()).toBe("internal audio");
    expect(network.calls[0].address).toBe("10.0.0.5");
  });

  test("allowedAudioHosts rejects a redirect to an unlisted host before resolving or connecting", async () => {
    const dns = resolverFor({
      "one.example.com": [{ address: "10.0.0.5", family: 4 }],
    });
    const network = transportFor(() =>
      new Response(null, { status: 302, headers: { location: "https://two.example.com/audio" } }),
    );

    await expect(
      guardedAudioDownload("https://one.example.com/start", {
        resolver: dns.resolver,
        transport: network.transport,
        allowedAudioHosts: ["one.example.com"],
      }),
    ).rejects.toThrow(/not in allowedAudioHosts/i);
    expect(dns.calls).toHaveLength(1);
    expect(network.calls).toHaveLength(1);
  });

  test("allowPrivateAudioUrl preserves the explicit global private-network opt-in", async () => {
    const dns = resolverFor({
      "internal.example.com": [{ address: "fd00::5", family: 6 }],
    });
    const network = transportFor(() => new Response("internal audio"));

    const response = await guardedAudioDownload("https://internal.example.com/audio", {
      resolver: dns.resolver,
      transport: network.transport,
      allowPrivateAudioUrl: true,
    });

    expect(await response.text()).toBe("internal audio");
    expect(network.calls[0].address).toBe("fd00::5");
  });

  test("allowedAudioHosts remains authoritative when allowPrivateAudioUrl is also true", async () => {
    let resolverCalled = false;
    let transportCalled = false;

    await expect(
      guardedAudioDownload("https://not-listed.example.com/audio", {
        resolver: async () => {
          resolverCalled = true;
          return [{ address: "10.0.0.5", family: 4 }];
        },
        transport: () => {
          transportCalled = true;
          return new Response("leaked");
        },
        allowedAudioHosts: ["listed.example.com"],
        allowPrivateAudioUrl: true,
      }),
    ).rejects.toThrow(/not in allowedAudioHosts/i);

    expect(resolverCalled).toBe(false);
    expect(transportCalled).toBe(false);
  });

  test("a pre-aborted signal never resolves or creates a transport", async () => {
    const controller = new AbortController();
    controller.abort(new Error("pre-aborted"));
    let resolverCalled = false;
    let transportCalled = false;

    await expect(
      guardedAudioDownload("https://audio.example.com/clip", {
        resolver: async () => {
          resolverCalled = true;
          return [{ address: "93.184.216.34", family: 4 }];
        },
        transport: () => {
          transportCalled = true;
          return new Response("must not connect");
        },
        signal: controller.signal,
      }),
    ).rejects.toThrow(/pre-aborted/i);

    expect(resolverCalled).toBe(false);
    expect(transportCalled).toBe(false);
  });

  test("an in-flight DNS lookup rejects promptly when aborted and cannot create a late transport", async () => {
    const controller = new AbortController();
    let resolverSignal;
    let finishResolution;
    let transportCalled = false;
    const pending = guardedAudioDownload("https://audio.example.com/clip", {
      resolver: (_hostname, options) => {
        resolverSignal = options.signal;
        return new Promise((resolve) => {
          finishResolution = resolve;
        });
      },
      transport: () => {
        transportCalled = true;
        return new Response("must not connect");
      },
      signal: controller.signal,
    });
    const captured = pending.then(
      () => null,
      (error) => error,
    );

    await Promise.resolve();
    controller.abort(new Error("test DNS abort"));

    expect(await captured).toBeInstanceOf(Error);
    expect(String((await captured)?.message)).toContain("test DNS abort");
    expect(resolverSignal).toBe(controller.signal);
    finishResolution?.([{ address: "93.184.216.34", family: 4 }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(transportCalled).toBe(false);
  });

  test("rejects empty and internally inconsistent resolver results", async () => {
    const network = transportFor(() => new Response("must not connect"));

    await expect(
      guardedAudioDownload("https://empty.example.com/audio", {
        resolver: async () => [],
        transport: network.transport,
      }),
    ).rejects.toThrow(/resolved to no addresses/i);

    await expect(
      guardedAudioDownload("https://mismatch.example.com/audio", {
        resolver: async () => [{ address: "93.184.216.34", family: 6 }],
        transport: network.transport,
      }),
    ).rejects.toThrow(/address-family mismatch/i);

    await expect(
      guardedAudioDownload("https://malformed.example.com/audio", {
        resolver: async () => [{ address: "not-an-address", family: 4 }],
        transport: network.transport,
      }),
    ).rejects.toThrow(/invalid address/i);
    expect(network.calls).toHaveLength(0);
  });
});
