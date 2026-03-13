import { updateSettingsInputSchema } from "@burns/shared"

import {
  completeOnboarding,
  factoryResetAppState,
  getOnboardingStatus,
  getSettings,
  resetSettings,
  updateSettings,
} from "@/services/settings-service"
import { toErrorResponse } from "@/utils/http-error"

export async function handleSettingsRoutes(request: Request, pathname: string) {
  try {
    if (pathname === "/api/settings" && request.method === "GET") {
      return Response.json(getSettings())
    }

    if (pathname === "/api/settings" && request.method === "PUT") {
      const requestBody = await request.json().catch(() => null)
      const input = updateSettingsInputSchema.parse(requestBody)
      return Response.json(updateSettings(input))
    }

    if (pathname === "/api/settings/reset" && request.method === "POST") {
      return Response.json(resetSettings())
    }

    if (pathname === "/api/settings/factory-reset" && request.method === "POST") {
      return Response.json(await factoryResetAppState())
    }

    if (pathname === "/api/onboarding-status" && request.method === "GET") {
      return Response.json(getOnboardingStatus())
    }

    if (pathname === "/api/onboarding-status/complete" && request.method === "POST") {
      return Response.json(completeOnboarding())
    }

    return null
  } catch (error) {
    return toErrorResponse(error)
  }
}
