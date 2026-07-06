import { afterEach, describe, expect, test } from "bun:test";
import * as BunContext from "@effect/platform-bun/BunContext";
import * as NodeContext from "@effect/platform-node/NodeContext";
import {
    __platformLayerInternals,
    clearEnginePlatformLayerOverride,
    resolveEnginePlatformLayer,
    setEnginePlatformLayerOverride,
    sleepMs,
    whichExecutable,
} from "../src/platform-layer.js";

const originalPlatform = process.env.SMITHERS_PLATFORM;
const originalEnginePlatform = process.env.SMITHERS_ENGINE_PLATFORM;

afterEach(() => {
    if (originalPlatform === undefined) {
        delete process.env.SMITHERS_PLATFORM;
    }
    else {
        process.env.SMITHERS_PLATFORM = originalPlatform;
    }
    if (originalEnginePlatform === undefined) {
        delete process.env.SMITHERS_ENGINE_PLATFORM;
    }
    else {
        process.env.SMITHERS_ENGINE_PLATFORM = originalEnginePlatform;
    }
    clearEnginePlatformLayerOverride();
    __platformLayerInternals.clearDefaultPlatformLayerCache();
});

describe("engine platform layer", () => {
    test("defaults to the Bun platform when running under Bun", async () => {
        delete process.env.SMITHERS_PLATFORM;
        delete process.env.SMITHERS_ENGINE_PLATFORM;
        expect(__platformLayerInternals.selectDefaultPlatformName()).toBe("bun");
        expect(await resolveEnginePlatformLayer()).toBe(BunContext.layer);
    });

    test("can select the Node platform with SMITHERS_PLATFORM", async () => {
        process.env.SMITHERS_PLATFORM = "node";
        expect(__platformLayerInternals.selectDefaultPlatformName()).toBe("node");
        expect(await resolveEnginePlatformLayer()).toBe(NodeContext.layer);
    });

    test("programmatic override wins over runtime selection", async () => {
        process.env.SMITHERS_PLATFORM = "bun";
        setEnginePlatformLayerOverride(NodeContext.layer);
        expect(await resolveEnginePlatformLayer()).toBe(NodeContext.layer);
    });

    test("sleepMs and whichExecutable are runtime-agnostic", async () => {
        await sleepMs(1);
        expect(whichExecutable(`smithers-missing-${Date.now()}`)).toBeNull();
        expect(whichExecutable(process.execPath)).toBe(process.execPath);
    });
});
