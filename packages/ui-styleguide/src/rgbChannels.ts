/** Parse `#rgb`, `#rrggbb`, or `#rrggbbaa` into 0-255 channels (alpha dropped). */
export function rgbChannels(color: string): [number, number, number] {
  const hex = color.replace("#", "");
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((channel) => channel + channel)
          .join("")
      : hex.slice(0, 6);
  return [0, 2, 4].map((offset) => Number.parseInt(full.slice(offset, offset + 2), 16)) as [
    number,
    number,
    number,
  ];
}
