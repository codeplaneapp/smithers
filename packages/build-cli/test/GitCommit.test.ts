import { Smithers as S } from "@smthrs/targets"
import type * as Target from "@smthrs/targets/Target"
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as GitCommit from "../src/GitCommit.ts"

/** Temp directories this file created; removed after the suite so a run leaves nothing in the OS temp dir. */
const temporaryDirectories: Array<string> = []
const tracked = async (directory: Promise<string>): Promise<string> => {
  const resolved = await directory
  temporaryDirectories.push(resolved)
  return resolved
}
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const git = (root: string, args: ReadonlyArray<string>): Promise<string> =>
  new Promise((resolve, reject) => {
    NodeChildProcess.execFile("git", [...args], { cwd: root }, (error, stdout) => {
      if (error !== null) reject(error)
      else resolve(stdout)
    })
  })

/** A throwaway git repository with one initial commit. */
const temporaryRepo = async (): Promise<string> => {
  const root = await tracked(Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-git-commit-"))))
  await git(root, ["init", "--quiet", "--initial-branch=main"])
  await git(root, ["config", "user.name", "smthrs test"])
  await git(root, ["config", "user.email", "test@example.invalid"])
  await git(root, ["config", "commit.gpgsign", "false"])
  await Fs.writeFile(NodePath.join(root, "README.md"), "seed\n", "utf8")
  await git(root, ["add", "-A"])
  await git(root, ["commit", "--quiet", "-m", "seed"])
  return root
}

const head = (root: string): Promise<string> => git(root, ["rev-parse", "HEAD"]).then((sha) => sha.trim())

const gateTarget = (): Target.AnyTarget => S.Memory.Retain({ source: S.gitCommit("HEAD"), tags: ["gate"] })

const greenGates: GitCommit.GateRunner = { run: async () => [] }

const fixedCommit = (gates: ReadonlyArray<Target.AnyTarget> = []): Target.AnyTarget =>
  S.Git.Commit({ gates, message: "chore: fixed message" })

const agentCommit = (): Target.AnyTarget => S.Git.Commit({ gates: [], message: S.Agents["luna"]! })

const failure = (work: Promise<unknown>): Promise<GitCommit.GitCommitError> =>
  work.then(
    () => {
      throw new Error("expected a GitCommitError")
    },
    (cause) => {
      if (GitCommit.isGitCommitError(cause)) return cause
      throw cause
    }
  )

describe("commit with fake gates", () => {
  it("stages, runs green gates, and creates the fixed-message commit", async () => {
    const root = await temporaryRepo()
    const before = await head(root)
    await Fs.writeFile(NodePath.join(root, "feature.txt"), "new\n", "utf8")
    const seen: Array<ReadonlyArray<Target.AnyTarget>> = []
    const gate = gateTarget()
    const result = await GitCommit.commit({
      root,
      target: fixedCommit([gate]),
      gateRunner: {
        run: async (gates) => {
          seen.push(gates)
          return []
        }
      }
    })
    expect(seen).toEqual([[gate]])
    expect(result.message).toBe("chore: fixed message")
    expect(await head(root)).toBe(result.sha)
    expect(result.sha).not.toBe(before)
    expect(await git(root, ["log", "-1", "--format=%s"])).toBe("chore: fixed message\n")
    expect(await git(root, ["status", "--porcelain"])).toBe("")
  })

  it("refuses the commit when a gate is red and creates nothing", async () => {
    const root = await temporaryRepo()
    const before = await head(root)
    await Fs.writeFile(NodePath.join(root, "feature.txt"), "new\n", "utf8")
    const error = await failure(GitCommit.commit({
      root,
      target: fixedCommit([gateTarget()]),
      gateRunner: {
        run: async () => [{ target: "Memory.Retain", message: "lint failed" }]
      }
    }))
    expect(error.code).toBe("gates_failed")
    expect(error.failures).toEqual([{ target: "Memory.Retain", message: "lint failed" }])
    expect(await head(root)).toBe(before)
  })

  it("lets the -m override win over the declared message", async () => {
    const root = await temporaryRepo()
    await Fs.writeFile(NodePath.join(root, "feature.txt"), "new\n", "utf8")
    const result = await GitCommit.commit({
      root,
      target: fixedCommit(),
      gateRunner: greenGates,
      messageOverride: "fix: override wins"
    })
    expect(result.message).toBe("fix: override wins")
    expect(await git(root, ["log", "-1", "--format=%s"])).toBe("fix: override wins\n")
  })
})

describe("agent-written messages", () => {
  it("composes the message from the named agent and the staged diff", async () => {
    const root = await temporaryRepo()
    await Fs.writeFile(NodePath.join(root, "feature.txt"), "agent change\n", "utf8")
    const contexts: Array<{ root: string; agent: string; stagedDiff: string }> = []
    const result = await GitCommit.commit({
      root,
      target: agentCommit(),
      gateRunner: greenGates,
      agentMessage: {
        compose: async (context) => {
          contexts.push({ ...context })
          return "feat: written by the agent"
        }
      }
    })
    expect(contexts).toHaveLength(1)
    expect(contexts[0]!.agent).toBe("luna")
    expect(contexts[0]!.root).toBe(root)
    expect(contexts[0]!.stagedDiff).toContain("agent change")
    expect(result.message).toBe("feat: written by the agent")
    expect(await git(root, ["log", "-1", "--format=%s"])).toBe("feat: written by the agent\n")
  })

  it("prefers the -m override without consulting the agent", async () => {
    const root = await temporaryRepo()
    await Fs.writeFile(NodePath.join(root, "feature.txt"), "agent change\n", "utf8")
    let composed = 0
    const result = await GitCommit.commit({
      root,
      target: agentCommit(),
      gateRunner: greenGates,
      agentMessage: {
        compose: async () => {
          composed += 1
          return "never used"
        }
      },
      messageOverride: "docs: override"
    })
    expect(composed).toBe(0)
    expect(result.message).toBe("docs: override")
  })

  it("refuses an agent-declared message with no bound AgentMessage", async () => {
    const root = await temporaryRepo()
    const before = await head(root)
    await Fs.writeFile(NodePath.join(root, "feature.txt"), "agent change\n", "utf8")
    const error = await failure(GitCommit.commit({
      root,
      target: agentCommit(),
      gateRunner: greenGates
    }))
    expect(error.code).toBe("agent_message_unavailable")
    expect(error.message).toContain("luna")
    expect(await head(root)).toBe(before)
  })

  it("refuses an empty composed message", async () => {
    const root = await temporaryRepo()
    const before = await head(root)
    await Fs.writeFile(NodePath.join(root, "feature.txt"), "agent change\n", "utf8")
    const error = await failure(GitCommit.commit({
      root,
      target: agentCommit(),
      gateRunner: greenGates,
      agentMessage: { compose: async () => "   " }
    }))
    expect(error.code).toBe("empty_message")
    expect(await head(root)).toBe(before)
  })
})

describe("refusals before staging", () => {
  it("refuses a root outside any git work tree", async () => {
    const root = await tracked(Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-not-a-repo-"))))
    const error = await failure(GitCommit.commit({
      root,
      target: fixedCommit(),
      gateRunner: greenGates
    }))
    expect(error.code).toBe("not_a_git_repository")
  })

  it("refuses a tree identical to HEAD", async () => {
    const root = await temporaryRepo()
    const error = await failure(GitCommit.commit({
      root,
      target: fixedCommit(),
      gateRunner: greenGates
    }))
    expect(error.code).toBe("nothing_to_commit")
  })

  it("refuses a non-Git.Commit target", async () => {
    const root = await temporaryRepo()
    await expect(GitCommit.commit({
      root,
      target: gateTarget(),
      gateRunner: greenGates
    })).rejects.toThrow("expected a Git.Commit target")
  })
})
