#!/usr/bin/env node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(SKILL_DIR, "../..");
const DEFAULT_CASES = resolve(SKILL_DIR, "assets/eval-cases.jsonl");
const SYSTEM_PROMPT = (await readFile(resolve(SKILL_DIR, "assets/system-prompt.txt"), "utf8")).trim();

function parseArgs(argv) {
  const options = {
    model: "",
    cases: DEFAULT_CASES,
    out: resolve(REPO_ROOT, "artifacts/kimi-smithers/eval.json"),
    limit: Infinity,
    graph: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--model") options.model = argv[++index];
    else if (arg === "--cases") options.cases = resolve(REPO_ROOT, argv[++index]);
    else if (arg === "--out") options.out = resolve(REPO_ROOT, argv[++index]);
    else if (arg === "--limit") options.limit = Number(argv[++index]);
    else if (arg === "--no-graph") options.graph = false;
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: evaluate-fireworks.mjs --model MODEL [--cases FILE] [--out FILE] [--limit N] [--no-graph]\n",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.model) throw new Error("--model is required");
  if (!process.env.FIREWORKS_API_KEY) throw new Error("FIREWORKS_API_KEY is required");
  return options;
}

async function readCases(path) {
  const rows = [];
  const text = await readFile(path, "utf8");
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (!row.id || !row.prompt || !Array.isArray(row.required) || !Array.isArray(row.forbidden)) {
      throw new Error(`${path}:${index + 1}: invalid eval case`);
    }
    rows.push(row);
  }
  return rows;
}

export function extractCode(content) {
  const fenced = content.match(/```(?:tsx?|jsx?)?\s*\n([\s\S]*?)```/i);
  return `${(fenced?.[1] ?? content).trim()}\n`;
}

async function generate(model, prompt) {
  const response = await fetch("https://api.fireworks.ai/inference/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.FIREWORKS_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      max_tokens: 32768,
      temperature: 0.2,
    }),
  });
  if (!response.ok) {
    throw new Error(`Fireworks ${response.status}: ${await response.text()}`);
  }
  const payload = await response.json();
  const message = payload.choices?.[0]?.message;
  if (!message?.content) throw new Error(`Fireworks returned no assistant content: ${JSON.stringify(payload)}`);
  return {
    code: extractCode(message.content),
    reasoning: message.reasoning_content ?? null,
    usage: payload.usage ?? null,
  };
}

function run(command, args, cwd) {
  return new Promise((completion) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => completion({ code, stdout, stderr }));
    child.on("error", (error) => completion({ code: -1, stdout, stderr: error.message }));
  });
}

export async function graphCheck(code, id) {
  const tempDir = await mkdtemp(resolve(REPO_ROOT, ".smithers/.kimi-eval-"));
  const file = resolve(tempDir, `${id}.tsx`);
  try {
    await writeFile(file, code);
    const result = await run(
      "bun",
      ["apps/cli/src/index.js", "graph", file, "--input", "{}", "--format", "json"],
      REPO_ROOT,
    );
    return {
      passed: result.code === 0,
      stderr: result.stderr.slice(-4000),
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export function lexicalCheck(code, testCase) {
  const required = testCase.required.map((pattern) => ({
    pattern,
    passed: new RegExp(pattern, "m").test(code),
  }));
  const forbidden = testCase.forbidden.map((pattern) => ({
    pattern,
    passed: !new RegExp(pattern, "mi").test(code),
  }));
  const total = required.length + forbidden.length;
  const passed = [...required, ...forbidden].filter((check) => check.passed).length;
  return { required, forbidden, score: total ? passed / total : 1 };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const cases = (await readCases(options.cases)).slice(0, options.limit);
  const results = [];
  for (const [index, testCase] of cases.entries()) {
    process.stderr.write(`[${index + 1}/${cases.length}] ${testCase.id}\n`);
    const generation = await generate(options.model, testCase.prompt);
    const lexical = lexicalCheck(generation.code, testCase);
    const graph = options.graph ? await graphCheck(generation.code, testCase.id) : { passed: null, stderr: "" };
    const score = options.graph ? lexical.score * 0.5 + (graph.passed ? 0.5 : 0) : lexical.score;
    results.push({
      id: testCase.id,
      prompt: testCase.prompt,
      score,
      lexical,
      graph,
      generation,
    });
  }
  const graphPasses = results.filter((result) => result.graph.passed === true).length;
  const report = {
    model: options.model,
    createdAt: new Date().toISOString(),
    cases: results.length,
    aggregateScore: results.reduce((sum, result) => sum + result.score, 0) / Math.max(results.length, 1),
    graphPassRate: options.graph ? graphPasses / Math.max(results.length, 1) : null,
    results,
  };
  await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify(
      {
        model: report.model,
        cases: report.cases,
        aggregateScore: report.aggregateScore,
        graphPassRate: report.graphPassRate,
        report: options.out,
      },
      null,
      2,
    )}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
