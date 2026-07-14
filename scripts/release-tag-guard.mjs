import { spawnSync } from "node:child_process";

function git(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

export function assertReleaseTagMatchesHead({ cwd, version }) {
  const tag = `v${version}`;
  const local = git(cwd, ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`]);

  if (local.status !== 0) {
    const remote = git(cwd, ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`]);
    if (remote.status !== 0) return;

    const fetch = git(cwd, [
      "fetch",
      "--no-tags",
      "origin",
      `refs/tags/${tag}:refs/tags/${tag}`,
    ]);
    if (fetch.status !== 0) {
      throw new Error(`could not fetch existing release tag ${tag} from origin:\n${fetch.stderr.trim()}`);
    }
  }

  const tagged = git(cwd, ["rev-parse", `${tag}^{commit}`]);
  const head = git(cwd, ["rev-parse", "HEAD"]);
  if (tagged.status !== 0 || head.status !== 0) {
    throw new Error(`could not resolve ${tag} and HEAD before release`);
  }

  const taggedCommit = tagged.stdout.trim();
  const headCommit = head.stdout.trim();
  if (taggedCommit !== headCommit) {
    throw new Error(
      `release tag ${tag} points to ${taggedCommit}, but HEAD is ${headCommit}.\n` +
        `Re-tag this release with \`git tag -f -a ${tag} HEAD\` and force-push the tag, ` +
        "or bump the package version before publishing.",
    );
  }
}
