# Add keyboard navigation and focus visibility coverage

GitHub: https://github.com/smithersai/smithers/issues/966

Parent: smithers/gh-856-add-responsive-accessibility-and-visual-regression.md

Context: The UI defines focus-visible styles and keyboard behavior for controls such as the composer, navigation buttons, and rail separator, but no browser tests exercise them. Acceptance criteria: Navigate representative shell and monitor controls using Tab and Shift+Tab; assert meaningful focus order and visible focus indicators; verify keyboard activation and rail separator resizing work without pointer input.
