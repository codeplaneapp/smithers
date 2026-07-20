import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

const pkgDir = resolve(import.meta.dir, "..");
const repoRoot = resolve(pkgDir, "..", "..");
const tsc = join(repoRoot, "node_modules", ".bin", "tsc");
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));

describe("integrations subpath exports have their own types mapping", () => {
  test("wildcard export maps to per-subpath declarations", () => {
    expect(pkg.exports["./*"].types).toBe("./src/*.d.ts");
    expect(pkg.exports["./*"].types).not.toBe("./src/index.d.ts");
  });

  for (const dts of [
    "./src/core/EventSource.d.ts",
    "./src/github/components/outbound.d.ts",
    "./src/telegram/components/SendMessage.d.ts",
  ]) {
    test(`${dts} is shipped`, () => {
      expect(existsSync(join(pkgDir, dts))).toBe(true);
    });
  }
});

describe("integrations deep subpath types resolve through published exports", () => {
  const tmp = mkdtempSync(join(tmpdir(), "integrations-subpath-types-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  symlinkSync(join(repoRoot, "node_modules"), join(tmp, "node_modules"), "dir");
  writeFileSync(
    join(tmp, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        jsx: "react-jsx",
        noEmit: true,
        skipLibCheck: true,
        types: [],
      },
      include: ["*.ts", "*.tsx"],
    }),
  );

  /** @param {string} name @param {string} source */
  function typecheck(name, source) {
    writeFileSync(join(tmp, name), source);
    const result = spawnSync(tsc, ["-p", "tsconfig.json"], { cwd: tmp, encoding: "utf8" });
    return { code: result.status, out: `${result.stdout}${result.stderr}` };
  }

  test("well-typed deep subpath imports typecheck clean", () => {
    const { code, out } = typecheck(
      "good.tsx",
      [
        `import { makePollingSource } from "@smithers-orchestrator/integrations/core/EventSource";`,
        `import { integrationEventName } from "@smithers-orchestrator/integrations/core/signalNames";`,
        `import { splitRepo } from "@smithers-orchestrator/integrations/github/components/outbound";`,
        `import { SendMessage } from "@smithers-orchestrator/integrations/telegram/components/SendMessage";`,
        `import { Effect } from "effect";`,
        `import type { TelegramClientConfig } from "@smithers-orchestrator/integrations/telegram/TelegramClientTypes";`,
        `const eventName: string = integrationEventName("github", "push");`,
        `const repo: { owner: string; name: string } = splitRepo("smithersai/smithers");`,
        `const config: TelegramClientConfig = { botToken: "token" };`,
        `const component: typeof SendMessage = SendMessage;`,
        `const source = makePollingSource({ id: "poller", poll: () => Effect.succeed({ events: [] }) });`,
        `export { eventName, repo, config, component, source };`,
      ].join("\n"),
    );
    expect(out).toBe("");
    expect(code).toBe(0);
  });

  test("misusing deep subpath types is a real type error", () => {
    const { code, out } = typecheck(
      "bad.tsx",
      [
        `import { splitRepo } from "@smithers-orchestrator/integrations/github/components/outbound";`,
        `import type { SendMessageProps } from "@smithers-orchestrator/integrations/telegram/components/SendMessage";`,
        `const badOwner: number = splitRepo("smithersai/smithers").owner;`,
        `const badProps: SendMessageProps = { id: "send", chatId: "chat", children: () => ({ text: 123 }) };`,
        `export { badOwner, badProps };`,
      ].join("\n"),
    );
    expect(code).not.toBe(0);
    expect(out).toContain("bad.tsx");
  });
});
