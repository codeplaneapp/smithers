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
      throw new Error(`Unsupported error-code member: ${member.getText()}`);
    }
    return value;
  });
}

function membersForTypeAlias(relativePath, alias) {
  const sourceFile = readSourceFile(relativePath);
  let members = null;
  sourceFile.forEachChild((node) => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === alias) {
      members = unionMembers(node.type);
    }
  });
  if (!members) throw new Error(`Missing ${alias} in ${relativePath}`);
  return members;
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
      expect(membersForTypeAlias(contract.relativePath, contract.alias)).toEqual(contract.runtime);
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
