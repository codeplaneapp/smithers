<!-- Generated from apps/site/src/data/project.json by apps/site/scripts/generate-project-copy.mjs. -->

<pre align="center">
███████╗███╗   ███╗██╗████████╗██╗  ██╗███████╗██████╗ ███████╗
██╔════╝████╗ ████║██║╚══██╔══╝██║  ██║██╔════╝██╔══██╗██╔════╝
███████╗██╔████╔██║██║   ██║   ███████║█████╗  ██████╔╝███████╗
╚════██║██║╚██╔╝██║██║   ██║   ██╔══██║██╔══╝  ██╔══██╗╚════██║
███████║██║ ╚═╝ ██║██║   ██║   ██║  ██║███████╗██║  ██║███████║
╚══════╝╚═╝     ╚═╝╚═╝   ╚═╝   ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚══════╝
</pre>

<p align="center"><strong>Build smart workflows for your codebase. Enable agents to work smarter, faster, and cheaper.</strong></p>

Smithers is an agentic workflow framework for defining workflows in simple TypeScript configuration files and executing them quickly, durably, and reliably.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/site/public/images/how-smithers-works.gif">
    <source media="(prefers-color-scheme: light)" srcset="apps/site/public/images/how-smithers-works-light.gif">
    <img src="apps/site/public/images/how-smithers-works-light.gif" alt="Monorepo tasks materialize into a planned dependency graph, then execute: each finished step caches its outputs. Agent 1 edits ui/src/button.tsx: only the ui build and test go stale and re-run, the rest comes back from cache. When a docs:api step joins the graph, fed by core/src/parse.ts, an edit to parse.ts re-runs build, test, and docs together. The wiki and AGENTS.md sit downstream of docs, and agent 2 sits downstream of the wiki, so every change regenerates the docs the next agent works from and they never drift. A CI scene shows an issue flowing through reproduction, fix, checks, and a human approval gate into a pull request. Finally, a remote cache serves every runner: CI reads and writes it, humans and agents read it.">
  </picture>
</p>

## Supported platforms

The release candidate's required package platform is Linux with Node 22.19.0. macOS and Windows package checks are advisory and do not establish a support guarantee.

Offline Chromium tests cover the included web UI. Packaged desktop and hosted deployments require separate acceptance evidence.

## Install

The 1.0 release candidate is not on npm yet. Use the
[source-checkout installation](https://smithers.sh/docs/installation/#use-the-source-checkout-before-publication)
until publication. After publication, install it with:

```bash
npm install --global @smthrs/cli@next
```

## Get started

Run these commands from your project directory. Before launching, edit the
scaffolded flow and configure the credential its `model:` field requires.
The [quickstart](https://smithers.sh/docs/quickstart/) covers each step.

```bash
smthrs init change
smthrs up change
```

> [!TIP]
> Ask your agent to help you figure out how Smithers can help you and your project, based on everything it knows about you.

## Documentation

Read the [Smithers documentation](https://smithers.sh/docs/) for tutorials, guides, and the full reference. For the top-level build API, keep the [Smithers API cheat sheet](./packages/smithers/build/targets/docs/reference/cheat-sheet.md) handy: one file of TypeScript examples covering the whole `Smithers.*` surface.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for local setup, testing, and pull request guidance.

## License

Smithers is MIT licensed. See [LICENSE](./LICENSE) for details.

## Join our community

Join the [Smithers community on Telegram](https://t.me/+ANThR9bHDLAwMjUx).
