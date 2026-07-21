/** @param {string[]} argv */
export function rewriteOneshotBooleanValues(argv) {
    const commandIndex = argv.findIndex((arg) => arg === "oneshot");
    if (commandIndex < 0) return argv;
    const rewritten = argv.slice(0, commandIndex + 1);
    for (let index = commandIndex + 1; index < argv.length; index += 1) {
        const arg = argv[index];
        const match = /^(--detach|--open|-d)=(true|false)$/.exec(arg);
        const flag = match?.[1] ?? arg;
        const nextValue = match?.[2] ?? argv[index + 1];
        if (["--detach", "--open", "-d"].includes(flag) && (nextValue === "true" || nextValue === "false")) {
            const name = flag === "--open" ? "open" : "detach";
            rewritten.push(nextValue === "true" ? `--${name}` : `--no-${name}`);
            if (!match) index += 1;
            continue;
        }
        rewritten.push(arg);
    }
    return rewritten;
}
