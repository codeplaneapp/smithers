import { describe, expect, test } from "bun:test";
import { buildPinnedAudioRequestOptions } from "../src/transcription/buildPinnedAudioRequestOptions.js";

describe("buildPinnedAudioRequestOptions", () => {
  test("connects to a numeric address while retaining DNS Host, SNI, path, query, and abort signal", () => {
    const controller = new AbortController();
    const options = buildPinnedAudioRequestOptions({
      url: new URL("https://audio.example.test:8443/clips/a%20b.mp3?token=abc#ignored"),
      address: "203.0.113.10",
      family: 4,
      signal: controller.signal,
    });

    expect(options.hostname).toBe("203.0.113.10");
    expect(options.family).toBe(4);
    expect(options.port).toBe(8443);
    expect(options.path).toBe("/clips/a%20b.mp3?token=abc");
    expect(options.headers).toEqual({ Host: "audio.example.test:8443", Connection: "close" });
    expect(options.servername).toBe("audio.example.test");
    expect(options.agent).toBe(false);
    expect(options.signal).toBe(controller.signal);
    expect(Object.hasOwn(options, "lookup")).toBe(false);
    expect(Object.hasOwn(options, "rejectUnauthorized")).toBe(false);
  });

  test("keeps a pinned IPv6 hostname unbracketed, brackets Host, and omits IP-literal SNI", () => {
    const options = buildPinnedAudioRequestOptions({
      url: new URL("https://[2606:4700:4700::1111]:9443/audio.wav?lang=en"),
      address: "2606:4700:4700::1111",
      family: 6,
    });

    expect(options.hostname).toBe("2606:4700:4700::1111");
    expect(options.family).toBe(6);
    expect(options.headers).toEqual({ Host: "[2606:4700:4700::1111]:9443", Connection: "close" });
    expect(options.path).toBe("/audio.wav?lang=en");
    expect(Object.hasOwn(options, "servername")).toBe(false);
    expect(Object.hasOwn(options, "rejectUnauthorized")).toBe(false);
  });
});
