/**
 * `CommandLine.render` is the string a `proc:spawn` grant is written against
 * and the line the browser interpreter actually runs. Those two must never
 * disagree, so the rendering rules get their own cases.
 */
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { describe, expect, it } from "vitest"
import * as CommandLine from "../src/CommandLine.ts"

describe("CommandLine.render", () => {
  it("leaves a bare command and shell-safe arguments unquoted", () => {
    expect(CommandLine.render(ChildProcess.make("git", ["status", "--short"]))).toBe("git status --short")
    expect(CommandLine.render(ChildProcess.make("/usr/bin/curl", ["https://example.com/a?b"])))
      .toBe("/usr/bin/curl 'https://example.com/a?b'")
  })

  it("single-quotes anything with whitespace, an empty argument, or a metacharacter", () => {
    expect(CommandLine.render(ChildProcess.make("echo", ["a b"]))).toBe("echo 'a b'")
    expect(CommandLine.render(ChildProcess.make("echo", [""]))).toBe("echo ''")
    expect(CommandLine.render(ChildProcess.make("echo", ["a;rm -rf /"]))).toBe("echo 'a;rm -rf /'")
  })

  it("escapes an embedded single quote so the rendering cannot break out of it", () => {
    expect(CommandLine.render(ChildProcess.make("echo", ["it's"]))).toBe("echo 'it'\\''s'")
  })

  it("preserves newline and NUL tokens in the durable grant identity", () => {
    const newline = "line\nbreak"
    expect(CommandLine.quote(newline)).toBe("'line\nbreak'")
    expect(CommandLine.render(ChildProcess.make("echo", [newline]))).toBe("echo 'line\nbreak'")

    const nul = "nul\0byte"
    expect(CommandLine.quote(nul)).toBe("'nul\0byte'")
    expect(CommandLine.render(ChildProcess.make("echo", [nul]))).toBe("echo 'nul\0byte'")
  })

  it("keeps a backslash literal inside the quoted rendering", () => {
    expect(CommandLine.quote("a\\b")).toBe("'a\\b'")
    expect(CommandLine.render(ChildProcess.make("echo", ["C:\\Windows\\system32"])))
      .toBe("echo 'C:\\Windows\\system32'")
    // A backslash adjacent to the escaped single quote must not swallow it:
    // the token `a\'b` has to survive a round trip through the shell.
    expect(CommandLine.quote("a\\'b")).toBe("'a\\'\\''b'")
  })

  it("quotes non-ASCII tokens so a lookalike never renders as a bare safe token", () => {
    expect(CommandLine.quote("café")).toBe("'café'")
    // U+FF47 FULLWIDTH LATIN SMALL LETTER G is not `g`, so `\uFF47it` must not
    // render as the bare `git` a reviewer would read it as.
    expect(CommandLine.quote("\uFF47it")).toBe("'\uFF47it'")
    expect(CommandLine.render(ChildProcess.make("echo", ["→", "\u200b"])))
      .toBe("echo '→' '\u200b'")
  })

  it("renders shell commands verbatim so the capability names what executes", () => {
    expect(CommandLine.render(ChildProcess.make("echo", ["safe; touch /tmp/marker"], { shell: true })))
      .toBe("echo safe; touch /tmp/marker")
    expect(CommandLine.render(ChildProcess.make("echo", ["a b"], { shell: "/bin/sh" })))
      .toBe("/bin/sh -c 'echo a b'")
    expect(CommandLine.render(ChildProcess.make("echo", ["it's"], { shell: "/custom shell" })))
      .toBe("'/custom shell' -c 'echo it'\\''s'")
    expect(CommandLine.render(ChildProcess.make("echo", ["a b"], { shell: false })))
      .toBe("echo 'a b'")
  })

  it("renders a pipeline with `|` between its stages", () => {
    const pipeline = ChildProcess.make("printf", ["a b"]).pipe(
      ChildProcess.pipeTo(ChildProcess.make("grep", ["a"]))
    )

    expect(CommandLine.render(pipeline)).toBe("printf 'a b' | grep a")
  })

  it("renders shell and custom-shell stages independently inside a pipeline", () => {
    const pipeline = ChildProcess.make("printf", ["safe; printf injected"], { shell: true }).pipe(
      ChildProcess.pipeTo(ChildProcess.make("grep", ["hello world"], { shell: "/custom shell" }))
    )

    expect(CommandLine.render(pipeline)).toBe(
      "printf safe; printf injected | '/custom shell' -c 'grep hello world'"
    )
  })

  it("keeps pipe descriptor options out of the capability resource at the fd3 boundary", () => {
    const defaultPipe = ChildProcess.pipeTo(ChildProcess.make("left"), ChildProcess.make("right"))
    const minimumCustomFd = ChildProcess.pipeTo(
      ChildProcess.make("left"),
      ChildProcess.make("right"),
      { from: "fd3", to: "fd3" }
    )
    const belowMinimumFd = ChildProcess.pipeTo(
      ChildProcess.make("left"),
      ChildProcess.make("right"),
      {
        from: "fd2" as unknown as ChildProcess.PipeFromOption,
        to: "fd2" as unknown as ChildProcess.PipeToOption
      }
    )

    expect(CommandLine.render(defaultPipe)).toBe("left | right")
    expect(CommandLine.render(minimumCustomFd)).toBe("left | right")
    expect(CommandLine.render(belowMinimumFd)).toBe("left | right")
  })
})

describe("CommandLine.cwd and CommandLine.env", () => {
  it("reads the options off a standard command", () => {
    const command = ChildProcess.make("ls", [], { cwd: "/work", env: { A: "1" } })

    expect(CommandLine.cwd(command)).toBe("/work")
    expect(CommandLine.env(command)).toEqual({ A: "1" })
  })

  it("is undefined when a command declares neither", () => {
    expect(CommandLine.cwd(ChildProcess.make("ls"))).toBeUndefined()
    expect(CommandLine.env(ChildProcess.make("ls"))).toBeUndefined()
  })

  it("takes the leftmost stage of a pipeline", () => {
    const pipeline = ChildProcess.make("ls", [], { cwd: "/left", env: { SIDE: "left" } }).pipe(
      ChildProcess.pipeTo(ChildProcess.make("wc", [], { cwd: "/right", env: { SIDE: "right" } }))
    )

    expect(CommandLine.cwd(pipeline)).toBe("/left")
    expect(CommandLine.env(pipeline)).toEqual({ SIDE: "left" })
  })
})
