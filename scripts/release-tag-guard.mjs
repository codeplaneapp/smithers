import { spawnSync } from "node:child_process";

function git(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function commandOutput(result, key) {
  return typeof result[key] === "string" ? result[key].trim() : "";
}

function commandFailure(result) {
  return [result.error?.message, commandOutput(result, "stderr"), commandOutput(result, "stdout")]
    .filter(Boolean)
    .join("\n");
}

function isMissingRemoteRef(result) {
  return result.status === 2 && !result.error && !commandOutput(result, "stdout") && !commandOutput(result, "stderr");
}

function remoteReleaseTagCommit(cwd, tag) {
  const ref = `refs/tags/${tag}`;
  const peeledRef = `${ref}^{}`;
  const remote = git(cwd, ["ls-remote", "--exit-code", "--tags", "origin", ref, peeledRef]);

  if (isMissingRemoteRef(remote)) return null;
  // A status-0 ls-remote can still print advice/warnings to stderr; only a
  // nonzero exit or a spawn error is a transport failure.
  if (remote.status !== 0 || remote.error) {
    throw new Error(
      `could not query release tag ${tag} on origin. Check origin transport and authentication:\n${commandFailure(remote)}`,
    );
  }

  const commits = new Map(
    commandOutput(remote, "stdout")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(/\s+/, 2))
      .filter(([commit, remoteRef]) => commit && remoteRef)
      .map(([commit, remoteRef]) => [remoteRef, commit]),
  );
  // Annotated tags have a peeled commit ref. Lightweight tags do not, so their
  // tag ref itself is already the commit to compare.
  const commit = commits.get(peeledRef) ?? commits.get(ref);
  if (!commit) {
    throw new Error(`could not resolve release tag ${tag} returned by origin:\n${commandOutput(remote, "stdout")}`);
  }
  return commit;
}

export function assertReleaseTagMatchesHead({ cwd, version }) {
  const tag = `v${version}`;
  const head = git(cwd, ["rev-parse", "HEAD"]);
  if (head.status !== 0) {
    throw new Error(`could not resolve HEAD before release:\n${commandFailure(head)}`);
  }

  const local = git(cwd, ["rev-parse", "--verify", "--quiet", `${tag}^{commit}`]);
  if (local.status !== 0 && local.status !== 1) {
    throw new Error(`could not resolve local release tag ${tag}:\n${commandFailure(local)}`);
  }

  const headCommit = commandOutput(head, "stdout");
  const localCommit = local.status === 0 ? commandOutput(local, "stdout") : null;
  const remoteCommit = remoteReleaseTagCommit(cwd, tag);

  if (localCommit && localCommit !== headCommit) {
    throw new Error(
      `local release tag ${tag} points to ${localCommit}, but HEAD is ${headCommit}.\n` +
        `Re-tag this release with \`git tag -f -a ${tag} HEAD\` and force-push the tag, ` +
        "or bump the package version before publishing.",
    );
  }

  if (remoteCommit && remoteCommit !== headCommit) {
    throw new Error(
      `release tag ${tag} on origin points to ${remoteCommit}, but HEAD is ${headCommit}.\n` +
        `Re-tag this release with \`git tag -f -a ${tag} HEAD\` and force-push it with ` +
        `\`git push --force origin refs/tags/${tag}\`, or bump the package version before publishing.`,
    );
  }
}
