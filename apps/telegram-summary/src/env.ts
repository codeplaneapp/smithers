export interface D1Meta {
  changes?: number;
  duration?: number;
  last_row_id?: number;
  rows_read?: number;
  rows_written?: number;
}

export interface D1Result<T = Record<string, unknown>> {
  results?: T[];
  success: boolean;
  meta?: D1Meta;
  error?: string;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  exec(query: string): Promise<D1Result>;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

export interface TelegramSummaryEnv {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_SOURCE_CHAT_ID?: string;
  TELEGRAM_OUTPUT_CHAT_ID?: string;
  TELEGRAM_OUTPUT_THREAD_ID?: string;
  MOONSHOT_API_KEY?: string;
  KIMI_MODEL?: string;
  ADMIN_TOKEN?: string;
  PUBLIC_BASE_URL?: string;
  DIGEST_WINDOW_HOURS?: string;
  DIGEST_TOPIC_HINT?: string;
  INGEST_CRON?: string;
  DIGEST_CRON?: string;
}

export interface ScheduledControllerLike {
  cron: string;
  scheduledTime?: number;
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}
