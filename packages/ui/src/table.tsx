/** @jsxImportSource react */
import type { ComponentProps } from "react";
import { cn } from "./cn";
import { useInjectUiCss } from "./styles";

/**
 * Table family styled to the styleguide `.table` vocabulary (uppercase 11px
 * headers, hairline row borders). The root wraps the `<table>` in an
 * `overflow-x:auto` container so wide tables scroll instead of breaking layout.
 */
export function Table({ className, ...props }: ComponentProps<"table">) {
  useInjectUiCss();
  return (
    <div data-slot="table-container" className="sui-table-container">
      <table data-slot="table" className={cn("sui-table", className)} {...props} />
    </div>
  );
}

export function TableHeader({ className, ...props }: ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={className} {...props} />;
}

export function TableBody({ className, ...props }: ComponentProps<"tbody">) {
  return <tbody data-slot="table-body" className={className} {...props} />;
}

export function TableRow({ className, ...props }: ComponentProps<"tr">) {
  return <tr data-slot="table-row" className={className} {...props} />;
}

export function TableHead({ className, ...props }: ComponentProps<"th">) {
  return <th data-slot="table-head" className={className} {...props} />;
}

export function TableCell({ className, ...props }: ComponentProps<"td">) {
  return <td data-slot="table-cell" className={className} {...props} />;
}

export function TableCaption({ className, ...props }: ComponentProps<"caption">) {
  return <caption data-slot="table-caption" className={className} {...props} />;
}
