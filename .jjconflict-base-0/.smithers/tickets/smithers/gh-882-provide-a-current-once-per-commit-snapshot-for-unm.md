# Provide a current, once-per-commit snapshot for unmount events

GitHub: https://github.com/smithersai/smithers/issues/882

Fix unmount event timing and snapshot selection so consumers do not receive the previous commit's tree containing the removed node, and do not receive one callback per deleted fiber in a subtree. Add a regression test covering removal of a Smithers subtree and assert the unmount callback is coalesced appropriately and carries the post-removal snapshot.
