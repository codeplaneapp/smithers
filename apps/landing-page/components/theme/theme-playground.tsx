"use client";

import { useTheme } from "@/components/theme/theme-provider";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  FONT_OPTIONS,
  PALETTE_OPTIONS,
  RADIUS_OPTIONS,
} from "@/lib/theme/config";
import type { ThemeFont, ThemePalette, ThemeRadius } from "@/lib/theme/types";
import { Palette } from "lucide-react";

function ThemeToggleRow<T extends string>({
  label,
  value,
  options,
  onValueChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onValueChange: (value: T) => void;
}) {
  return (
    <div className="space-y-2">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={value}
        onValueChange={(next) => {
          if (next) onValueChange(next as T);
        }}
        className="flex w-full"
      >
        {options.map((option) => (
          <ToggleGroupItem
            key={option.value}
            value={option.value}
            className="min-w-0 flex-1 px-2 text-xs"
            aria-label={option.label}
          >
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

export function ThemePlayground() {
  const { theme, setPalette, setFont, setRadius, resetTheme } = useTheme();

  return (
    <div className="theme-playground fixed bottom-4 right-4 z-60 pb-[env(safe-area-inset-bottom)] pr-[env(safe-area-inset-right)]">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-2 border-primary/30 bg-card/95 shadow-lg shadow-black/30 backdrop-blur-sm"
          >
            <Palette className="size-3.5" aria-hidden />
            Theme
          </Button>
        </PopoverTrigger>

        <PopoverContent
          align="end"
          side="top"
          sideOffset={10}
          className="w-[min(calc(100vw-2rem),18rem)] border-border bg-popover/95 p-4 backdrop-blur-sm"
        >
          <PopoverHeader className="gap-0.5">
            <PopoverTitle className="font-display text-base">Theme lab</PopoverTitle>
            <PopoverDescription className="text-xs">
              Preview palettes, type, and radius. Saved in this browser.
            </PopoverDescription>
          </PopoverHeader>

          <Separator className="my-4" />

          <div className="space-y-4">
            <ThemeToggleRow<ThemePalette>
              label="Color"
              value={theme.palette}
              options={PALETTE_OPTIONS}
              onValueChange={setPalette}
            />

            <ThemeToggleRow<ThemeFont>
              label="Font"
              value={theme.font}
              options={FONT_OPTIONS}
              onValueChange={setFont}
            />

            <ThemeToggleRow<ThemeRadius>
              label="Radius"
              value={theme.radius}
              options={RADIUS_OPTIONS}
              onValueChange={setRadius}
            />
          </div>

          <Separator className="my-4" />

          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 w-full text-xs text-muted-foreground"
            onClick={resetTheme}
          >
            Reset to defaults
          </Button>
        </PopoverContent>
      </Popover>
    </div>
  );
}
