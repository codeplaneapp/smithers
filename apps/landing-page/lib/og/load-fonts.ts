import { readFile } from "node:fs/promises";
import { join } from "node:path";

type OgFont = {
  name: string;
  data: ArrayBuffer;
  weight: 400 | 700;
  style: "normal";
};

const FONT_FILES = {
  newsreader: "newsreader-400.ttf",
  dmSans: "dm-sans-400.ttf",
} as const;

let fontsPromise: Promise<OgFont[]> | null = null;

async function loadFontFile(
  name: string,
  fileName: string,
  weight: 400 | 700,
): Promise<OgFont> {
  const filePath = join(process.cwd(), "assets/og-fonts", fileName);
  const data = await readFile(filePath);

  return {
    name,
    data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    weight,
    style: "normal",
  };
}

export function loadOgFonts() {
  if (!fontsPromise) {
    fontsPromise = Promise.all([
      loadFontFile("Newsreader", FONT_FILES.newsreader, 400),
      loadFontFile("DM Sans", FONT_FILES.dmSans, 400),
    ]);
  }
  return fontsPromise;
}
