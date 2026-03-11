import { pickDirectoryWithNativeDialog } from "@/services/native-folder-picker-service"
import { HttpError, toErrorResponse } from "@/utils/http-error"

type HandleSystemRoutesOptions = {
  pickDirectory?: () => string | null
}

function isLoopbackHost(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
}

export function handleSystemRoutes(
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

    return null
  } catch (error) {
    return toErrorResponse(error)
  }
}
