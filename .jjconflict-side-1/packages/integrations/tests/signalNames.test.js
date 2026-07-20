import { describe, expect, test } from "bun:test";
import { INTEGRATION_SIGNAL_PREFIX, integrationEventName, integrationReceivedBy, isIntegrationSignalName, parseIntegrationEventName, } from "../src/core/signalNames.js";

describe("signalNames", () => {
    test("integrationEventName builds integration:<service>:<event>", () => {
        expect(integrationEventName("telegram", "message")).toBe("integration:telegram:message");
        expect(integrationEventName("github", "pull_request.opened")).toBe("integration:github:pull_request.opened");
    });
    test("integrationEventName rejects empty or colon-bearing segments", () => {
        expect(() => integrationEventName("", "message")).toThrow();
        expect(() => integrationEventName("telegram", " ")).toThrow();
        expect(() => integrationEventName("tele:gram", "message")).toThrow();
        expect(() => integrationEventName("github", "a:b")).toThrow();
    });
    test("isIntegrationSignalName recognizes the reserved prefix", () => {
        expect(INTEGRATION_SIGNAL_PREFIX).toBe("integration:");
        expect(isIntegrationSignalName("integration:github:push")).toBe(true);
        expect(isIntegrationSignalName("deploy.ready")).toBe(false);
        expect(isIntegrationSignalName(42)).toBe(false);
    });
    test("parseIntegrationEventName round-trips and rejects malformed names", () => {
        expect(parseIntegrationEventName("integration:github:pull_request.opened")).toEqual({
            service: "github",
            event: "pull_request.opened",
        });
        expect(parseIntegrationEventName("deploy.ready")).toBeNull();
        expect(parseIntegrationEventName("integration:github")).toBeNull();
        expect(parseIntegrationEventName("integration:github:")).toBeNull();
    });
    test("integrationReceivedBy stamps integration:<service>", () => {
        expect(integrationReceivedBy("linear")).toBe("integration:linear");
    });
});
