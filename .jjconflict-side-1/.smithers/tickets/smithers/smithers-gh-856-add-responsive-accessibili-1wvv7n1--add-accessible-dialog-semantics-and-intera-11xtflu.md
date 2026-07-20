# Add accessible dialog semantics and interaction coverage

GitHub: https://github.com/smithersai/smithers/issues/967

Parent: smithers/gh-856-add-responsive-accessibility-and-visual-regression.md

Context: ControlRequestDialog.tsx renders a dialog with role=dialog, aria-modal, and aria-labelledby, but there is no browser-level semantic or interaction test. Acceptance criteria: Trigger the real control-request dialog; assert its accessible role, name, modal state, labelled content, and action names; verify keyboard access to Allow and Deny, backdrop denial, and appropriate focus behavior.
