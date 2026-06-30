/**
 * Environment detection helpers for deciding whether a CLI command should
 * run interactively (prompts / TUI) or non-interactively (structured output).
 *
 * isAgentHarness() MUST read env BEFORE the process starts, because some
 * harnesses (notably Claude Code) clear CLAUDECODE / CLAUDE_CODE_ENTRYPOINT
 * from child-process env so hijacked subprocesses don't inherit them.
 */

/**
 * Returns true when running inside a known CI system.
 *
 * Covers: GitHub Actions, GitLab CI, Buildkite, CircleCI, Travis CI,
 * Azure Pipelines (TF_BUILD), Jenkins (JENKINS_URL), Drone, Bitbucket
 * Pipelines, TeamCity, Semaphore, AppVeyor, Codeship, Heroku CI, Wercker,
 * and the generic CI=true convention.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function isCI(env = process.env) {
    return Boolean(
        env.CI ||
        env.GITHUB_ACTIONS ||
        env.GITLAB_CI ||
        env.BUILDKITE ||
        env.CIRCLECI ||
        env.TF_BUILD ||
        env.JENKINS_URL ||
        env.DRONE ||
        env.BITBUCKET_BUILD_NUMBER ||
        env.TEAMCITY_VERSION ||
        env.SEMAPHORE ||
        env.APPVEYOR ||
        env.CODESHIP ||
        env.HEROKU_TEST_RUN_ID ||
        env.WERCKER
    );
}

/**
 * Returns true when running inside a known coding-agent harness.
 * Read EARLY — harnesses may strip these vars from child-process env.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function isAgentHarness(env = process.env) {
    return Boolean(
        env.CLAUDECODE ||
        env.CLAUDE_CODE_ENTRYPOINT
    );
}
