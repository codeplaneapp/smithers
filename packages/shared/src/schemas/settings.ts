import { z } from "zod"

export const settingsSchema = z.object({
  workspaceRoot: z.string(),
  defaultAgent: z.string(),
  smithersBaseUrl: z.string(),
  allowNetwork: z.boolean().default(false),
  smithersManagedPerWorkspace: z.boolean().default(false),
})

export type Settings = z.infer<typeof settingsSchema>
