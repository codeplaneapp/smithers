import { describe, expect, test } from "bun:test";
import { DEFAULT_GATEWAY_PORT, resolveGatewayConfig } from "../src/gatewayConfig.ts";

describe("resolveGatewayConfig", () => {
  test("defaults to the local gateway with autostart allowed", () => {
    expect(resolveGatewayConfig({ env: {} })).toEqual({
      base: `http://127.0.0.1:${DEFAULT_GATEWAY_PORT}`,
      port: DEFAULT_GATEWAY_PORT,
      autoStartAllowed: true,
    });
  });

  test("--port alone builds the default local base on that port", () => {
    expect(resolveGatewayConfig({ portArg: 9000, env: {} })).toEqual({
      base: "http://127.0.0.1:9000",
      port: 9000,
      autoStartAllowed: true,
    });
  });

  test("SMITHERS_GATEWAY_PORT env sets the local default port", () => {
    expect(resolveGatewayConfig({ env: { SMITHERS_GATEWAY_PORT: "8123" } })).toEqual({
      base: "http://127.0.0.1:8123",
      port: 8123,
      autoStartAllowed: true,
    });
  });

  test("pinned --gateway disables autostart and derives the port from the URL", () => {
    expect(resolveGatewayConfig({ gatewayUrlArg: "http://10.0.0.5:4444/", env: {} })).toEqual({
      base: "http://10.0.0.5:4444",
      port: 4444,
      autoStartAllowed: false,
    });
  });

  test("--port applies to a pinned --gateway that has no port", () => {
    expect(resolveGatewayConfig({ gatewayUrlArg: "http://127.0.0.1", portArg: 9000, env: {} })).toEqual({
      base: "http://127.0.0.1:9000",
      port: 9000,
      autoStartAllowed: false,
    });
  });

  test("--port overrides a different port already in the pinned URL", () => {
    expect(resolveGatewayConfig({ gatewayUrlArg: "http://127.0.0.1:1111", portArg: 2222, env: {} })).toEqual({
      base: "http://127.0.0.1:2222",
      port: 2222,
      autoStartAllowed: false,
    });
  });

  test("--port preserves the pinned URL's path while overriding the port", () => {
    expect(
      resolveGatewayConfig({ gatewayUrlArg: "http://gw.internal/base", portArg: 8080, env: {} }),
    ).toEqual({
      base: "http://gw.internal:8080/base",
      port: 8080,
      autoStartAllowed: false,
    });
  });

  test("SMITHERS_GATEWAY_URL is pinned (no autostart) when no --gateway arg", () => {
    expect(
      resolveGatewayConfig({ env: { SMITHERS_GATEWAY_URL: "http://host:5555" } }),
    ).toEqual({
      base: "http://host:5555",
      port: 5555,
      autoStartAllowed: false,
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
    });
  });
});
