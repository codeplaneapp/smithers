// @ts-nocheck
/**
 * <DocumentExceptionQueue> - Extract a document packet, reconcile it, and queue exceptions.
 *
 * Pattern: classify packet -> parallel extraction -> reconciliation -> targeted
 * retry -> human exception review -> normalized export.
 * Use cases: AP packet matching, claim document review, onboarding packets,
 * banking and insurance back-office automation.
 *
 * Smithers implementation: extraction is parallel, reconciliation is a durable
 * loop, and only high-severity mismatches pause for human review.
 */
import { Sequence, Parallel, Loop } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit.js";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, write, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import ClassifyPrompt from "./prompts/document-exception-queue/classify.mdx";
import ExtractPrompt from "./prompts/document-exception-queue/extract.mdx";
import ReconcilePrompt from "./prompts/document-exception-queue/reconcile.mdx";
import TargetedReextractPrompt from "./prompts/document-exception-queue/targeted-reextract.mdx";
import ExportPrompt from "./prompts/document-exception-queue/export.mdx";

function nodeId(value) {
    return String(value ?? "document").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "document";
}

const documentClassSchema = z.object({
    file: z.string(),
    type: z.enum(["invoice", "purchase-order", "receipt", "contract", "bank-statement", "unknown"]),
    confidence: z.number().min(0).max(1),
    reason: z.string(),
});

const extractionSchema = z.object({
    file: z.string(),
    fields: z.record(z.string(), z.unknown()),
    tables: z.array(z.record(z.string(), z.unknown())),
    confidence: z.number().min(0).max(1),
    missingFields: z.array(z.string()),
});

const reconciliationSchema = z.object({
    passed: z.boolean(),
    checks: z.array(z.object({
        name: z.string(),
        passed: z.boolean(),
        explanation: z.string(),
    })),
    exceptions: z.array(z.object({
        severity: z.enum(["low", "medium", "high"]),
        message: z.string(),
        files: z.array(z.string()),
    })),
});

const approvalSchema = z.object({
    approved: z.boolean(),
    reviewer: z.string(),
    note: z.string(),
});

const exportSchema = z.object({
    normalizedJsonPath: z.string(),
    exceptionQueuePath: z.string(),
    passThrough: z.boolean(),
    summary: z.string(),
});

const { Workflow, Task, Branch, Approval, smithers, outputs } = createExampleSmithers({
    documentClass: documentClassSchema,
    extraction: extractionSchema,
    reconciliation: reconciliationSchema,
    approval: approvalSchema,
    exportRecord: exportSchema,
});

const classifierAgent = new Agent({
    model: anthropic("claude-sonnet-4-6"),
    tools: { read, bash, grep },
    instructions: `You are a document packet classifier. Identify document type and
confidence from filenames, OCR text, or supplied content. Explain uncertain cases.`,
});

const extractorAgent = new Agent({
    model: anthropic("claude-sonnet-4-6"),
    tools: { read, bash, grep },
    instructions: `You are a document extractor. Extract typed fields and tables,
track missing fields, and report honest confidence. Prefer source-grounded values.`,
});

const reconciliationAgent = new Agent({
    model: anthropic("claude-sonnet-4-6"),
    tools: { read, bash },
    instructions: `You are a reconciliation analyst. Compare extracted fields across
documents and master data. Check totals, vendor identity, PO references, dates,
and policy rules. Return exceptions with severity.`,
});

const exportAgent = new Agent({
    model: anthropic("claude-sonnet-4-6"),
    tools: { read, write, bash },
    instructions: `You are a document operations exporter. Write normalized JSON and
exception queue files. Mark passThrough false when unresolved high-severity issues remain.`,
});

export default smithers((ctx) => {
    const files = ctx.input.files ?? [
        "fixtures/document-exception-queue/invoice.pdf",
        "fixtures/document-exception-queue/purchase-order.pdf",
        "fixtures/document-exception-queue/receipt.png",
    ];
    const reconciliation = ctx.outputMaybe("reconciliation", { nodeId: "reconcile" });
    const passed = reconciliation?.passed === true;
    const highSeverity = (reconciliation?.exceptions ?? []).some((exception) => exception.severity === "high");

    return (
        <Workflow name="document-exception-queue">
            <Sequence>
                <Parallel maxConcurrency={ctx.input.maxConcurrency ?? 8}>
                    {files.map((file) => (
                        <Task key={file} id={`classify-${nodeId(file)}`} output={outputs.documentClass} agent={classifierAgent}>
                            <ClassifyPrompt file={file} packetContext={ctx.input.packetContext ?? ""} />
                        </Task>
                    ))}
                </Parallel>

                <Parallel maxConcurrency={ctx.input.maxConcurrency ?? 8}>
                    {files.map((file) => (
                        <Task key={file} id={`extract-${nodeId(file)}`} output={outputs.extraction} agent={extractorAgent}>
                            <ExtractPrompt
                                file={file}
                                documentClasses={ctx.outputs.documentClass ?? []}
                                targetFields={ctx.input.targetFields ?? ["vendor", "amount", "tax", "poNumber", "date", "lineItems"]}
                            />
                        </Task>
                    ))}
                </Parallel>

                <Loop
                    until={passed}
                    maxIterations={ctx.input.maxReconcileIterations ?? 2}
                    onMaxReached="return-last"
                >
                    <Sequence>
                        <Task id="reconcile" output={outputs.reconciliation} agent={reconciliationAgent}>
                            <ReconcilePrompt
                                extractions={ctx.outputs.extraction ?? []}
                                documentClasses={ctx.outputs.documentClass ?? []}
                                vendorMaster={ctx.input.vendorMaster ?? "fixtures/document-exception-queue/vendor-master.json"}
                                checks={ctx.input.checks ?? [
                                    "Invoice total equals line subtotal plus tax.",
                                    "Vendor matches vendor master.",
                                    "PO number appears on purchase order and invoice.",
                                    "Receipt amount does not exceed approved PO amount.",
                                ]}
                            />
                        </Task>

                        <Task id="targeted-reextract" output={outputs.extraction} agent={extractorAgent} skipIf={passed}>
                            <TargetedReextractPrompt
                                reconciliation={reconciliation}
                                extractions={ctx.outputs.extraction ?? []}
                                files={files}
                            />
                        </Task>
                    </Sequence>
                </Loop>

                <Branch
                    if={highSeverity}
                    then={
                        <Approval
                            id="human-exception-review"
                            output={outputs.approval}
                            request={{
                                title: "Review document exception queue",
                                summary: `${(reconciliation?.exceptions ?? []).filter((exception) => exception.severity === "high").length} high-severity exception(s) require review.`,
                            }}
                        />
                    }
                    else={null}
                />

                <Task id="export-normalized-record" output={outputs.exportRecord} agent={exportAgent}>
                    <ExportPrompt
                        extractions={ctx.outputs.extraction ?? []}
                        reconciliation={reconciliation}
                        approval={ctx.outputMaybe("approval", { nodeId: "human-exception-review" })}
                        outputDir={ctx.input.outputDir ?? "artifacts/document-exception-queue"}
                    />
                </Task>
            </Sequence>
        </Workflow>
    );
});
