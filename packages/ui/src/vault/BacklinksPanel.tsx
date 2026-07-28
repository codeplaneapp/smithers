/** @jsxImportSource react */
import type { CSSProperties } from "react";
import { cn } from "../cn";
import { Badge } from "../badge";
import { Eyebrow } from "../section-header";
import { RowButton } from "../row-button";
import { useVaultCss } from "./useVaultCss";
import { noteLabel } from "./wikilinks";

export type BacklinksPanelProps = {
  /** Notes that link to the current note. */
  backlinks: string[];
  /** Notes the current note links out to. */
  linksOut?: string[];
  onOpenNote?: (path: string) => void;
  className?: string;
  style?: CSSProperties;
};

function LinkSection({
  title,
  paths,
  empty,
  onOpenNote,
}: {
  title: string;
  paths: string[];
  empty: string;
  onOpenNote?: (path: string) => void;
}) {
  return (
    <section className="sui-vault-links-section">
      <div className="sui-vault-links-head">
        <Eyebrow>{title}</Eyebrow>
        <Badge variant="secondary">{paths.length}</Badge>
      </div>
      {paths.length === 0 ? (
        <p className="sui-vault-links-empty">{empty}</p>
      ) : (
        paths.map((path) => (
          <RowButton key={path} onClick={() => onOpenNote?.(path)}>
            <span className="sui-vault-link-label">{noteLabel(path)}</span>
            <span className="sui-vault-link-path">{path}</span>
          </RowButton>
        ))
      )}
    </section>
  );
}

/**
 * The Obsidian backlinks footer: who links here, and where this note links
 * out to, as clickable note chips with count badges.
 */
export function BacklinksPanel({ backlinks, linksOut = [], onOpenNote, className, style }: BacklinksPanelProps) {
  useVaultCss();
  return (
    <div data-slot="vault-backlinks" className={cn("sui-vault-links", className)} style={style}>
      <LinkSection title="Backlinks" paths={backlinks} empty="No backlinks yet" onOpenNote={onOpenNote} />
      <LinkSection title="Linked mentions" paths={linksOut} empty="No outgoing links yet" onOpenNote={onOpenNote} />
    </div>
  );
}
