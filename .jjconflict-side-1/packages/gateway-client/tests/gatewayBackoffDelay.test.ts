import { describe, expect, test } from "bun:test";
import { gatewayBackoffDelay } from "../src/index.ts";

/**
 * Deterministic generator that yields the supplied random samples in order so
 * the real `gatewayBackoffDelay` jitter math can be asserted exactly. Falls
 * back to 0.5 (the no-jitter midpoint) once the script is exhausted.
 */
function scriptedRandom(samples: number[]): () => number {
  let index = 0;
  return () => (index < samples.length ? samples[index++] : 0.5);
}

describe("gatewayBackoffDelay", () => {
  test("grows exponentially per attempt at the jitter midpoint (random=0.5)", () => {
    // random()=0.5 -> delta = (0.5*2 - 1)*spread = 0, so we observe the raw curve.
    const opts = { baseMs: 100, factor: 2, jitter: 0.5, random: () => 0.5 };
    expect(gatewayBackoffDelay(0, opts)).toBe(100);
    expect(gatewayBackoffDelay(1, opts)).toBe(200);
    expect(gatewayBackoffDelay(2, opts)).toBe(400);
    expect(gatewayBackoffDelay(3, opts)).toBe(800);
    expect(gatewayBackoffDelay(4, opts)).toBe(1600);
  });

  test("caps the raw delay at maxMs (default 10s) before jitter", () => {
    // base 250 * 2^attempt would blow past 10_000 by attempt 6 (250*64=16000).
    // With random=0.5 the jitter delta is 0 so the result is exactly the cap.
    const noJitter = () => 0.5;
    expect(gatewayBackoffDelay(6, { random: noJitter })).toBe(10_000);
    expect(gatewayBackoffDelay(20, { random: noJitter })).toBe(10_000);
    // Even with maximal jitter the value stays bounded by raw +/- raw*jitter.
    const maxJitterUp = gatewayBackoffDelay(20, { random: () => 1 });
    expect(maxJitterUp).toBe(15_000); // 10000 + 10000*0.5
    const maxJitterDown = gatewayBackoffDelay(20, { random: () => 0 });
    expect(maxJitterDown).toBe(5_000); // 10000 - 10000*0.5
  });

  test("applies symmetric jitter bounds: result within raw +/- raw*jitter", () => {
    const baseMs = 1000;
    const jitter = 0.5;
    const raw = baseMs; // attempt 0
    // random()=1 -> +spread, random()=0 -> -spread.
    expect(gatewayBackoffDelay(0, { baseMs, jitter, random: () => 1 })).toBe(raw + raw * jitter);
    expect(gatewayBackoffDelay(0, { baseMs, jitter, random: () => 0 })).toBe(raw - raw * jitter);

    // Sweep a deterministic script of samples and assert every value lands in bounds.
    const samples = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];
    const random = scriptedRandom(samples);
    for (let i = 0; i < samples.length; i += 1) {
      const value = gatewayBackoffDelay(0, { baseMs, jitter, random });
      expect(value).toBeGreaterThanOrEqual(raw - raw * jitter);
      expect(value).toBeLessThanOrEqual(raw + raw * jitter);
    }
  });

  test("never returns a negative delay even with extreme negative jitter", () => {
    // jitter > 1 could push raw + delta below zero; the function clamps at 0.
    const value = gatewayBackoffDelay(0, { baseMs: 100, jitter: 2, random: () => 0 });
    expect(value).toBe(0);
    expect(value).toBeGreaterThanOrEqual(0);
  });

  test("treats negative attempt numbers as attempt 0 (no underflow)", () => {
    const noJitter = () => 0.5;
    expect(gatewayBackoffDelay(-5, { baseMs: 250, random: noJitter })).toBe(250);
    expect(gatewayBackoffDelay(0, { baseMs: 250, random: noJitter })).toBe(250);
  });

  test("returns integer milliseconds (rounded)", () => {
    const value = gatewayBackoffDelay(0, { baseMs: 333, jitter: 0.5, random: () => 0.123 });
    expect(Number.isInteger(value)).toBe(true);
  });
});
