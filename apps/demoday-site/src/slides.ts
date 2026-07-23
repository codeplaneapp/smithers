// Slide content for the Smithers demo-day pitch (script source: pitch-v2.md)

export interface Section {
  id: string;
  /** number of navigation steps this section occupies (beats for the live section) */
  steps: number;
  /** speaker notes, one entry per step */
  notes: string[];
  render(): string;
}

const DOWNLOADS: [string, number][] = [
  ["Jan", 3_235],
  ["Feb", 2_608],
  ["Mar", 2_760],
  ["Apr", 4_827],
  ["May", 7_224],
  ["Jun", 97_000],
];

function fmt(v: number): string {
  if (v >= 10_000) return `${Math.round(v / 1000)}K`;
  if (v >= 1_000) return `${(v / 1000).toFixed(1)}K`;
  return String(v);
}

function roundedTopBar(x: number, y: number, w: number, h: number, r: number): string {
  return [
    `M ${x} ${y + h}`,
    `L ${x} ${y + r}`,
    `Q ${x} ${y} ${x + r} ${y}`,
    `L ${x + w - r} ${y}`,
    `Q ${x + w} ${y} ${x + w} ${y + r}`,
    `L ${x + w} ${y + h}`,
    "Z",
  ].join(" ");
}

function tractionChart(): string {
  const W = 560;
  const H = 350;
  const padT = 44;
  const padB = 36;
  const padX = 6;
  const plotH = H - padT - padB;
  const plotW = W - padX * 2;
  const max = Math.max(...DOWNLOADS.map(([, v]) => v));
  const n = DOWNLOADS.length;
  const gap = 18;
  const bw = (plotW - gap * (n - 1)) / n;
  const labeled = new Set(["Jan", "May", "Jun"]);

  let marks = "";
  DOWNLOADS.forEach(([m, v], i) => {
    const h = Math.max(3, (v / max) * plotH);
    const x = padX + i * (bw + gap);
    const y = padT + plotH - h;
    const r = Math.min(4, h / 2);
    const hero = m === "Jun";
    marks += `<path d="${roundedTopBar(x, y, bw, h, r)}" fill="var(--chart-mark)" opacity="${hero ? 1 : 0.45}">`;
    marks += `<title>${m} 2026 — ${v.toLocaleString()} downloads</title></path>`;
    if (labeled.has(m)) {
      marks += `<text x="${x + bw / 2}" y="${y - 10}" text-anchor="middle" class="${hero ? "c-val c-val-hero" : "c-val"}">${fmt(v)}</text>`;
    }
    marks += `<text x="${x + bw / 2}" y="${H - 12}" text-anchor="middle" class="c-cat">${m}</text>`;
  });

  return `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="npm downloads per month, January to June 2026: 3,235; 2,608; 2,760; 4,827; 7,224; 97,000" class="chart">
      <line x1="${padX}" y1="${padT + plotH}" x2="${W - padX}" y2="${padT + plotH}" class="c-axis" />
      ${marks}
    </svg>`;
}

interface LiveBeat {
  step: string;
  caption: string;
  img?: string;
  alt?: string;
  /** Inline syntax-highlighted code panel instead of an image. */
  code?: string;
  /** Small print under the caption (e.g. source attribution). */
  fineprint?: string;
  note: string;
}

export const LIVE_BEATS: LiveBeat[] = [
  {
    step: "ask",
    caption: "Ask for it in your terminal",
    img: "/shots/terminal.gif",
    alt: "Terminal: asking Claude Code for a vibeaudit-style security-review workflow; it writes the workflow and its UI",
    fineprint: "Ask modeled on vibeaudit, a real security-review orchestrator built on Smithers: \u201cruns audit skills in parallel \u2026 deduplicated, triaged, and aggregated in a final report.\u201d",
    note: "In my terminal, I ask for a security review like vibeaudit — strategies in parallel, dedupe, triage, one report. A real example, built on Smithers.",
  },
  {
    step: "code",
    caption: "The workflow it wrote — real source, and it's React",
    code: `<span class="k">const</span> { Workflow, Task, smithers, outputs } = <span class="f">createSmithers</span>({
  vaInjection: strategySchema, vaAuth: strategySchema,
  vaSecrets: strategySchema,  vaDeps: strategySchema,
  vaDedupe: dedupeSchema, vaTriage: triageSchema, vaReport: reportSchema,
});

<span class="k">export default</span> <span class="f">smithers</span>((ctx) => (
  <span class="t">&lt;Workflow</span> <span class="a">name</span>=<span class="s">"vibe-audit"</span><span class="t">&gt;</span>
    <span class="t">&lt;Sequence&gt;</span>
      <span class="t">&lt;Parallel&gt;</span>
        <span class="t">&lt;Task</span> <span class="a">id</span>=<span class="s">"injection-scan"</span> <span class="a">output</span>={outputs.vaInjection} <span class="t">/&gt;</span>
        <span class="t">&lt;Task</span> <span class="a">id</span>=<span class="s">"auth-review"</span> <span class="a">output</span>={outputs.vaAuth} <span class="t">/&gt;</span>
        <span class="t">&lt;Task</span> <span class="a">id</span>=<span class="s">"secrets-scan"</span> <span class="a">output</span>={outputs.vaSecrets} <span class="t">/&gt;</span>
        <span class="t">&lt;Task</span> <span class="a">id</span>=<span class="s">"deps-audit"</span> <span class="a">output</span>={outputs.vaDeps} <span class="a">retries</span>={2} <span class="t">/&gt;</span>
      <span class="t">&lt;/Parallel&gt;</span>
      <span class="t">&lt;Task</span> <span class="a">id</span>=<span class="s">"dedupe"</span> <span class="a">output</span>={outputs.vaDedupe} <span class="t">/&gt;</span>
      <span class="t">&lt;Task</span> <span class="a">id</span>=<span class="s">"triage"</span> <span class="a">output</span>={outputs.vaTriage} <span class="t">/&gt;</span>
      <span class="t">&lt;Task</span> <span class="a">id</span>=<span class="s">"report"</span> <span class="a">output</span>={outputs.vaReport} <span class="t">/&gt;</span>
    <span class="t">&lt;/Sequence&gt;</span>
  <span class="t">&lt;/Workflow&gt;</span>
));`,
    note: "That's the workflow it wrote — real source, and it's React. Agents one-shot these workflows because they already know React deeply.",
  },
  {
    step: "run",
    caption: "…and the UI it built — a live control room on real runs",
    img: "/shots/ui-run.gif",
    alt: "Agent-built control room: four audit strategies streaming in parallel, findings deduped and triaged live",
    note: "And it built this — a live control room from Smithers components. Strategies streaming in parallel, findings deduped and triaged as they land.",
  },
  {
    step: "recover",
    caption: "Rate-limited mid-run — parked on quota, recovered on a fallback agent",
    img: "/shots/ui-recover.gif",
    alt: "Dependency audit hits a 429 rate limit, parks on quota, retries on a fallback agent, and finishes",
    note: "Now watch the dependency audit — it hits a rate limit. Smithers parks it, costing nothing, retries on a fallback agent, and finishes. Nothing lost.",
  },
];

export const sections: Section[] = [
  {
    id: "title",
    steps: 1,
    notes: [
      "Hey everyone — I'm Will, also known as fucory, creator of Smithers. I've spent every day for almost a year now obsessing over agentic workflows.",
    ],
    render: () => `
      <div class="center">
        <div class="wordmark"><span class="dot"></span>smithers</div>
        <h1 class="tagline">Reliable, self-improving<br />agentic workflows.<br /><em>In one prompt.</em></h1>
        <div class="chips">
          <span class="chip">smithers.sh</span>
          <span class="chip">github.com/smithersai/smithers</span>
          <span class="chip">open source</span>
        </div>
      </div>`,
  },
  {
    id: "traction",
    steps: 1,
    notes: [
      "Most users quietly churn when they hit bugs early in a project. Smithers users write multi-paragraph open letters to the maintainer, because they love Smithers and desperately want it to succeed.",
    ],
    render: () => `
      <div class="traction">
        <div class="traction-copy">
          <div class="eyebrow">Traction</div>
          <h2 class="big big-md"><span class="accent">450</span> active in<br />our Telegram.</h2>
          <p class="support"><strong>40 community projects</strong> known to be<br />building on Smithers today.</p>
          <div class="stat-chips">
            <span class="chip">launched January</span>
            <span class="chip">329 GitHub stars</span>
            <span class="chip">38 forks</span>
            <span class="chip">18 external contributors</span>
          </div>
        </div>
        <figure class="traction-chart">
          <figcaption class="chart-title">npm downloads / month · 2026</figcaption>
          ${tractionChart()}
          <div class="chart-source">source: npmjs.org · smithers-orchestrator</div>
        </figure>
      </div>`,
  },
  {
    id: "problem",
    steps: 1,
    notes: [
      "Building workflows is hard. Users trust Smithers because it's dependable.",
    ],
    render: () => `
      <div class="statement">
        <div class="eyebrow">Problem</div>
        <h2 class="big">The plumbing is more work<br />than the idea.</h2>
        <p class="support">Author it. Monitor it. Wire in approvals.<br />Clean up after every crash.</p>
      </div>`,
  },
  {
    id: "solution",
    steps: 1,
    notes: [
      "Smithers ships the plumbing as the framework — durability, retries, approvals, observability built in. You just describe the job.",
    ],
    render: () => `
      <div class="statement">
        <div class="eyebrow">Solution</div>
        <h2 class="big">Describe the job.<br />Your agent builds it.</h2>
        <p class="support">Durability, retries, approvals, observability —<br />built into the framework, not bolted on.</p>
      </div>`,
  },
  {
    id: "live",
    steps: LIVE_BEATS.length,
    notes: LIVE_BEATS.map((b) => b.note),
    render: () => `
      <div class="live">
        <div class="live-head">
          <div class="eyebrow">The run</div>
          <div class="live-steps">
            ${LIVE_BEATS.map((b, i) => `<span class="live-step" data-i="${i}">${b.step}</span>`).join('<span class="live-arrow">→</span>')}
          </div>
        </div>
        <div class="live-frame">
          ${LIVE_BEATS.map((b, i) =>
            b.code
              ? `<pre class="live-shot live-code" data-i="${i}"><code>${b.code}</code></pre>`
              : `<img class="live-shot" data-i="${i}" src="${b.img}" alt="${b.alt}" />`,
          ).join("")}
        </div>
        <div class="live-captions">
          ${LIVE_BEATS.map((b, i) => `<p class="live-caption" data-i="${i}"><span class="live-num">${i + 1}</span>${b.caption}${b.fineprint ? `<span class="live-fineprint">${b.fineprint}</span>` : ""}</p>`).join("")}
        </div>
      </div>`,
  },
  {
    id: "dataflow",
    steps: 1,
    notes: [
      "Under the hood: one-way data flow. Events update state; the plan is a pure function of state. Time travel, resume, and SQL debug come for free.",
    ],
    render: () => `
      <div class="statement">
        <div class="eyebrow">Under the hood</div>
        <h2 class="big big-md">The plan is a <em>pure function</em><br />of state.</h2>
        <div class="flowline">
          <span class="flow-node">Render</span><span class="flow-arrow">→</span>
          <span class="flow-node">Extract</span><span class="flow-arrow">→</span>
          <span class="flow-node">Execute</span><span class="flow-arrow">→</span>
          <span class="flow-node">Persist</span>
          <span class="flow-return">↻ re-render with new state</span>
        </div>
        <div class="stack">
          <div class="stack-row"><span>Free time travel</span><span class="stack-tag">a frame is a snapshot — forking is "throw away rows"</span></div>
          <div class="stack-row"><span>Free resume</span><span class="stack-tag">re-render from state — no event log to replay</span></div>
          <div class="stack-row"><span>Free SQL debug</span><span class="stack-tag">state is queryable — an event chain is not</span></div>
        </div>
      </div>`,
  },
  {
    id: "builton",
    steps: 1,
    notes: [
      "Real products ship on Smithers — Aomi ships production apps from a single prompt. The next Harvey, the next CodeRabbit: built on agents they can trust.",
    ],
    render: () => `
      <div class="media-slide">
        <div class="media-copy">
          <div class="eyebrow">Built on Smithers</div>
          <h2 class="big big-md">Real products<br />ship on Smithers.</h2>
          <div class="chips">
            <span class="chip chip-accent">Aomi — apps from a prompt</span>
            <span class="chip">Burns — a full UI</span>
            <span class="chip">40 community projects</span>
          </div>
        </div>
        <figure class="media-frame">
          <img src="/shots/aomi.jpg" alt="Aomi: production app built from a single prompt on Smithers — plan, generate, compile and test, ship" />
        </figure>
      </div>`,
  },
  {
    id: "insight",
    steps: 1,
    notes: [
      "Building agents shifts like a game meta — a new patch drops, everyone re-learns, but the engine stays. Every model release makes Smithers stronger. And other orchestrators are one-size-fits-all — you bend the job to fit the tool. Smithers is custom-fitted to every job.",
    ],
    render: () => `
      <div class="statement">
        <div class="eyebrow">Why we win</div>
        <h2 class="big big-md">Agents change every 6 months.<br />We're the layer that doesn't.</h2>
        <div class="stack">
          <div class="stack-row"><span>Models</span><span class="stack-tag">volatile · weekly</span></div>
          <div class="stack-row"><span>Topologies</span><span class="stack-tag">fluid · quarterly</span></div>
          <div class="stack-row stack-accent"><span>Durable orchestration — <strong>Smithers</strong></span><span class="stack-tag">stable · plugs into every agent</span></div>
        </div>
        <p class="support">The meta shifts like a game patch — the engine underneath stays.<br />Every model release makes Smithers stronger, not obsolete.</p>
      </div>`,
  },
  {
    id: "market",
    steps: 1,
    notes: [
      "Workflow automation was giant before agents. After agents it gets bigger — everyone's asking to start.",
    ],
    render: () => `
      <div class="statement">
        <div class="eyebrow">Market</div>
        <h2 class="big">Workflow automation gets<br /><em>bigger</em> after agents.</h2>
        <p class="support">Zapier, UiPath, Temporal built on slices of it. Companies that never<br />automated a single process are asking to start.</p>
      </div>`,
  },
  {
    id: "rails",
    steps: 1,
    notes: [
      "Smithers is the Ruby on Rails of workflow automation.",
    ],
    render: () => `
      <div class="statement">
        <h2 class="big">Smithers is the<br /><em>Ruby on Rails</em> of<br />workflow automation.</h2>
      </div>`,
  },
  {
    id: "model",
    steps: 1,
    notes: [
      "Smithers is free — that's distribution; the canonical open-source engine is the moat. Revenue is cloud, plus the enterprise last mile.",
    ],
    render: () => `
      <div class="statement">
        <div class="eyebrow">Business model</div>
        <div class="flow">
          <div class="flow-box"><strong>Free engine</strong><span>distribution + moat</span></div>
          <div class="flow-arrow">→</div>
          <div class="flow-box"><strong>Cloud</strong><span>runs the workflows</span></div>
          <div class="flow-arrow">→</div>
          <div class="flow-box flow-accent"><strong>Enterprise last mile</strong><span>the revenue</span></div>
        </div>
        <p class="support">The canonical open-source workflow engine is the moat.<br />Revenue is making it dead simple to plug into enterprise.</p>
      </div>`,
  },
  {
    id: "team",
    steps: 1,
    notes: [
      "In twenty twenty-five I built the fastest open-source Ethereum VM with agents. Tevm, the OP Stack, now Smithers.",
    ],
    render: () => `
      <div class="statement">
        <div class="eyebrow">Team</div>
        <h2 class="big big-md">Built the fastest open-source<br />Ethereum VM — <em>with agents.</em></h2>
        <div class="chips">
          <span class="chip">early to every agentic trend</span>
          <span class="chip">Tevm</span>
          <span class="chip">OP Stack</span>
          <span class="chip">Smithers</span>
        </div>
      </div>`,
  },
  {
    id: "ask",
    steps: 1,
    notes: [
      "We're looking for angels and design partners — I'll work hands-on to integrate Smithers into your product or back office. Smithers makes agent workflows reliable. Come find me.",
    ],
    render: () => `
      <div class="statement">
        <div class="eyebrow">The ask</div>
        <h2 class="big">Looking for <em>angels</em><br />&amp; <em>design partners.</em></h2>
        <p class="support">I'll work hands-on with you to integrate Smithers<br />into your product or your back office.</p>
        <p class="closer">Smithers makes agent workflows <em>reliable</em>.</p>
        <div class="chips">
          <span class="chip chip-accent">will@tevm.tech</span>
          <span class="chip">smithers.sh</span>
        </div>
      </div>`,
  },
];
