#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BenchmarkInstance } from "./BenchmarkInstance";
import type { BenchmarkTask } from "./BenchmarkTask";
import type { Subscription } from "./Subscription";
import { benchmarkTasksFromInstances } from "./benchmarkTasksFromInstances";
import { buildDelegationShardTasks } from "./buildDelegationShardTasks";
import { formatShardPlan } from "./formatShardPlan";
import { mintFleetTokens } from "./mintFleetTokens";
import { planShards } from "./planShards";
import { resolveSubscriptions } from "./resolveSubscriptions";
import { runFleetLogin } from "./runFleetLogin";

/**
 * Fleet orchestrator CLI.
 *
 *   # dry-run how tasks shard across subscriptions
 *   bun cli.ts plan --benchmark swe-bench-pro --tasks 60 --subs s1,s2,s3,s4,s5,s6
 *
 *   # prepare per-container shard files from a prepared-instances JSON
 *   bun cli.ts prep --benchmark swe-evo --instances ./instances.json \
 *                   --subs s1,s2,s3 --out-dir ./shards
 *
 * `instances.json` is an array of BenchmarkInstance ({ id, prompt, cwd, weight?,
 * budgetMinutes? }) produced by the benchmark-specific prep step. `prep` plans
 * the shard split (least-used-weighted) and writes one `<sub>.shard.json`
 * (ShardTask[]) per subscription — the file each rollout container mounts as
 * FLEET_SHARD_FILE.
 */
function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = "true";
      }
    }
  }
  return out;
}

function makeSubscriptions(args: Record<string, string>): Subscription[] {
  if (args.subs) return args.subs.split(",").map((id) => ({ id: id.trim() }));
  const real = resolveSubscriptions();
  if (real.length > 0) return real;
  return Array.from({ length: 6 }, (_, i) => ({ id: `demo-sub-${i + 1}` }));
}

function planCommand(args: Record<string, string>) {
  const benchmark = args.benchmark ?? "demo";
  const tasks: BenchmarkTask[] = args.ids
    ? args.ids.split(",").map((id) => ({ id: `${benchmark}:${id.trim()}`, benchmark }))
    : Array.from({ length: Number(args.tasks ?? "60") }, (_, i) => ({
        id: `${benchmark}:instance-${String(i).padStart(3, "0")}`,
        benchmark,
      }));
  const subscriptions = makeSubscriptions(args);
  console.log(formatShardPlan(planShards(tasks, subscriptions), subscriptions));
}

function prepCommand(args: Record<string, string>) {
  const benchmark = args.benchmark ?? "demo";
  if (!args.instances) throw new Error("prep: --instances <path> is required");
  const outDir = args["out-dir"] ?? "./shards";
  const instances = JSON.parse(readFileSync(args.instances, "utf8")) as BenchmarkInstance[];
  const byId = new Map(instances.map((inst) => [inst.id, inst]));
  const subscriptions = makeSubscriptions(args);

  const tasks = benchmarkTasksFromInstances(instances, benchmark);
  const shards = planShards(tasks, subscriptions);
  const idToInstanceId = new Map(tasks.map((t, i) => [t.id, instances[i].id]));

  mkdirSync(outDir, { recursive: true });
  for (const shard of shards) {
    const shardInstances = shard.tasks
      .map((t) => byId.get(idToInstanceId.get(t.id) ?? ""))
      .filter((x): x is BenchmarkInstance => Boolean(x));
    const shardTasks = buildDelegationShardTasks(shardInstances, {
      benchmark,
      workflow: args.workflow,
      budgetMinutes: args.budgetMinutes ? Number(args.budgetMinutes) : undefined,
    });
    const file = join(outDir, `${shard.subscriptionId}.shard.json`);
    writeFileSync(file, JSON.stringify(shardTasks, null, 2));
  }
  console.log(formatShardPlan(shards, subscriptions));
  console.log(`\nWrote ${shards.length} shard file(s) to ${outDir}/`);
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (command === "login") return void runFleetLogin({ count: Number(args.count ?? "6"), prefix: args.prefix });
  if (command === "tokens") return mintFleetTokens();
  if (command === "plan") return planCommand(args);
  if (command === "prep") return prepCommand(args);
  console.error(
    "usage: bun cli.ts <command> [flags]\n" +
      "  login  --count 6            log in to N subscriptions (one config dir each)\n" +
      "  tokens                      mint per-Machine CLAUDE_CODE_OAUTH_TOKENs\n" +
      "  plan   --benchmark N ...    dry-run the shard split across subscriptions\n" +
      "  prep   --instances f ...    write per-container shard files",
  );
  process.exit(1);
}

main();
