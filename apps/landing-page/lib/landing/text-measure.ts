"use client";

import {
  LANDING_FONTS,
  STEP_DETAIL_CANDIDATES,
} from "@/lib/landing/demo-reserve-text";
import { layout, prepare, prepareWithSegments, measureNaturalWidth } from "@chenglou/pretext";
import { useEffect, useRef, useState } from "react";

export function measureTextHeight(
  text: string,
  font: string,
  maxWidth: number,
  lineHeight: number,
): number {
  if (!text.trim()) {
    return lineHeight;
  }

  const prepared = prepare(text, font, { whiteSpace: "pre-wrap" });
  const { height, lineCount } = layout(prepared, maxWidth, lineHeight);
  return Math.max(height, lineCount > 0 ? lineHeight : lineHeight);
}

export function measureMaxDetailWidth(font: string = LANDING_FONTS.monoXs): number {
  return Math.max(
    ...STEP_DETAIL_CANDIDATES.map((detail) =>
      measureNaturalWidth(prepareWithSegments(detail, font)),
    ),
  );
}

export function useStableTextHeight(
  reserveText: string,
  font: string,
  lineHeight: number,
) {
  const ref = useRef<HTMLDivElement>(null);
  const [minHeight, setMinHeight] = useState<number | undefined>(undefined);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const update = () => {
      const width = element.clientWidth;
      if (width <= 0) return;
      setMinHeight(measureTextHeight(reserveText, font, width, lineHeight));
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [reserveText, font, lineHeight]);

  return { ref, minHeight };
}

export function useStepDetailMinWidth() {
  const [minWidth, setMinWidth] = useState(120);

  useEffect(() => {
    // Canvas text measurement is client-only; run once after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- pretext needs DOM canvas
    setMinWidth(Math.ceil(measureMaxDetailWidth()));
  }, []);

  return minWidth;
}

export function useStableTextHeights(
  reserveTexts: string[],
  font: string,
  lineHeight: number,
) {
  const ref = useRef<HTMLDivElement>(null);
  const [minHeight, setMinHeight] = useState<number | undefined>(undefined);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const update = () => {
      const width = element.clientWidth;
      if (width <= 0) return;
      const heights = reserveTexts.map((text) =>
        measureTextHeight(text, font, width, lineHeight),
      );
      setMinHeight(Math.max(...heights));
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [reserveTexts, font, lineHeight]);

  return { ref, minHeight };
}
