# Security Policy

## Supported versions

Security fixes are released for the latest published Smithers version. Because
Smithers is pre-1.0 and changes quickly, older versions are not routinely
backported. Upgrade to the newest release before reporting an issue that may
already be fixed.

## Report a vulnerability privately

Use [GitHub's private vulnerability reporting
form](https://github.com/smithersai/smithers/security/advisories/new). Do not
open a public issue for a suspected vulnerability.

Repository administrators must keep GitHub Private Vulnerability Reporting
enabled for that form to work. If the form is unavailable, open a public issue
that asks for a private security contact but contains no vulnerability details,
proof of concept, affected paths, or secrets.

Include, when available:

- the affected package and version;
- the deployment shape and required configuration;
- a minimal reproduction or proof of concept;
- the security impact and affected trust boundary; and
- any suggested mitigation.

Do not include production credentials, personal data, or customer data. Use
synthetic test data and revoke any secret that may have been exposed during
research.

Maintainers aim to acknowledge a complete report within three business days,
share an initial assessment within seven business days, and coordinate a fix
and disclosure timeline with the reporter. These are response targets, not a
service-level agreement.

## Scope

In scope are the maintained packages and applications shipped from this
repository, including the CLI, Gateway, workflow runtime, sandbox boundary,
official integrations, GitHub Action, and hosted worker source.

Proof-of-concept applications identified as POCs in `AGENTS.md`, third-party
agent CLIs, model-provider services, and deployments operated by other parties
are outside the maintained security boundary. Vulnerabilities in a Smithers
adapter or in how Smithers invokes a third-party component remain in scope.

## Coordinated disclosure and safe harbor

Please give maintainers a reasonable opportunity to investigate and release a
fix before public disclosure. Good-faith research that avoids privacy
violations, data destruction, service disruption, social engineering, and
persistence is welcome. Maintainers will not pursue legal action for research
that follows this policy.

Dependency advisories without an upstream fix are documented in
`.github/production-advisory-exceptions.json`. Every exception has a mitigation
and expiry date; CI rejects new, stale, expired, or newly fixable exceptions.

For the operating assumptions behind these boundaries, see the [threat
model](https://smithers.sh/security/threat-model).
