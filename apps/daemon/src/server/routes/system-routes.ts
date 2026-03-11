import { pickDirectoryWithNativeDialog } from "@/services/native-folder-picker-service"
import { validateSmithersBaseUrl } from "@/services/smithers-validation-service"
import { HttpError, toErrorResponse } from "@/utils/http-error"

type HandleSystemRoutesOptions = {
  pickDirectory?: () => string | null
  validateSmithersUrl?: (baseUrl: string) => Promise<{
    ok: boolean
    status: number | null
    message: string
  }>
}

function isLoopbackHost(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
}

export async function handleSystemRoutes(
  request: Request,
  pathname: string,
  options: HandleSystemRoutesOptions = {}
) {
  try {
    if (pathname === "/api/system/folder-picker" && request.method === "POST") {
      const requestUrl = new URL(request.url)
      if (!isLoopbackHost(requestUrl.hostname)) {
        throw new HttpError(403, "Native folder picker is only available on localhost daemon URLs")
      }

      const pickDirectory = options.pickDirectory ?? pickDirectoryWithNativeDialog
      return Response.json({ path: pickDirectory() })
    }

    if (pathname === "/api/system/validate-smithers-url" && request.method === "POST") {
      const requestBody = (await request.json().catch(() => null)) as { baseUrl?: unknown } | null
      const baseUrl = typeof requestBody?.baseUrl === "string" ? requestBody.baseUrl : ""
      const validateUrl = options.validateSmithersUrl ?? validateSmithersBaseUrl
      const validation = await validateUrl(baseUrl)
      return Response.json(validation)
    }

    return null
  } catch (error) {
    return toErrorResponse(error)
  }
}
