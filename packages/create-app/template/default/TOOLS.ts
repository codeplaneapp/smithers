import { defineTools } from "@smthrs/create-app/app"
import { ui } from "./tools/ui.ts"

// The root tool layer: the FlowBinding sources every flow below this directory
// reaches as ctx.call("<source>/<flow>", input).
export const Tools = defineTools([ui])
