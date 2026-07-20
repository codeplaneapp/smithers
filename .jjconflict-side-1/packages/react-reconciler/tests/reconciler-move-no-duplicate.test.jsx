import { describe, expect, test } from "bun:test";
import { SmithersRenderer } from "../src/dom/renderer.js";
import React from "react";

/**
 * Regression test for the mutation-mode move bug.
 *
 * In mutation mode React relocates an already-mounted keyed child by calling
 * insertBefore/appendChild WITHOUT a preceding removeChild. The host config
 * used to push/splice the child into parent.children without removing its
 * current position, so a reordered keyed child appeared twice in the extracted
 * graph. The fix removes any existing occurrence of the child before inserting.
 *
 * Render a keyed list [A, B] then re-render as [B, A]; the parent must end up
 * with exactly two children in order [B, A] with no duplicated node.
 */
describe("reconciler keyed move", () => {
    test("reordering keyed children moves a node instead of duplicating it", async () => {
        const renderer = new SmithersRenderer();

        const makeChild = (id) =>
            React.createElement("smithers:task", { key: id, id, output: "out" });

        await renderer.render(
            React.createElement(
                "smithers:parallel",
                null,
                makeChild("A"),
                makeChild("B"),
            ),
        );

        const firstRoot = renderer.getRoot();
        expect(firstRoot.kind).toBe("element");
        expect(firstRoot.children.map((c) => c.props.id)).toEqual(["A", "B"]);

        // Re-render with the order swapped. React moves an existing child.
        await renderer.render(
            React.createElement(
                "smithers:parallel",
                null,
                makeChild("B"),
                makeChild("A"),
            ),
        );

        const root = renderer.getRoot();
        const ids = root.children.map((c) => c.props.id);

        // Exactly two children, no duplicates, in the new order.
        expect(root.children).toHaveLength(2);
        expect(ids).toEqual(["B", "A"]);
        expect(new Set(ids).size).toBe(ids.length);
    });
});
