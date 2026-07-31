import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { resolveSmithersObservabilityOptions, renderPrometheusMetrics } from "../src/index.js";
import { parseOtlpHeaders } from "../src/resolveSmithersObservabilityOptions.js";
describe("resolveSmithersObservabilityOptions", () => {
  const savedEnv = {};
  const envKeys = [
    "SMITHERS_OTEL_ENABLED",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_HEADERS",
    "OTEL_SERVICE_NAME",
    "SMITHERS_LOG_FORMAT",
    "SMITHERS_LOG_LEVEL",
  ];
  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });
  test("returns defaults when no options or env vars", () => {
    const result = resolveSmithersObservabilityOptions();
    expect(result.enabled).toBe(false);
    expect(result.endpoint).toBe("http://localhost:4318");
    expect(result.headers).toBeUndefined();
    expect(result.serviceName).toBe("smithers");
    expect(result.logFormat).toBe("logfmt");
    expect(result.logLevel).toBe("Info");
    expect(result.installLogger).toBe(true);
  });
  test("explicit options override defaults", () => {
    const result = resolveSmithersObservabilityOptions({
      enabled: true,
      endpoint: "http://custom:4317",
      serviceName: "my-service",
      logFormat: "json",
      logLevel: "debug",
      installLogger: false,
    });
    expect(result.enabled).toBe(true);
    expect(result.endpoint).toBe("http://custom:4317");
    expect(result.serviceName).toBe("my-service");
    expect(result.logFormat).toBe("json");
    expect(result.logLevel).toBe("Debug");
    expect(result.installLogger).toBe(false);
  });
  test("parses simple OTLP header pairs", () => {
    expect(parseOtlpHeaders("x-honeycomb-team=key,Authorization=Basic token")).toEqual({
      "x-honeycomb-team": "key",
      Authorization: "Basic token",
    });
  });
  test("decodes percent-encoded OTLP header values", () => {
    expect(parseOtlpHeaders("Authorization=Basic%20dG9rZW46c2VjcmV0%3D")).toEqual({
      Authorization: "Basic dG9rZW46c2VjcmV0=",
    });
  });
  test("trims surrounding OTLP header whitespace", () => {
    expect(parseOtlpHeaders(" x-honeycomb-team = key , Authorization = Basic token ")).toEqual({
      "x-honeycomb-team": "key",
      Authorization: "Basic token",
    });
  });
  test("skips malformed OTLP header entries", () => {
    expect(parseOtlpHeaders("missing-equals,=empty-key,bad-percent=%ZZ,valid=value,also-missing")).toEqual({
      valid: "value",
    });
  });
  test("resolves OTLP headers from the environment", () => {
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "x-honeycomb-team=env-key,Authorization=Basic%20token";
    const result = resolveSmithersObservabilityOptions();
    expect(result.headers).toEqual({
      "x-honeycomb-team": "env-key",
      Authorization: "Basic token",
    });
  });
  test("explicit OTLP headers override the environment", () => {
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "x-honeycomb-team=env-key";
    const result = resolveSmithersObservabilityOptions({
      headers: { Authorization: "Basic explicit-token" },
    });
    expect(result.headers).toEqual({ Authorization: "Basic explicit-token" });
  });
  test("explicit empty OTLP headers override the environment", () => {
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "x-honeycomb-team=env-key";
    const result = resolveSmithersObservabilityOptions({ headers: {} });
    expect(result.headers).toEqual({});
  });
  test("env vars used when no options provided", () => {
    process.env.SMITHERS_OTEL_ENABLED = "true";
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://env:4318";
    process.env.OTEL_SERVICE_NAME = "env-service";
    process.env.SMITHERS_LOG_FORMAT = "pretty";
    process.env.SMITHERS_LOG_LEVEL = "warning";
    const result = resolveSmithersObservabilityOptions();
    expect(result.enabled).toBe(true);
    expect(result.endpoint).toBe("http://env:4318");
    expect(result.serviceName).toBe("env-service");
    expect(result.logFormat).toBe("pretty");
    expect(result.logLevel).toBe("Warn");
  });
  test("SMITHERS_OTEL_ENABLED=1 enables", () => {
    process.env.SMITHERS_OTEL_ENABLED = "1";
    const result = resolveSmithersObservabilityOptions();
    expect(result.enabled).toBe(true);
  });
  test("SMITHERS_OTEL_ENABLED=0 does not enable", () => {
    process.env.SMITHERS_OTEL_ENABLED = "0";
    const result = resolveSmithersObservabilityOptions();
    expect(result.enabled).toBe(false);
  });
  test("resolves all log levels", () => {
    const levels = [
      ["none", "None"],
      ["trace", "Trace"],
      ["debug", "Debug"],
      ["info", "Info"],
      ["warning", "Warn"],
      ["warn", "Warn"],
      ["error", "Error"],
      ["fatal", "Fatal"],
      ["all", "All"],
    ];
    for (const [input, expected] of levels) {
      const result = resolveSmithersObservabilityOptions({ logLevel: input });
      expect(result.logLevel).toBe(expected);
    }
  });
  test("unknown log level defaults to Info", () => {
    const result = resolveSmithersObservabilityOptions({ logLevel: "banana" });
    expect(result.logLevel).toBe("Info");
  });
  test("resolves all log formats", () => {
    const formats = [
      ["json", "json"],
      ["pretty", "pretty"],
      ["string", "string"],
      ["logfmt", "logfmt"],
    ];
    for (const [input, expected] of formats) {
      const result = resolveSmithersObservabilityOptions({
        logFormat: input,
      });
      expect(result.logFormat).toBe(expected);
    }
  });
  test("unknown log format defaults to logfmt", () => {
    process.env.SMITHERS_LOG_FORMAT = "unknown";
    const result = resolveSmithersObservabilityOptions();
    expect(result.logFormat).toBe("logfmt");
  });
  test("explicit enabled=false overrides env var", () => {
    process.env.SMITHERS_OTEL_ENABLED = "true";
    const result = resolveSmithersObservabilityOptions({ enabled: false });
    expect(result.enabled).toBe(false);
  });
});
describe("Prometheus formatting edge cases", () => {
  test("renderPrometheusMetrics returns string output", () => {
    const output = renderPrometheusMetrics();
    expect(typeof output).toBe("string");
  });
  test("output ends with newline when metrics present", () => {
    const output = renderPrometheusMetrics();
    if (output.length > 0) {
      expect(output.endsWith("\n")).toBe(true);
    }
  });
  test("output contains TYPE annotations", () => {
    const output = renderPrometheusMetrics();
    if (output.length > 0) {
      expect(output).toContain("# TYPE");
    }
  });
});
