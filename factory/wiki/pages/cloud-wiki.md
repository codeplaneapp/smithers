# Collaborative repository Wiki

The repository Wiki client reuses the existing world-document collection, actor-tagged dispatcher, card and Markdown editor. The cloud connection is an internal Effect service over the existing authenticated fetch/proxy seam. It does not introduce another database or gateway extension.

## One document, two revision domains

A local document keeps its ordinary app revision. Its optional `cloud` metadata separately records the repository, stable Plue page ID, current slug, remote page revision, causal state and pending edits. Reusing a deleted slug cannot make it the same page identity. This distinction matters when restoring historical application state or retrying an edit.

The card starts with an outline and recorded source information. Its selected document and outline/document view are persisted card state. Opening the document uses the existing Markdown editor. The onboarding contract keeps chat history in the main UI and summons the composer separately. The embedded conversation test host does not define the shell layout.

## Persist before sending, acknowledge exact edits

Local edits update `Y.Text("markdown")` and persist both readable state and an immutable UUID/delta pair before sending. A per-page sender posts one pending update at a time. An acknowledgement must match the update and page identities, and its causal state must contain the submitted delta, including deletions. The client merges that state with newer local edits and removes only the acknowledged queue entry.

Revision streams resume from the last applied page revision. Events trigger a document refresh; a timer or a newer body cannot acknowledge a pending edit. A lost response keeps the original UUID and bytes for retry. Refresh or a subsequent edit retries the queue. Reload or branch restoration requires explicit refresh before collaboration resumes.

## Use the existing app flow doors

`wiki.cloud` browses a repository; `wiki.cloud.open` opens a page; `wiki.sync` refreshes and retries saved edits; `wiki.edit` accepts Markdown. `wiki.card.select` and `wiki.card.view` change the embedded selection and presentation. These are app flow registrations with typed inputs and the existing form/actor path, not new public package primitives. The owning client document gives their exact input shapes.

Transport success does not verify generated prose. Semantic verification belongs to the dependency-bound generation workflow. The client contract and synthetic causal fixtures also do not establish a deployed two-client canary. Presence cursors, collaborative selection/undo and a ProseMirror operation binding remain outside this slice; remote Markdown replacement can move the caret.
