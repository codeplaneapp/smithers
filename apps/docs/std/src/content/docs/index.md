---
title: "@smthrs/std"
description: "The standard tool library for a Smithers agent: 17 callable flows for files, search, shell, tests, HTTP, and language servers, each a portable declaration with a host-supplied handler."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/std/docs/README.md"
---

`@smthrs/std` is the tool library a coding agent runs on. It declares the
capabilities an agent reaches for every frame: read a file, edit it, list a
directory, search a tree, run a shell command, run the repository's test suite,
fetch a URL, query a language server. There are 17 of them, and every one is an
ordinary [`@smthrs/core`](https://core.smithers.sh/reference/api/) flow.

A flow here is two halves that ship apart. The **declaration** carries `name`,
`description`, `Input`, `Output`, `capabilities`, and `effects`: it is pure
data, safe to hand to a model, and safe to plan against before anything runs.
The **handler** is the executable half, and it asks the host for the services it
needs. A host binds the handlers it can serve and offers the declarations it
wants a model to see, so a browser host and a Node host offer the same `read`
and implement it differently.

That split is what the rest of the library is built around. Limits are display
budgets that every capped result discloses. Failures are one closed list of
codes, and an ordinary outcome such as a non-zero exit code stays a value.
Effect envelopes narrow per call, so a scheduler serializes two writes to one
path instead of every write in the workspace.

## Who uses this package

Hosts bind these flows into an agent. [`@smthrs/agent`](https://agent.smithers.sh/reference/api/) does exactly
that in `StandardFlows`, which is what the Smithers CLI runs. Flow authors reach
for the declarations directly, naming `Read.flow` and `Edit.flow` in a larger
flow so the composed step inherits their capabilities and effect envelope. Peers
implementing their own search back end use `Search`, `SearchContract`, and
`SearchConformance`.

## Install

```bash
pnpm add @smthrs/std
```

For runtime requirements, import forms, and the browser-safe subset, see
[Installation](/installation/).

## The smallest call

A handler is an ordinary Effect. Give it the services it asks for and run it:

```ts
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as Read from "@smthrs/std/Read"
import * as Effect from "effect/Effect"

const page = Read.run({ path: "/workspace/notes.md" })

Effect.runPromise(Effect.provide(page, NodeFileSystem.layer)).then((result) => {
  console.log(result.startLine, result.endLine, result.totalLines)
  console.log(result.content)
})
```

`result.content` is raw file text. The line numbers are sibling fields, never a
gutter inside the text, so any line of `content` is an edit anchor exactly as it
stands.

## The 17 flows

| Name            | What it does                                                     | The service it needs                |
| --------------- | ---------------------------------------------------------------- | ----------------------------------- |
| `read`          | Reads one page of a text file by 1-based offset and limit.       | `FileSystem`                        |
| `write`         | Replaces a file, creating parent directories.                    | `FileSystem`, `Path`                |
| `edit`          | Replaces exact text, or an earlier hit's line range.             | `FileSystem`                        |
| `ls`            | Lists a directory, directories first, deterministically ordered. | `FileSystem`, `Path`                |
| `glob`          | Finds files by a ripgrep `-g` pattern.                           | `Search`                            |
| `grep`          | Searches file contents and returns match-centric hits.           | `Search`                            |
| `bash`          | Runs a shell command line, or a script delivered as data.        | `ChildProcessSpawner`, `Path`       |
| `test`          | Runs the declared suite and reports `{passed, failed}`.          | `ChildProcessSpawner`, `TestRunner` |
| `shell_command` | Runs a Codex-shaped shell command.                               | `ChildProcessSpawner`               |
| `apply_patch`   | Applies a Codex V4A patch.                                       | `FileSystem`, `Path`                |
| `update_plan`   | Acknowledges a Codex plan update.                                | none                                |
| `fetch`         | Gets a URL and returns status and text body.                     | `HttpClient`                        |
| `http-post`     | Posts a text body to a URL.                                      | `HttpClient`                        |
| `explore`       | Investigates the workspace read-only over the four readers.      | no handler                          |
| `webfetch`      | Fetches a page and renders it as text, Markdown, or HTML.        | `HttpClient`                        |
| `websearch`     | Searches the web through a configured provider.                  | `WebSearch`                         |
| `lsp`           | Runs one language-server query.                                  | `LanguageServer`                    |

`explore` is a declaration only. It is a dynamic flow composed from `read`,
`ls`, `glob`, and `grep`, so a seat can be offered it, and `Manifest.handlers`
has no entry for it.

## The registries

`Manifest` is how a host reaches all 17 at once without naming them:

```ts
import * as Manifest from "@smthrs/std/Manifest"

Manifest.flows // every declaration, by name
Manifest.handlers // the 16 executable handlers, by name
Manifest.effectsFor // the per-invocation envelope narrowing, by name
Manifest.names // the 17 names, in registry order
Manifest.readOnly // the 8 names a read-only seat may see
```

## Where to go next

- [Installation](/installation/) for requirements, import forms, and the
  browser-safe subpaths.
- [Quickstart](/quickstart/) to search a real tree and read the definition a
  hit sits in.
- [Flows and handlers](/concepts/flows-and-handlers/) for the model behind
  the two halves.
- [Bind the standard flows into a host](/guides/bind-the-standard-flows/) for
  the composition every other guide assumes.
- [Flow reference](/reference/flows/) for every flow's input and output
  fields.
- [API reference](/reference/api/) for every module and every public export.
