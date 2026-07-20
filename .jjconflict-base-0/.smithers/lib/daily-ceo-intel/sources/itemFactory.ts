import { createHash } from "node:crypto";
import type { Item } from "../schemas";

export function makeItemId(sourceId: string, url: string): string {
  return `${sourceId}:${createHash("sha1").update(url).digest("hex").slice(0, 16)}`;
}

export function makeItem(params: {
  sourceId: string;
  sourceKind: Item["sourceKind"];
  url: string;
  title: string;
  body: string;
  author: string | null;
  publishedAt: string | null;
  retrievedAt: string;
}): Item {
  return {
    id: makeItemId(params.sourceId, params.url),
    sourceId: params.sourceId,
    sourceKind: params.sourceKind,
    url: params.url,
    title: params.title.slice(0, 500),
    body: params.body.slice(0, 4000),
    author: params.author,
    publishedAt: params.publishedAt,
    retrievedAt: params.retrievedAt,
    dateUncertain: params.publishedAt === null,
    corroboratingSourceIds: [],
    isUpdate: false,
  };
}
