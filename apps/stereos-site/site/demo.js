// Drives the WebContainer demo: boot, install, start the gateway and the web
// app, then run the three workflows.
//
// Every status shown on the page is read back from the engine through
// `smithers inspect --format json`. A command exiting zero is never treated as
// a workflow succeeding.
import { WebContainer } from "./webcontainer-api.js";
import { projectFiles } from "./project-files.js";

const terminal = document.getElementById("terminal");
const termNote = document.getElementById("term-note");
const frame = document.getElementById("app-frame");
const frameEmpty = document.getElementById("app-frame-empty");
const frameNote = document.getElementById("frame-note");
const startButton = document.getElementById("start");
const startNote = document.getElementById("start-note");

// Run smithers under Node: the bin's shebang is bun, and the loader shims map
// the bun-only specifiers to stubs.
const SMITHERS = "node --import ./shims/register.mjs --import tsx node_modules/smthrs/src/bin/smithers.js";

let booted = false;

/** Append a chunk to the terminal pane, trimming to the last 400 lines. */
function write(chunk) {
  if (terminal.textContent === "Press “Start the demo”.") {
    terminal.textContent = "";
  }
  terminal.textContent += chunk;
  const lines = terminal.textContent.split("\n");
  if (lines.length > 400) {
    terminal.textContent = lines.slice(-400).join("\n");
  }
  terminal.scrollTop = terminal.scrollHeight;
}

/** Mark a step chip. */
function step(name, state) {
  const el = document.querySelector(`[data-step="${name}"]`);
  if (el) {
    el.dataset.state = state;
  }
}

/** Strip ANSI escapes so the log pane stays readable. */
function clean(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;]*[A-Za-z]/g, "").replace(/\[[0-9]+[GK]/g, "");
}

/**
 * Run a command in the container, streaming its merged output to the pane.
 *
 * @returns {Promise<number>} exit code
 */
async function sh(wc, command, { quiet = false } = {}) {
  const proc = await wc.spawn("jsh", ["-c", command]);
  proc.output.pipeTo(
    new WritableStream({
      write(data) {
        if (!quiet) {
          write(clean(String(data)));
        }
      },
    }),
  );
  return await proc.exit;
}

/**
 * Run a smithers command that prints a JSON envelope.
 *
 * stdout goes to a file so the envelope parses cleanly; stderr keeps streaming
 * to the pane so the viewer sees the engine's live log.
 *
 * @returns {Promise<{ exitCode: number, json: unknown }>}
 */
async function smithersJson(wc, args) {
  const out = "/tmp/smithers-out.json";
  // `2>&1 >file` sends stderr to the pane and stdout to the file.
  const exitCode = await sh(wc, `SMITHERS_BACKEND=pglite ${SMITHERS} ${args} --format json 2>&1 >${out}`);
  let json = null;
  try {
    json = JSON.parse(await wc.fs.readFile(out, "utf-8"));
  } catch {
    json = null;
  }
  return { exitCode, json };
}

/** Ask the engine what a run's status actually is. */
async function runStatus(wc, runId) {
  const { json } = await smithersJson(wc, `inspect ${runId}`);
  return {
    status: json?.run?.status ?? "unknown",
    approvals: json?.approvals ?? [],
    blocked: json?.runState?.blocked ?? null,
  };
}

/** Fill one row of the results table from engine-reported state. */
function report(prefix, runId, status) {
  document.getElementById(`${prefix}-run`).textContent = runId ?? "—";
  document.getElementById(`${prefix}-status`).textContent = status ?? "—";
}

async function main() {
  if (booted) {
    return;
  }
  booted = true;
  startButton.disabled = true;
  startNote.textContent = "This takes a few minutes: npm install runs inside the browser.";

  if (!window.crossOriginIsolated) {
    write("This page is not cross-origin isolated, so WebContainer cannot boot.\n");
    step("boot", "failed");
    return;
  }

  step("boot", "active");
  termNote.textContent = "booting";
  const wc = await WebContainer.boot();
  await wc.mount(projectFiles);
  // Exposed so the e2e check and a human debugging the page can run commands
  // against the same container.
  window.__container = wc;
  step("boot", "done");
  write("Container booted. Node ");
  await sh(wc, "node --version");

  // The gateway and the app announce themselves through server-ready.
  const previews = new Map();
  wc.on("server-ready", (port, url) => {
    previews.set(port, url);
    if (port === 5173) {
      frame.src = url;
      frame.hidden = false;
      frameEmpty.hidden = true;
      frameNote.textContent = "live";
      step("app", "done");
    }
  });

  step("install", "active");
  termNote.textContent = "installing";
  write("\n$ npm install\n");
  const installCode = await sh(wc, "npm install --no-audit --no-fund");
  if (installCode !== 0) {
    step("install", "failed");
    termNote.textContent = "install failed";
    return;
  }
  step("install", "done");

  step("gateway", "active");
  termNote.textContent = "starting gateway";
  write("\n$ smithers gateway\n");
  sh(wc, `SMITHERS_BACKEND=pglite ${SMITHERS} gateway --port 7331`).then((code) =>
    write(`\n[gateway process exited with code ${code}]\n`),
  );
  // The gateway binds loopback inside the container, so it never emits a
  // preview URL. Poll it from inside with node; the container shell has no
  // wget or curl.
  const probe =
    "node -e \"fetch('http://127.0.0.1:7331/v1/api/runs').then(()=>process.exit(0)).catch(()=>process.exit(1))\"";
  let gatewayUp = false;
  for (let i = 0; i < 60 && !gatewayUp; i += 1) {
    gatewayUp = (await sh(wc, probe, { quiet: true })) === 0;
    if (!gatewayUp) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  step("gateway", gatewayUp ? "done" : "failed");
  if (!gatewayUp) {
    write("\nGateway did not come up.\n");
    return;
  }

  step("app", "active");
  frameNote.textContent = "starting";
  write("\n$ vite (app/)\n");
  sh(wc, "cd app && ../node_modules/.bin/vite");

  termNote.textContent = "running workflows";

  step("hello", "active");
  write("\n$ smithers up workflows/hello.tsx\n");
  const hello = await smithersJson(wc, `up workflows/hello.tsx --input '{"name":"stereOS"}'`);
  const helloId = hello.json?.runId ?? null;
  const helloState = helloId ? await runStatus(wc, helloId) : { status: "unknown" };
  report("hello", helloId, helloState.status);
  step("hello", helloState.status === "finished" ? "done" : "failed");

  step("pipeline", "active");
  write("\n$ smithers up workflows/pipeline.tsx\n");
  const pipeline = await smithersJson(
    wc,
    `up workflows/pipeline.tsx --input '{"text":"  Smithers runs real workflows in the browser  "}'`,
  );
  const pipelineId = pipeline.json?.runId ?? null;
  const pipelineState = pipelineId ? await runStatus(wc, pipelineId) : { status: "unknown" };
  report("pipeline", pipelineId, pipelineState.status);
  step("pipeline", pipelineState.status === "finished" ? "done" : "failed");

  step("approval", "active");
  write("\n$ smithers up workflows/approval-demo.tsx\n");
  const approval = await smithersJson(
    wc,
    `up workflows/approval-demo.tsx --input '{"change":"enable the demo"}'`,
  );
  const approvalId = approval.json?.runId ?? null;
  let approvalState = approvalId ? await runStatus(wc, approvalId) : { status: "unknown" };
  report("approval", approvalId, approvalState.status);
  step("approval", approvalState.status === "waiting-approval" ? "done" : "failed");

  if (!approvalId || approvalState.status !== "waiting-approval") {
    termNote.textContent = "approval gate did not open";
    return;
  }

  termNote.textContent = "waiting for your approval";
  startNote.textContent = "Click Approve in the panel on the right.";
  step("approved", "active");

  // Wait for a human decision, then resume. `smithers up` exits at the gate,
  // so the decision alone does not finish the run.
  let decided = false;
  for (let i = 0; i < 300 && !decided; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    approvalState = await runStatus(wc, approvalId);
    decided =
      approvalState.approvals.some((row) => row.status === "approved" || row.status === "denied") ||
      approvalState.blocked?.kind === "approval-decided-resume-required";
  }
  if (!decided) {
    step("approved", "failed");
    termNote.textContent = "no decision arrived";
    return;
  }

  write("\n$ smithers up workflows/approval-demo.tsx --resume\n");
  await smithersJson(wc, `up workflows/approval-demo.tsx --resume --run-id ${approvalId}`);
  const finalState = await runStatus(wc, approvalId);
  report("approval", approvalId, finalState.status);
  step("approved", finalState.status === "finished" ? "done" : "failed");
  termNote.textContent = finalState.status === "finished" ? "done" : finalState.status;
  startNote.textContent = "";
}

startButton.addEventListener("click", () => {
  main().catch((error) => {
    write(`\nDemo failed: ${error?.message ?? String(error)}\n`);
    termNote.textContent = "failed";
  });
});
