# Key RunInspector render caching by width, height, and theme

GitHub: https://github.com/smithersai/smithers/issues/843

Update RunInspector so cached output is invalidated or bypassed when height changes or when a different theme is supplied. Add regression tests proving vertical-only resize recalculates the body layout and theme changes produce freshly themed output.
