import { apiBaseUrl, cronSecret } from "../lib/apiClient.js";

/**
 * Creates pending settlements for merchants with "Auto Settlement" switched on, once their
 * settlement cycle is due. The logic lives in ookaro-api (admin/settlements/auto-run), so this
 * job only triggers it. Safe to run often: a merchant is skipped until its cycle is due again.
 * No money moves here - each settlement is marked paid later, with its bank reference.
 */
export async function runAutoSettlementsJob() {
  const res = await fetch(`${apiBaseUrl()}/api/v1/admin/settlements/auto-run`, {
    method: "POST",
    headers: { "X-Cron-Secret": cronSecret() },
  });

  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.status) {
    console.error("[ookaro-worker] autoSettlements failed", res.status, body?.responseMessage);
    return;
  }

  const created = body.data?.created_count ?? 0;
  if (created > 0) console.log(`[ookaro-worker] autoSettlements - created ${created} pending settlement(s)`);
}
