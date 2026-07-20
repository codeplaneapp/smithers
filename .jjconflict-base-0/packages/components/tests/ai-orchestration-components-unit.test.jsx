/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { sep } from "node:path";
import React from "react";
import {
    ClassifyAndRoute,
    Debate,
    DecisionTable,
    GatherAndSynthesize,
    Loop,
    Optimizer,
    Panel,
    Parallel,
    Ralph,
    ReviewLoop,
    SuperSmithers,
    Supervisor,
    Task,
    Worktree,
} from "../src/components/index.js";
import { SmithersRenderer } from "@smithers-orchestrator/react-reconciler/dom/renderer";
import {
    SmithersContext,
    SmithersCtx,
} from "@smithers-orchestrator/react-reconciler/context";

const RUN_ID = "ai-orchestration-unit";
const agent = { id: "agent", generate: async () => ({ text: "ok" }) };
const otherAgent = { id: "other", generate: async () => ({ text: "ok" }) };
const judgeAgent = { id: "judge", generate: async () => ({ text: "ok" }) };

async function render(element, outputs = {}) {
    const renderer = new SmithersRenderer();
    const ctx = new SmithersCtx({
        runId: RUN_ID,
        iteration: 0,
        input: {},
        outputs,
    });
    const graph = await renderer.render(
        <SmithersContext.Provider value={ctx}>{element}</SmithersContext.Provider>,
    );
    return { graph, root: renderer.getRoot() };
}

function findHosts(root, tag) {
    const found = [];
    const visit = (node) => {
        if (!node || node.kind === "text") return;
        if (node.tag === tag) found.push(node);
        for (const child of node.children ?? []) visit(child);
    };
    visit(root);
    return found;
}

function findHost(root, tag, predicate = () => true) {
    const host = findHosts(root, tag).find(predicate);
    expect(host).toBeDefined();
    return host;
}

function outputRow(nodeId, payload) {
    return { runId: RUN_ID, nodeId, iteration: 0, ...payload };
}

function childArray(element) {
    return React.Children.toArray(element.props.children);
}

describe("Loop/Ralph host element contract", () => {
    test("Loop passes only loop host props through and drops everything else", () => {
        const el = Loop({
            id: "l",
            until: false,
            maxIterations: 7,
            onMaxReached: "fail",
            continueAsNewEvery: 3,
            label: "not-a-loop-prop",
            bogus: 42,
            children: null,
        });
        expect(el.type).toBe("smithers:ralph");
        expect(el.props).toEqual({
            id: "l",
            until: false,
            maxIterations: 7,
            onMaxReached: "fail",
            continueAsNewEvery: 3,
            children: null,
        });
    });

    test("Loop skipIf renders nothing and Ralph is the deprecated alias of Loop", () => {
        expect(Loop({ skipIf: true, id: "skipped" })).toBeNull();
        expect(Ralph).toBe(Loop);
    });
});

describe("Supervisor structural defaults and worktree wiring", () => {
    const baseProps = {
        boss: agent,
        workers: { docs: agent, tests: otherAgent },
        planOutput: "plan_out",
        workerOutput: "worker_out",
        reviewOutput: "review_out",
        finalOutput: "final_out",
        children: "plan work",
    };

    test("defaults: prefix, loop caps, parallel concurrency, worker and final task wiring", () => {
        const supervisor = Supervisor(baseProps);
        const [plan, loop, final] = childArray(supervisor);

        expect(plan.props.id).toBe("supervisor-plan");
        expect(loop.type).toBe(Loop);
        expect(loop.props.id).toBe("supervisor-loop");
        expect(loop.props.until).toBe(false);
        expect(loop.props.maxIterations).toBe(3);
        expect(loop.props.onMaxReached).toBe("return-last");

        const [parallel, review] = childArray(loop.props.children);
        expect(parallel.type).toBe(Parallel);
        expect(parallel.props.maxConcurrency).toBe(5);
        const workers = childArray(parallel);
        expect(workers).toHaveLength(2);
        expect(workers[0].type).toBe(Task);
        expect(workers[0].props.id).toBe("supervisor-worker-docs");
        expect(workers[0].props.continueOnFail).toBe(true);
        expect(workers[0].props.needs).toEqual({ plan: "supervisor-plan" });
        expect(workers[1].props.agent).toBe(otherAgent);

        expect(review.props.id).toBe("supervisor-review");
        expect(review.props.needs).toEqual({
            plan: "supervisor-plan",
            "supervisor-worker-docs": "supervisor-worker-docs",
            "supervisor-worker-tests": "supervisor-worker-tests",
        });

        expect(final.props.id).toBe("supervisor-final");
        expect(final.props.needs).toEqual({
            review: "supervisor-review",
            plan: "supervisor-plan",
        });
    });

    test("custom maxIterations and maxConcurrency flow into the loop and parallel block", () => {
        const supervisor = Supervisor({
            ...baseProps,
            id: "boss",
            maxIterations: 9,
            maxConcurrency: 2,
        });
        const loop = childArray(supervisor)[1];
        expect(loop.props.maxIterations).toBe(9);
        const parallel = childArray(loop.props.children)[0];
        expect(parallel.props.maxConcurrency).toBe(2);
    });

    test("useWorktrees wraps each worker in a Worktree with a per-worker path and branch", () => {
        const supervisor = Supervisor({ ...baseProps, id: "boss", useWorktrees: true });
        const loop = childArray(supervisor)[1];
        const workers = childArray(childArray(loop.props.children)[0]);
        expect(workers[0].type).toBe(Worktree);
        expect(workers[0].props.path).toBe(".worktrees/boss-worker-docs");
        expect(workers[0].props.branch).toBe("worker/boss-worker-docs");
        const wrappedTask = React.Children.only(workers[0].props.children);
        expect(wrappedTask.props.id).toBe("boss-worker-docs");
        expect(workers[1].props.path).toBe(".worktrees/boss-worker-tests");
        expect(workers[1].props.branch).toBe("worker/boss-worker-tests");
    });

    test("worker tasks carry worktree metadata through the renderer only when useWorktrees is set", async () => {
        const withWorktrees = await render(
            <Supervisor {...baseProps} id="boss" useWorktrees />,
            { plan_out: [outputRow("boss-plan", { plan: "PLAN" })] },
        );
        const docsWorker = withWorktrees.graph.tasks.find(
            (task) => task.nodeId === "boss-worker-docs",
        );
        expect(docsWorker).toBeDefined();
        // worktreePath is an absolute path with platform separators.
        expect(docsWorker.worktreePath.split(sep).join("/")).toContain(".worktrees/boss-worker-docs");
        expect(docsWorker.worktreeBranch).toBe("worker/boss-worker-docs");

        const without = await render(
            <Supervisor {...baseProps} id="plain" />,
            { plan_out: [outputRow("plain-plan", { plan: "PLAN" })] },
        );
        const plainWorker = without.graph.tasks.find(
            (task) => task.nodeId === "plain-worker-docs",
        );
        expect(plainWorker).toBeDefined();
        expect(plainWorker.worktreeId).toBeUndefined();
        expect(plainWorker.worktreePath).toBeUndefined();
    });

    test("loop exit tracks the review row: allDone must be strictly true", async () => {
        const done = await render(<Supervisor {...baseProps} id="boss" />, {
            review_out: [outputRow("boss-review", { allDone: true })],
        });
        expect(findHost(done.root, "smithers:ralph").rawProps.until).toBe(true);

        const truthyButNotTrue = await render(<Supervisor {...baseProps} id="boss" />, {
            review_out: [outputRow("boss-review", { allDone: 1 })],
        });
        expect(findHost(truthyButNotTrue.root, "smithers:ralph").rawProps.until).toBe(false);
    });
});

describe("ReviewLoop iteration caps and approval condition", () => {
    const baseProps = {
        producer: agent,
        reviewer: otherAgent,
        produceOutput: "produce_out",
        reviewOutput: "review_out",
        children: "produce",
    };

    test("defaults: prefix, maxIterations 5, return-last, single reviewer stays unwrapped", () => {
        const el = ReviewLoop(baseProps);
        expect(el.type).toBe(Loop);
        expect(el.props.id).toBe("review-loop");
        expect(el.props.until).toBe(false);
        expect(el.props.maxIterations).toBe(5);
        expect(el.props.onMaxReached).toBe("return-last");

        const [produce, review] = childArray(el.props.children);
        expect(produce.props.id).toBe("review-loop-produce");
        expect(review.props.id).toBe("review-loop-review");
        expect(review.props.agent).toBe(otherAgent);
        expect(review.props.needs).toEqual({ produced: "review-loop-produce" });
    });

    test("a single-element reviewer array is unwrapped instead of running a one-agent failover chain", () => {
        const el = ReviewLoop({ ...baseProps, reviewer: [otherAgent] });
        const review = childArray(el.props.children)[1];
        expect(review.props.agent).toBe(otherAgent);
    });

    test("custom maxIterations and onMaxReached reach the ralph host", async () => {
        const { root } = await render(
            <ReviewLoop {...baseProps} id="rl" maxIterations={2} onMaxReached="fail" />,
        );
        const ralph = findHost(root, "smithers:ralph");
        expect(ralph.rawProps.maxIterations).toBe(2);
        expect(ralph.rawProps.onMaxReached).toBe("fail");
        expect(ralph.rawProps.until).toBe(false);
    });

    test("loop exits only on a strictly-true approved review row", async () => {
        const approved = await render(<ReviewLoop {...baseProps} id="rl" />, {
            review_out: [outputRow("rl-review", { approved: true })],
        });
        expect(findHost(approved.root, "smithers:ralph").rawProps.until).toBe(true);

        const stringApproved = await render(<ReviewLoop {...baseProps} id="rl" />, {
            review_out: [outputRow("rl-review", { approved: "true" })],
        });
        expect(findHost(stringApproved.root, "smithers:ralph").rawProps.until).toBe(false);
    });
});

describe("Optimizer convergence and iteration caps", () => {
    const baseProps = {
        generator: agent,
        evaluator: otherAgent,
        generateOutput: "gen_out",
        evaluateOutput: "eval_out",
        children: "generate",
    };

    test("defaults: prefix, maxIterations 10, return-last, no convergence without targetScore", () => {
        const el = Optimizer(baseProps);
        expect(el.type).toBe(Loop);
        expect(el.props.id).toBe("optimizer");
        expect(el.props.until).toBe(false);
        expect(el.props.maxIterations).toBe(10);
        expect(el.props.onMaxReached).toBe("return-last");
    });

    test("converges when the latest score meets the target, including the exact-equality boundary", async () => {
        const above = await render(<Optimizer {...baseProps} id="opt" targetScore={0.9} />, {
            eval_out: [outputRow("opt-evaluate", { score: 0.95 })],
        });
        expect(findHost(above.root, "smithers:ralph").rawProps.until).toBe(true);

        const exact = await render(<Optimizer {...baseProps} id="opt" targetScore={0.9} />, {
            eval_out: [outputRow("opt-evaluate", { score: 0.9 })],
        });
        expect(findHost(exact.root, "smithers:ralph").rawProps.until).toBe(true);

        const below = await render(<Optimizer {...baseProps} id="opt" targetScore={0.9} />, {
            eval_out: [outputRow("opt-evaluate", { score: 0.5 })],
        });
        expect(findHost(below.root, "smithers:ralph").rawProps.until).toBe(false);
    });

    test("a non-numeric score or a missing targetScore never converges", async () => {
        const stringScore = await render(
            <Optimizer {...baseProps} id="opt" targetScore={0.9} />,
            { eval_out: [outputRow("opt-evaluate", { score: "0.95" })] },
        );
        expect(findHost(stringScore.root, "smithers:ralph").rawProps.until).toBe(false);

        const noTarget = await render(<Optimizer {...baseProps} id="opt" />, {
            eval_out: [outputRow("opt-evaluate", { score: 1 })],
        });
        expect(findHost(noTarget.root, "smithers:ralph").rawProps.until).toBe(false);
    });

    test("custom maxIterations reaches the ralph host", async () => {
        const { root } = await render(
            <Optimizer {...baseProps} id="opt" maxIterations={4} onMaxReached="fail" />,
        );
        const ralph = findHost(root, "smithers:ralph");
        expect(ralph.rawProps.maxIterations).toBe(4);
        expect(ralph.rawProps.onMaxReached).toBe("fail");
    });
});

describe("Debate round wiring", () => {
    const baseProps = {
        proposer: agent,
        opponent: otherAgent,
        judge: judgeAgent,
        argumentOutput: "argument_out",
        verdictOutput: "verdict_out",
        topic: "typed workflows",
    };

    test("rounds map to the loop's maxIterations with a default of 2 and until always false", () => {
        const defaulted = Debate(baseProps);
        const [loop, judge] = childArray(defaulted);
        expect(loop.type).toBe(Loop);
        expect(loop.props.id).toBe("debate-loop");
        expect(loop.props.until).toBe(false);
        expect(loop.props.maxIterations).toBe(2);
        expect(loop.props.onMaxReached).toBe("return-last");
        expect(judge.props.id).toBe("debate-judge");
        expect(judge.props.agent).toBe(judgeAgent);

        const singleRound = Debate({ ...baseProps, rounds: 1 });
        expect(childArray(singleRound)[0].props.maxIterations).toBe(1);
    });
});

describe("Panel minAgree threshold and default strategy", () => {
    const baseProps = {
        panelists: [
            { agent, role: "security" },
            { agent: otherAgent, role: "perf" },
        ],
        moderator: judgeAgent,
        panelistOutput: "panel_out",
        moderatorOutput: "moderator_out",
        children: "review this",
    };

    test("vote strategy threads minAgree into the moderator prompt and omits it when unset", async () => {
        const withMin = await render(
            <Panel {...baseProps} id="p" strategy="vote" minAgree={3} />,
        );
        const moderator = withMin.graph.tasks.find((t) => t.nodeId === "p-moderator");
        expect(moderator.prompt).toContain("Strategy: VOTE");
        expect(moderator.prompt).toContain("Minimum agreement required: 3.");

        const withoutMin = await render(<Panel {...baseProps} id="p" strategy="vote" />);
        const bare = withoutMin.graph.tasks.find((t) => t.nodeId === "p-moderator");
        expect(bare.prompt).toContain("Strategy: VOTE");
        expect(bare.prompt).not.toContain("Minimum agreement required");
    });

    test("consensus strategy also honors minAgree", async () => {
        const { graph } = await render(
            <Panel {...baseProps} id="p" strategy="consensus" minAgree={2} />,
        );
        const moderator = graph.tasks.find((t) => t.nodeId === "p-moderator");
        expect(moderator.prompt).toContain("Strategy: CONSENSUS");
        expect(moderator.prompt).toContain("Minimum agreement required: 2.");
    });

    test("omitting strategy defaults to synthesize", async () => {
        const { graph } = await render(<Panel {...baseProps} id="p" />);
        const moderator = graph.tasks.find((t) => t.nodeId === "p-moderator");
        expect(moderator.prompt).toContain("Strategy: SYNTHESIZE");
    });
});

describe("ClassifyAndRoute classification-result input handling", () => {
    const baseProps = {
        items: [{ id: "one" }, { id: "two" }],
        classifierAgent: agent,
        classifierOutput: "class_out",
        routeOutput: "route_out",
        categories: { bug: agent, docs: otherAgent },
    };

    test("without a classificationResult only the classify task renders and no Parallel block exists", async () => {
        const { graph, root } = await render(<ClassifyAndRoute {...baseProps} id="router" />);
        expect(graph.tasks.map((t) => t.nodeId)).toEqual(["router-classify"]);
        expect(findHosts(root, "smithers:parallel")).toHaveLength(0);

        const empty = await render(
            <ClassifyAndRoute
                {...baseProps}
                id="router"
                classificationResult={{ classifications: [] }}
            />,
        );
        expect(empty.graph.tasks.map((t) => t.nodeId)).toEqual(["router-classify"]);
    });

    test("classifications without itemId fall back to the index for route ids and default prompts", async () => {
        const { graph } = await render(
            <ClassifyAndRoute
                {...baseProps}
                id="router"
                maxConcurrency={3}
                classificationResult={{
                    classifications: [
                        { category: "bug" },
                        { category: "docs" },
                    ],
                }}
            />,
        );
        const ids = graph.tasks.map((t) => t.nodeId);
        expect(ids).toEqual(["router-classify", "router-route-0", "router-route-1"]);
        const first = graph.tasks[1];
        expect(first.label).toBe("Route: bug");
        expect(first.prompt).toContain('Handle item classified as "bug"');
        expect(first.parallelMaxConcurrency).toBe(3);
    });

    test("custom children replace the default classifier prompt", async () => {
        const { graph } = await render(
            <ClassifyAndRoute {...baseProps} id="router">
                custom classify instructions
            </ClassifyAndRoute>,
        );
        const classify = graph.tasks[0];
        expect(classify.prompt).toBe("custom classify instructions");
        expect(classify.prompt).not.toContain("Classify the following items");
    });

    test("the default classifier prompt lists categories and serializes the items", async () => {
        const { graph } = await render(<ClassifyAndRoute {...baseProps} id="router" />);
        const classify = graph.tasks[0];
        expect(classify.prompt).toContain("bug, docs");
        expect(classify.prompt).toContain('"id": "one"');
        expect(classify.prompt).toContain('"id": "two"');
    });
});

describe("GatherAndSynthesize prompt precedence", () => {
    const baseProps = {
        sources: {
            web: { agent },
            code: { agent: otherAgent },
        },
        synthesizer: judgeAgent,
        gatherOutput: "gather_out",
        synthesisOutput: "synthesis_out",
    };

    test("without gatheredResults the synthesis prompt names the sources and gathers use their default prompt", async () => {
        const { graph } = await render(<GatherAndSynthesize {...baseProps} id="g" />);
        const gather = graph.tasks.find((t) => t.nodeId === "g-gather-web");
        expect(gather.prompt).toBe('Gather data from source "web".');
        const synth = graph.tasks.find((t) => t.nodeId === "g-synthesize");
        expect(synth.prompt).toContain("Synthesize the gathered data from sources: web, code.");
        // Neither gather task has produced output yet, so both sources are
        // reported as unresolved rather than injecting empty/fabricated data.
        expect(synth.prompt).toContain("## web\n(no data — this source failed)");
        expect(synth.prompt).toContain("## code\n(no data — this source failed)");
    });

    test("synthesisPrompt overrides the default and children override synthesisPrompt", async () => {
        const withPrompt = await render(
            <GatherAndSynthesize
                {...baseProps}
                id="g"
                gatheredResults={{ web: { hits: 2 } }}
                synthesisPrompt="use the override"
            />,
        );
        const synth = withPrompt.graph.tasks.find((t) => t.nodeId === "g-synthesize");
        expect(synth.prompt).toBe("use the override");

        const withChildren = await render(
            <GatherAndSynthesize {...baseProps} id="g" synthesisPrompt="use the override">
                children win
            </GatherAndSynthesize>,
        );
        const childSynth = withChildren.graph.tasks.find((t) => t.nodeId === "g-synthesize");
        expect(childSynth.prompt).toBe("children win");
    });
});

describe("DecisionTable first-match fallback boundaries", () => {
    test("first-match falls through to the default when no rule matches", async () => {
        const { graph } = await render(
            <DecisionTable
                rules={[
                    { when: false, then: <Task id="a" output="out">{{ ok: "a" }}</Task> },
                    { when: false, then: <Task id="b" output="out">{{ ok: "b" }}</Task> },
                ]}
                default={<Task id="fallback" output="out">{{ ok: true }}</Task>}
            />,
        );
        expect(graph.tasks.map((t) => t.nodeId)).toEqual(["fallback"]);
    });

    test("first-match with no matches and no default renders nothing", async () => {
        const { graph } = await render(
            <DecisionTable
                rules={[
                    { when: false, then: <Task id="a" output="out">{{ ok: "a" }}</Task> },
                ]}
            />,
        );
        expect(graph.tasks).toHaveLength(0);
    });

    test("an empty rule table renders the default for both strategies", async () => {
        const first = await render(
            <DecisionTable
                rules={[]}
                default={<Task id="d1" output="out">{{ ok: true }}</Task>}
            />,
        );
        expect(first.graph.tasks.map((t) => t.nodeId)).toEqual(["d1"]);

        const all = await render(
            <DecisionTable
                strategy="all-match"
                rules={[]}
                default={<Task id="d2" output="out">{{ ok: true }}</Task>}
            />,
        );
        expect(all.graph.tasks.map((t) => t.nodeId)).toEqual(["d2"]);
    });

    test("first-match runs only the first of several matching rules", async () => {
        const { graph } = await render(
            <DecisionTable
                rules={[
                    { when: true, then: <Task id="first" output="out">{{ ok: 1 }}</Task> },
                    { when: true, then: <Task id="second" output="out">{{ ok: 2 }}</Task> },
                ]}
            />,
        );
        expect(graph.tasks.map((t) => t.nodeId)).toEqual(["first"]);
    });
});

describe("Optimizer falsy-but-valid targetScore boundary", () => {
    const baseProps = {
        generator: agent,
        evaluator: otherAgent,
        generateOutput: "gen_out",
        evaluateOutput: "eval_out",
        children: "generate",
    };

    test("targetScore 0 is a real target: score 0 converges, a negative score does not", async () => {
        const atZero = await render(<Optimizer {...baseProps} id="opt" targetScore={0} />, {
            eval_out: [outputRow("opt-evaluate", { score: 0 })],
        });
        expect(findHost(atZero.root, "smithers:ralph").rawProps.until).toBe(true);

        const belowZero = await render(<Optimizer {...baseProps} id="opt" targetScore={0} />, {
            eval_out: [outputRow("opt-evaluate", { score: -0.5 })],
        });
        expect(findHost(belowZero.root, "smithers:ralph").rawProps.until).toBe(false);
    });
});

describe("Supervisor and GatherAndSynthesize with empty collections", () => {
    test("Supervisor with zero workers still renders plan, review, and final", async () => {
        const { graph } = await render(
            <Supervisor
                id="boss"
                boss={agent}
                workers={{}}
                planOutput="plan_out"
                workerOutput="worker_out"
                reviewOutput="review_out"
                finalOutput="final_out"
            >
                plan work
            </Supervisor>,
        );
        expect(graph.tasks.map((t) => t.nodeId)).toEqual([
            "boss-plan",
            "boss-review",
            "boss-final",
        ]);
    });

    test("GatherAndSynthesize with zero sources renders only the synthesis task with no needs", async () => {
        const { graph } = await render(
            <GatherAndSynthesize
                id="g"
                sources={{}}
                synthesizer={judgeAgent}
                gatherOutput="gather_out"
                synthesisOutput="synthesis_out"
            />,
        );
        expect(graph.tasks.map((t) => t.nodeId)).toEqual(["g-synthesize"]);
        // The empty needs map normalizes away: the synthesis task waits on nothing.
        expect(graph.tasks[0].needs).toBeUndefined();
    });
});

describe("GatherAndSynthesize per-source content precedence", () => {
    test("source children beat source prompt when both are set", async () => {
        const { graph } = await render(
            <GatherAndSynthesize
                id="g"
                sources={{
                    web: { agent, children: "use the children", prompt: "not this prompt" },
                }}
                synthesizer={judgeAgent}
                gatherOutput="gather_out"
                synthesisOutput="synthesis_out"
            />,
        );
        const gather = graph.tasks.find((t) => t.nodeId === "g-gather-web");
        expect(gather.prompt).toBe("use the children");
    });
});

describe("ClassifyAndRoute per-category config fallbacks", () => {
    test("a config with only an agent falls back to routeOutput and the default route prompt", async () => {
        const { graph } = await render(
            <ClassifyAndRoute
                id="router"
                items={[{ id: "one" }]}
                classifierAgent={agent}
                classifierOutput="class_out"
                routeOutput="route_out"
                categories={{ bug: { agent: otherAgent } }}
                classificationResult={{
                    classifications: [{ itemId: "A", category: "bug" }],
                }}
            />,
        );
        const route = graph.tasks.find((t) => t.nodeId === "router-route-A");
        expect(route).toBeDefined();
        expect(route.outputTableName).toBe("route_out");
        expect(route.prompt).toContain('Handle item classified as "bug"');
        expect(route.agent).toBe(otherAgent);
        expect(route.continueOnFail).toBe(true);
    });
});

describe("Panel panelist identity, concurrency, and input guard", () => {
    const baseProps = {
        moderator: judgeAgent,
        panelistOutput: "panel_out",
        moderatorOutput: "moderator_out",
        children: "review this",
    };

    test("when a panelist has both label and role, label names the task id and role names the display label", async () => {
        const { graph } = await render(
            <Panel
                {...baseProps}
                id="p"
                panelists={[{ agent, label: "lbl", role: "security" }]}
            />,
        );
        const panelist = graph.tasks.find((t) => t.nodeId === "p-lbl");
        expect(panelist).toBeDefined();
        expect(panelist.label).toBe("security");
    });

    test("maxConcurrency reaches the panelist parallel block", async () => {
        const { graph } = await render(
            <Panel
                {...baseProps}
                id="p"
                maxConcurrency={1}
                panelists={[
                    { agent, role: "security" },
                    { agent: otherAgent, role: "perf" },
                ]}
            />,
        );
        const panelist = graph.tasks.find((t) => t.nodeId === "p-security");
        expect(panelist.parallelMaxConcurrency).toBe(1);
    });

    test("a non-array panelists value is rejected with the same loud error as an empty list", () => {
        expect(() => Panel({ ...baseProps, id: "p", panelists: agent })).toThrow(
            /at least one panelist/i,
        );
    });
});

describe("Debate side prompts and output tables", () => {
    test("proposer argues FOR and opponent argues AGAINST the same topic into the shared argument table", async () => {
        const { graph } = await render(
            <Debate
                id="d"
                proposer={agent}
                opponent={otherAgent}
                judge={judgeAgent}
                argumentOutput="argument_out"
                verdictOutput="verdict_out"
                topic="typed workflows"
            />,
        );
        const proposer = graph.tasks.find((t) => t.nodeId === "d-proposer");
        const opponent = graph.tasks.find((t) => t.nodeId === "d-opponent");
        const judge = graph.tasks.find((t) => t.nodeId === "d-judge");

        expect(proposer.prompt).toContain("Argue FOR");
        expect(proposer.prompt).toContain("typed workflows");
        expect(opponent.prompt).toContain("Argue AGAINST");
        expect(opponent.prompt).toContain("typed workflows");
        expect(proposer.outputTableName).toBe("argument_out");
        expect(opponent.outputTableName).toBe("argument_out");
        expect(judge.outputTableName).toBe("verdict_out");
        expect(judge.prompt).toContain("render a verdict");
    });
});

describe("SuperSmithers prompts and dependency chains", () => {
    test("the read prompt embeds the strategy text and the target globs, defaulting to all files", () => {
        const withGlobs = SuperSmithers({
            id: "ss",
            strategy: "Refactor everything",
            agent,
            targetFiles: ["src/**/*.ts", "docs/*.md"],
            dryRun: true,
            reportOutput: "report_out",
        });
        const read = childArray(withGlobs)[0];
        expect(read.props.children).toContain("Refactor everything");
        expect(read.props.children).toContain("src/**/*.ts, docs/*.md");

        const withoutGlobs = SuperSmithers({
            id: "ss",
            strategy: "Refactor everything",
            agent,
            dryRun: true,
            reportOutput: "report_out",
        });
        const bareRead = childArray(withoutGlobs)[0];
        expect(bareRead.props.children).toContain("All files in the project");
    });

    test("dry run proposes without editing while the apply run edits and gates the report on the apply barrier", () => {
        const dry = SuperSmithers({
            id: "ss",
            strategy: "Refactor",
            agent,
            dryRun: true,
            reportOutput: "report_out",
        });
        const [, dryPropose, dryReport] = childArray(dry);
        expect(dryPropose.props.children).toContain("DRY RUN");
        expect(dryPropose.props.children).toContain("do NOT modify any files");
        expect(dryReport.props.dependsOn).toEqual(["ss-propose"]);
        expect(dryReport.props.children).toContain("proposed (dry run)");

        const apply = SuperSmithers({
            id: "ss",
            strategy: "Refactor",
            agent,
            reportOutput: "report_out",
        });
        const [, applyPropose, applyBarrier, applyReport] = childArray(apply);
        expect(applyPropose.props.children).toContain(
            "apply the necessary code modifications directly",
        );
        expect(applyPropose.props.children).not.toContain("DRY RUN");
        expect(applyBarrier.props.dependsOn).toEqual(["ss-propose"]);
        expect(applyReport.props.dependsOn).toEqual(["ss-apply"]);
        expect(applyReport.props.children).toContain("applied");
    });

    test("omitting the id uses the super-smithers prefix and a JSX strategy still lists target files", () => {
        const defaulted = SuperSmithers({
            strategy: "Refactor",
            agent,
            dryRun: true,
        });
        expect(childArray(defaulted).map((child) => child.props.id)).toEqual([
            "super-smithers-read",
            "super-smithers-propose",
            "super-smithers-report",
        ]);

        const jsxStrategy = SuperSmithers({
            id: "jx",
            strategy: <p>Strategy doc</p>,
            agent,
            targetFiles: ["src/a.ts"],
            dryRun: true,
        });
        // An element strategy is flattened to prompt text at render time — the
        // raw smithers:task host stringifies its children, so leaving a live
        // React element here used to crash the run with "[object Object]".
        const read = childArray(jsxStrategy)[0];
        expect(typeof read.props.children).toBe("string");
        expect(read.props.children).toContain("Strategy doc");
        expect(read.props.children).toContain("Target files");
        expect(read.props.children).toContain("src/a.ts");
    });
});
