import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";

const WORKSPACE_RUNTIME_ENABLED = process.env.SMITHERS_E2E_WORKSPACE_RUNTIME === "1";
const WORKSPACE_IMAGE = process.env.SMITHERS_E2E_WORKSPACE_IMAGE ?? "alpine:3.20";

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

async function docker(args: string[]): Promise<CommandResult> {
  const child = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function dockerOk(args: string[]): Promise<string> {
  const result = await docker(args);
  if (result.exitCode !== 0) {
    throw new Error(
      `docker ${args[0] ?? "command"} failed (${result.exitCode}): ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

async function createWorkspace(container: string, volume: string): Promise<void> {
  await dockerOk([
    "create",
    "--name",
    container,
    "--mount",
    `type=volume,source=${volume},target=/home/workspace`,
    WORKSPACE_IMAGE,
    "sh",
    "-c",
    "sleep 300",
  ]);
  await dockerOk(["start", container]);
}

describe("case 19: Auth persistence across workspace suspend/resume", () => {
  test.skipIf(!WORKSPACE_RUNTIME_ENABLED)(
    "a real suspended workspace retains auth in its persistent home volume",
    async () => {
      const suffix = randomUUID();
      const volume = `smithers-case19-home-${suffix}`;
      const firstContainer = `smithers-case19-before-${suffix}`;
      const resumedContainer = `smithers-case19-after-${suffix}`;
      const auth = JSON.stringify({
        provider: "case19-deterministic-provider",
        accessToken: "case19-persisted-auth-token",
        accountId: "case19-account",
      });
      const encodedAuth = Buffer.from(auth).toString("base64");
      const expectedDigest = createHash("sha256").update(auth).digest("hex");

      await dockerOk(["info", "--format", "{{.ServerVersion}}"]).catch((error) => {
        throw new Error(
          `SMITHERS_E2E_WORKSPACE_RUNTIME=1 requires a reachable Docker daemon: ${String(error)}`,
        );
      });

      try {
        await dockerOk(["volume", "create", volume]);
        await createWorkspace(firstContainer, volume);
        await dockerOk([
          "exec",
          firstContainer,
          "sh",
          "-ceu",
          `mkdir -p /home/workspace/.config/smithers
printf '%s' '${encodedAuth}' | base64 -d > /home/workspace/.config/smithers/auth.json
chmod 600 /home/workspace/.config/smithers/auth.json`,
        ]);

        await dockerOk(["pause", firstContainer]);
        expect(await dockerOk(["inspect", "--format", "{{.State.Paused}}", firstContainer])).toBe("true");

        await dockerOk(["unpause", firstContainer]);
        expect(await dockerOk(["inspect", "--format", "{{.State.Paused}}", firstContainer])).toBe("false");
        expect(
          await dockerOk([
            "exec",
            firstContainer,
            "sha256sum",
            "/home/workspace/.config/smithers/auth.json",
          ]),
        ).toStartWith(expectedDigest);

        // Re-provisioning the workspace proves the auth belongs to the sticky
        // home volume, rather than merely surviving in the paused container's
        // writable layer.
        await dockerOk(["rm", "-f", firstContainer]);
        await createWorkspace(resumedContainer, volume);
        expect(
          await dockerOk([
            "exec",
            resumedContainer,
            "sha256sum",
            "/home/workspace/.config/smithers/auth.json",
          ]),
        ).toStartWith(expectedDigest);
        expect(
          await dockerOk([
            "exec",
            resumedContainer,
            "stat",
            "-c",
            "%a",
            "/home/workspace/.config/smithers/auth.json",
          ]),
        ).toBe("600");
      } finally {
        await docker(["rm", "-f", firstContainer]);
        await docker(["rm", "-f", resumedContainer]);
        await docker(["volume", "rm", "-f", volume]);
      }
    },
    60_000,
  );
});
