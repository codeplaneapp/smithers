import { describe, expect, test } from "bun:test";
import { createTranscriptionTool } from "../src/transcription/createTranscriptionTool.js";

const callOptions = { toolCallId: "test-call", messages: [] };
const publicDns = async () => ["8.8.8.8"];

/** @param {string[]} chunks */
function chunkedResponse(chunks) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  }));
}

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
    expect(String(requests[0].url)).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(requests[0].init.method).toBe("POST");
    expect(new Headers(requests[0].init.headers).get("authorization")).toBe("Bearer openai-test-key");
    const encodedForm = await new Response(requests[0].init.body, {
      headers: requests[0].init.headers,
    }).formData();
    expect(encodedForm.get("file")).toBeInstanceOf(Blob);
    expect(encodedForm.get("model")).toBe("whisper-1");
  });

  test("blocks a transcription provider redirect into a private destination", async () => {
    let calls = 0;
    const transcription = createTranscriptionTool({
      provider: "whisper",
      apiKey: "openai-test-key",
      fetch: async () => {
        calls += 1;
        return new Response(null, {
          status: 302,
          headers: { location: "https://127.0.0.1/private" },
        });
      },
    });

    await expect(transcription.execute(
      { audioBase64: Buffer.from("audio bytes").toString("base64"), mimeType: "audio/wav" },
      callOptions,
    )).rejects.toMatchObject({
      code: "INVALID_URL",
      details: { reason: "non-public-destination" },
    });
    expect(calls).toBe(1);
  });

  test("posts audio URLs to Deepgram and normalizes the first alternative", async () => {
    const requests = [];
    const transcription = createTranscriptionTool({
      provider: "deepgram",
      apiKey: "deepgram-test-key",
      resolveHostname: publicDns,
      fetch: async (url, init) => {
        requests.push({ url, init });
        if (String(url) === "https://example.com/audio.mp3") {
          return new Response("audio bytes", { headers: { "content-type": "audio/mpeg" } });
        }
        return Response.json({
          metadata: { duration: 2.5 },
          results: { channels: [{ alternatives: [{ transcript: "deepgram transcript" }] }] },
        });
      },
    });

    const result = await transcription.execute({ audioUrl: "https://example.com/audio.mp3" }, callOptions);

    expect(result).toEqual({ text: "deepgram transcript", durationSeconds: 2.5, provider: "deepgram" });
    expect(String(requests[0].url)).toBe("https://example.com/audio.mp3");
    expect(String(requests[1].url)).toBe("https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true");
    expect(new Headers(requests[1].init.headers).get("authorization")).toBe("Token deepgram-test-key");
    expect(new Headers(requests[1].init.headers).get("content-type")).toBe("audio/mpeg");
    expect(new TextDecoder().decode(requests[1].init.body)).toBe("audio bytes");
  });

  const ssrfAudioUrls = [
    ["cloud metadata", "http://169.254.169.254/latest/meta-data/iam/security-credentials/"],
    ["loopback IPv4", "http://127.0.0.1/secret"],
    ["private IPv4", "http://10.0.0.5/internal"],
    ["localhost name", "http://localhost:8080/audio.wav"],
    ["absolute localhost name", "http://localhost./audio.wav"],
    ["absolute localhost subdomain", "http://media.localhost./audio.wav"],
    ["absolute single-label mDNS name", "http://local./audio.wav"],
    ["absolute mDNS name", "http://media.local./audio.wav"],
    ["benchmarking IPv4", "http://198.18.0.1/audio.wav"],
    ["documentation IPv4", "http://192.0.2.1/audio.wav"],
    ["IPv6 loopback", "http://[::1]/audio.wav"],
    ["documentation IPv6", "http://[2001:db8::1]/audio.wav"],
    ["multicast IPv6", "http://[ff02::1]/audio.wav"],
    ["IPv4-mapped loopback", "http://[::ffff:127.0.0.1]/audio.wav"],
    ["IPv4-mapped public", "http://[::ffff:8.8.8.8]/audio.wav"],
    ["integer loopback spelling", "http://2130706433/audio.wav"],
    ["octal loopback spelling", "http://0177.0.0.1/audio.wav"],
    ["hex loopback spelling", "http://0x7f000001/audio.wav"],
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

      await expect(transcription.execute({ audioUrl }, callOptions)).rejects.toMatchObject({
        code: "INVALID_URL",
      });
      expect(called).toBe(0);
    });
  }

  test("refuses an audio hostname whose DNS answers include a private address", async () => {
    let called = 0;
    const transcription = createTranscriptionTool({
      provider: "whisper",
      apiKey: "openai-test-key",
      resolveHostname: async () => ["8.8.8.8", "169.254.169.254"],
      fetch: async () => {
        called += 1;
        return Response.json({ text: "leaked" });
      },
    });

    await expect(transcription.execute({
      audioUrl: "https://public-audio.example/file.mp3",
    }, callOptions)).rejects.toMatchObject({
      code: "INVALID_URL",
      details: { reason: "dns-non-public-address" },
    });
    expect(called).toBe(0);
  });

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

    await expect(
      transcription.execute({ audioUrl: "file:///etc/passwd" }, callOptions),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_PROTOCOL" });
    expect(called).toBe(0);
  });

  test("still downloads and transcribes a legitimate public audioUrl", async () => {
    const requests = [];
    const transcription = createTranscriptionTool({
      provider: "whisper",
      apiKey: "openai-test-key",
      resolveHostname: publicDns,
      fetch: async (url) => {
        requests.push(String(url));
        if (String(url) === "https://cdn.example.com/audio.mp3") {
          return new Response(new Blob([Buffer.from("audio bytes")]), {
            headers: { "content-type": "audio/mpeg" },
          });
        }
        return Response.json({ text: "public transcript", language: "en", duration: 3 });
      },
    });

    const result = await transcription.execute({ audioUrl: "https://cdn.example.com/audio.mp3" }, callOptions);

    expect(result).toEqual({ text: "public transcript", language: "en", durationSeconds: 3, provider: "whisper" });
    expect(requests[0]).toBe("https://cdn.example.com/audio.mp3");
    expect(requests[1]).toBe("https://api.openai.com/v1/audio/transcriptions");
  });

  test("forwards the tool-call abortSignal to the Whisper download and transcription fetches", async () => {
    const signals = [];
    const controller = new AbortController();
    const transcription = createTranscriptionTool({
      provider: "whisper",
      apiKey: "openai-test-key",
      fetch: async (url, init) => {
        signals.push(init?.signal);
        if (String(url) === "https://cdn.example.com/audio.mp3") {
          return new Response(new Blob([Buffer.from("audio bytes")]), {
            headers: { "content-type": "audio/mpeg" },
          });
        }
        return Response.json({ text: "ok" });
      },
    });

    await transcription.execute(
      { audioUrl: "https://cdn.example.com/audio.mp3" },
      { ...callOptions, abortSignal: controller.signal },
    );

    expect(signals).toEqual([controller.signal, controller.signal]);
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
    const transcription = createTranscriptionTool({
      provider: "whisper",
      apiKey: "openai-test-key",
      allowedAudioHosts: ["127.0.0.1"],
      fetch: async (url) => {
        if (String(url) === "http://127.0.0.1:9000/audio.mp3") {
          downloaded = true;
          return new Response(new Blob([Buffer.from("audio bytes")]), {
            headers: { "content-type": "audio/mpeg" },
          });
        }
        return Response.json({ text: "internal transcript" });
      },
    });

    const result = await transcription.execute({ audioUrl: "http://127.0.0.1:9000/audio.mp3" }, callOptions);

    expect(downloaded).toBe(true);
    expect(result.text).toBe("internal transcript");
  });

  test("bounds remote audio, base64 audio, and provider response bodies", async () => {
    const remote = createTranscriptionTool({
      provider: "whisper",
      apiKey: "key",
      maxAudioBytes: 4,
      resolveHostname: publicDns,
      fetch: async (url) => {
        if (String(url).includes("cdn.example")) {
          return new Response("12345", { headers: { "content-length": "5" } });
        }
        return Response.json({ text: "unused" });
      },
    });
    await expect(
      remote.execute({ audioUrl: "https://cdn.example/audio.wav" }, callOptions),
    ).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });

    const base64 = createTranscriptionTool({
      provider: "whisper",
      apiKey: "key",
      maxAudioBytes: 4,
      resolveHostname: publicDns,
      fetch: async () => Response.json({ text: "unused" }),
    });
    await expect(
      base64.execute({ audioBase64: Buffer.from("12345").toString("base64") }, callOptions),
    ).rejects.toThrow(/4 bytes/);

    let malformedCalled = false;
    const malformed = createTranscriptionTool({
      provider: "whisper",
      apiKey: "key",
      fetch: async () => {
        malformedCalled = true;
        return Response.json({ text: "unused" });
      },
    });
    await expect(
      malformed.execute({ audioBase64: "YQ=" }, callOptions),
    ).rejects.toThrow(/Invalid base64 input/);
    expect(malformedCalled).toBe(false);

    const provider = createTranscriptionTool({
      provider: "deepgram",
      apiKey: "key",
      maxResponseBytes: 4,
      fetch: async () => new Response("12345", { headers: { "content-length": "5" } }),
    });
    await expect(
      provider.execute({ audioBase64: Buffer.from("a").toString("base64") }, callOptions),
    ).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
  });

  test("bounds chunked audio/provider bodies and accepts exact-at-cap bodies", async () => {
    const remoteOverflow = createTranscriptionTool({
      provider: "whisper",
      apiKey: "key",
      maxAudioBytes: 4,
      resolveHostname: publicDns,
      fetch: async (url) =>
        String(url).includes("cdn.example")
          ? chunkedResponse(["123", "45"])
          : Response.json({ text: "unused" }),
    });
    await expect(
      remoteOverflow.execute({ audioUrl: "https://cdn.example/audio.wav" }, callOptions),
    ).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });

    const remoteExact = createTranscriptionTool({
      provider: "whisper",
      apiKey: "key",
      maxAudioBytes: 4,
      resolveHostname: publicDns,
      fetch: async (url) =>
        String(url).includes("cdn.example")
          ? chunkedResponse(["12", "34"])
          : Response.json({ text: "exact audio" }),
    });
    await expect(
      remoteExact.execute({ audioUrl: "https://cdn.example/audio.wav" }, callOptions),
    ).resolves.toMatchObject({ text: "exact audio" });

    const providerOverflow = createTranscriptionTool({
      provider: "deepgram",
      apiKey: "key",
      maxResponseBytes: 4,
      fetch: async () => chunkedResponse(["123", "45"]),
    });
    await expect(
      providerOverflow.execute({ audioBase64: Buffer.from("a").toString("base64") }, callOptions),
    ).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });

    const providerExact = createTranscriptionTool({
      provider: "deepgram",
      apiKey: "key",
      maxResponseBytes: 2,
      fetch: async () => chunkedResponse(["{", "}"]),
    });
    await expect(
      providerExact.execute({ audioBase64: Buffer.from("a").toString("base64") }, callOptions),
    ).resolves.toEqual({ text: "", provider: "deepgram" });
  });

  test("cancels both a remote audio download and a provider submission", async () => {
    for (const input of [
      { audioUrl: "https://cdn.example/audio.wav" },
      { audioBase64: Buffer.from("audio").toString("base64") },
    ]) {
      const controller = new AbortController();
      const transcription = createTranscriptionTool({
        provider: "whisper",
        apiKey: "key",
        resolveHostname: publicDns,
        fetch: async (_url, init) =>
          new Promise((_resolve, reject) => {
            const signal = init?.signal;
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      });
      const pending = transcription.execute(input, {
        ...callOptions,
        abortSignal: controller.signal,
      });
      controller.abort(new DOMException("cancelled", "AbortError"));
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    }
  });

  test("preserves cancellation while reading a non-2xx provider body", async () => {
    const controller = new AbortController();
    const reason = new DOMException("cancelled during provider error", "AbortError");
    const transcription = createTranscriptionTool({
      provider: "whisper",
      apiKey: "key",
      fetch: async () => {
        queueMicrotask(() => controller.abort(reason));
        return new Response("provider failure", { status: 500 });
      },
    });

    let caught;
    try {
      await transcription.execute(
        { audioBase64: Buffer.from("audio").toString("base64") },
        { ...callOptions, abortSignal: controller.signal },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(reason);
  });

  test("redacts a reflected provider API key from non-2xx errors", async () => {
    const transcription = createTranscriptionTool({
      provider: "whisper",
      apiKey: "transcription-secret",
      fetch: async () => new Response("received bearer transcription-secret", { status: 500 }),
    });
    let caught;
    try {
      await transcription.execute(
        { audioBase64: Buffer.from("audio").toString("base64") },
        callOptions,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught?.message).toContain("[REDACTED]");
    expect(caught?.message).not.toContain("transcription-secret");
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
