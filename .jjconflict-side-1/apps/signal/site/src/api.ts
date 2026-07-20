import type { PublicIssue } from "./types";

async function getJson<T>(path: string): Promise<T | null> {
  const response = await fetch(path);
  if (!response.ok) return null;
  return (await response.json()) as T;
}

export function fetchLatestIssue(): Promise<PublicIssue | null> {
  return getJson<PublicIssue>("/api/issue/latest");
}

export function fetchIssueByDate(date: string): Promise<PublicIssue | null> {
  return getJson<PublicIssue>(`/api/issue/${encodeURIComponent(date)}`);
}

export async function fetchArchive(): Promise<string[]> {
  return (await getJson<string[]>("/api/archive")) ?? [];
}
