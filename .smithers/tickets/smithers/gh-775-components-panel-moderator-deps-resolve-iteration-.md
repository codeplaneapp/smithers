# components(Panel): moderator deps resolve iteration 0 inside concurrent Loops, scoring stale panelist outputs

GitHub: https://github.com/smithersai/smithers/issues/775

## What happens

`Panel` wires moderator deps with `ctx.outputMaybe(..., { nodeId })` and no enclosing loop iteration. After a review loop advances (especially after resume or with concurrent sibling loops), the moderator can resolve iteration-0 seat rows instead of the current iteration and score stale reviews.

A direct reproduction has seat output rows at iterations 0 (`stale`) and 2 (`current`): implicit `outputMaybe({nodeId})` returns iteration 0, while explicit `iteration: 2` and `ctx.latest` return the current row.

## Expected

The Panel moderator binds each panelist dependency to the Panel node's enclosing loop scope/iteration and remains stable across resume and concurrent sibling loops.

## Regression test

Render a Panel inside one of multiple concurrent Loops, advance it beyond iteration 0, resume/re-render, and assert the moderator prompt contains only that loop's current-iteration seat outputs.

The multi issue-swarm currently uses a Panel completion barrier plus an exact-iteration companion judge as a workaround.
