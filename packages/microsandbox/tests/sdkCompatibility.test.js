import { expect, test } from "bun:test";
import { Sandbox } from "microsandbox";

test("published microsandbox SDK exposes the adapter surface without booting a VM", async () => {
	expect(typeof Sandbox.get).toBe("function");
	expect(typeof Sandbox.remove).toBe("function");

	const builder = Sandbox.builder("smithers-sdk-compatibility")
		.image("oven/bun:1")
		.cpus(2)
		.maxCpus(4)
		.memory(1024)
		.maxMemory(2048)
		.workdir("/workspace")
		.security("restricted")
		.pullPolicy("if-missing")
		.labels({ owner: "smithers" })
		.scripts({ prepare: "#!/bin/sh\necho ready" })
		.maxDuration(900)
		.idleTimeout(120)
		.ephemeral(true)
		.detached(false)
		.disableNetwork()
		.replaceWithTimeout(0);

	expect(typeof builder.port).toBe("function");
	expect(typeof builder.volume).toBe("function");
	expect(typeof builder.fromSnapshot).toBe("function");
	expect(typeof builder.create).toBe("function");

	const config = await builder.build();
	expect(config.name).toBe("smithers-sdk-compatibility");
	expect(config.resources).toMatchObject({ cpus: 2, maxCpus: 4, memoryMib: 1024, maxMemoryMib: 2048 });
	expect(config.runtime).toMatchObject({ workdir: "/workspace", scripts: { prepare: "#!/bin/sh\necho ready" } });
	expect(config.lifecycle).toMatchObject({ ephemeral: true, maxDurationSecs: 900, idleTimeoutSecs: 120 });
	expect(config.network.enabled).toBe(false);
});
