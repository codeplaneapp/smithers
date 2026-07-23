(function(){let e=document.createElement(`link`).relList;if(e&&e.supports&&e.supports(`modulepreload`))return;for(let e of document.querySelectorAll(`link[rel="modulepreload"]`))n(e);new MutationObserver(e=>{for(let t of e)if(t.type===`childList`)for(let e of t.addedNodes)e.tagName===`LINK`&&e.rel===`modulepreload`&&n(e)}).observe(document,{childList:!0,subtree:!0});function t(e){let t={};return e.integrity&&(t.integrity=e.integrity),e.referrerPolicy&&(t.referrerPolicy=e.referrerPolicy),e.crossOrigin===`use-credentials`?t.credentials=`include`:e.crossOrigin===`anonymous`?t.credentials=`omit`:t.credentials=`same-origin`,t}function n(e){if(e.ep)return;e.ep=!0;let n=t(e);fetch(e.href,n)}})();var e=[[`Jan`,3235],[`Feb`,2608],[`Mar`,2760],[`Apr`,4827],[`May`,7224],[`Jun`,97e3]];function t(e){return e>=1e4?`${Math.round(e/1e3)}K`:e>=1e3?`${(e/1e3).toFixed(1)}K`:String(e)}function n(e,t,n,r,i){return[`M ${e} ${t+r}`,`L ${e} ${t+i}`,`Q ${e} ${t} ${e+i} ${t}`,`L ${e+n-i} ${t}`,`Q ${e+n} ${t} ${e+n} ${t+i}`,`L ${e+n} ${t+r}`,`Z`].join(` `)}function r(){let r=Math.max(...e.map(([,e])=>e)),i=e.length,a=(548-18*(i-1))/i,o=new Set([`Jan`,`May`,`Jun`]),s=``;return e.forEach(([e,i],c)=>{let l=Math.max(3,i/r*270),u=6+c*(a+18),d=314-l,f=Math.min(4,l/2),p=e===`Jun`;s+=`<path d="${n(u,d,a,l,f)}" fill="var(--chart-mark)" opacity="${p?1:.45}">`,s+=`<title>${e} 2026 — ${i.toLocaleString()} downloads</title></path>`,o.has(e)&&(s+=`<text x="${u+a/2}" y="${d-10}" text-anchor="middle" class="${p?`c-val c-val-hero`:`c-val`}">${t(i)}</text>`),s+=`<text x="${u+a/2}" y="338" text-anchor="middle" class="c-cat">${e}</text>`}),`
    <svg viewBox="0 0 560 350" role="img" aria-label="npm downloads per month, January to June 2026: 3,235; 2,608; 2,760; 4,827; 7,224; 97,000" class="chart">
      <line x1="6" y1="314" x2="554" y2="314" class="c-axis" />
      ${s}
    </svg>`}var i=[{step:`describe`,caption:`Describe the job in chat`,img:`/shots/home.png`,alt:`Smithers home: a single chat composer that says Ask Smithers to build`,note:`Here's what that looks like: I describe the job in chat, one sentence — and minutes later, a workflow exists.`},{step:`build`,caption:`Your agent authors the workflow`,img:`/shots/workflow.png`,alt:`Workflow editor showing agent-authored JSX workflow source with tasks and a review loop`,note:`My agent authors the workflow — real source, tasks, a review loop; I never wrote a line. And it self-improves: every run is scored, and the prompts re-optimize weekly.`},{step:`run`,caption:`It runs — every step streaming live`,img:`/shots/inspector.png`,alt:`Run inspector: live execution tree with plan, edit-files and run-tests steps streaming`,note:`It runs, every step streaming live — and I can time-travel back to any point in the workflow.`},{step:`gate`,caption:`Approval gate — kill it mid-run, it resumes at the same frame`,img:`/shots/timeline.png`,alt:`Time travel scrubber with seven snapshots, an approval gate marker, and fork and replay controls`,note:`It pauses at my approval gate, costing nothing while it waits. Now watch — I kill the process mid-run… and it resumes exactly where it stopped. Every frame is saved.`},{step:`ship`,caption:`Done — reviewed, diffed, shipped`,img:`/shots/diff.png`,alt:`Completed change: six files, plus 67 minus 234, reviewed as syntax-highlighted diffs`,note:`Done: reviewed, diffed, shipped.`}],a=[{id:`title`,steps:1,notes:[`Hi, I'm Will, the creator of Smithers. Smithers runs agent workflows you can actually trust — jobs that finish, survive crashes, and wait for human sign-off before anything ships.`],render:()=>`
      <div class="center">
        <div class="wordmark"><span class="dot"></span>smithers</div>
        <h1 class="tagline">Reliable, self-improving<br />agentic workflows.<br /><em>In one prompt.</em></h1>
        <div class="chips">
          <span class="chip">smithers.sh</span>
          <span class="chip">github.com/smithersai/smithers</span>
          <span class="chip">open source</span>
        </div>
      </div>`},{id:`traction`,steps:1,notes:[`We launched in January, open source. Today, forty community projects build on Smithers, and four hundred fifty people are active in our Telegram. Users don't churn: they report bugs and stay, calling it one of the biggest unlocks in their agentic toolkit.`],render:()=>`
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
          ${r()}
          <div class="chart-source">source: npmjs.org · smithers-orchestrator</div>
        </figure>
      </div>`},{id:`problem`,steps:1,notes:[`Here's the problem. Everyone can describe a workflow they want automated. Making it real is the hard part: authoring, monitoring, approvals, cleanup after every crash. The plumbing is more work than the idea.`],render:()=>`
      <div class="statement">
        <div class="eyebrow">Problem</div>
        <h2 class="big">The plumbing is more work<br />than the idea.</h2>
        <p class="support">Author it. Monitor it. Wire in approvals.<br />Clean up after every crash.</p>
      </div>`},{id:`solution`,steps:1,notes:[`Smithers ships the plumbing as the framework — durability, retries, approvals, observability, built in. You don't write the workflows: describe the job, your agent builds it. Agents one-shot these workflows because it's React, which they already know.`],render:()=>`
      <div class="statement">
        <div class="eyebrow">Solution</div>
        <h2 class="big">Describe the job.<br />Your agent builds it.</h2>
        <p class="support">Durability, retries, approvals, observability —<br />built into the framework, not bolted on.</p>
      </div>`},{id:`live`,steps:i.length,notes:i.map(e=>e.note),render:()=>`
      <div class="live">
        <div class="live-head">
          <div class="eyebrow">The run</div>
          <div class="live-steps">
            ${i.map((e,t)=>`<span class="live-step" data-i="${t}">${e.step}</span>`).join(`<span class="live-arrow">→</span>`)}
          </div>
        </div>
        <div class="live-frame">
          ${i.map((e,t)=>`<img class="live-shot" data-i="${t}" src="${e.img}" alt="${e.alt}" />`).join(``)}
        </div>
        <div class="live-captions">
          ${i.map((e,t)=>`<p class="live-caption" data-i="${t}"><span class="live-num">${t+1}</span>${e.caption}</p>`).join(``)}
        </div>
      </div>`},{id:`insight`,steps:1,notes:[`The right way to build agents shifts like a video-game meta: a new patch drops, everyone re-learns — but the engine stays. Smithers is the engine: it plugs into every agent, so every model release makes it stronger, not obsolete.`],render:()=>`
      <div class="statement">
        <div class="eyebrow">Why we win</div>
        <h2 class="big big-md">Agents change every 6 months.<br />We're the layer that doesn't.</h2>
        <div class="stack">
          <div class="stack-row"><span>Models</span><span class="stack-tag">volatile · weekly</span></div>
          <div class="stack-row"><span>Topologies</span><span class="stack-tag">fluid · quarterly</span></div>
          <div class="stack-row stack-accent"><span>Durable orchestration — <strong>Smithers</strong></span><span class="stack-tag">stable · plugs into every agent</span></div>
        </div>
        <p class="support">The meta shifts like a game patch — the engine underneath stays.<br />Every model release makes Smithers stronger, not obsolete.</p>
      </div>`},{id:`market`,steps:1,notes:[`Workflow automation was giant before agents — Zapier, UiPath, Temporal. After agents, it gets bigger: companies that never automated anything are asking to start.`],render:()=>`
      <div class="statement">
        <div class="eyebrow">Market</div>
        <h2 class="big">Workflow automation gets<br /><em>bigger</em> after agents.</h2>
        <p class="support">Zapier, UiPath, Temporal built on slices of it. Companies that never<br />automated a single process are asking to start.</p>
      </div>`},{id:`model`,steps:1,notes:[`Smithers is free — that's distribution, and the canonical open-source engine is the moat. Revenue is the cloud that runs these workflows, plus the enterprise last mile.`],render:()=>`
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
      </div>`},{id:`team`,steps:1,notes:[`We know this space. In twenty twenty-five I built the fastest open-source Ethereum VM — with agents. Tevm, the OP Stack, now Smithers.`],render:()=>`
      <div class="statement">
        <div class="eyebrow">Team</div>
        <h2 class="big big-md">Built the fastest open-source<br />Ethereum VM — <em>with agents.</em></h2>
        <div class="chips">
          <span class="chip">early to every agentic trend</span>
          <span class="chip">Tevm</span>
          <span class="chip">OP Stack</span>
          <span class="chip">Smithers</span>
        </div>
      </div>`},{id:`ask`,steps:1,notes:[`We're looking for design partners — I'll work hands-on to integrate Smithers into your product or back office. Smithers makes agent workflows reliable. Come find me.`],render:()=>`
      <div class="statement">
        <div class="eyebrow">The ask</div>
        <h2 class="big">Looking for<br /><em>design partners.</em></h2>
        <p class="support">I'll work hands-on with you to integrate Smithers<br />into your product or your back office.</p>
        <p class="closer">Smithers makes agent workflows <em>reliable</em>.</p>
        <div class="chips">
          <span class="chip chip-accent">will@tevm.tech</span>
          <span class="chip">smithers.sh</span>
        </div>
      </div>`}],o=[];a.forEach((e,t)=>{for(let n=0;n<e.steps;n++)o.push({section:t,beat:n})});var s=document.querySelector(`#app`);s.innerHTML=`
  <main class="stage">
    ${a.map((e,t)=>`<section class="slide" data-section="${t}" data-id="${e.id}">${e.render()}</section>`).join(``)}
  </main>
  <div class="hud">
    <div class="hud-timer" id="timer" hidden>3:00</div>
    <div class="hud-counter" id="counter"></div>
    <div class="hud-progress"><div class="hud-progress-fill" id="progress"></div></div>
  </div>
  <aside class="notes" id="notes" hidden>
    <div class="notes-label">speaker notes · <kbd>N</kbd> to hide</div>
    <p class="notes-text" id="notes-text"></p>
  </aside>
  <div class="help" id="help">
    <kbd>←</kbd><kbd>→</kbd> navigate · <kbd>N</kbd> notes · <kbd>P</kbd> rehearse · <kbd>T</kbd> 3:00 timer · <kbd>F</kbd> fullscreen
  </div>
`;var c=Array.from(s.querySelectorAll(`.slide`)),l=document.getElementById(`counter`),u=document.getElementById(`progress`),d=document.getElementById(`notes`),f=document.getElementById(`notes-text`),p=document.getElementById(`timer`),m=document.getElementById(`help`),h=0;function g(e){return Math.max(0,Math.min(o.length-1,e))}function _(e){h=g(e);let{section:t,beat:n}=o[h];c.forEach((e,r)=>{e.classList.toggle(`active`,r===t),r===t&&e.setAttribute(`data-beat`,String(n))}),c[t].querySelectorAll(`[data-i]`).forEach(e=>{e.classList.toggle(`on`,Number(e.dataset.i)===n),e.classList.toggle(`done`,Number(e.dataset.i)<n)}),l.textContent=`${h+1} / ${o.length}`,u.style.width=`${(h+1)/o.length*100}%`,f.textContent=a[t].notes[n]??``,location.hash=String(h+1)}var v=180,y=v,b;function x(){let e=Math.floor(Math.abs(y)/60),t=Math.abs(y)%60;p.textContent=`${y<0?`-`:``}${e}:${String(t).padStart(2,`0`)}`,p.classList.toggle(`warn`,y<=60&&y>20),p.classList.toggle(`danger`,y<=20)}function S(){if(p.hidden=!1,b!==void 0){clearInterval(b),b=void 0;return}b=window.setInterval(()=>{--y,x()},1e3)}function C(){b!==void 0&&clearInterval(b),b=void 0,y=v,x(),p.hidden=!0}var w=null,T=null,E=!1;async function D(){if(w)return w;try{let e=await fetch(`/narration/manifest.json`);return e.ok?(w=(await e.json()).steps,w):null}catch{return null}}function O(){E=!1,T&&=(T.pause(),null)}async function k(){if(E){O();return}let e=await D();if(!e)return;E=!0,C(),S();let t=n=>{if(!E||n>=e.length){O();return}_(n);let r=new Audio(`/narration/${e[n].file}`);T=r,r.onended=()=>t(n+1),r.play()};t(0)}document.addEventListener(`keydown`,e=>{if(!(e.metaKey||e.ctrlKey||e.altKey))switch(e.key){case`ArrowRight`:case`ArrowDown`:case`PageDown`:case` `:e.preventDefault(),O(),_(h+1);break;case`ArrowLeft`:case`ArrowUp`:case`PageUp`:e.preventDefault(),O(),_(h-1);break;case`Home`:O(),_(0);break;case`End`:O(),_(o.length-1);break;case`n`:case`N`:d.hidden=!d.hidden;break;case`t`:case`T`:S();break;case`p`:case`P`:k();break;case`r`:case`R`:C();break;case`f`:case`F`:document.fullscreenElement?document.exitFullscreen():document.documentElement.requestFullscreen();break}}),document.addEventListener(`click`,e=>{let t=e.target;if(t.closest(`.notes`)||t.closest(`.hud`))return;let n=e.clientX;O(),n>window.innerWidth*.33?_(h+1):_(h-1)}),window.setTimeout(()=>m.classList.add(`gone`),6e3);var A=Number(location.hash.slice(1));_(Number.isFinite(A)&&A>=1?A-1:0),x();