# Dependency-bound build targets

`PACKAGE.ts` declares repository targets using `@smthrs/targets`; `.smithers/WORKSPACE.ts` declares shared toolchain and host configuration. A target's input files and dependency edges participate in its key. A documentation generator needs those code dependencies just as a compiler does.

## Declare exact wiki inputs

The wiki catalog names each page's owning Markdown and source files. `flows/wiki/PACKAGE.ts` imports that same catalog and turns its source list into explicit repository-root file inputs. There is one dependency inventory, not a hand-maintained second list of broad globs.

This matters across package boundaries. File globs are package scoped. A named `Filegroup` is the reusable way to carry another package's set of files into a consumer; explicit file inputs are appropriate for this small curated recipe.

## Distinguish generation and verification

The wiki's preview build performs deterministic source capture and rendering. It carries an unreviewed status. The verified run calls a model-backed semantic reviewer for every section of every page and refuses verified success if any section remains unsupported or uncertain.

A source digest proves which bytes were read. It cannot prove that prose accurately explains those bytes. The review gate is therefore a separate operation with its own source-bound receipt, and the writer rechecks inputs after the review.

## Understand the portability boundary

The workspace currently declares a Node toolchain for repository targets and separately declares Bun. Selecting Node for the build command is a repository policy; it is not a reason for a reusable flow to import Node filesystem or SQL APIs. The generation actions depend on Effect services, and the executable selects the Node or Bun runtime composition.
