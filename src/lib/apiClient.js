/**
 * Calls ookaro-api's own HTTP endpoints for the few jobs that need logic living there
 * (scheduled broadcasts, the Razorpay webhook path). Everything else the worker does
 * talks straight to ookaro_db.
 */
export function apiBaseUrl() {
  const base = process.env.API_BASE_URL;
  if (!base) throw new Error("API_BASE_URL is not set");
  return base.replace(/\/+$/, "");
}

export function cronSecret() {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new Error("CRON_SECRET is not set");
  return secret;
}
