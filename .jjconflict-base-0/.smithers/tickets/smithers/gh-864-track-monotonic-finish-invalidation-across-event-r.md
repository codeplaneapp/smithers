# Track monotonic finish invalidation across event-ring eviction

GitHub: https://github.com/smithersai/smithers/issues/864

Replace the windowed countFinishes(inputsNow.events) marker with accumulated per-node finish state or another monotonic marker that cannot decrease when the 1000-event ring evicts frames. Add a regression test covering more than 1000 events and a new finish that must refetch and display newly produced output.
