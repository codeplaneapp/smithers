# Eliminate duplicate generic and dedicated run-event delivery

GitHub: https://github.com/smithersai/smithers/issues/897

Define one delivery path for run events when a connection has a streamRunEvents subscription, remove the generic-plus-dedicated duplicate, and test that each logical run event is delivered exactly once while preserving filtering and replay semantics.
