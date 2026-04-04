#!/usr/bin/env bun
/**
 * ask-user — blocking CLI tool for agent-to-user questions.
 *
 * Usage (from an agent's bash tool):
 *   bun .smithers/scripts/ask-user.ts "What database should we use?" --recommended "PostgreSQL"
 *
 * Flow:
 *   1. Writes question to .smithers/state/ask-user/{id}.question.json
 *   2. Polls for .smithers/state/ask-user/{id}.answer.json
 *   3. Once answer file appears, prints the answer to stdout and exits
 *
 * The answer can be provided by:
 *   - smithers-ctl (desktop IDE)
 *   - The smithers GUI server
 *   - A human running: echo '{"answer":"PostgreSQL"}' > .smithers/state/ask-user/{id}.answer.json
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync, watchFile, unwatchFile } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    recommended: { type: "string", short: "r" },
    branch: { type: "string", short: "b" },
    timeout: { type: "string", short: "t", default: "300" },
  },
  allowPositionals: true,
});

const question = positionals[0];
if (!question) {
  console.error("Usage: ask-user <question> [--recommended <answer>] [--branch <branch>] [--timeout <seconds>]");
  process.exit(1);
}

const id = randomUUID();
const stateDir = resolve(process.cwd(), ".smithers/state/ask-user");
mkdirSync(stateDir, { recursive: true });

const questionFile = join(stateDir, `${id}.question.json`);
const answerFile = join(stateDir, `${id}.answer.json`);

// Write the question
const questionPayload = {
  id,
  question,
  recommendedAnswer: values.recommended ?? null,
  branch: values.branch ?? null,
  createdAt: new Date().toISOString(),
};

writeFileSync(questionFile, JSON.stringify(questionPayload, null, 2), "utf8");

// Also write to stderr so the user can see the question in the terminal
console.error(`\n🤔 Question: ${question}`);
if (values.recommended) {
  console.error(`   Recommended: ${values.recommended}`);
}
console.error(`   Waiting for answer... (write to ${answerFile})\n`);

// Poll for the answer
const timeoutMs = (Number(values.timeout) || 300) * 1000;
const startTime = Date.now();

const checkAnswer = (): string | null => {
  if (!existsSync(answerFile)) return null;
  try {
    const raw = readFileSync(answerFile, "utf8");
    const parsed = JSON.parse(raw);
    return parsed.answer ?? parsed.note ?? raw.trim();
  } catch {
    return null;
  }
};

// Try fs.watchFile for efficiency, fall back to polling
const answer = await new Promise<string>((resolveAnswer, reject) => {
  const cleanup = () => {
    try { unwatchFile(answerFile); } catch {}
    try { unlinkSync(questionFile); } catch {}
    try { unlinkSync(answerFile); } catch {}
  };

  const timeoutTimer = setTimeout(() => {
    cleanup();
    reject(new Error(`Timed out waiting for answer after ${values.timeout}s`));
  }, timeoutMs);

  // Check immediately in case answer was already written
  const immediate = checkAnswer();
  if (immediate) {
    clearTimeout(timeoutTimer);
    cleanup();
    resolveAnswer(immediate);
    return;
  }

  // Watch for changes
  watchFile(answerFile, { interval: 500 }, () => {
    const ans = checkAnswer();
    if (ans) {
      clearTimeout(timeoutTimer);
      cleanup();
      resolveAnswer(ans);
    }
  });
});

// Print the answer to stdout (this is what the agent reads)
console.log(answer);
