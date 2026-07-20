# Add live-update browser coverage for monitor state

GitHub: https://github.com/smithersai/smithers/issues/969

Parent: smithers/gh-856-add-responsive-accessibility-and-visual-regression.md

Context: Existing workflow-ui tests prove initial live data and event rendering, but the major monitor surfaces do not have broad live-update assertions. Acceptance criteria: Against the real seeded gateway, verify an out-of-band run, approval, or event update changes the rendered UI without reload; cover reconnect or waiting states where applicable; do not fabricate gateway data with browser mocks.
