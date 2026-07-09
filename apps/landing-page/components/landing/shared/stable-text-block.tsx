"use client";

import { useStableTextHeight } from "@/lib/landing/text-measure";

type StableTextBlockProps = {
  reserveText: string;
  font: string;
  lineHeight: number;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
};

export function StableTextBlock({
  reserveText,
  font,
  lineHeight,
  className,
  style,
  children,
}: StableTextBlockProps) {
  const { ref, minHeight } = useStableTextHeight(reserveText, font, lineHeight);

  return (
    <div
      ref={ref}
      className={className}
      style={{ ...style, minHeight: minHeight ?? undefined }}
    >
      {children}
    </div>
  );
}
