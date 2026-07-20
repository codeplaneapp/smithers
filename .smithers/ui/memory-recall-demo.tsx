/** @jsxImportSource react */
import { useMemo } from "react";
import { createGatewayReactRoot, useGatewayMemoryFacts, useGatewayRun, useGatewayRunEvents, useGatewayRunTree } from "smithers-orchestrator/gateway-react";
import { RunEventLog, RunTree, WorkflowUiShell, WorkflowUiStyles } from "smithers-orchestrator/gateway-ui";
import { Badge, Card, EmptyState, SmithersUiStyles, StatusPill, Table, TableBody, TableCell, TableRow } from "smithers-orchestrator/ui";

type MemoryConfig = {
	bank: string;
	tags: string[];
	recall: "auto" | string | false;
	budget?: "low" | "mid" | "high";
	maxTokens?: number;
	primers?: string[];
	retain: "on-complete" | "off";
	tools: boolean;
};

type LifecycleRow = {
	nodeId: string;
	label: string;
	config: MemoryConfig;
	status: string;
	toolCalls: string[];
	recalled: string[];
	recallTokens?: number;
	digest: string | undefined;
};

const inheritedConfig: MemoryConfig = {
	bank: "support-triage-demo",
	tags: ["source:run", "scope:main", "branch:main", "stream:release-demo"],
	recall: "auto",
	budget: "low",
	maxTokens: 1200,
	primers: ["support-triage-primer"],
	retain: "on-complete",
	tools: true,
};

export const MEMORY_TASK_CONFIGS: Record<string, { label: string; mode: string; config: MemoryConfig }> = {
	triage: { label: "Triage incident", mode: "inherited", config: inheritedConfig },
	investigation: {
		label: "Investigate known issue",
		mode: "overridden",
		config: { ...inheritedConfig, recall: "duplicate invoice retry idempotency history", retain: "off" },
	},
	"customer-response": {
		label: "Write customer response",
		mode: "opted out",
		config: { bank: inheritedConfig.bank, tags: inheritedConfig.tags, recall: false, retain: "off", tools: false },
	},
};

function runIdFromUrl(): string | undefined {
	if (typeof location === "undefined") return undefined;
	return new URLSearchParams(location.search).get("runId") ?? undefined;
}

function parseJson(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

function eventType(event: { event: string; payload?: unknown }): string {
	return event.event.toLowerCase().replaceAll("_", ".");
}

function isMemoryRecallEvent(event: { event: string }): boolean {
	return eventType(event).includes("memoryrecalled");
}

function memoryRecallText(payload: unknown): { text: string; tokens?: number } | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const raw = payload as Record<string, unknown>;
	const text = typeof raw.text === "string" ? raw.text : typeof raw.content === "string" ? raw.content : undefined;
	if (!text) return undefined;
	return { text, tokens: typeof raw.tokens === "number" ? raw.tokens : undefined };
}

function retainedContent(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const content = (value as Record<string, unknown>).content;
	return typeof content === "string" ? content : undefined;
}

export function deriveMemoryLifecycle(
	nodes: ReadonlyArray<{ id: string; status: string; toolCalls?: ReadonlyArray<Record<string, unknown>> }>,
	events: ReadonlyArray<{ event: string; payload?: unknown }>,
	facts: ReadonlyArray<{ valueJson: string }>,
): LifecycleRow[] {
	return Object.entries(MEMORY_TASK_CONFIGS).map(([nodeId, definition]) => {
		const node = nodes.find((candidate) => candidate.id === nodeId);
		const taskEvents = events.filter((event) => {
			if (!isMemoryRecallEvent(event)) return false;
			const payload = event.payload;
			return !payload || typeof payload !== "object" || (payload as Record<string, unknown>).nodeId === nodeId;
		});
		const recalled = taskEvents.map((event) => memoryRecallText(event.payload)).filter((value): value is { text: string; tokens?: number } => Boolean(value));
		const toolCalls = (node?.toolCalls ?? [])
			.map((call) => (typeof call.name === "string" ? call.name : typeof call.toolName === "string" ? call.toolName : ""))
			.filter((name) => name === "remember" || name === "recall");
		const digest = facts
			.map((fact) => parseJson(fact.valueJson))
			.map(retainedContent)
			.find((content) => content?.includes(`Task ${nodeId} completed successfully.`));
		return {
			nodeId,
			label: definition.label,
			config: definition.config,
			status: node?.status ?? "queued",
			toolCalls,
			recalled: recalled.map((value) => value.text),
			recallTokens: recalled.reduce((sum, value) => sum + (value.tokens ?? 0), 0) || undefined,
			digest,
		};
	});
}

function ConfigTable({ config }: { config: MemoryConfig }) {
	return (
		<Table>
			<TableBody>
				<TableRow><TableCell>bank</TableCell><TableCell>{config.bank}</TableCell></TableRow>
				<TableRow><TableCell>recall</TableCell><TableCell>{config.recall === false ? "false" : config.recall}</TableCell></TableRow>
				<TableRow><TableCell>retain</TableCell><TableCell>{config.retain}</TableCell></TableRow>
				<TableRow><TableCell>tools</TableCell><TableCell>{config.tools ? "remember + recall" : "disabled"}</TableCell></TableRow>
				<TableRow><TableCell>cap</TableCell><TableCell>{config.maxTokens ? `${config.maxTokens} tokens` : "default"}</TableCell></TableRow>
			</TableBody>
		</Table>
	);
}

export function LifecycleCard({ row }: { row: LifecycleRow }) {
	return (
		<Card>
			<div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
				<div>
					<h2 style={{ margin: 0 }}>{row.label}</h2>
					<p style={{ margin: "6px 0 0", opacity: 0.7 }}>{row.nodeId} · {MEMORY_TASK_CONFIGS[row.nodeId]?.mode}</p>
				</div>
				<StatusPill status={row.status as never} />
			</div>
			<div
				style={{
					display: "grid",
					gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
					gap: 12,
					marginTop: 16,
				}}
			>
				<div>
					<Badge>1 · RECALL</Badge>
					<p>{row.recalled.length ? row.recalled.join("\n\n") : "No recalled block is exposed by the gateway."}</p>
					<small>
						{row.recallTokens
							? `${row.recallTokens} reported tokens`
							: `Configured cap: ${row.config.maxTokens ?? 2048} tokens`}
					</small>
				</div>
				<div>
					<Badge>2 · TASK</Badge>
					<p>Task output: {row.status === "ok" ? "completed" : row.status}.</p>
					<p>Tools: {row.toolCalls.length ? row.toolCalls.join(", ") : "none observed"}</p>
				</div>
				<div>
					<Badge>3 · RETAIN</Badge>
					<p>
						{row.digest ??
							(row.config.retain === "on-complete"
								? "Waiting for the async retained fact."
								: "Retention is disabled for this task.")}
					</p>
				</div>
			</div>
			<details style={{ marginTop: 12 }}>
				<summary>Resolved memory configuration</summary>
				<ConfigTable config={row.config} />
			</details>
		</Card>
	);
}

export function MemoryRecallApp({ runId = runIdFromUrl() }: { runId?: string } = {}) {
	const run = useGatewayRun(runId);
	const tree = useGatewayRunTree(runId);
	const stream = useGatewayRunEvents(runId, { maxEvents: 1000 });
	const facts = useGatewayMemoryFacts();
	const rows = useMemo(() => deriveMemoryLifecycle(tree.nodes, stream.events, facts.data ?? []), [facts.data, stream.events, tree.nodes]);
	const status = typeof run.data === "object" && run.data !== null && "status" in run.data ? String(run.data.status) : undefined;

	return (
		<WorkflowUiShell title="Memory Recall" subtitle={`${runId ?? "preview"} · recall → task → retain`} status={status}>
			<WorkflowUiStyles />
			<SmithersUiStyles />
			<Card>
				<h2 style={{ marginTop: 0 }}>Memory lifecycle</h2>
				<p>
					Each task resolves a memory policy. The arrows are the same lifecycle
					the engine runs: recalled context enters, the agent works, and
					successful output is retained asynchronously.
				</p>
				{rows.length
					? rows.map((row) => <LifecycleCard key={row.nodeId} row={row} />)
					: <EmptyState
						title="No memory tasks yet"
						description="Start a memory-recall-demo run to populate the lifecycle."
					  />}
			</Card>
			<div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 16, marginTop: 16 }}>
				<Card><h2 style={{ marginTop: 0 }}>Run tree</h2><RunTree runId={runId} /></Card>
				<Card><h2 style={{ marginTop: 0 }}>Gateway events</h2><RunEventLog runId={runId} style={{ height: 320 }} /></Card>
			</div>
			{facts.data?.length === 0 ? (
				<EmptyState
					title="No retained local facts"
					description="With HINDSIGHT_URL unset, run completion writes local facts asynchronously. Refresh after the run finishes."
				/>
			) : null}
		</WorkflowUiShell>
	);
}

if (typeof document !== "undefined") createGatewayReactRoot(<MemoryRecallApp />);
