# Make frame scrubbing and node inspection coherent

GitHub: https://github.com/smithersai/smithers/issues/950

Parent: smithers/gh-852-polish-execution-tree-retries-and-node-inspection.md

Context: Frame scrubbing renders a static historical tree and disables selection, while the separate inspector can remain on a live node. Acceptance criteria: clearly clear or rebind the inspector during scrubbing; show the selected historical node's state and output when supported; restore live selection and updates on returning to Live; add regression coverage for previous/next frame navigation and live restoration.
