// bun 1.3.13's dual CJS/ESM loader can reject with "Requested module is
// already fetched" when react-remove-scroll's CJS require("react") races a
// concurrent test file's in-flight ESM import of react (the radix chain is
// pulled lazily by UI-importing tests such as monitor-shell-controls). The
// rejection is unhandled and kills the whole `bun test` process "between
// tests" on CI's Linux shards and coverage job. Loading the chain exactly
// once, before any test file, removes the race. bun reads bunfig.toml only
// from the package cwd, so this must be a package-local preload.
import "react";
import "smithers-orchestrator/ui";
// gateway-ui pulls react-dom and scheduler, whose CJS bundle has the same
// lazy require("react")/require("scheduler") race.
import "smithers-orchestrator/gateway-ui";
