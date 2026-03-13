# Changelog

All notable changes to this project will be documented in this file.

The format follows Keep a Changelog and this project currently tracks SemVer-style release tags.

## [Unreleased]

### Added

- Added runtime smoke scripts for release gating:
  - `scripts/smoke/desktop-runtime-smoke.ts`
  - `scripts/smoke/cli-runtime-smoke.ts`
- Added `scripts/release/build-cli-artifact.sh` to build CLI release archives into `dist/cli`.
- Added `scripts/release/verify-artifact-integrity.sh` to validate non-empty artifacts, reject placeholders, and generate `SHA256SUMS.txt`.
- Added persisted Burns settings with onboarding status tracking, advanced Smithers auth/rootDir/logging controls, and a non-destructive reset endpoint.
- Added a first-run onboarding wizard that redirects new users into app setup before the first workspace flow.
- Added a `Factory Reset` settings action that forgets all Burns state and returns the app to onboarding without deleting repo folders.

### Changed

- Hardened canary/stable workflows with runtime smoke checks, strict artifact collection, and artifact integrity verification.
- Updated release docs and README entries for new smoke and release artifact commands.
- Added local workspace `Open Folder` and `Copy Path` actions, and changed workflow path copying to return the raw folder path instead of a `cd` command.
- Replaced the read-only settings page with editable forms that save daemon defaults and preserve existing workspaces during reset.
- Removed automatic default-workspace seeding so first-run users land in onboarding instead of a precreated workspace.
- Moved repo-local workflow and Smithers state storage from `.burns`/legacy `.mr-burns` into `.smithers`, with one-time migration of legacy workspace directories and top-level `smithers.db*` files.
- Changed default workspace creation root to `~/Documents/Burns`, while Burns app state now defaults to `~/.burns` for direct daemon/web runs and platform app-data locations in desktop mode.
