# Add mobile and desktop responsive layout coverage

GitHub: https://github.com/smithersai/smithers/issues/965

Parent: smithers/gh-856-add-responsive-accessibility-and-visual-regression.md

Context: The UI has responsive CSS for the chat shell, monitor canvases, files, VCS, and dock, but Playwright currently runs only Desktop Chrome. Acceptance criteria: Test representative surfaces at desktop and phone/tablet viewports; verify the normal and sidebar layouts fit without unintended horizontal overflow; verify stacked mobile panes, controls, dialogs, and major surface content remain usable.
