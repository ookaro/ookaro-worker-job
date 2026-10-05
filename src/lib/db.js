import mysql from "mysql2/promise";

/**
 * A plain module-level singleton - unlike ookaro-api's own db.js, there's no Next.js
 * dev-mode hot-reload churning through module re-evaluation here, so the globalThis
 * caching trick that file needs doesn't apply; this process starts once and runs.
 */
let pool;

export function db() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
      port: Number(process.env.DB_PORT || 3306),
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0,
    });
  }
  return pool;
}
