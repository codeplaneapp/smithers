import { execFile } from "node:child_process";

/** Run the gh CLI in a repo directory; resolves stdout, throws with stderr. */
export function runGh(repoDir: string, args: string[], stdin?: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      "gh",
      args,
      { cwd: repoDir, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${stderr.trim() || error.message}`));
          return;
        }
        resolvePromise(stdout);
      },
    );
    if (stdin != null) {
      child.stdin?.write(stdin);
      child.stdin?.end();
    }
  });
}
