import { createAppIcon } from "@/lib/og/image-template";
import { ImageResponse } from "next/og";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(createAppIcon(32, 6), size);
}
