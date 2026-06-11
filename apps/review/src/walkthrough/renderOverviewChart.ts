import type { ChangedFile } from "./changedFileSchema";
import { escapeHtml } from "./escapeHtml";

const MAX_AREAS = 8;
const BAR_AREA_WIDTH = 460;
const ROW_HEIGHT = 26;
const LABEL_WIDTH = 220;

const groupedRoots = new Set(["apps", "packages", "examples", "src"]);

function areaOf(path: string): string {
  const parts = path.split("/");
  if (parts.length === 1) return "(root)";
  if (parts.length > 2 && groupedRoots.has(parts[0])) return `${parts[0]}/${parts[1]}`;
  return parts[0];
}

/**
 * Deterministic change-shape visual for the walkthrough header: one row per
 * workspace area, additions and deletions as proportional bars. Pure SVG,
 * no agent and no runtime dependency.
 */
export function renderOverviewChart(files: ChangedFile[]): string {
  const byArea = new Map<string, { insertions: number; deletions: number; files: number }>();
  for (const file of files) {
    const area = areaOf(file.path);
    const entry = byArea.get(area) ?? { insertions: 0, deletions: 0, files: 0 };
    entry.insertions += file.insertions;
    entry.deletions += file.deletions;
    entry.files += 1;
    byArea.set(area, entry);
  }
  const rows = [...byArea.entries()]
    .sort((a, b) => b[1].insertions + b[1].deletions - (a[1].insertions + a[1].deletions))
    .slice(0, MAX_AREAS);
  if (rows.length === 0) return "";

  const maxChurn = Math.max(...rows.map(([, entry]) => entry.insertions + entry.deletions), 1);
  const height = rows.length * ROW_HEIGHT + 8;
  const parts: string[] = [
    `<svg class="overview-chart" viewBox="0 0 ${LABEL_WIDTH + BAR_AREA_WIDTH + 90} ${height}" role="img" aria-label="Changed lines by area">`,
  ];
  rows.forEach(([area, entry], index) => {
    const y = index * ROW_HEIGHT + 4;
    const addWidth = Math.max(entry.insertions > 0 ? 2 : 0, Math.round((entry.insertions / maxChurn) * BAR_AREA_WIDTH));
    const delWidth = Math.max(entry.deletions > 0 ? 2 : 0, Math.round((entry.deletions / maxChurn) * BAR_AREA_WIDTH));
    const label = `${area} (${entry.files})`;
    parts.push(
      `<text x="${LABEL_WIDTH - 8}" y="${y + 14}" text-anchor="end" class="chart-label">${escapeHtml(label)}</text>`,
      `<rect x="${LABEL_WIDTH}" y="${y + 3}" width="${addWidth}" height="7" rx="2" class="chart-add"></rect>`,
      `<rect x="${LABEL_WIDTH}" y="${y + 12}" width="${delWidth}" height="7" rx="2" class="chart-del"></rect>`,
      `<text x="${LABEL_WIDTH + Math.max(addWidth, delWidth) + 8}" y="${y + 14}" class="chart-count">+${entry.insertions} −${entry.deletions}</text>`,
    );
  });
  parts.push("</svg>");
  return parts.join("");
}
