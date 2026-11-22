export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: boolean }>;
  run(): Promise<{ success: boolean; meta?: Record<string, unknown> }>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<T[]>;
}

export interface AssetsFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface WorkersAiBinding {
  run(
    model: string,
    input: {
      messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
      max_tokens?: number;
      temperature?: number;
    }
  ): Promise<{ response?: string } | Record<string, unknown>>;
}

export interface WorkerEnv {
  DB: D1Database;
  ASSETS: AssetsFetcher;
  AI?: WorkersAiBinding;
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  TELEGRAM_BOT_TOKEN?: string;
  CRON_SECRET?: string;
  AUTH_USERNAME?: string;
  AUTH_PASSWORD?: string;
  AUTH_PASSWORD_HASH?: string;
  AUTH_SESSION_SECRET?: string;
}

export interface WorkerScheduledEvent {
  cron: string;
  scheduledTime: number;
}

export interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}
