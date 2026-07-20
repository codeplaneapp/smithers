import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const OBSERVABILITY_PACKAGE_DIR = resolve(REPO_ROOT, "apps/observability");

test("observability package ships the local Docker Compose stack assets", () => {
    const manifest = JSON.parse(readFileSync(resolve(OBSERVABILITY_PACKAGE_DIR, "package.json"), "utf8"));
    const files = new Set(manifest.files ?? []);

    expect(files.has("docker-compose.otel.yml")).toBe(true);
    expect(files.has("otel-collector-config.yml")).toBe(true);
    expect(files.has("prometheus/")).toBe(true);
    expect(files.has("tempo/")).toBe(true);
    expect(files.has("loki/")).toBe(true);
    expect(files.has("grafana/")).toBe(true);
    expect(existsSync(resolve(OBSERVABILITY_PACKAGE_DIR, "docker-compose.otel.yml"))).toBe(true);
    expect(existsSync(resolve(OBSERVABILITY_PACKAGE_DIR, "otel-collector-config.yml"))).toBe(true);
    expect(existsSync(resolve(OBSERVABILITY_PACKAGE_DIR, "prometheus/prometheus.yml"))).toBe(true);
    expect(existsSync(resolve(OBSERVABILITY_PACKAGE_DIR, "tempo/tempo.yml"))).toBe(true);
    expect(existsSync(resolve(OBSERVABILITY_PACKAGE_DIR, "loki/loki-config.yaml"))).toBe(true);
    expect(existsSync(resolve(OBSERVABILITY_PACKAGE_DIR, "grafana/provisioning/datasources/datasources.yml"))).toBe(true);
    expect(existsSync(resolve(OBSERVABILITY_PACKAGE_DIR, "grafana/provisioning/dashboards/dashboards.yml"))).toBe(true);
    expect(existsSync(resolve(OBSERVABILITY_PACKAGE_DIR, "grafana/dashboards/smithers-dashboard.json"))).toBe(true);
});

test("docs and Smithers skill use the supported observability CLI shape", () => {
    const checkedFiles = [
        "README.md",
        "docs/index.mdx",
        "docs/why/durable-open-orchestration.mdx",
        "docs/guides/monitoring-logs.mdx",
        "skills/smithers/SKILL.md",
    ];

    for (const file of checkedFiles) {
        const contents = readFileSync(resolve(REPO_ROOT, file), "utf8");
        expect(contents).not.toMatch(/\bsmithers(?:-orchestrator)?\s+observability\s+up\b/);
    }
});
