import { describe, expect, test } from "bun:test";
import {
  DEFAULT_GATEWAY_PORT,
  GatewayConfigError,
  isValidGatewayPort,
  parseGatewayPortEnv,
  resolveGatewayConfig,
} from "../src/gatewayConfig.ts";

describe("resolveGatewayConfig", () => {
  test("defaults to the local gateway with autostart allowed", () => {
    expect(resolveGatewayConfig({ env: {} })).toEqual({
      base: `http://127.0.0.1:${DEFAULT_GATEWAY_PORT}`,
      port: DEFAULT_GATEWAY_PORT,
      autoStartAllowed: true,
      portExplicit: false,
    });
  });

  test("--port alone builds the default local base on that port", () => {
    expect(resolveGatewayConfig({ portArg: 9000, env: {} })).toEqual({
      base: "http://127.0.0.1:9000",
      port: 9000,
      autoStartAllowed: true,
      portExplicit: true,
    });
  });

  test("SMITHERS_GATEWAY_PORT env sets the local default port", () => {
    expect(resolveGatewayConfig({ env: { SMITHERS_GATEWAY_PORT: "8123" } })).toEqual({
      base: "http://127.0.0.1:8123",
      port: 8123,
      autoStartAllowed: true,
      portExplicit: true,
    });
  });

  test("rejects a set-but-invalid SMITHERS_GATEWAY_PORT instead of a bad URL", () => {
    // 70000 is out of the 1..65535 TCP range; without validation this built an
    // unreachable http://127.0.0.1:70000. It must fail loudly instead.
    for (const bad of ["70000", "0", "-1", "8.5", "abc"]) {
      expect(() => resolveGatewayConfig({ env: { SMITHERS_GATEWAY_PORT: bad } })).toThrow(GatewayConfigError);
    }
  });

  test("blank/unset SMITHERS_GATEWAY_PORT falls back to the default", () => {
    expect(resolveGatewayConfig({ env: { SMITHERS_GATEWAY_PORT: "" } }).port).toBe(DEFAULT_GATEWAY_PORT);
    expect(resolveGatewayConfig({ env: {} }).port).toBe(DEFAULT_GATEWAY_PORT);
  });

  test("pinned --gateway disables autostart and derives the port from the URL", () => {
    expect(resolveGatewayConfig({ gatewayUrlArg: "http://10.0.0.5:4444/", env: {} })).toEqual({
      base: "http://10.0.0.5:4444",
      port: 4444,
      autoStartAllowed: false,
      portExplicit: false,
    });
  });

  test("--port applies to a pinned --gateway that has no port", () => {
    expect(resolveGatewayConfig({ gatewayUrlArg: "http://127.0.0.1", portArg: 9000, env: {} })).toEqual({
      base: "http://127.0.0.1:9000",
      port: 9000,
      autoStartAllowed: false,
      portExplicit: true,
    });
  });

  test("--port overrides a different port already in the pinned URL", () => {
    expect(resolveGatewayConfig({ gatewayUrlArg: "http://127.0.0.1:1111", portArg: 2222, env: {} })).toEqual({
      base: "http://127.0.0.1:2222",
      port: 2222,
      autoStartAllowed: false,
      portExplicit: true,
    });
  });

  test("--port preserves the pinned URL's path while overriding the port", () => {
    expect(resolveGatewayConfig({ gatewayUrlArg: "http://gw.internal/base", portArg: 8080, env: {} })).toEqual({
      base: "http://gw.internal:8080/base",
      port: 8080,
      autoStartAllowed: false,
      portExplicit: true,
    });
  });

  test("SMITHERS_GATEWAY_URL is pinned (no autostart) when no --gateway arg", () => {
    expect(resolveGatewayConfig({ env: { SMITHERS_GATEWAY_URL: "http://host:5555" } })).toEqual({
      base: "http://host:5555",
      port: 5555,
      autoStartAllowed: false,
      portExplicit: false,
    });
  });

  test("--gateway arg wins over SMITHERS_GATEWAY_URL env", () => {
    expect(
      resolveGatewayConfig({
        gatewayUrlArg: "http://arg:6001",
        env: { SMITHERS_GATEWAY_URL: "http://env:7002" },
      }),
    ).toEqual({
      base: "http://arg:6001",
      port: 6001,
      autoStartAllowed: false,
      portExplicit: false,
    });
  });

  test("leaves token undefined when no auth is configured", () => {
    expect(resolveGatewayConfig({ env: {} }).token).toBeUndefined();
    expect(resolveGatewayConfig({ env: { SMITHERS_API_KEY: "" } }).token).toBeUndefined();
  });

  test("resolves the token from SMITHERS_API_KEY (the var the gateway reads)", () => {
    expect(resolveGatewayConfig({ env: { SMITHERS_API_KEY: "secret-key" } }).token).toBe("secret-key");
  });

  test("SMITHERS_TOKEN overrides SMITHERS_API_KEY", () => {
    expect(resolveGatewayConfig({ env: { SMITHERS_TOKEN: "tok", SMITHERS_API_KEY: "key" } }).token).toBe("tok");
  });

  test("--token arg wins over both env tokens", () => {
    expect(
      resolveGatewayConfig({
        tokenArg: "arg-token",
        env: { SMITHERS_TOKEN: "tok", SMITHERS_API_KEY: "key" },
      }).token,
    ).toBe("arg-token");
  });

  test("carries the token onto a pinned gateway too", () => {
    expect(resolveGatewayConfig({ gatewayUrlArg: "http://host:5555", env: { SMITHERS_API_KEY: "key" } })).toEqual({
      base: "http://host:5555",
      port: 5555,
      autoStartAllowed: false,
      portExplicit: false,
      token: "key",
    });
  });
});

describe("isValidGatewayPort / parseGatewayPortEnv", () => {
  test("isValidGatewayPort accepts only integers in 1..65535", () => {
    expect(isValidGatewayPort(1)).toBe(true);
    expect(isValidGatewayPort(7331)).toBe(true);
    expect(isValidGatewayPort(65535)).toBe(true);
    expect(isValidGatewayPort(0)).toBe(false);
    expect(isValidGatewayPort(65536)).toBe(false);
    expect(isValidGatewayPort(-1)).toBe(false);
    expect(isValidGatewayPort(8.5)).toBe(false);
    expect(isValidGatewayPort(Number.NaN)).toBe(false);
  });

  test("parseGatewayPortEnv returns undefined for unset/blank, the port for valid", () => {
    expect(parseGatewayPortEnv(undefined)).toBeUndefined();
    expect(parseGatewayPortEnv("")).toBeUndefined();
    expect(parseGatewayPortEnv("   ")).toBeUndefined();
    expect(parseGatewayPortEnv("8123")).toBe(8123);
  });

  test("parseGatewayPortEnv throws GatewayConfigError for a set-but-invalid value", () => {
    expect(() => parseGatewayPortEnv("70000")).toThrow(GatewayConfigError);
    expect(() => parseGatewayPortEnv("0")).toThrow(GatewayConfigError);
    expect(() => parseGatewayPortEnv("nope")).toThrow(GatewayConfigError);
  });
});
