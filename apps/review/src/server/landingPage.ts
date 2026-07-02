import { workflowUiThemeCss } from "@smithers-orchestrator/gateway-ui/styleguide-css";

export const landingPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>smithers review</title>
<style>
${workflowUiThemeCss}
body { margin: 0; font-size: 16px; line-height: 1.6; color: var(--text); background: var(--bg); }
main { max-width: 720px; margin: 0 auto; padding: 64px 24px; }
h1 { font-size: 28px; margin: 0 0 8px; }
p { color: var(--muted); max-width: 65ch; }
pre { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; overflow-x: auto; font-size: 13px; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
</head>
<body>
<main>
<h1>smithers review</h1>
<p>Code review plus story-form walkthroughs. Walkthroughs published here are unlisted; you need the link.</p>
<p>Publish one from a repo:</p>
<pre><code>smithers-review --from main --to HEAD --publish</code></pre>
<p>Part of <a href="https://github.com/smithersai/smithers">smithers</a>.</p>
</main>
</body>
</html>`;
