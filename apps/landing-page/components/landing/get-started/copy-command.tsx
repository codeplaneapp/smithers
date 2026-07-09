"use client";

import { GET_STARTED } from "@/lib/landing/content";
import { INIT_COMMAND } from "@/lib/landing/constants";
import { Check, Copy } from "lucide-react";
import { useState } from "react";

export function CopyCommand() {
  const [copied, setCopied] = useState(false);

  async function copyCommand() {
    await navigator.clipboard.writeText(INIT_COMMAND);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="text-center">
      <p className="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
        {GET_STARTED.commandLabel}
      </p>

      <div className="mt-3 flex flex-col items-stretch gap-3 sm:mt-4 sm:flex-row sm:items-center sm:justify-center">
        <code className="block w-full overflow-x-auto rounded-lg border border-border bg-background px-4 py-3 text-left font-mono text-xs text-foreground sm:inline-block sm:w-auto sm:px-5 sm:py-3.5 sm:text-sm">
          {INIT_COMMAND}
        </code>
        <button
          type="button"
          onClick={copyCommand}
          className={`inline-flex w-full shrink-0 items-center justify-center gap-2 rounded-md px-5 py-3 text-sm font-medium transition-colors sm:w-auto ${
            copied
              ? "border border-primary/30 bg-accent text-primary landing-persist"
              : "bg-primary text-primary-foreground hover:opacity-90"
          }`}
        >
          {copied ? (
            <>
              <Check className="size-4" aria-hidden />
              Copied
            </>
          ) : (
            <>
              <Copy className="size-4" aria-hidden />
              Copy command
            </>
          )}
        </button>
      </div>

      <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-muted-foreground">
        {GET_STARTED.commandPayoff}
      </p>

      <div className="mx-auto mt-6 max-w-lg rounded-lg border border-dashed border-primary/25 bg-accent/10 px-4 py-3">
        <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          Then tell your agent
        </p>
        <p className="mt-1 font-mono text-sm text-foreground">
          &ldquo;{GET_STARTED.firstPrompt}&rdquo;
        </p>
        <p className="mt-2 text-xs text-muted-foreground">{GET_STARTED.firstPromptHint}</p>
      </div>
    </div>
  );
}
