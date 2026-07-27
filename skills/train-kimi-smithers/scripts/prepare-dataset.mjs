#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(SKILL_DIR, "../..");
const ASSETS_DIR = resolve(SKILL_DIR, "assets");

const PROMPT_TEMPLATES = [
  ({ id, description }) => `Create a Smithers workflow named "${id}" that ${lowerFirst(description)}`,
  ({ id, description }) => `Write .smithers/workflows/${id}.tsx. Requirement: ${description}`,
  ({ id, description }) => `Implement this as a production Smithers workflow called "${id}": ${description}`,
  ({ id, description }) => `Author the complete primary workflow file for "${id}". It must ${lowerFirst(description)}`,
  ({ id, description }) =>
    `Build a durable Smithers script for this outcome: ${description} Use "${id}" as the workflow id.`,
  ({ id, description }) => `Turn this request into the canonical Smithers TSX workflow "${id}": ${description}`,
  ({ id, description }) => `Add a typed Smithers workflow named "${id}" for the following job. ${description}`,
  ({ id, description }) =>
    `Produce the primary .tsx workflow, not a tutorial. Workflow id: ${id}. Goal: ${description}`,
  ({ id, description }) => `I need a real Smithers workflow for this: ${description} Name it "${id}".`,
  ({ id, description }) => `Create the shipped workflow "${id}" with current Smithers APIs. ${description}`,
  ({ id, description, tags }) => `Implement "${id}" as a Smithers workflow for ${tags}. ${description}`,
  ({ id, description, tags }) =>
    `Write a production Smithers script in the ${tags} area. Call it "${id}". ${description}`,
  ({ id, description }) => `Build and return only .smithers/workflows/${id}.tsx for: ${description}`,
  ({ id, description }) =>
    `Use typed inputs, outputs, and durable graph control flow to implement "${id}": ${description}`,
  ({ id, description }) =>
    `Create a complete Smithers orchestration file named "${id}" that achieves this outcome: ${description}`,
  ({ id, description }) => `We need the "${id}" workflow in the built-in pack. ${description}`,
  ({ id, description }) =>
    `Write the canonical primary file for a new Smithers workflow. Name: ${id}. Behavior: ${description}`,
  ({ id, description }) =>
    `Implement this long-running job with Smithers rather than prose: ${description} Workflow id "${id}".`,
  ({ id, description }) =>
    `Create a durable, replayable Smithers workflow "${id}". It should ${lowerFirst(description)}`,
  ({ id, description }) => `Add the production workflow file for "${id}" using repository conventions. ${description}`,
  ({ id, description, tags }) => `Author a typed ${tags} Smithers workflow called "${id}". ${description}`,
  ({ id, description }) => `Return only the full TSX for workflow "${id}". User outcome: ${description}`,
  ({ id, description }) => `Make this request executable and resumable with Smithers under id "${id}": ${description}`,
  ({ id, description }) =>
    `Create .smithers/workflows/${id}.tsx with real agents and safe operator boundaries. ${description}`,
  ({ id, description }) =>
    `Implement the current-repo Smithers script "${id}". Do not mock its backends. ${description}`,
  ({ id, description }) =>
    `Write a complete workflow, including schemas and terminal output, for "${id}": ${description}`,
  ({ id, description }) =>
    `Convert this product requirement into the shipped Smithers workflow "${id}". ${description}`,
  ({ id, description }) => `Build a graph-valid Smithers workflow named "${id}" for this use case: ${description}`,
  ({ id, description }) =>
    `Create the primary workflow source for "${id}", preserving built-in pack metadata. ${description}`,
  ({ id, description, tags }) =>
    `Implement "${id}" with current Smithers authoring patterns (${tags}). Required behavior: ${description}`,
];

function lowerFirst(value) {
  return value.length ? value[0].toLowerCase() + value.slice(1) : value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv) {
  const options = {
    out: resolve(REPO_ROOT, "artifacts/kimi-smithers"),
    variants: undefined,
    validationVariants: undefined,
    archiveOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") options.out = resolve(REPO_ROOT, argv[++index]);
    else if (arg === "--variants") options.variants = Number(argv[++index]);
    else if (arg === "--validation-variants") options.validationVariants = Number(argv[++index]);
    else if (arg === "--archive-only") options.archiveOnly = true;
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: prepare-dataset.mjs [--out DIR] [--variants N] [--validation-variants N] [--archive-only]\n",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function metadataFor(sourcePath, source) {
  const description = source.match(/^\/\/ smithers-description:\s*(.+)$/m)?.[1]?.trim();
  if (!description) throw new Error(`${sourcePath}: missing smithers-description metadata`);
  const tags = source.match(/^\/\/ smithers-tags:\s*(.+)$/m)?.[1]?.trim() ?? "workflow authoring";
  const id = basename(sourcePath).replace(/\.tsx$/, "");
  return { id, description, tags };
}

function validateSource(sourcePath, source) {
  const errors = [];
  if (!source.includes("export default")) errors.push("missing default export");
  if (!source.includes("<Workflow")) errors.push("missing <Workflow");
  if (source.includes("@ts-nocheck")) errors.push("contains @ts-nocheck");
  if (/^(<<<<<<<|=======|>>>>>>>)/m.test(source)) errors.push("contains conflict markers");
  if (/\b(?:sk|fw)_[A-Za-z0-9]{20,}\b/.test(source)) errors.push("contains an apparent API key");
  if (errors.length) throw new Error(`${sourcePath}: ${errors.join(", ")}`);
}

function rowFor(systemPrompt, prompt, completion) {
  return {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
      { role: "assistant", content: completion },
    ],
  };
}

export async function buildSplit(paths, variantCount, systemPrompt) {
  if (!Number.isInteger(variantCount) || variantCount < 1 || variantCount > PROMPT_TEMPLATES.length) {
    throw new Error(`variant count must be an integer from 1 to ${PROMPT_TEMPLATES.length}`);
  }
  const rows = [];
  const sources = [];
  const prompts = new Set();
  for (const sourcePath of paths) {
    const absolutePath = resolve(REPO_ROOT, sourcePath);
    if (!absolutePath.startsWith(`${REPO_ROOT}/`)) throw new Error(`source escapes repository: ${sourcePath}`);
    const source = `${(await readFile(absolutePath, "utf8")).trimEnd()}\n`;
    validateSource(sourcePath, source);
    const metadata = metadataFor(sourcePath, source);
    for (let index = 0; index < variantCount; index += 1) {
      const prompt = PROMPT_TEMPLATES[index](metadata);
      if (prompts.has(prompt)) throw new Error(`duplicate prompt: ${prompt}`);
      prompts.add(prompt);
      rows.push(rowFor(systemPrompt.trim(), prompt, source));
    }
    sources.push({
      path: sourcePath,
      id: metadata.id,
      description: metadata.description,
      sha256: sha256(source),
      bytes: Buffer.byteLength(source),
      variants: variantCount,
    });
  }
  return { rows, sources };
}

export function validateRows(rows, label) {
  if (rows.length < 3) throw new Error(`${label}: Fireworks requires at least 3 examples`);
  const prompts = new Set();
  for (const [index, row] of rows.entries()) {
    if (!row || !Array.isArray(row.messages) || row.messages.length !== 3) {
      throw new Error(`${label}:${index + 1}: expected exactly 3 messages`);
    }
    const roles = row.messages.map((message) => message.role).join(",");
    if (roles !== "system,user,assistant") {
      throw new Error(`${label}:${index + 1}: invalid role order ${roles}`);
    }
    for (const message of row.messages) {
      if (typeof message.content !== "string" || !message.content.trim()) {
        throw new Error(`${label}:${index + 1}: empty ${message.role} content`);
      }
    }
    const prompt = row.messages[1].content;
    if (prompts.has(prompt)) throw new Error(`${label}:${index + 1}: duplicate user prompt`);
    prompts.add(prompt);
    validateSource(`${label}:${index + 1}`, row.messages[2].content);
  }
}

function serialize(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

async function writeSplit(outDir, label, payload, archiveOnly) {
  const jsonlPath = resolve(outDir, `${label}.jsonl`);
  const gzipPath = `${jsonlPath}.gz`;
  if (!archiveOnly) await writeFile(jsonlPath, payload);
  await writeFile(gzipPath, gzipSync(payload, { level: 9 }));
  return {
    jsonl: archiveOnly ? null : `${label}.jsonl`,
    gzip: `${label}.jsonl.gz`,
    sha256: sha256(payload),
    bytes: Buffer.byteLength(payload),
    approximateTokens: Math.ceil(payload.length / 4),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const sourceManifest = JSON.parse(await readFile(resolve(ASSETS_DIR, "source-manifest.json"), "utf8"));
  const systemPrompt = await readFile(resolve(ASSETS_DIR, sourceManifest.systemPrompt), "utf8");
  const variants = options.variants ?? sourceManifest.promptVariants;
  const validationVariants = options.validationVariants ?? sourceManifest.validationPromptVariants;
  const overlap = sourceManifest.train.filter((path) => sourceManifest.validation.includes(path));
  if (overlap.length) throw new Error(`train/validation source overlap: ${overlap.join(", ")}`);

  const train = await buildSplit(sourceManifest.train, variants, systemPrompt);
  const validation = await buildSplit(sourceManifest.validation, validationVariants, systemPrompt);
  validateRows(train.rows, "train");
  validateRows(validation.rows, "validation");

  await mkdir(options.out, { recursive: true });
  const trainPayload = serialize(train.rows);
  const validationPayload = serialize(validation.rows);
  const trainOutput = await writeSplit(options.out, "train", trainPayload, options.archiveOnly);
  const validationOutput = await writeSplit(options.out, "validation", validationPayload, options.archiveOnly);
  const approximateTrainingCostUsd = Number(((trainOutput.approximateTokens / 1_000_000) * 10).toFixed(2));
  const manifest = {
    formatVersion: 1,
    generator: "skills/train-kimi-smithers/scripts/prepare-dataset.mjs",
    systemPromptSha256: sha256(systemPrompt.trim()),
    splitPolicy: "source-file",
    train: {
      rows: train.rows.length,
      sources: train.sources,
      ...trainOutput,
    },
    validation: {
      rows: validation.rows.length,
      sources: validation.sources,
      ...validationOutput,
    },
    estimate: {
      method: "characters / 4",
      managedLoraSftRateAssumptionUsdPerMillionTokens: 10,
      approximateOneEpochTrainingCostUsd: approximateTrainingCostUsd,
      warning: "Recheck live Fireworks pricing and the provider token count before launch.",
    },
  };
  const manifestPath = resolve(options.out, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify(
      {
        out: options.out,
        trainRows: train.rows.length,
        validationRows: validation.rows.length,
        approximateTrainingTokens: trainOutput.approximateTokens,
        approximateOneEpochTrainingCostUsd: approximateTrainingCostUsd,
        manifest: manifestPath,
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
