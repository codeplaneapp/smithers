/** @jsxImportSource smthrs */
import { describe, expect, test } from "bun:test";
import { extractGraph } from "../src/extract.js";
import { extractFromHost } from "../src/dom/extract.js";

/**
 * @param {string} tag
 * @param {Record<string, any>} [rawProps]
 * @param {any[]} [children]
 */
function hostEl(tag, rawProps = {}, children = []) {
  const stringProps = {};
  for (const [k, v] of Object.entries(rawProps)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      stringProps[k] = String(v);
    }
  }
  return { kind: "element", tag, props: stringProps, rawProps, children };
}

/** @param {string} text */
function hostText(text) {
  return { kind: "text", text };
}

/**
 * @param {string} id
 * @param {Record<string, any>} [extra]
 */
function taskEl(id, extra = {}) {
  return hostEl("smithers:task", { id, output: "t", ...extra });
}

/**
 * Kanban-shaped tree: an outer subtree-capped parallel whose direct children
 * are a keyed sequence (implement + nested reviewer parallel), an unkeyed
 * sequence, and a bare task.
 */
function kanbanRoot() {
  return hostEl("smithers:workflow", {}, [
    hostEl("smithers:parallel", { id: "tickets", maxConcurrency: 3, subtreeConcurrency: 2 }, [
      hostText("ignored"),
      hostEl("smithers:sequence", { id: "ticket-1" }, [
        taskEl("impl-1"),
        hostEl("smithers:parallel", { id: "reviews-1", maxConcurrency: 1 }, [taskEl("review-1a"), taskEl("review-1b")]),
      ]),
      hostEl("smithers:sequence", {}, [taskEl("impl-2")]),
      taskEl("solo"),
    ]),
    taskEl("outside"),
  ]);
}

function nestedRoot() {
  return hostEl("smithers:workflow", {}, [
    hostEl("smithers:parallel", { id: "outer", subtreeConcurrency: 2 }, [
      hostEl("smithers:sequence", { id: "outer-child" }, [
        taskEl("before-inner"),
        hostEl("smithers:parallel", { id: "inner", subtreeConcurrency: 1 }, [
          hostEl("smithers:sequence", { id: "inner-child" }, [taskEl("deep")]),
        ]),
      ]),
    ]),
  ]);
}

const extractors = [
  ["extractGraph", extractGraph],
  ["extractFromHost", extractFromHost],
];

for (const [name, extract] of extractors) {
  describe(`${name} subtreeConcurrency extraction`, () => {
    /** @param {any} result @param {string} nodeId */
    const byId = (result, nodeId) => {
      const found = result.tasks.find((t) => t.nodeId === nodeId);
      if (!found) throw new Error(`missing descriptor ${nodeId}`);
      return found;
    };

    test("every descendant leaf records the subtree group, not just innermost-group members", () => {
      const result = extract(kanbanRoot());
      for (const nodeId of ["impl-1", "review-1a", "review-1b", "impl-2", "solo"]) {
        const descriptor = byId(result, nodeId);
        expect(descriptor.subtreeGroupId).toBe("tickets");
        expect(descriptor.subtreeMax).toBe(2);
      }
      // Leaf-group semantics are unchanged: nested reviewer tasks belong to
      // the inner parallel; direct members belong to the outer parallel.
      expect(byId(result, "review-1a").parallelGroupId).toBe("reviews-1");
      expect(byId(result, "review-1a").parallelMaxConcurrency).toBe(1);
      expect(byId(result, "impl-1").parallelGroupId).toBe("tickets");
      expect(byId(result, "impl-1").parallelMaxConcurrency).toBe(3);
    });

    test("child key prefers the direct child's explicit id and falls back to element ordinal", () => {
      const result = extract(kanbanRoot());
      expect(byId(result, "impl-1").subtreeChildKey).toBe("ticket-1");
      expect(byId(result, "review-1b").subtreeChildKey).toBe("ticket-1");
      // Unkeyed sequence: element ordinal (text children don't count).
      expect(byId(result, "impl-2").subtreeChildKey).toBe("child:1");
      // A direct-child task keys by its own id.
      expect(byId(result, "solo").subtreeChildKey).toBe("solo");
    });

    test("tasks outside the subtree parallel record no subtree fields", () => {
      const result = extract(kanbanRoot());
      const outside = byId(result, "outside");
      expect(outside.subtreeGroupId).toBeUndefined();
      expect(outside.subtreeChildKey).toBeUndefined();
      expect(outside.subtreeMax).toBeUndefined();
    });

    test("nested subtree parallels: a leaf records the NEAREST declaring ancestor", () => {
      const result = extract(nestedRoot());
      const deep = byId(result, "deep");
      expect(deep.subtreeGroupId).toBe("inner");
      expect(deep.subtreeChildKey).toBe("inner-child");
      expect(deep.subtreeMax).toBe(1);
      // Sibling above the inner parallel still belongs to the outer group.
      const before = byId(result, "before-inner");
      expect(before.subtreeGroupId).toBe("outer");
      expect(before.subtreeChildKey).toBe("outer-child");
      expect(before.subtreeMax).toBe(2);
    });

    test("coerces numeric strings, floors fractions, and ignores non-positive or invalid values", () => {
      const root = hostEl("smithers:workflow", {}, [
        hostEl("smithers:parallel", { id: "s", subtreeConcurrency: "2" }, [taskEl("a")]),
        hostEl("smithers:parallel", { id: "f", subtreeConcurrency: 2.9 }, [taskEl("b")]),
        hostEl("smithers:parallel", { id: "z", subtreeConcurrency: 0 }, [taskEl("c")]),
        hostEl("smithers:parallel", { id: "n", subtreeConcurrency: -1 }, [taskEl("d")]),
        hostEl("smithers:parallel", { id: "x", subtreeConcurrency: "nope" }, [taskEl("e")]),
      ]);
      const result = extract(root);
      expect(byId(result, "a").subtreeMax).toBe(2);
      expect(byId(result, "b").subtreeMax).toBe(2);
      expect(byId(result, "c").subtreeMax).toBeUndefined();
      expect(byId(result, "c").subtreeGroupId).toBeUndefined();
      expect(byId(result, "d").subtreeMax).toBeUndefined();
      expect(byId(result, "e").subtreeMax).toBeUndefined();
    });

    test("maxConcurrency alone leaves subtree fields unset (opt-in only)", () => {
      const root = hostEl("smithers:workflow", {}, [
        hostEl("smithers:parallel", { id: "g", maxConcurrency: 2 }, [taskEl("a")]),
      ]);
      const descriptor = extract(root).tasks[0];
      expect(descriptor.parallelMaxConcurrency).toBe(2);
      expect(descriptor.subtreeGroupId).toBeUndefined();
      expect(descriptor.subtreeChildKey).toBeUndefined();
      expect(descriptor.subtreeMax).toBeUndefined();
    });
  });
}
