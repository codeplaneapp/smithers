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
  img: string;
  alt: string;
  note: string;
}

export const LIVE_BEATS: LiveBeat[] = [
  {
    step: "describe",
    caption: "Describe the pipeline in chat",
    img: "/shots/describe.gif",
    alt: "Smithers composer: typing a one-sentence sales-pipeline request",
    note: "Here's what that looks like: I describe the pipeline in chat — score my inbound leads, draft outreach, nothing sends without my sign-off.",
  },
  {
    step: "build",
    caption: "Your agent authors the workflow — scoring built in",
    img: "/shots/build.gif",
    alt: "Workflow editor showing the agent-authored sales-pipeline source: enrich, score, draft, approval gate",
    note: "My agent authors the workflow — real source: enrich, score, draft, an approval gate; I never wrote a line. And it self-improves: every run is scored, and the prompts re-optimize weekly.",
  },
  {
    step: "run",
    caption: "It runs — leads scored live, outreach held for approval",
    img: "/shots/run.gif",
    alt: "Run inspector streaming the sales pipeline: intake, enrich, score, draft, approval hold",
    note: "It runs, every step streaming — leads enriched and scored, outreach held at my gate — and I can time-travel back to any point.",
  },
];

export const sections: Section[] = [
  {
    id: "title",
    steps: 1,
    notes: [
      "Hi, I'm Will, the creator of Smithers. Smithers runs agent workflows you can trust — jobs that finish, survive crashes, and wait for human sign-off.",
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
      "We launched in January, open source. Today, forty community projects build on Smithers, and four hundred fifty people are active in our Telegram. And users don't churn — they report bugs and stay.",
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
      "Everyone can describe a workflow they want automated. Making it real is the hard part: authoring, monitoring, approvals, cleanup after every crash. The plumbing is more work than the idea.",
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
      "Smithers ships the plumbing as the framework — durability, retries, approvals, observability, built in. You don't write the workflows: you simply describe the job. Agents one-shot these workflows because it's React, which they already know.",
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
          ${LIVE_BEATS.map(
            (b, i) => `<img class="live-shot" data-i="${i}" src="${b.img}" alt="${b.alt}" />`,
          ).join("")}
        </div>
        <div class="live-captions">
          ${LIVE_BEATS.map((b, i) => `<p class="live-caption" data-i="${i}"><span class="live-num">${i + 1}</span>${b.caption}</p>`).join("")}
        </div>
      </div>`,
  },
  {
    id: "people",
    steps: 1,
    notes: [
      "And not just agents — Smithers orchestrates people too: approvals, durable steps, and live collaboration, like a Google Doc.",
    ],
    render: () => `
      <div class="media-slide">
        <div class="media-copy">
          <div class="eyebrow">People too</div>
          <h2 class="big big-md">Orchestrate <em>people</em>,<br />not just agents.</h2>
          <p class="support">Durable steps, approval gates, and live collaboration —<br />cursors and prompts shared like a Google Doc.</p>
        </div>
        <figure class="media-frame">
          <img src="/shots/collab.gif" alt="Live Smithers session with two participants editing a workflow together, cursors visible" />
        </figure>
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
      "Building agents shifts like a video-game meta: a new patch drops, everyone re-learns — but the engine stays. Smithers plugs into every agent, so every model release makes it stronger.",
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
    id: "market",
    steps: 1,
    notes: [
      "Workflow automation was giant before agents. After agents it gets bigger — companies that never automated anything are asking to start.",
    ],
    render: () => `
      <div class="statement">
        <div class="eyebrow">Market</div>
        <h2 class="big">Workflow automation gets<br /><em>bigger</em> after agents.</h2>
        <p class="support">Zapier, UiPath, Temporal built on slices of it. Companies that never<br />automated a single process are asking to start.</p>
      </div>`,
  },
  {
    id: "model",
    steps: 1,
    notes: [
      "Smithers is free — that's distribution, and the canonical open-source engine is the moat. Revenue is the cloud that runs these workflows, plus the enterprise last mile.",
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
      "In twenty twenty-five I built the fastest open-source Ethereum VM — with agents. Tevm, the OP Stack, now Smithers.",
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
