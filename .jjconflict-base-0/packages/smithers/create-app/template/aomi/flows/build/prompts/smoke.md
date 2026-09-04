# smoke

Prove the app runs before anyone is asked to approve a deploy.

Do these, in order:

- Start the app and confirm it serves its entry point.
- Exercise the primary path the description named: the first thing a user does.
- Read one real value through the tevm/* flows and confirm it renders.
- Confirm nothing in the console is an error.

Report what you ran and what you saw. A smoke test that was not run is
`pending`, never `done`. If the smoke test fails, the ship stage does not run
and no shipUrl is reported.
