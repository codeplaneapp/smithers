import { afterEach, describe, expect, test } from "bun:test";
import { Context, Layer } from "effect";
import {
  getDefaultPlatformLayer,
  getPlatformLayer,
  resetPlatformLayer,
  setPlatformLayer,
  withPlatformLayer,
} from "../src/platform-layer.js";

const TestService = Context.GenericTag("smithers/test/PlatformLayer");
const layer = Layer.succeed(TestService, "test");
const scopedLayer = Layer.succeed(TestService, "scoped");

afterEach(() => {
  resetPlatformLayer();
});

describe("platform layer", () => {
  test("defaults to the Bun platform layer and can be reset", () => {
    const defaultLayer = getDefaultPlatformLayer();
    expect(getPlatformLayer()).toBe(defaultLayer);

    setPlatformLayer(layer);
    expect(getPlatformLayer()).toBe(layer);

    resetPlatformLayer();
    expect(getPlatformLayer()).toBe(defaultLayer);
  });

  test("scopes a temporary platform layer", async () => {
    setPlatformLayer(layer);

    const result = await withPlatformLayer(scopedLayer, async () => {
      expect(getPlatformLayer()).toBe(scopedLayer);
      return "done";
    });

    expect(result).toBe("done");
    expect(getPlatformLayer()).toBe(layer);
  });

  test("keeps layers isolated across concurrent runs (no global bleed)", async () => {
    const layerA = Layer.succeed(TestService, "A");
    const layerB = Layer.succeed(TestService, "B");
    let releaseA;
    let releaseB;
    const gateA = new Promise((resolve) => {
      releaseA = resolve;
    });
    const gateB = new Promise((resolve) => {
      releaseB = resolve;
    });
    const observed = {};

    // Both runs enter (and establish their scoped layer) before either reads.
    const a = withPlatformLayer(layerA, async () => {
      await gateA;
      return "a";
    });
    const b = withPlatformLayer(layerB, async () => {
      await gateB;
      observed.b = getPlatformLayer();
      return "b";
    });

    // Let A finish first (its restore would clobber the global), THEN B reads.
    // A mutable-global impl leaves B reading the default here; ALS reads layerB.
    releaseA();
    expect(await a).toBe("a");
    releaseB();
    expect(await b).toBe("b");

    expect(observed.b).toBe(layerB);
    expect(getPlatformLayer()).toBe(getDefaultPlatformLayer());
  });
});
