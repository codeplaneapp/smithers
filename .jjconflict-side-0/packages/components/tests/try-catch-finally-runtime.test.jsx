/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { Parallel, Sequence, SmithersErrorInstance, TryCatchFinally, runWorkflow } from "smithers-orchestrator";
import { createTestSmithers } from "./helpers.js";
import { z } from "zod";
import { Effect } from "effect";
const COMPONENT_TIMEOUT_MS = 30_000;
/**
 * @param {string} name
 * @param {() => Promise<unknown>} fn
 */
function workflowTest(name, fn) {
    test(name, fn, COMPONENT_TIMEOUT_MS);
}
function createTcfSmithers() {
    return createTestSmithers({
        attempt: z.object({ ok: z.boolean() }),
        recovery: z.object({ handled: z.string() }),
        cleanup: z.object({ done: z.boolean() }),
    });
}
describe("TryCatchFinally runtime", () => {
    workflowTest("try success runs finally and skips catch", async () => {
        const { Workflow, Task, smithers, outputs, tables, db, cleanup } = createTcfSmithers();
        const workflow = smithers(() => (<Workflow name="tcf-success">
        <TryCatchFinally id="tcf" try={<Task id="attempt" output={outputs.attempt}>
              {{ ok: true }}
            </Task>} catch={<Task id="recover" output={outputs.recovery}>
              {{ handled: "should-not-run" }}
            </Task>} finally={<Task id="clean" output={outputs.cleanup}>
              {{ done: true }}
            </Task>}/>
      </Workflow>));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");
        expect(db.select().from(tables.attempt).all().length).toBe(1);
        expect(db.select().from(tables.recovery).all().length).toBe(0);
        expect(db.select().from(tables.cleanup).all().length).toBe(1);
        cleanup();
    });
    workflowTest("try failure mounts catch then finally and the run finishes", async () => {
        const { Workflow, Task, smithers, outputs, tables, db, cleanup } = createTcfSmithers();
        const workflow = smithers(() => (<Workflow name="tcf-catch">
        <TryCatchFinally id="tcf" try={<Task id="attempt" output={outputs.attempt} noRetry>
              {() => {
                    throw new Error("boom");
                }}
            </Task>} catch={<Task id="recover" output={outputs.recovery}>
              {{ handled: "boom" }}
            </Task>} finally={<Task id="clean" output={outputs.cleanup}>
              {{ done: true }}
            </Task>}/>
      </Workflow>));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");
        expect(db.select().from(tables.recovery).all().length).toBe(1);
        expect(db.select().from(tables.cleanup).all().length).toBe(1);
        cleanup();
    });
    workflowTest("catchless try failure still runs finally then fails the run", async () => {
        const { Workflow, Task, smithers, outputs, tables, db, cleanup } = createTcfSmithers();
        const workflow = smithers(() => (<Workflow name="tcf-catchless">
        <TryCatchFinally id="tcf" try={<Task id="attempt" output={outputs.attempt} noRetry>
              {() => {
                    throw new Error("boom");
                }}
            </Task>} finally={<Task id="clean" output={outputs.cleanup}>
              {{ done: true }}
            </Task>}/>
      </Workflow>));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("failed");
        expect(JSON.stringify(result.error)).toContain("TryCatchFinally tcf failed");
        expect(db.select().from(tables.cleanup).all().length).toBe(1);
        cleanup();
    });
    workflowTest("catchErrors matching the failure code mounts catch", async () => {
        const { Workflow, Task, smithers, outputs, tables, db, cleanup } = createTcfSmithers();
        const workflow = smithers(() => (<Workflow name="tcf-filter-match">
        <TryCatchFinally id="tcf-filter" catchErrors={["INVALID_INPUT"]} try={<Task id="attempt" output={outputs.attempt} noRetry>
              {() => {
                    throw new SmithersErrorInstance("INVALID_INPUT", "bad payload");
                }}
            </Task>} catch={<Task id="recover" output={outputs.recovery}>
              {{ handled: "invalid-input" }}
            </Task>} finally={<Task id="clean" output={outputs.cleanup}>
              {{ done: true }}
            </Task>}/>
      </Workflow>));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");
        expect(db.select().from(tables.recovery).all().length).toBe(1);
        expect(db.select().from(tables.cleanup).all().length).toBe(1);
        cleanup();
    });
    workflowTest("catchErrors not matching the failure code skips catch, runs finally, and fails the run", async () => {
        const { Workflow, Task, smithers, outputs, tables, db, cleanup } = createTcfSmithers();
        const workflow = smithers(() => (<Workflow name="tcf-filter-miss">
        <TryCatchFinally id="tcf-filter" catchErrors={["TIMEOUT"]} try={<Task id="attempt" output={outputs.attempt} noRetry>
              {() => {
                    throw new SmithersErrorInstance("INVALID_INPUT", "bad payload");
                }}
            </Task>} catch={<Task id="recover" output={outputs.recovery}>
              {{ handled: "should-not-run" }}
            </Task>} finally={<Task id="clean" output={outputs.cleanup}>
              {{ done: true }}
            </Task>}/>
      </Workflow>));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("failed");
        expect(JSON.stringify(result.error)).toContain("TryCatchFinally tcf-filter failed");
        expect(db.select().from(tables.recovery).all().length).toBe(0);
        expect(db.select().from(tables.cleanup).all().length).toBe(1);
        cleanup();
    });
    workflowTest("catchErrors arms when at least one of several parallel try failures matches", async () => {
        const { Workflow, Task, smithers, outputs, tables, db, cleanup } = createTcfSmithers();
        const workflow = smithers(() => (<Workflow name="tcf-filter-partial-match">
        <TryCatchFinally id="tcf-partial" catchErrors={["TIMEOUT"]} try={<Parallel>
              <Task id="fail-invalid" output={outputs.attempt} noRetry>
                {() => {
                    throw new SmithersErrorInstance("INVALID_INPUT", "bad payload");
                }}
              </Task>
              <Task id="fail-timeout" output={outputs.attempt} noRetry>
                {() => {
                    throw new SmithersErrorInstance("TIMEOUT", "took too long");
                }}
              </Task>
            </Parallel>} catch={<Task id="recover" output={outputs.recovery}>
              {{ handled: "timeout" }}
            </Task>} finally={<Task id="clean" output={outputs.cleanup}>
              {{ done: true }}
            </Task>}/>
      </Workflow>));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");
        expect(db.select().from(tables.recovery).all().length).toBe(1);
        expect(db.select().from(tables.cleanup).all().length).toBe(1);
        cleanup();
    });
    workflowTest("catchErrors stays disarmed when none of several parallel try failures match", async () => {
        const { Workflow, Task, smithers, outputs, tables, db, cleanup } = createTcfSmithers();
        const workflow = smithers(() => (<Workflow name="tcf-filter-all-miss">
        <TryCatchFinally id="tcf-all-miss" catchErrors={["TIMEOUT"]} try={<Parallel>
              <Task id="fail-invalid" output={outputs.attempt} noRetry>
                {() => {
                    throw new SmithersErrorInstance("INVALID_INPUT", "bad payload");
                }}
              </Task>
              <Task id="fail-db" output={outputs.attempt} noRetry>
                {() => {
                    throw new SmithersErrorInstance("DB_QUERY_FAILED", "query blew up");
                }}
              </Task>
            </Parallel>} catch={<Task id="recover" output={outputs.recovery}>
              {{ handled: "should-not-run" }}
            </Task>} finally={<Task id="clean" output={outputs.cleanup}>
              {{ done: true }}
            </Task>}/>
      </Workflow>));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("failed");
        expect(JSON.stringify(result.error)).toContain("TryCatchFinally tcf-all-miss failed");
        expect(db.select().from(tables.recovery).all().length).toBe(0);
        expect(db.select().from(tables.cleanup).all().length).toBe(1);
        cleanup();
    });
    workflowTest("catchErrors stays disarmed for a codeless try failure", async () => {
        const { Workflow, Task, smithers, outputs, tables, db, cleanup } = createTcfSmithers();
        const workflow = smithers(() => (<Workflow name="tcf-filter-codeless">
        <TryCatchFinally id="tcf-codeless" catchErrors={["TIMEOUT"]} try={<Task id="attempt" output={outputs.attempt} noRetry>
              {() => {
                    throw new Error("plain failure without a code");
                }}
            </Task>} catch={<Task id="recover" output={outputs.recovery}>
              {{ handled: "should-not-run" }}
            </Task>} finally={<Task id="clean" output={outputs.cleanup}>
              {{ done: true }}
            </Task>}/>
      </Workflow>));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("failed");
        expect(JSON.stringify(result.error)).toContain("TryCatchFinally tcf-codeless failed");
        expect(db.select().from(tables.recovery).all().length).toBe(0);
        expect(db.select().from(tables.cleanup).all().length).toBe(1);
        cleanup();
    });
    workflowTest("an unmatched inner catchErrors filter propagates to the outer boundary", async () => {
        const { Workflow, Task, smithers, outputs, tables, db, cleanup } = createTcfSmithers();
        const workflow = smithers(() => (<Workflow name="tcf-filter-propagate">
        <TryCatchFinally id="outer" try={<Sequence>
              <TryCatchFinally id="inner" catchErrors={["TIMEOUT"]} try={<Task id="attempt" output={outputs.attempt} noRetry>
                    {() => {
                        throw new SmithersErrorInstance("INVALID_INPUT", "bad payload");
                    }}
                  </Task>} catch={<Task id="inner-recover" output={outputs.recovery}>
                    {{ handled: "should-not-run" }}
                  </Task>}/>
            </Sequence>} catch={<Task id="outer-recover" output={outputs.recovery}>
              {{ handled: "outer" }}
            </Task>}/>
      </Workflow>));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");
        const recoveryRows = db.select().from(tables.recovery).all();
        expect(recoveryRows.length).toBe(1);
        expect(recoveryRows[0].handled).toBe("outer");
        cleanup();
    });
});
