import { describe, expect, test } from "bun:test";
import { createTranscriptionTool } from "../src/transcription/createTranscriptionTool.js";

const callOptions = { toolCallId: "test-call", messages: [] };

describe("createTranscriptionTool", () => {
  test("posts audio to Whisper and returns normalized transcript text", async () => {
    const requests = [];
    const transcription = createTranscriptionTool({
      provider: "whisper",
      apiKey: "openai-test-key",
      fetch: async (url, init) => {
        requests.push({ url, init });
        return Response.json({ text: "hello from audio", language: "en", duration: 1.25 });
      },
    });

    const result = await transcription.execute(
      { audioBase64: Buffer.from("audio bytes").toString("base64"), mimeType: "audio/wav" },
      callOptions,
    );

    expect(result).toEqual({ text: "hello from audio", language: "en", durationSeconds: 1.25, provider: "whisper" });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(requests[0].init.method).toBe("POST");
    expect(requests[0].init.headers.Authorization).toBe("Bearer openai-test-key");
    expect(requests[0].init.body).toBeInstanceOf(FormData);
  });

  test("posts audio URLs to Deepgram and normalizes the first alternative", async () => {
    const requests = [];
    let localDownloadCalled = false;
    const transcription = createTranscriptionTool({
      provider: "deepgram",
      apiKey: "deepgram-test-key",
      audioUrlResolver: async () => {
        localDownloadCalled = true;
        throw new Error("Deepgram URL handoff must not resolve locally");
      },
      audioUrlTransport: () => {
        localDownloadCalled = true;
        throw new Error("Deepgram URL handoff must not download locally");
      },
      fetch: async (url, init) => {
        requests.push({ url, init });
        return Response.json({
          metadata: { duration: 2.5 },
          results: { channels: [{ alternatives: [{ transcript: "deepgram transcript" }] }] },
        });
      },
    });

    const result = await transcription.execute({ audioUrl: "https://example.com/audio.mp3" }, callOptions);

    expect(result).toEqual({ text: "deepgram transcript", durationSeconds: 2.5, provider: "deepgram" });
    expect(requests[0].url).toBe("https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true");
    expect(requests[0].init.headers.Authorization).toBe("Token deepgram-test-key");
    expect(JSON.parse(requests[0].init.body)).toEqual({ url: "https://example.com/audio.mp3" });
    expect(localDownloadCalled).toBe(false);
  });

  const ssrfAudioUrls = [
    ["cloud metadata", "http://169.254.169.254/latest/meta-data/iam/security-credentials/"],
    ["loopback IPv4", "http://127.0.0.1/secret"],
    ["private IPv4", "http://10.0.0.5/internal"],
    ["localhost name", "http://localhost:8080/audio.wav"],
    ["IPv6 loopback", "http://[::1]/audio.wav"],
    ["IPv4-mapped loopback", "http://[::ffff:127.0.0.1]/audio.wav"],
  ];
  for (const [label, audioUrl] of ssrfAudioUrls) {
    test(`refuses to fetch an SSRF audioUrl (${label}) before any request`, async () => {
      let called = 0;
      const transcription = createTranscriptionTool({
        provider: "whisper",
        apiKey: "openai-test-key",
        fetch: async () => {
          called += 1;
          return Response.json({ text: "leaked" });
        },
      });

      await expect(transcription.execute({ audioUrl }, callOptions)).rejects.toThrow(
        /private, loopback, or link-local/i,
      );
      expect(called).toBe(0);
    });
  }

  test("refuses a non-http(s) audioUrl scheme", async () => {
    let called = 0;
    const transcription = createTranscriptionTool({
      provider: "whisper",
      apiKey: "openai-test-key",
      fetch: async () => {
        called += 1;
        return Response.json({ text: "leaked" });
      },
    });

    await expect(transcription.execute({ audioUrl: "file:///etc/passwd" }, callOptions)).rejects.toThrow(
      /http\(s\)/i,
    );
    expect(called).toBe(0);
  });

  test("still downloads and transcribes a legitimate public audioUrl", async () => {
    const providerRequests = [];
    const downloadRequests = [];
    const transcription = createTranscriptionTool({
      provider: "whisper",
      apiKey: "openai-test-key",
      audioUrlResolver: async () => [{ address: "93.184.216.34", family: 4 }],
      audioUrlTransport: async (request) => {
        downloadRequests.push(request);
        return new Response(new Blob([Buffer.from("audio bytes")]), {
          headers: { "content-type": "audio/mpeg" },
        });
      },
      fetch: async (url, init) => {
        providerRequests.push({ url: String(url), init });
        return Response.json({ text: "public transcript", language: "en", duration: 3 });
      },
    });

    const result = await transcription.execute({ audioUrl: "https://cdn.example.com/audio.mp3" }, callOptions);

    expect(result).toEqual({ text: "public transcript", language: "en", durationSeconds: 3, provider: "whisper" });
    expect(downloadRequests).toHaveLength(1);
    expect(downloadRequests[0].url.href).toBe("https://cdn.example.com/audio.mp3");
    expect(downloadRequests[0].address).toBe("93.184.216.34");
    expect(providerRequests).toHaveLength(1);
    expect(providerRequests[0].url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(providerRequests[0].init.method).toBe("POST");
  });

  test("forwards the tool-call abortSignal to the Whisper download and transcription fetches", async () => {
    const resolverSignals = [];
    const downloadSignals = [];
    const providerSignals = [];
    const controller = new AbortController();
    const transcription = createTranscriptionTool({
      provider: "whisper",
      apiKey: "openai-test-key",
      audioUrlResolver: async (_hostname, options) => {
        resolverSignals.push(options.signal);
        return [{ address: "93.184.216.34", family: 4 }];
      },
      audioUrlTransport: async (request) => {
        downloadSignals.push(request.signal);
        return new Response(new Blob([Buffer.from("audio bytes")]), {
          headers: { "content-type": "audio/mpeg" },
        });
      },
      fetch: async (_url, init) => {
        providerSignals.push(init?.signal);
        return Response.json({ text: "ok" });
      },
    });

    await transcription.execute(
      { audioUrl: "https://cdn.example.com/audio.mp3" },
      { ...callOptions, abortSignal: controller.signal },
    );

    expect(resolverSignals).toEqual([controller.signal]);
    expect(downloadSignals).toEqual([controller.signal]);
    expect(providerSignals).toEqual([controller.signal]);
  });

  test("forwards the tool-call abortSignal to the Deepgram fetch", async () => {
    const signals = [];
    const controller = new AbortController();
    const transcription = createTranscriptionTool({
      provider: "deepgram",
      apiKey: "deepgram-test-key",
      fetch: async (_url, init) => {
        signals.push(init?.signal);
        return Response.json({ results: { channels: [{ alternatives: [{ transcript: "ok" }] }] } });
      },
    });

    await transcription.execute(
      { audioBase64: Buffer.from("audio bytes").toString("base64"), mimeType: "audio/wav" },
      { ...callOptions, abortSignal: controller.signal },
    );

    expect(signals).toEqual([controller.signal]);
  });

  for (const provider of /** @type {const} */ (["whisper", "deepgram"])) {
    test(`a pre-aborted signal rejects promptly without any ${provider} request`, async () => {
      let called = 0;
      const transcription = createTranscriptionTool({
        provider,
        apiKey: "test-key",
        fetch: async () => {
          called += 1;
          return Response.json({ text: "leaked" });
        },
      });
      const controller = new AbortController();
      controller.abort();

      await expect(
        transcription.execute(
          { audioBase64: Buffer.from("audio bytes").toString("base64") },
          { ...callOptions, abortSignal: controller.signal },
        ),
      ).rejects.toThrow(/abort/i);
      expect(called).toBe(0);
    });
  }

  test("allowedAudioHosts opts a private host back in on purpose", async () => {
    let downloaded = false;
    const providerRequests = [];
    const transcription = createTranscriptionTool({
      provider: "whisper",
      apiKey: "openai-test-key",
      allowedAudioHosts: ["127.0.0.1"],
      audioUrlTransport: async (request) => {
        downloaded = request.url.href === "http://127.0.0.1:9000/audio.mp3" && request.address === "127.0.0.1";
        return new Response(new Blob([Buffer.from("audio bytes")]), {
          headers: { "content-type": "audio/mpeg" },
        });
      },
      fetch: async (url) => {
        providerRequests.push(String(url));
        return Response.json({ text: "internal transcript" });
      },
    });

    const result = await transcription.execute({ audioUrl: "http://127.0.0.1:9000/audio.mp3" }, callOptions);

    expect(downloaded).toBe(true);
    expect(result.text).toBe("internal transcript");
    expect(providerRequests).toEqual(["https://api.openai.com/v1/audio/transcriptions"]);
  });

  test("blocks a DNS name resolving to a real loopback server before any connection", async () => {
    const serverRequests = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        serverRequests.push(request.url);
        return new Response("should not connect");
      },
    });
    let providerRequests = 0;
    try {
      const transcription = createTranscriptionTool({
        provider: "whisper",
        apiKey: "openai-test-key",
        audioUrlResolver: async (hostname) => {
          expect(hostname).toBe("attacker.test");
          return [{ address: "127.0.0.1", family: 4 }];
        },
        fetch: async () => {
          providerRequests += 1;
          return Response.json({ text: "leaked" });
        },
      });

      await expect(
        transcription.execute({ audioUrl: `http://attacker.test:${server.port}/secret` }, callOptions),
      ).rejects.toThrow(/private, loopback, or link-local address/i);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(serverRequests).toHaveLength(0);
      expect(providerRequests).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  for (const [label, policy] of [
    ["strict allowlist", { allowedAudioHosts: ["audio.test"] }],
    ["private-network opt-in", { allowPrivateAudioUrl: true }],
  ]) {
    test(`${label} connects to the pinned address while retaining Host, path, and query`, async () => {
      const observed = [];
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          const url = new URL(request.url);
          observed.push({ host: request.headers.get("host"), path: url.pathname, query: url.search });
          return new Response("audio bytes", { headers: { "content-type": "audio/mpeg" } });
        },
      });
      const providerRequests = [];
      try {
        const transcription = createTranscriptionTool({
          provider: "whisper",
          apiKey: "openai-test-key",
          ...policy,
          audioUrlResolver: async () => [{ address: "127.0.0.1", family: 4 }],
          fetch: async (url) => {
            providerRequests.push(String(url));
            return Response.json({ text: "pinned transcript" });
          },
        });

        const result = await transcription.execute(
          { audioUrl: `http://audio.test:${server.port}/clips/input.mp3?token=abc` },
          callOptions,
        );

        expect(result.text).toBe("pinned transcript");
        expect(observed).toEqual([
          { host: `audio.test:${server.port}`, path: "/clips/input.mp3", query: "?token=abc" },
        ]);
        expect(providerRequests).toEqual(["https://api.openai.com/v1/audio/transcriptions"]);
      } finally {
        server.stop(true);
      }
    });
  }

  test("rejects an oversized declared Whisper audio download before requesting transcription", async () => {
    let cancelled = false;
    let providerCalled = false;
    const transcription = createTranscriptionTool({
      provider: "whisper",
      apiKey: "openai-test-key",
      maxResponseBytes: 4,
      audioUrlResolver: async () => [{ address: "8.8.8.8", family: 4 }],
      audioUrlTransport: async () =>
        new Response(
          new ReadableStream({ cancel: () => void (cancelled = true) }),
          { headers: { "content-length": "5" } },
        ),
      fetch: async () => {
        providerCalled = true;
        return Response.json({ text: "unexpected" });
      },
    });

    await expect(transcription.execute({ audioUrl: "https://cdn.example.com/audio.mp3" }, callOptions)).rejects.toThrow(
      /exceeds 4 bytes/,
    );
    expect(cancelled).toBe(true);
    expect(providerCalled).toBe(false);
  });

  test("cancels a chunked Whisper audio download that exceeds the cap", async () => {
    let cancelled = false;
    const transcription = createTranscriptionTool({
      provider: "whisper",
      apiKey: "openai-test-key",
      maxResponseBytes: 4,
      audioUrlResolver: async () => [{ address: "8.8.8.8", family: 4 }],
      audioUrlTransport: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2]));
              controller.enqueue(new Uint8Array([3, 4, 5]));
            },
            cancel: () => void (cancelled = true),
          }),
        ),
      fetch: async () => Response.json({ text: "unexpected" }),
    });

    await expect(transcription.execute({ audioUrl: "https://cdn.example.com/audio.mp3" }, callOptions)).rejects.toThrow(
      /exceeds 4 bytes/,
    );
    expect(cancelled).toBe(true);
  });

  test("cancels a chunked provider response that exceeds the cap", async () => {
    let cancelled = false;
    const transcription = createTranscriptionTool({
      provider: "deepgram",
      apiKey: "deepgram-test-key",
      maxResponseBytes: 4,
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2]));
              controller.enqueue(new Uint8Array([3, 4, 5]));
            },
            cancel: () => void (cancelled = true),
          }),
        ),
    });

    await expect(
      transcription.execute({ audioBase64: Buffer.from("audio bytes").toString("base64") }, callOptions),
    ).rejects.toThrow(/exceeds 4 bytes/);
    expect(cancelled).toBe(true);
  });

  test("accepts a provider response exactly at the configured cap", async () => {
    const payload = JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: "ok" }] }] } });
    const transcription = createTranscriptionTool({
      provider: "deepgram",
      apiKey: "deepgram-test-key",
      maxResponseBytes: Buffer.byteLength(payload),
      fetch: async () => new Response(payload),
    });

    await expect(
      transcription.execute({ audioBase64: Buffer.from("audio bytes").toString("base64") }, callOptions),
    ).resolves.toEqual({ text: "ok", provider: "deepgram" });
  });
});

describe("createTranscriptionTool cancellation against real servers", () => {
  /**
   * Start a real HTTP server that never responds: each request hangs until the
   * client cancels it, which we observe via the request's abort signal.
   */
  function startHangingServer() {
    const state = { requests: /** @type {string[]} */ ([]), aborted: /** @type {string[]} */ ([]) };
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const pathname = new URL(request.url).pathname;
        state.requests.push(pathname);
        return new Promise((_resolve, reject) => {
          request.signal.addEventListener("abort", () => {
            state.aborted.push(pathname);
            reject(new Error(`client aborted ${pathname}`));
          });
        });
      },
    });
    return { server, state, origin: `http://127.0.0.1:${server.port}` };
  }

  /** @param {() => boolean} predicate */
  async function waitFor(predicate, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("timed out waiting for condition");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /**
   * Await a promise that must reject, returning the rejection error. Attaches
   * the handler before the abort fires so the rejection is never unhandled.
   * @param {Promise<unknown>} pending
   */
  function captureRejection(pending) {
    return pending.then(
      () => {
        throw new Error("expected the transcription to reject on abort");
      },
      (error) => /** @type {Error} */ (error),
    );
  }

  test("abort cancels an in-flight Whisper transcription request", async () => {
    const { server, state, origin } = startHangingServer();
    try {
      const controller = new AbortController();
      const transcription = createTranscriptionTool({
        provider: "whisper",
        apiKey: "openai-test-key",
        baseUrl: `${origin}/v1/audio/transcriptions`,
      });

      const rejection = captureRejection(
        transcription.execute(
          { audioBase64: Buffer.from("audio bytes").toString("base64"), mimeType: "audio/wav" },
          { ...callOptions, abortSignal: controller.signal },
        ),
      );
      await waitFor(() => state.requests.length === 1);
      controller.abort();

      const error = await rejection;
      expect(error.name).toBe("AbortError");
      await waitFor(() => state.aborted.length === 1);
      expect(state.aborted).toEqual(["/v1/audio/transcriptions"]);
    } finally {
      server.stop(true);
    }
  });

  test("abort cancels the Whisper audio download and never reaches the transcription endpoint", async () => {
    const audio = startHangingServer();
    const whisper = startHangingServer();
    try {
      const controller = new AbortController();
      const transcription = createTranscriptionTool({
        provider: "whisper",
        apiKey: "openai-test-key",
        baseUrl: `${whisper.origin}/v1/audio/transcriptions`,
        allowedAudioHosts: ["127.0.0.1"],
      });

      const rejection = captureRejection(
        transcription.execute(
          { audioUrl: `${audio.origin}/audio.mp3` },
          { ...callOptions, abortSignal: controller.signal },
        ),
      );
      await waitFor(() => audio.state.requests.length === 1);
      controller.abort();

      const error = await rejection;
      expect(error.name).toBe("AbortError");
      await waitFor(() => audio.state.aborted.length === 1);
      expect(audio.state.aborted).toEqual(["/audio.mp3"]);
      expect(whisper.state.requests).toHaveLength(0);
    } finally {
      audio.server.stop(true);
      whisper.server.stop(true);
    }
  });

  test("abort cancels an in-flight Deepgram request", async () => {
    const { server, state, origin } = startHangingServer();
    try {
      const controller = new AbortController();
      const transcription = createTranscriptionTool({
        provider: "deepgram",
        apiKey: "deepgram-test-key",
        baseUrl: `${origin}/v1/listen`,
      });

      const rejection = captureRejection(
        transcription.execute(
          { audioBase64: Buffer.from("audio bytes").toString("base64"), mimeType: "audio/wav" },
          { ...callOptions, abortSignal: controller.signal },
        ),
      );
      await waitFor(() => state.requests.length === 1);
      controller.abort();

      const error = await rejection;
      expect(error.name).toBe("AbortError");
      await waitFor(() => state.aborted.length === 1);
      expect(state.aborted).toEqual(["/v1/listen"]);
    } finally {
      server.stop(true);
    }
  });
});
