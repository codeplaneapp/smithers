import { siteConfig } from "@/lib/site";
import { createSocialImage } from "@/lib/og/image-template";
import { ImageResponse } from "next/og";

export const alt = siteConfig.tagline;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image() {
  const { element, fonts } = await createSocialImage();

  return new ImageResponse(element, {
    ...size,
    fonts,
  });
}
