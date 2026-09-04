---
name: pdf-processing
description: Extracts text and metadata from PDF files, repairs malformed documents, and produces accessible output.
license: Apache-2.0
allowed-tools: Read Write Bash(pdftotext:*) Bash(pdfinfo:*) Bash(qpdf:*)
metadata:
  author: document-tools
  version: "1.0"
  category: documents
---

# PDF Processing

Use this skill when a task involves inspecting, repairing, extracting, or
rewriting PDF documents.

## Flow

1. Inspect the document with `pdfinfo`.
2. Extract text with `pdftotext -layout` and preserve page boundaries.
3. If the file is malformed, repair it with `qpdf` before retrying extraction.
4. Verify the resulting document opens and that its page count is unchanged.

Do not overwrite the source document unless the user explicitly requests it.
