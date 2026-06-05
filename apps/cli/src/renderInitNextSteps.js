import { note, outro } from "@clack/prompts";
import pc from "picocolors";

/**
 * Render the post-init "Next steps" block as a clack note + outro, so the
 * human flow ends with copy-pasteable commands instead of a TOON CTA dump.
 *
 * @param {{ description?: string; commands: { command: string; description?: string }[] }} cta
 */
export function renderInitNextSteps(cta) {
    const commands = cta.commands ?? [];
    if (commands.length === 0) {
        outro(pc.green("Smithers is ready."));
        return;
    }
    const width = Math.max(...commands.map((entry) => entry.command.length));
    const body = commands
        .map((entry) => {
            const command = pc.cyan(`smithers ${entry.command}`.padEnd(width + "smithers ".length));
            return entry.description ? `${command}  ${pc.dim(entry.description)}` : command;
        })
        .join("\n");
    note(body, cta.description ?? "Next steps");
    outro(`${pc.green("✓")} Smithers is ready in ${pc.cyan(".smithers/")}`);
}
