# Filesystem routing contract

## Boundary order

One scan snapshots its configuration, resolves the root to an absolute path,
and uses that value for the entire asynchronous operation. Discovery stays
metadata-only. Route construction then validates and freezes every field,
including schema locators, effect declarations, capabilities, placement, and
companion paths.

An invocation follows this order:

1. Resolve one canonical slash-joined route name.
2. Load only that module through an escaped absolute file URL.
3. Project its loaded Effect input schema into CLI descriptors.
4. Decode and detach the input through the authoritative Effect schema.
5. Invoke through `FlowInvoker`.
6. Encode and detach the output through the authoritative Effect schema.

Missing schema services, parse failures, validation failures, and defects are
all converted to sanitized `FsError` values. Raw arguments, input values,
output values, and implementation causes are never retained in those errors.

## Identity and paths

`Route.name` must equal `Route.segments.join("/")`. Direct calls require an
exact match; parsing uses the longest command prefix and leaves the remainder
for arguments. A listed slash name is normalized to those same segments in
both the direct command and Incur CLI surfaces.

Filesystem segmentation uses the active `Path.sep`. A literal backslash on
POSIX remains part of one segment and cannot collide with a nested directory.
Absolute filesystem paths are converted with the registry's file-specifier
encoder, so spaces, Unicode, percent signs, hashes, and query characters name
the intended file rather than URL structure.

## Snapshot semantics

Routes, trie nodes, maps, scan results, warnings, command inputs, decoded
values, and encoded values are detached from caller-owned containers and
frozen before they cross an asynchronous boundary. Accessors, proxies that
throw, exotic prototypes, sparse arrays, cycles, repeated references,
non-finite numbers, malformed Unicode, symbol keys, and prototype-control
keys are refused without executing user code.

## Resource limits

| Boundary                 |                   Limit |
| ------------------------ | ----------------------: |
| Routes per tree or scan  |                     256 |
| Route depth              |             64 segments |
| Total trie segments      |                    4096 |
| Route segment            |   255 UTF-16 code units |
| Route name               |  4096 UTF-16 code units |
| Source or companion path | 16384 UTF-16 code units |
| Capabilities per route   |                     256 |
| Command text             |       65536 UTF-8 bytes |
| Command tokens           |                    4096 |
| Command token            | 16384 UTF-16 code units |
| Invocation JSON          |   1048576 encoded bytes |
| Invocation JSON depth    |                      64 |
| Invocation JSON members  |                    4096 |
| Invocation JSON nodes    |                    8192 |
| Invocation JSON string   |     65536 encoded bytes |
| Invocation JSON key      |      1024 encoded bytes |

Exact limits succeed. One-over inputs fail with `resource_limit` or
`invalid_route`, depending on whether the bound belongs to the container or
to one route declaration.

## Error codes

| Code                     | Meaning                                                          |
| ------------------------ | ---------------------------------------------------------------- |
| `root_missing`           | The scan root does not exist.                                    |
| `invalid_root`           | The root or scan configuration is invalid.                       |
| `read_failed`            | Discovery or companion inspection could not read the filesystem. |
| `discovery_failed`       | Registry discovery failed without a more specific category.      |
| `parse_failed`           | Command token or option grammar was invalid.                     |
| `unknown_command`        | No visible route, or no exact route, matched.                    |
| `duplicate_route`        | Two source paths produced one command identity.                  |
| `invalid_route`          | Route metadata violated its immutable contract.                  |
| `resource_limit`         | A bounded command, scan, trie, or value exceeded its limit.      |
| `load_failed`            | The selected module could not load or did not export a flow.     |
| `unsupported_body`       | A non-module route was sent to the loader.                       |
| `unsupported_schema`     | A schema locator cannot describe command input.                  |
| `decode_failed`          | Input failed descriptor or Effect schema decoding.               |
| `encode_failed`          | Output failed Effect schema encoding.                            |
| `invocation_unavailable` | No execution seam is installed.                                  |
