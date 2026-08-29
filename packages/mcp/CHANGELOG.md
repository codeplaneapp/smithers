# Changelog

## [Unreleased]

### Added

- Added `@smthrs/mcp`: a stdio MCP client (`McpClient`) and a `FlowBinding.Source` projector (`McpFlows`) that turns a connected server's tool catalog into one flow per tool, so an MCP tool call is an ordinary flow call — no second registration path alongside `@smthrs/std`'s filesystem and shell flows.
