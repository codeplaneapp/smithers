import type { EmbeddingModel } from "ai";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type { VectorStore } from "@smithers/rag/types";

export type MemoryLayerConfig = {
  db: BunSQLiteDatabase<any>;
  vectorStore?: VectorStore;
  embeddingModel?: EmbeddingModel;
};
