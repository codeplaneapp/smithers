# Harden API-key search providers against cross-origin redirects

GitHub: https://github.com/smithersai/smithers/issues/916

Update the Brave and Serper web-search providers in packages/agents/src/web-search/createBraveSearchProvider.js and packages/agents/src/web-search/createSerperSearchProvider.js so x-subscription-token and x-api-key are not forwarded to unauthorized redirect origins. Add cross-origin, same-origin, and multi-hop redirect tests for the affected providers.
