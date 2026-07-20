# Make local UI file saves atomic and mode-preserving

GitHub: https://github.com/smithersai/smithers/issues/910

Write edited content to a temporary file in the target directory, preserve the target's relevant mode bits, then atomically rename the temporary file over the target and clean up on failure. Add a simulated write-failure test proving the original file remains intact.
