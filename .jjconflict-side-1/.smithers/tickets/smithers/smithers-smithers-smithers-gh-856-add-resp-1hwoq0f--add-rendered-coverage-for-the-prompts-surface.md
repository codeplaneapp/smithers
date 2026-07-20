# Add rendered coverage for the prompts surface

GitHub: https://github.com/smithersai/smithers/issues/1161

Parent: smithers/smithers-smithers-gh-856-add-responsive-ac-174ebeo--add-rendered-coverage-for-scores-crons-and-prompts.md

Context: navigation.spec.ts currently verifies only that /prompts mounts. Add real browser coverage for the prompts editor surface. Acceptance criteria: cover populated and empty prompt lists; selecting a prompt and rendering the editor; switching Source, Imports, Inputs, and Preview tabs; discovering and editing inputs; generating and displaying a preview; entering a dirty source or input state; saving source changes; and exercising the dirty-selection discard/cancel state.
