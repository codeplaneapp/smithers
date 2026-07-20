# Add reduced-motion coverage

GitHub: https://github.com/smithersai/smithers/issues/968

Parent: smithers/gh-856-add-responsive-accessibility-and-visual-regression.md

Context: The UI includes prefers-reduced-motion rules in styles.css and control.css, but no test verifies the reduced-motion behavior. Acceptance criteria: Emulate reduced motion in a real browser; assert monitored elements and control overlays disable or clamp animations and transitions; retain a normal-motion check so the regular visual state remains covered.
