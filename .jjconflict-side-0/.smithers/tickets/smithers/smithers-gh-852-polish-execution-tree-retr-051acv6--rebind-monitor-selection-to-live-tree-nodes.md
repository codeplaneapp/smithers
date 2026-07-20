# Rebind monitor selection to live tree nodes

GitHub: https://github.com/smithersai/smithers/issues/948

Parent: smithers/gh-852-polish-execution-tree-retries-and-node-inspection.md

Context: The monitor stores the selected TreeNode object, so live replacements can update the tree while the inspector shows stale node state. Acceptance criteria: store a stable structural node key; resolve the selected node from the newest live tree on every render; preserve duplicate logical IDs and iterations; keep deep-link selection and run switching correct; add a regression test for a selected node changing from running to finished.
