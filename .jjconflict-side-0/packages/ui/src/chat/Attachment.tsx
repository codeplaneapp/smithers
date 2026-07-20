/** @jsxImportSource react */
import type { ComponentProps } from "react";
import { cn } from "../cn";
import { byteCountString } from "../diff-paginate";
import { useInjectUiCss } from "../styles";

export type AttachmentState = "uploading" | "processing" | "ready" | "error";

export type AttachmentProps = Omit<ComponentProps<"div">, "children"> & {
  name: string;
  state?: AttachmentState;
  sizeBytes?: number;
  mediaType?: string;
  thumbnailUrl?: string;
  progress?: number | null;
  onRemove?: () => void;
};

const stateLabels: Record<Exclude<AttachmentState, "ready">, string> = {
  uploading: "Uploading…",
  processing: "Processing…",
  error: "Failed",
};

function extensionLabel(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return "FILE";
  return name.slice(dot + 1).toUpperCase().slice(0, 4) || "FILE";
}

/** File or image attachment chip with upload and processing state. */
export function Attachment({
  name,
  state = "ready",
  sizeBytes,
  mediaType,
  thumbnailUrl,
  progress,
  onRemove,
  className,
  ...props
}: AttachmentProps) {
  useInjectUiCss();
  const progressLabel = `${state === "processing" ? "Processing" : state === "error" ? "Failed" : state === "ready" ? "Ready" : "Uploading"} ${name}`;
  const numericProgress = typeof progress === "number" ? Math.max(0, Math.min(100, progress)) : undefined;
  const readyMeta = [
    typeof sizeBytes === "number" ? byteCountString(sizeBytes) : undefined,
    mediaType,
  ].filter((value): value is string => Boolean(value));
  const meta = state === "ready" ? readyMeta.join(" · ") : stateLabels[state];

  return (
    <div
      data-slot="attachment"
      data-state={state}
      className={cn("sui-attachment", className)}
      {...props}
    >
      <div data-slot="attachment-thumb" className="sui-attachment-thumb">
        {thumbnailUrl ? (
          <img src={thumbnailUrl} alt="" />
        ) : (
          <span className="sui-attachment-ext" aria-hidden="true">
            {extensionLabel(name)}
          </span>
        )}
      </div>
      <div className="sui-attachment-details">
        <div data-slot="attachment-name" className="sui-attachment-name" title={name}>
          {name}
        </div>
        {meta ? (
          <div data-slot="attachment-meta" className="sui-attachment-meta">
            {meta}
          </div>
        ) : null}
        {progress !== undefined ? (
          <div
            data-slot="attachment-progress"
            className="sui-attachment-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={numericProgress}
            aria-label={progressLabel}
          >
            <span
              className={cn(
                "sui-attachment-progress-bar",
                progress === null && "sui-attachment-progress-indeterminate",
              )}
              style={numericProgress === undefined ? undefined : { width: `${numericProgress}%` }}
            />
          </div>
        ) : null}
      </div>
      {onRemove ? (
        <button
          type="button"
          data-slot="attachment-remove"
          className="sui-attachment-remove"
          aria-label={`Remove ${name}`}
          onClick={onRemove}
        >
          <span aria-hidden="true">×</span>
        </button>
      ) : null}
    </div>
  );
}
