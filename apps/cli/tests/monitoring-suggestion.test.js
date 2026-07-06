import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
    buildMonitoringGuidance,
    buildMonitoringOptions,
    hasCustomUi,
    workflowIdFromPath,
} from "../src/monitoring-suggestion.js";

describe("workflowIdFromPath", () => {
    test("strips the directory and known workflow extensions", () => {
        expect(workflowIdFromPath(".smithers/workflows/implement.tsx")).toBe("implement");
        expect(workflowIdFromPath("/abs/path/my-flow.mdx")).toBe("my-flow");
        expect(workflowIdFromPath("plain")).toBe("plain");
    });
});

describe("hasCustomUi", () => {
    test("looks for .smithers/ui/<id>.tsx under cwd via the injected probe", () => {
        const seen = [];
        const exists = (p) => {
            seen.push(p);
            return p.endsWith("/.smithers/ui/implement.tsx");
        };
        expect(hasCustomUi("implement", "/work", exists)).toBe(true);
        expect(hasCustomUi("missing", "/work", exists)).toBe(false);
        expect(seen[0]).toContain("/work/.smithers/ui/implement.tsx");
    });

    test("is false for an empty workflow id", () => {
        expect(hasCustomUi("", "/work", () => true)).toBe(false);
    });

    test("detects a global ~/.smithers/ui/<id>.tsx via SMITHERS_HOME", () => {
        const priorHome = process.env.SMITHERS_HOME;
        process.env.SMITHERS_HOME = "/global-home";
        try {
            const globalUi = resolve("/global-home", "ui", "implement.tsx");
            const seen = [];
            const exists = (p) => {
                seen.push(p);
                return p === globalUi;
            };
            // Workspace candidate is absent, so only the global-pack branch matches.
            expect(hasCustomUi("implement", "/work", exists)).toBe(true);
            expect(seen).toContain(globalUi);
            expect(seen[0]).toContain("/work/.smithers/ui/implement.tsx");
            // A workflow with no global UI stays false.
            expect(hasCustomUi("missing", "/work", exists)).toBe(false);
        } finally {
            if (priorHome === undefined) delete process.env.SMITHERS_HOME;
            else process.env.SMITHERS_HOME = priorHome;
        }
    });
});

describe("buildMonitoringOptions", () => {
    test("offers the monitoring options, Smithers Monitor first, with the run id wired in", () => {
        const options = buildMonitoringOptions({ runId: "run-1", workflowId: "implement", hasUi: false });
        expect(options.map((o) => o.id)).toEqual(["monitor-ui", "cron-report", "live-ui", "html-page"]);
        expect(options[0].how).toContain("smithers monitor run-1");
        expect(options[1].how).toContain("smithers inspect run-1 --format json");
        expect(options[3].how).toContain("smithers inspect run-1");
    });

    test("the live-ui option opens the existing UI when one exists", () => {
        const withUi = buildMonitoringOptions({ runId: "run-1", workflowId: "implement", hasUi: true });
        expect(withUi[2].how).toContain("smithers ui run-1");
        expect(withUi[2].how).not.toContain("author");
    });

    test("the live-ui option tells the agent to author a UI when none exists", () => {
        const noUi = buildMonitoringOptions({ runId: "run-1", workflowId: "implement", hasUi: false });
        expect(noUi[2].how).toContain(".smithers/ui/implement.tsx");
        expect(noUi[2].how).toContain("author");
    });
});

describe("buildMonitoringGuidance", () => {
    test("returns agent-directed prose plus the structured options", () => {
        const { text, options } = buildMonitoringGuidance({ runId: "run-1", workflowId: "implement", hasUi: false });
        expect(text).toContain("run-1");
        expect(text).toContain("background");
        expect(text).toContain("Offer the user");
        expect(options).toHaveLength(4);
        // Every option title surfaces in the rendered prose.
        for (const option of options) {
            expect(text).toContain(option.title);
        }
    });
});
