/** @jsxImportSource react */
import { useMemo, useState } from "react";
import { createGatewayReactRoot, useGatewayNodeOutput, useGatewayRun } from "smthrs/gateway-react";
import { ApprovalPanel, ConnectionBadge, LaunchButton, RunEventLog, RunTree, WorkflowUiShell } from "smthrs/gateway-ui";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  KpiStat,
  SectionHeader,
  SmithersUiStyles,
  StatusPill,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "smthrs/ui";

const WORKFLOW = "whole-foods-meal-planner";
const wholeFoodsMealPlannerStyles = [
  ".wfm-form-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; }",
  ".wfm-wide { grid-column:span 2; }",
  ".wfm-full { grid-column:1 / -1; }",
  ".wfm-note { margin:0; font-size:12px; }",
  ".wfm-actions { margin-top:12px; }",
  ".wfm-stat-row { display:flex; gap:12px; flex-wrap:wrap; align-items:center; }",
  ".wfm-warning-row { display:flex; gap:6px; flex-wrap:wrap; margin-top:8px; }",
  ".wfm-meal-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:12px; }",
  ".wfm-meal-card { border:1px solid var(--sui-border,var(--border)); border-radius:8px; padding:10px; }",
  ".wfm-meal-item { margin-top:6px; }",
  ".wfm-meal-name { font-weight:600; }",
  ".wfm-small { font-size:12px; }",
  ".wfm-muted { color:var(--sui-muted-foreground,var(--muted)); }",
  ".wfm-section { margin-bottom:12px; }",
  ".wfm-revision-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }",
  ".wfm-bottom-note { margin-bottom:0; font-size:12px; }",
  ".wfm-checkout { margin-top:8px; }",
  ".wfm-shell-content { display:flex; flex-direction:column; gap:12px; padding:16px; }",
  ".wfm-run-grid { display:grid; grid-template-columns:260px minmax(0,1fr); gap:12px; }",
  ".wfm-event-log { height:260px; }",
  "@media (max-width:760px) { .wfm-form-grid,.wfm-revision-grid,.wfm-run-grid { grid-template-columns:1fr; } .wfm-wide,.wfm-full { grid-column:auto; } }",
].join("\n");

type GroceryItem = {
  name: string;
  quantity: string;
  packageSize: string;
  estimatedPriceUsd: number;
  estimatedCalories: number | null;
  sourceUrl: string;
  storeSection: string;
  prepTag: string;
  favoriteMatch: boolean;
};

type MealItem = {
  name: string;
  quantity: string;
  estimatedCalories: number;
  sourceUrl: string | null;
  prepMinutes: number;
  prepTag: string;
  favoriteMatch: boolean;
};

type PlanDay = {
  day: number;
  meals: Array<{
    name: string;
    items: MealItem[];
    totalCalories: number;
    memberCalories: Array<{ name: string; estimatedCalories: number }>;
  }>;
  dailyTotalCalories: number;
};

type LaunchForm = {
  householdSize: number;
  days: number;
  dailyCalorieTarget: number;
  requestedDailyCalorieTarget: number | null;
  calorieProfiles: string;
  dietaryPreferences: string;
  favoriteFoods: string;
  allergiesExclusions: string;
  maxPrepMinutes: number;
  budget: number;
  zipCode: string;
  orderWebhookUrl: string;
  requireOrderApproval: boolean;
  deliveryOnly: boolean;
  revisionPrompt: string;
  priorPlanJson: string;
};

const DEFAULT_FORM: LaunchForm = {
  householdSize: 2,
  days: 7,
  dailyCalorieTarget: 2000,
  requestedDailyCalorieTarget: null,
  calorieProfiles: "",
  dietaryPreferences: "",
  favoriteFoods: "",
  allergiesExclusions: "",
  maxPrepMinutes: 15,
  budget: 200,
  zipCode: "",
  orderWebhookUrl: "",
  requireOrderApproval: true,
  deliveryOnly: true,
  revisionPrompt: "",
  priorPlanJson: "",
};

function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function rowOf(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const row = (value as { row?: unknown }).row;
  if (isRecord(row)) return row;
  return value as Record<string, unknown>;
}

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//.test(value);
}

function asArray<T = unknown>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === "string" && value.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function groupByStoreSection<T extends { storeSection: string }>(items: readonly T[]): Record<string, T[]> {
  return items.reduce<Record<string, T[]>>((groups, item) => {
    const section = item.storeSection.trim() || "other";
    (groups[section] ??= []).push(item);
    return groups;
  }, {});
}

function LaunchPanel({ onLaunched }: { onLaunched: (runId: string) => void }) {
  const [form, setForm] = useState<LaunchForm>(DEFAULT_FORM);
  const set = <K extends keyof LaunchForm>(key: K, value: LaunchForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  return (
    <Card>
      <SectionHeader title="Launch a meal plan">
        <span>
          Configure constraints, then launch. For a revision run, paste the prior plan JSON and describe what to change.
        </span>
      </SectionHeader>
      <div className="wfm-form-grid">
        <label>
          Household size
          <Input
            type="number"
            value={form.householdSize}
            onChange={(e: any) => set("householdSize", Number(e.target.value))}
          />
        </label>
        <label>
          Days
          <Input type="number" value={form.days} onChange={(e: any) => set("days", Number(e.target.value))} />
        </label>
        <label>
          Fallback calories/person
          <Input
            type="number"
            value={form.dailyCalorieTarget}
            onChange={(e: any) => set("dailyCalorieTarget", Number(e.target.value))}
          />
        </label>
        <label className="wfm-wide">
          Person-specific calorie targets
          <Input
            value={form.calorieProfiles}
            onChange={(e: any) => set("calorieProfiles", e.target.value)}
            placeholder="You: 3500, Wife: 2500"
          />
        </label>
        <label>
          Max prep minutes
          <Input
            type="number"
            value={form.maxPrepMinutes}
            onChange={(e: any) => set("maxPrepMinutes", Number(e.target.value))}
          />
        </label>
        <label>
          Budget (USD)
          <Input type="number" value={form.budget} onChange={(e: any) => set("budget", Number(e.target.value))} />
        </label>
        <label>
          Zip code
          <Input value={form.zipCode} onChange={(e: any) => set("zipCode", e.target.value)} />
        </label>
        <label className="wfm-full">
          Dietary preferences
          <Input value={form.dietaryPreferences} onChange={(e: any) => set("dietaryPreferences", e.target.value)} />
        </label>
        <label className="wfm-full">
          Favorite foods
          <Input
            value={form.favoriteFoods}
            onChange={(e: any) => set("favoriteFoods", e.target.value)}
            placeholder="berries, sushi bowls, rotisserie chicken"
          />
        </label>
        <label className="wfm-full">
          Allergies / exclusions
          <Input value={form.allergiesExclusions} onChange={(e: any) => set("allergiesExclusions", e.target.value)} />
        </label>
        <label className="wfm-full">
          Order webhook URL (HTTPS or localhost, optional)
          <Input value={form.orderWebhookUrl} onChange={(e: any) => set("orderWebhookUrl", e.target.value)} />
        </label>
        <label>
          <input
            type="checkbox"
            checked={form.requireOrderApproval}
            onChange={(e) => set("requireOrderApproval", e.target.checked)}
          />{" "}
          Approve before checkout links
        </label>
        <label>
          <input type="checkbox" checked={form.deliveryOnly} onChange={(e) => set("deliveryOnly", e.target.checked)} />{" "}
          Delivery products only
        </label>
        <p className="wfm-note">Real webhook orders always require approval.</p>
        <label className="wfm-full">
          Revision prompt (optional)
          <Input value={form.revisionPrompt} onChange={(e: any) => set("revisionPrompt", e.target.value)} />
        </label>
        <label className="wfm-full">
          Prior plan JSON (optional, for revisions)
          <Input value={form.priorPlanJson} onChange={(e: any) => set("priorPlanJson", e.target.value)} />
        </label>
      </div>
      <div className="wfm-actions">
        <LaunchButton workflow={WORKFLOW} input={form} onLaunched={onLaunched}>
          Launch plan
        </LaunchButton>
      </div>
    </Card>
  );
}

function CalorieOverview({ runId }: { runId?: string }) {
  const calories = useGatewayNodeOutput({ runId, nodeId: "calculate-calories" });
  const normalized = useGatewayNodeOutput({ runId, nodeId: "normalize-inputs" });
  const validation = useGatewayNodeOutput({ runId, nodeId: "validate-plan" });
  const calorieRow = rowOf(calories.data);
  const normalizedRow = rowOf(normalized.data);
  const validationRow = rowOf(validation.data);
  if (!calorieRow)
    return <EmptyState title="No plan yet" description="Calculated calorie totals appear once plan-meals completes." />;
  const days = asArray<{
    day: number;
    calculatedTotalCalories: number;
    memberTotals: Array<{ name: string; estimatedCalories: number }>;
  }>(calorieRow.days);
  const constraints = asRecord(normalizedRow?.constraints);
  const target = Number(constraints?.householdDailyCalorieTarget ?? constraints?.dailyCalorieTarget ?? 0);
  const warnings = [...asArray<string>(validationRow?.warnings), ...asArray<string>(validationRow?.findings)];
  return (
    <Card>
      <SectionHeader title="Calorie overview" />
      <div className="wfm-stat-row">
        {days.map((day) => (
          <KpiStat
            key={day.day}
            label={`Day ${day.day}`}
            value={`${day.calculatedTotalCalories} kcal`}
            hint={`household target ${target} · ${day.memberTotals
              .map((member) => `${member.name} ${member.estimatedCalories}`)
              .join(" · ")}`}
          />
        ))}
      </div>
      {warnings.length > 0 ? (
        <div className="wfm-warning-row">
          {warnings.map((w, i) => (
            <Badge key={i}>{w}</Badge>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

export function MealCards({ runId }: { runId?: string }) {
  const plan = useGatewayNodeOutput({ runId, nodeId: "plan-meals" });
  const planRow = rowOf(plan.data);
  const days = asArray<PlanDay>(planRow?.plan);
  if (days.length === 0)
    return <EmptyState title="No meals yet" description="Meal cards appear once the plan is produced." />;
  return (
    <Card>
      <SectionHeader title="Meal plan" />
      <div className="wfm-meal-grid">
        {days.map((day) => (
          <div key={day.day} className="wfm-meal-card">
            <strong>Day {day.day}</strong>
            <div>{day.dailyTotalCalories} kcal total</div>
            {day.meals.map((meal, i) => (
              <div key={i} className="wfm-meal-item">
                <div className="wfm-meal-name">{meal.name}</div>
                {meal.items.map((item, itemIndex) => (
                  <div key={itemIndex} className="wfm-small wfm-muted">
                    {item.sourceUrl && isHttpUrl(item.sourceUrl) ? (
                      <a href={item.sourceUrl} target="_blank" rel="noreferrer">
                        {item.name}
                      </a>
                    ) : (
                      <>
                        {item.name}
                        {item.sourceUrl ? ` · ${item.sourceUrl}` : ""}
                      </>
                    )}
                    {` · ${item.quantity} · ~${item.estimatedCalories} kcal · ${item.prepTag}`}
                    {item.favoriteMatch ? " · favorite" : ""}
                  </div>
                ))}
                <div className="wfm-small">{meal.totalCalories} kcal</div>
                {(meal.memberCalories ?? []).length > 0 ? (
                  <div className="wfm-small">
                    {(meal.memberCalories ?? [])
                      .map((member) => `${member.name}: ${member.estimatedCalories} kcal`)
                      .join(" · ")}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ))}
      </div>
    </Card>
  );
}

export function GroceryChecklist({ runId }: { runId?: string }) {
  const plan = useGatewayNodeOutput({ runId, nodeId: "plan-meals" });
  const planRow = rowOf(plan.data);
  const items = asArray<GroceryItem>(planRow?.groceryList);
  if (items.length === 0)
    return <EmptyState title="No grocery list yet" description="The checklist appears once the plan lands." />;
  const bySection = groupByStoreSection(items);
  return (
    <Card>
      <SectionHeader title="Grocery checklist" />
      {Object.entries(bySection).map(([section, sectionItems]) => (
        <div key={section} className="wfm-section">
          <strong>{section}</strong>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead>Qty</TableHead>
                <TableHead>Est. price</TableHead>
                <TableHead>Prep</TableHead>
                <TableHead>Source</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sectionItems.map((item, i) => (
                <TableRow key={i}>
                  <TableCell>{item.name}</TableCell>
                  <TableCell>{item.quantity}</TableCell>
                  <TableCell>~${item.estimatedPriceUsd.toFixed(2)}</TableCell>
                  <TableCell>
                    {item.prepTag}
                    {item.favoriteMatch ? " · favorite" : ""}
                  </TableCell>
                  <TableCell>
                    {isHttpUrl(item.sourceUrl) ? (
                      <a href={item.sourceUrl} target="_blank" rel="noreferrer">
                        link
                      </a>
                    ) : (
                      item.sourceUrl
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ))}
    </Card>
  );
}

function BudgetPrepSummary({ runId }: { runId?: string }) {
  const plan = useGatewayNodeOutput({ runId, nodeId: "plan-meals" });
  const validation = useGatewayNodeOutput({ runId, nodeId: "validate-plan" });
  const planRow = rowOf(plan.data);
  const validationRow = rowOf(validation.data);
  if (!planRow) return null;
  const passed = validationRow?.passed === true;
  return (
    <Card>
      <SectionHeader title="Budget & validation" />
      <div className="wfm-stat-row">
        <KpiStat label="Estimated subtotal" value={`$${Number(planRow.estimatedSubtotal ?? 0).toFixed(2)}`} />
        <StatusPill status={passed ? "finished" : "running"} label={passed ? "validated" : "revising"} />
      </div>
    </Card>
  );
}

function RevisionPanel({ runId, onLaunched }: { runId: string; onLaunched: (nextRunId: string) => void }) {
  const plan = useGatewayNodeOutput({ runId, nodeId: "plan-meals" });
  const normalized = useGatewayNodeOutput({ runId, nodeId: "normalize-inputs" });
  const planRow = rowOf(plan.data);
  const normalizedRow = rowOf(normalized.data);
  const constraints = asRecord(normalizedRow?.constraints);
  const [revisionPrompt, setRevisionPrompt] = useState("");
  const [requestedTarget, setRequestedTarget] = useState("");
  const [profiles, setProfiles] = useState("");
  const [favorites, setFavorites] = useState("");

  if (!planRow || !constraints) return null;

  const currentFavorites = asArray<string>(constraints.favoriteFoods);
  const currentProfiles = asArray<{ name: string; dailyCalorieTarget: number }>(constraints.memberCalorieTargets);
  const parsedTarget = requestedTarget.trim() ? Number(requestedTarget) : null;
  const input: LaunchForm = {
    householdSize: Number(constraints.householdSize ?? 2),
    days: Number(constraints.days ?? 7),
    dailyCalorieTarget: Number(constraints.dailyCalorieTarget ?? 2000),
    requestedDailyCalorieTarget: parsedTarget !== null && Number.isFinite(parsedTarget) ? parsedTarget : null,
    calorieProfiles:
      profiles.trim() || currentProfiles.map((profile) => `${profile.name}: ${profile.dailyCalorieTarget}`).join(", "),
    dietaryPreferences: String(constraints.dietaryPreferences ?? ""),
    favoriteFoods: favorites.trim() || currentFavorites.join(", "),
    allergiesExclusions: String(constraints.allergiesExclusions ?? ""),
    maxPrepMinutes: Number(constraints.maxPrepMinutes ?? 15),
    budget: Number(constraints.budget ?? 200),
    zipCode: String(constraints.zipCode ?? ""),
    orderWebhookUrl: "",
    requireOrderApproval: true,
    deliveryOnly: constraints.deliveryOnly !== false,
    revisionPrompt,
    priorPlanJson: JSON.stringify({ constraints, plan: planRow }),
  };

  return (
    <Card>
      <SectionHeader title="Update this plan">
        <span>Prompt the agent to revise the current plan. Allergies and exclusions remain hard constraints.</span>
      </SectionHeader>
      <div className="wfm-revision-grid">
        <label className="wfm-full">
          What should change?
          <Input
            value={revisionPrompt}
            onChange={(event: any) => setRevisionPrompt(event.target.value)}
            placeholder="More berries, fewer sandwiches, and aim for 1,800 calories per day"
          />
        </label>
        <label>
          New daily target (optional)
          <Input
            type="number"
            value={requestedTarget}
            onChange={(event: any) => setRequestedTarget(event.target.value)}
            placeholder={String(constraints.dailyCalorieTarget ?? 2000)}
          />
        </label>
        <label>
          Person-specific targets
          <Input
            value={profiles}
            onChange={(event: any) => setProfiles(event.target.value)}
            placeholder={
              currentProfiles.map((profile) => `${profile.name}: ${profile.dailyCalorieTarget}`).join(", ") ||
              "You: 3500, Wife: 2500"
            }
          />
        </label>
        <label>
          Favorite foods
          <Input
            value={favorites}
            onChange={(event: any) => setFavorites(event.target.value)}
            placeholder={currentFavorites.join(", ") || "Add favorite foods"}
          />
        </label>
      </div>
      <div className="wfm-actions">
        <LaunchButton workflow={WORKFLOW} input={input} onLaunched={onLaunched}>
          Update meal plan
        </LaunchButton>
      </div>
      <p className="wfm-bottom-note">
        The revision starts without an order connector. Review the updated plan before configuring checkout.
      </p>
    </Card>
  );
}

export function OrderStatus({ runId }: { runId?: string }) {
  const finalize = useGatewayNodeOutput({ runId, nodeId: "finalize" });
  const row = rowOf(finalize.data);
  if (!row)
    return (
      <EmptyState title="No order status yet" description="Appears after approval and the order/checkout step run." />
    );
  const status = String(row.orderStatus ?? "skipped");
  const links = asArray<{ name: string; wholeFoodsUrl: string; amazonUrl: string }>(row.links);
  return (
    <Card>
      <SectionHeader title="Order status" />
      <StatusPill
        status={status === "ordered" ? "finished" : status === "denied" || status === "failed" ? "failed" : "running"}
        label={status}
      />
      {status === "needs-checkout" && links.length > 0 ? (
        <div className="wfm-checkout">
          {links.map((l, i) => (
            <div key={i} className="wfm-small">
              {l.name}:{" "}
              {isHttpUrl(l.wholeFoodsUrl) ? (
                <a href={l.wholeFoodsUrl} target="_blank" rel="noreferrer">
                  Whole Foods
                </a>
              ) : (
                l.wholeFoodsUrl
              )}
              {" · "}
              {isHttpUrl(l.amazonUrl) ? (
                <a href={l.amazonUrl} target="_blank" rel="noreferrer">
                  Amazon
                </a>
              ) : (
                l.amazonUrl
              )}
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

function App() {
  const [runId, setRunId] = useState<string | undefined>(runIdFromUrl());
  const [nodeId, setNodeId] = useState<string | undefined>(undefined);
  const run = useGatewayRun(runId);
  const status = useMemo(() => {
    const data = run.data as { status?: string } | undefined;
    return data?.status;
  }, [run.data]);

  return (
    <WorkflowUiShell
      title="Whole Foods Meal Planner"
      meta={`${runId ?? "no run"}${status ? ` · ${status}` : ""}`}
      actions={<ConnectionBadge />}
    >
      <SmithersUiStyles extra={wholeFoodsMealPlannerStyles} />
      <div className="wfm-shell-content">
        {!runId ? <LaunchPanel onLaunched={setRunId} /> : null}
        {runId ? (
          <>
            <CalorieOverview runId={runId} />
            <MealCards runId={runId} />
            <GroceryChecklist runId={runId} />
            <BudgetPrepSummary runId={runId} />
            <RevisionPanel runId={runId} onLaunched={setRunId} />
            <ApprovalPanel filter={{ workflow: WORKFLOW, runId }} />
            <OrderStatus runId={runId} />
            <div className="wfm-run-grid">
              <RunTree
                runId={runId}
                activeNodeId={nodeId}
                onSelectNode={(node: { id: string }) => setNodeId(node.id)}
              />
              <RunEventLog runId={runId} className="wfm-event-log" selectedNodeId={nodeId} onSelectNode={setNodeId} />
            </div>
            <Button onClick={() => setRunId(undefined)}>Start a new plan</Button>
          </>
        ) : null}
      </div>
    </WorkflowUiShell>
  );
}

if (typeof document !== "undefined") {
  createGatewayReactRoot(<App />);
}
