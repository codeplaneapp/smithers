import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * The page names real surfaces, and a rename in the repository must not leave
 * it naming an old one.
 *
 * `worker.test.ts` enforces that `status.json` and the static block in
 * `index.html` agree with each other. It cannot tell whether either is still
 * true, which is how the page kept advertising `smithers-orchestrator` after
 * the CLI was republished as `@smthrs/cli`. These tests read the repository
 * itself.
 */
const status = JSON.parse(readFileSync(new URL("../site/status.json", import.meta.url), "utf8")) as {
  components: Array<{ id: string; name: string; url?: string; description?: string; status: string }>;
};
const homeHtml = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const cliManifest = JSON.parse(
  readFileSync(new URL("../../../packages/cli/package.json", import.meta.url), "utf8"),
) as { name: string };
const bugWorkerManifest = JSON.parse(
  readFileSync(new URL("../../bug-worker/package.json", import.meta.url), "utf8"),
) as { description: string };

const componentById = new Map(status.components.map((component) => [component.id, component]));

describe("the components name the surfaces this repository actually publishes", () => {
  test("CLI distribution names the published package", () => {
    const npm = componentById.get("npm");
    expect(npm).toBeDefined();
    expect(npm?.url).toBe(`https://www.npmjs.com/package/${cliManifest.name}`);
    expect(npm?.description).toStartWith(`${cliManifest.name} on npm`);
    expect(homeHtml).toContain(`${cliManifest.name} on npm`);
  });

  test("bug intake names the endpoint the bug worker serves", () => {
    const intake = componentById.get("bug-intake");
    expect(intake?.url).toBe("https://bug.smithers.sh");
    // The worker's own manifest is the record of what it is deployed behind.
    expect(bugWorkerManifest.description).toContain("bug.smithers.sh");
  });

  test("no component still names a 0.x package or a Flows-era domain", () => {
    const text = `${JSON.stringify(status)}\n${homeHtml}`;
    expect(text).not.toContain("smithers-orchestrator");
    expect(text).not.toContain("smithersai/flows");
    expect(text).not.toContain("flows.sh");
  });

  test("every component carries one of the four states the page can render", () => {
    for (const component of status.components) {
      expect(["operational", "degraded", "outage", "maintenance"]).toContain(component.status);
    }
  });
});
