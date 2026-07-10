# Rebind monitor inspector selection to the latest live tree node

GitHub: https://github.com/smithersai/smithers/issues/907

Store a stable selected node key instead of the selected TreeNode object, resolve that key against the latest useGatewayRunTree result on each render, and keep the inspector status, tool calls, metadata, and deep-link selection current after live tree replacements. Add a regression test that selects a running node, publishes a finished replacement, and verifies the inspector updates without reselection.
