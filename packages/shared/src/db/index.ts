import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export * from "./schema.js";

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (!_db) {
    const sqlite = new Database(process.env.DATABASE_PATH ?? "./autocfo.db");
    sqlite.pragma("journal_mode = WAL");
    _db = drizzle(sqlite, { schema });
  }
  return _db;
}
