# Documentation Index

## Product and architecture

- [Repository Guide](./repository-guide.md)
- [Product Spec (target state)](./burns-spec.md)
- [Codebase Layout](./codebase-layout.md)
- [Daemon API Reference](./daemon-api-reference.md)
- [Workspace + Runtime Handoff (Next Agent)](./next-agent-workspace-gaps.md)
- [ADR-0001: Desktop Daemon Bootstrap Mode](./decisions/ADR-0001-daemon-bootstrap-mode.md)
- [ADR-0002: Runtime API URL Contract](./decisions/ADR-0002-runtime-api-url-contract.md)

## ElectroBun + CLI rollout

- [ElectroBun Release Plan](./electrobun-release-plan.md)
- [Release Automation Reference](./release-automation.md)
- [Release Runbook (Canary + Stable)](./release-runbook.md)
- [Release Checklist](./release-checklist.md)

## Release notes and changelog

- Use `scripts/release/create-release-notes.sh` to generate a release notes draft for canary/stable.
- Use `scripts/release/verify-artifact-integrity.sh` to produce checksum manifests for collected artifacts.
- Use `bun run smoke:release` to run desktop + CLI runtime smoke checks locally.
- Promote release notes highlights into the root `CHANGELOG.md` before stable publication.
