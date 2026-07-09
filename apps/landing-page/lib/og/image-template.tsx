import { brandWordmark, ogBrand, smithersMarkPath } from "@/lib/brand";
import { loadOgFonts } from "@/lib/og/load-fonts";
import { siteConfig } from "@/lib/site";

const OG_WIDTH = 1200;
const OG_HEIGHT = 630;

export function SmithersMark({
  size,
  color = ogBrand.gold,
}: {
  size: number;
  color?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path fill={color} d={smithersMarkPath} />
    </svg>
  );
}

export async function createSocialImage() {
  const fonts = await loadOgFonts();

  return {
    fonts,
    element: (
      <div
        style={{
          width: OG_WIDTH,
          height: OG_HEIGHT,
          position: "relative",
          display: "flex",
          background: `radial-gradient(ellipse 90% 80% at 50% 45%, ${ogBrand.surface} 0%, ${ogBrand.canvas} 75%)`,
          color: ogBrand.ink,
        }}
      >
        <div
          style={{
            position: "absolute",
            left: OG_WIDTH / 2,
            top: OG_HEIGHT / 2,
            transform: "translate(-50%, -50%)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 36,
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 22,
            }}
          >
            <div style={{ display: "flex", width: 108, height: 108 }}>
              <SmithersMark size={108} />
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                fontFamily: "Newsreader",
                fontSize: 90,
                letterSpacing: "-0.04em",
                lineHeight: 1,
                marginTop: 4,
              }}
            >
              {brandWordmark}
            </div>
          </div>

          <div
            style={{
              display: "flex",
              justifyContent: "center",
              fontFamily: "DM Sans",
              fontSize: 30,
              lineHeight: 1.4,
              letterSpacing: "-0.01em",
              color: ogBrand.inkMuted,
              textAlign: "center",
            }}
          >
            {siteConfig.tagline}
          </div>
        </div>
      </div>
    ),
  };
}

export function createAppIcon(size: number, padding: number) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: ogBrand.canvas,
        border: `1px solid ${ogBrand.line}`,
      }}
    >
      <SmithersMark size={size - padding * 2} />
    </div>
  );
}
