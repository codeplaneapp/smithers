import { createAppIcon } from "@/lib/og/image-template";
import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(createAppIcon(180, 28), size);
}
