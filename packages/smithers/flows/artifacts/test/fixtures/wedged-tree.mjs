// Starts a grandchild that inherits this process group, records its pid, then
// wedges. A deadline that signals only the direct child leaves the grandchild
// running; both self-exit after two minutes so a failing run leaves no orphan.
import { spawn } from "node:child_process"
import { writeFileSync } from "node:fs"

const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120_000)"], { stdio: "ignore" })
writeFileSync(process.argv[2], String(grandchild.pid))
setTimeout(() => {}, 120_000)
