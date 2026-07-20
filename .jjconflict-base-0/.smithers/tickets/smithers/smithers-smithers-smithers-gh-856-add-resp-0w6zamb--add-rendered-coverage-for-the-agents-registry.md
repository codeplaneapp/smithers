# Add rendered coverage for the Agents registry

GitHub: https://github.com/smithersai/smithers/issues/1154

Parent: smithers/smithers-smithers-gh-856-add-responsive-ac-174ebeo--add-rendered-coverage-for-agents-and-memory.md

Context: The Agents registry is implemented by AgentsCanvas, but current Playwright coverage only verifies that /agents opens. Add real-browser coverage against deterministic real backend data. Acceptance criteria: verify populated and empty registry states; exercise All, Available, and Not detected filtering; select an agent and verify its detail view; open registration and exercise provider selection, authentication-specific fields, label/model/force controls, validation, submit, and cancel; use real backend fixtures and no mocked network responses.
