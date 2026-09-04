import { describe, expect, it } from "vitest"
import { inferEffectTier, maxTier } from "../src/internal/Authority.ts"

describe("Authority", () => {
  it("returns the more conservative tier and keeps the left value when ranks tie", () => {
    expect(maxTier("sealed", "sealed")).toBe("sealed")
    expect(maxTier("compensable", "compensable")).toBe("compensable")
    expect(maxTier("sealed", "compensable")).toBe("compensable")
    expect(maxTier("compensable", "sealed")).toBe("compensable")
    expect(maxTier("irreversible", "compensable")).toBe("irreversible")
    expect(maxTier("compensable", "irreversible")).toBe("irreversible")
  })

  it("treats an empty capability list as sealed", () => {
    expect(inferEffectTier([])).toBe("sealed")
  })

  it.each([
    ["read", "Read"],
    ["grep", "Grep"],
    ["glob", "Glob"],
    ["ls", "LS"],
    ["an exact sealed action", "fs:read"],
    ["a scoped sealed action", "fs:read:src/**"],
    ["a scoped network read", "net:get:api.github.com"],
    ["a model call", "model:call"],
    ["a jj status read", "jj:status"],
    ["a jj diff read", "jj:diff"]
  ])("infers sealed from %s", (_label, capability) => {
    expect(inferEffectTier([capability])).toBe("sealed")
  })

  it.each([
    ["a workspace-relative scope", "fs:write:src/**"],
    ["an ordinary workspace-relative report", "fs:write:out/report.md"],
    ["a leading current-directory segment", "fs:write:./src/./out"],
    ["empty segments from a doubled separator", "fs:write:src//out"],
    ["a parent segment that stays inside the descent", "fs:write:src/nested/../out"],
    ["the workspace root itself", "fs:write:."],
    ["backslash separators", "fs:write:src\\nested"]
  ])("infers compensable from %s", (_label, capability) => {
    expect(inferEffectTier([capability])).toBe("compensable")
  })

  it.each([
    ["an unscoped write", "fs:write"],
    ["an empty scope", "fs:write:"],
    ["a whitespace-only scope", "fs:write:   "],
    ["a leading parent segment", "fs:write:../outside"],
    ["a parent segment that escapes after descending", "fs:write:src/../../outside"],
    ["a posix absolute scope", "fs:write:/tmp/out"],
    ["a windows absolute scope", "fs:write:C:/tmp/out"],
    ["a home-relative scope", "fs:write:~/.ssh/authorized_keys"],
    ["the home directory marker", "fs:write:~"],
    ["a shell variable prefix", "fs:write:$HOME/.bashrc"],
    ["an interpolated shell variable", "fs:write:${HOME}/x"],
    ["a Windows environment variable", "fs:write:%USERPROFILE%/x"],
    ["a file URI", "fs:write:file:///etc/passwd"],
    ["an unrecognised action", "git:push"],
    ["the wildcard", "*"]
  ])("infers irreversible from %s", (_label, capability) => {
    expect(inferEffectTier([capability])).toBe("irreversible")
  })

  it("ignores capability casing", () => {
    expect(inferEffectTier(["READ"])).toBe("sealed")
    expect(inferEffectTier(["FS:READ:SRC"])).toBe("sealed")
    expect(inferEffectTier(["FS:WRITE:SRC"])).toBe("compensable")
  })

  it("takes the most conservative tier across mixed capabilities", () => {
    expect(inferEffectTier(["Read", "fs:write:src/**"])).toBe("compensable")
    expect(inferEffectTier(["fs:write:src/**", "Read"])).toBe("compensable")
    expect(inferEffectTier(["Read", "fs:write:src/**", "Write"])).toBe("irreversible")
  })
})
