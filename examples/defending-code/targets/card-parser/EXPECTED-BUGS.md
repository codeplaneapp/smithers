# Expected bugs (ground truth)

This file is for **you**, the human verifying the demo. It is never shown to the
agents. The whole point is that the pipeline rediscovers these by execution.

The card-parser ships with three planted memory-safety bugs, one per parsing
subsystem. All three are reachable from a single input file and detected by
AddressSanitizer.

| # | Subsystem | Class | Trigger | Site |
|---|-----------|-------|---------|------|
| 1 | NAME  | stack-buffer-overflow | `NAME:` value longer than 31 bytes | `parse_name` writes `strcpy` into `char name[32]` |
| 2 | EMAIL | heap-buffer-overflow  | `EMAIL:` value longer than 31 bytes | `parse_email` writes `strcpy` into `malloc(32)` |
| 3 | TAGS  | stack-buffer-overflow | more than 4 tags | `parse_tags` writes unbounded `strcpy` into `char tags[4][24]` |

## Minimal proof-of-concept inputs

```
# bug 1 (stack overflow via NAME)
NAME: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA

# bug 2 (heap overflow via EMAIL)
EMAIL: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@example.com

# bug 3 (stack overflow via too many TAGS)
TAGS: a,b,c,d,e,f,g,h
```

## Crash-class caveats (so you are not surprised)

AddressSanitizer flags writes that cross *object* boundaries, and its `strcpy`
interceptor reports overlap when source and destination ranges collide. Two
consequences worth knowing:

- **Bug 1 (NAME).** Moderate-length values (roughly 32 to 400 bytes) report
  `stack-buffer-overflow`. Very long values (500+ bytes) report
  `strcpy-param-overlap` instead, because `name[32]` and the source pointer both
  live in the same stack frame and the ranges overlap. Same root cause (an
  unbounded `strcpy` into `name[32]`), different ASAN label. Bug 2 (EMAIL) does
  not flip, because its destination is on the heap.
- **Bug 3 (TAGS).** The reliable trigger is more than 4 tags, which writes past
  the whole `tags[4][24]` table. A single over-long tag overflows `tags[0]` into
  `tags[1]`, but that stays *inside* the 96-byte table, so ASAN only fires once a
  tag runs past the entire table, and its class there is length-dependent for the
  same reason as bug 1.

A dedupe stage that clusters by root cause and crash site (not just ASAN class)
collapses these correctly. The canary inputs above stay in the clean ranges.

## A correct fix

Bound every copy: use `strncpy` with the destination size plus an explicit NUL
for NAME and EMAIL (or `malloc(strlen(value) + 1)` for EMAIL), and cap
`tag_count` at `MAX_TAGS` while truncating each tag to `TAG_LEN - 1`. The fix
must still pass `smoke_test.sh` (valid cards keep parsing).
