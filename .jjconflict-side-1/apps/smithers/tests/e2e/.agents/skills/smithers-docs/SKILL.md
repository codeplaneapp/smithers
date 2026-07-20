---
name: smithers-docs
description: Print llms.txt (concise docs index for LLMs) for this CLI version. Run `smithers docs --help` for usage details.
requires_bin: smithers
command: smithers docs
---

# smithers docs

Print llms.txt (concise docs index for LLMs) for this CLI version.

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--latest` | `boolean` | `false` | Fetch the latest docs from smithers.sh instead of docs for this CLI version |
| `--docsVersion` | `string` |  | Fetch docs for a specific Smithers version, e.g. 0.22.0 or v0.22.0 |
