import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { DEVTOOLS_PROTOCOL_VERSION } from "../src/devtools.js";
import {
  DEVTOOLS_ERROR_CODES,
  JUMP_TO_FRAME_ERROR_CODES,
  NODE_DIFF_ERROR_CODES,
  NODE_OUTPUT_ERROR_CODES,
} from "../src/errors/index.js";

const protocolRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(protocolRoot, "../..");
const tsc = resolve(repoRoot, "node_modules/.bin/tsc");

// Each error code is spelled in three hand-maintained places that must stay in
// sync, INCLUDING member order: the runtime tuple in src/errors/index.js, the
// type-alias union in src/errors/*.ts, and the generated-but-committed declaration
// tuple in src/index.d.ts. The guards below compare with ordered `toEqual`, so a
// reorder in one file that is not mirrored in the others fails by design — keep the
// lists literally identical, in the same order, across all three representations.
const ERROR_CODE_CONTRACTS = [
  {
    alias: "DevToolsErrorCode",
    declaration: "DEVTOOLS_ERROR_CODES",
    relativePath: "src/errors/DevToolsErrorCode.ts",
    runtime: DEVTOOLS_ERROR_CODES,
  },
  {
    alias: "NodeOutputErrorCode",
    declaration: "NODE_OUTPUT_ERROR_CODES",
    relativePath: "src/errors/NodeOutputErrorCode.ts",
    runtime: NODE_OUTPUT_ERROR_CODES,
  },
  {
    alias: "NodeDiffErrorCode",
    declaration: "NODE_DIFF_ERROR_CODES",
    relativePath: "src/errors/NodeDiffErrorCode.ts",
    runtime: NODE_DIFF_ERROR_CODES,
  },
  {
    alias: "JumpToFrameErrorCode",
    declaration: "JUMP_TO_FRAME_ERROR_CODES",
    relativePath: "src/errors/JumpToFrameErrorCode.ts",
    runtime: JUMP_TO_FRAME_ERROR_CODES,
  },
];

function expectNoDuplicates(values) {
  expect(new Set(values).size).toBe(values.length);
}

function readSourceFile(relativePath) {
  const absolutePath = resolve(protocolRoot, relativePath);
  return ts.createSourceFile(
    relativePath,
    readFileSync(absolutePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function stringLiteralMember(node) {
  if (!ts.isLiteralTypeNode(node)) return null;
  return ts.isStringLiteral(node.literal) ? node.literal.text : null;
}

function unionMembers(node) {
  const members = ts.isUnionTypeNode(node) ? node.types : [node];
  return members.map((member) => {
    const value = stringLiteralMember(member);
    if (value === null) {
      throw new Error(
        `Unsupported error-code member \`${member.getText()}\` in a type alias. This ` +
          "drift guard expects each src/errors/*.ts alias to be either a string-literal " +
          "union or the drift-proof `(typeof CODES)[number]` form. If you refactored the " +
          "alias to a different shape, teach derivedRuntimeConstName()/unionMembers() how " +
          "to read it so the runtime<->type contract stays enforced.",
      );
    }
    return value;
  });
}

// Recognize the drift-proof-by-construction alias `type X = (typeof CODES)[number]`,
// which derives its members directly from the runtime tuple and therefore cannot
// drift. Returns the referenced runtime const's name, or null for any other shape.
function derivedRuntimeConstName(node) {
  if (!ts.isIndexedAccessTypeNode(node)) return null;
  if (node.indexType.kind !== ts.SyntaxKind.NumberKeyword) return null;
  let objectType = node.objectType;
  while (ts.isParenthesizedTypeNode(objectType)) objectType = objectType.type;
  if (!ts.isTypeQueryNode(objectType)) return null;
  return objectType.exprName.getText();
}

function typeAliasContract(relativePath, alias) {
  const sourceFile = readSourceFile(relativePath);
  let contract = null;
  sourceFile.forEachChild((node) => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === alias) {
      const derivedFrom = derivedRuntimeConstName(node.type);
      contract = derivedFrom ? { derivedFrom } : { members: unionMembers(node.type) };
    }
  });
  if (!contract) throw new Error(`Missing ${alias} in ${relativePath}`);
  return contract;
}

function tupleLiteralMembers(node) {
  if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword) {
    return tupleLiteralMembers(node.type);
  }
  if (!ts.isTupleTypeNode(node)) return null;
  return node.elements.map((element) => {
    const member = ts.isNamedTupleMember(element) ? element.type : element;
    const value = stringLiteralMember(member);
    if (value === null) {
      throw new Error(`Unsupported declaration member: ${member.getText()}`);
    }
    return value;
  });
}

function membersForDeclarationTuple(declaration) {
  const sourceFile = readSourceFile("src/index.d.ts");
  let members = null;
  function visit(node) {
    if (members) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === declaration &&
      node.type
    ) {
      members = tupleLiteralMembers(node.type);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  if (!members) throw new Error(`Missing ${declaration} in src/index.d.ts`);
  return members;
}

describe("protocol runtime constants", () => {
  test("package root exposes runtime constants", () => {
    const result = spawnSync(
      "node",
      [
        "--input-type=module",
        "--eval",
        `
          import {
            DEVTOOLS_ERROR_CODES,
            DEVTOOLS_PROTOCOL_VERSION,
            JUMP_TO_FRAME_ERROR_CODES,
            NODE_DIFF_ERROR_CODES,
            NODE_OUTPUT_ERROR_CODES,
          } from "@smithers-orchestrator/protocol";

          console.log(JSON.stringify({
            DEVTOOLS_ERROR_CODES,
            DEVTOOLS_PROTOCOL_VERSION,
            JUMP_TO_FRAME_ERROR_CODES,
            NODE_DIFF_ERROR_CODES,
            NODE_OUTPUT_ERROR_CODES,
          }));
        `,
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      DEVTOOLS_ERROR_CODES,
      DEVTOOLS_PROTOCOL_VERSION,
      JUMP_TO_FRAME_ERROR_CODES,
      NODE_DIFF_ERROR_CODES,
      NODE_OUTPUT_ERROR_CODES,
    });
  });

  test("devtools protocol version is the v1 wire contract", () => {
    expect(DEVTOOLS_PROTOCOL_VERSION).toBe(1);
  });

  test("devtools error codes cover auth delta and backpressure failures", () => {
    expect(DEVTOOLS_ERROR_CODES).toEqual([
      "RunNotFound",
      "InvalidRunId",
      "FrameOutOfRange",
      "SeqOutOfRange",
      "BackpressureDisconnect",
      "Unauthorized",
      "InvalidDelta",
    ]);
  });

  test("node output error codes cover malformed rows and payload limits", () => {
    expect(NODE_OUTPUT_ERROR_CODES).toEqual([
      "InvalidRunId",
      "InvalidNodeId",
      "InvalidIteration",
      "RunNotFound",
      "NodeNotFound",
      "IterationNotFound",
      "NodeHasNoOutput",
      "SchemaConversionError",
      "MalformedOutputRow",
      "PayloadTooLarge",
    ]);
  });

  test("node diff error codes cover dirty worktrees and attempt states", () => {
    expect(NODE_DIFF_ERROR_CODES).toEqual([
      "InvalidRunId",
      "InvalidNodeId",
      "InvalidIteration",
      "RunNotFound",
      "NodeNotFound",
      "AttemptNotFound",
      "AttemptNotFinished",
      "VcsError",
      "WorkingTreeDirty",
      "DiffTooLarge",
    ]);
  });

  test("jump-to-frame error codes cover confirmation busy rate-limit and auth paths", () => {
    expect(JUMP_TO_FRAME_ERROR_CODES).toEqual([
      "InvalidRunId",
      "InvalidFrameNo",
      "RunNotFound",
      "FrameOutOfRange",
      "ConfirmationRequired",
      "Busy",
      "UnsupportedSandbox",
      "VcsError",
      "RewindFailed",
      "TIME_TRAVEL_SIDE_EFFECT_BLOCKED",
      "RateLimited",
      "Unauthorized",
    ]);
  });

  test("all error code lists are duplicate-free", () => {
    expectNoDuplicates(DEVTOOLS_ERROR_CODES);
    expectNoDuplicates(NODE_OUTPUT_ERROR_CODES);
    expectNoDuplicates(NODE_DIFF_ERROR_CODES);
    expectNoDuplicates(JUMP_TO_FRAME_ERROR_CODES);
  });

  test("type aliases match runtime error code lists", () => {
    for (const contract of ERROR_CODE_CONTRACTS) {
      const alias = typeAliasContract(contract.relativePath, contract.alias);
      if (alias.derivedFrom !== undefined) {
        // Drift-proof-by-construction: `type X = (typeof CODES)[number]` takes its
        // members from the runtime tuple verbatim, so only confirm it derives from the
        // matching runtime const rather than re-comparing member-by-member.
        expect(alias.derivedFrom).toBe(contract.declaration);
      } else {
        expect(alias.members).toEqual(contract.runtime);
      }
    }
  });

  test("public declaration tuples match runtime error code lists", () => {
    for (const contract of ERROR_CODE_CONTRACTS) {
      expect(membersForDeclarationTuple(contract.declaration)).toEqual(contract.runtime);
    }
  });

  test("run lookup failures use consistent code spelling", () => {
    for (const codes of [
      DEVTOOLS_ERROR_CODES,
      NODE_OUTPUT_ERROR_CODES,
      NODE_DIFF_ERROR_CODES,
      JUMP_TO_FRAME_ERROR_CODES,
    ]) {
      expect(codes).toContain("RunNotFound");
      expect(codes).toContain("InvalidRunId");
    }
  });

  test("diff and rewind VCS errors use consistent code spelling", () => {
    expect(NODE_DIFF_ERROR_CODES).toContain("VcsError");
    expect(JUMP_TO_FRAME_ERROR_CODES).toContain("VcsError");
  });
});

describe("DevTools snapshot consumer types", () => {
  test("published snapshots expose their optional derived run state", () => {
    const result = spawnSync(
      tsc,
      [
        "--ignoreConfig",
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "--target",
        "ESNext",
        "--module",
        "ESNext",
        "--moduleResolution",
        "bundler",
        "tests/fixtures/devtools-snapshot-consumer.ts",
      ],
      { cwd: protocolRoot, encoding: "utf8" },
    );

    expect(`${result.stdout}${result.stderr}`).toBe("");
    expect(result.status).toBe(0);
  });
});

describe("Gateway RPC consumer types", () => {
  test("the explicit gateway-rpc subpath exposes wire contracts without gateway", () => {
    const result = spawnSync(
      tsc,
      [
        "--ignoreConfig",
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "--target",
        "ESNext",
        "--module",
        "ESNext",
        "--moduleResolution",
        "bundler",
        "tests/fixtures/gateway-rpc-consumer.ts",
      ],
      { cwd: protocolRoot, encoding: "utf8" },
    );

    expect(`${result.stdout}${result.stderr}`).toBe("");
    expect(result.status).toBe(0);
  });
});
