import { smithersMarkPath } from "@/lib/brand";

type SmithersMarkProps = {
  className?: string;
  size?: number;
};

export function SmithersMark({ className, size = 48 }: SmithersMarkProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 48 48"
      fill="none"
      width={size}
      height={size}
      className={["shrink-0 text-primary", className].filter(Boolean).join(" ")}
      role="img"
      aria-label="Smithers"
    >
      <path fill="currentColor" d={smithersMarkPath} />
    </svg>
  );
}
