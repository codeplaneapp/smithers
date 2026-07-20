# Add rendered coverage for the Memory surface

GitHub: https://github.com/smithersai/smithers/issues/1155

Parent: smithers/smithers-smithers-gh-856-add-responsive-ac-174ebeo--add-rendered-coverage-for-agents-and-memory.md

Context: The Memory surface is implemented by MemoryCanvas, but current Playwright coverage only verifies that /memory opens. Add real-browser coverage against deterministic real backend memory data. Acceptance criteria: verify populated Facts mode and the no-facts empty state; switch between Facts and Recall; filter by namespace; open a fact and verify its details and return control; enter a recall query and verify query/search controls; cover both recall results and no-results states; use real backend fixtures and no mocked network responses.
