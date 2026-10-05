import { apiBaseUrl, cronSecret } from "../lib/apiClient.js";

/**
 * Fires every scheduled notification broadcast that has come due. The send logic (audience
 * resolution, fan-out, push) lives in ookaro-api and already handles everything - this job
 * only triggers it on a schedule, so the external crontab entry that used to do this is no
 * longer needed. Safe to run as often as you like: the endpoint only picks up drafts whose
 * scheduled time has passed, and a send that has already happened is never sent twice.
 */
export async function runScheduledBroadcastsJob() {
  const res = await fetch(`${apiBaseUrl()}/api/v1/admin/notifications/broadcasts/dispatch-due`, {
    method: "POST",
    headers: { "X-Cron-Secret": cronSecret() },
  });

  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.status) {
    console.error("[ookaro-worker] scheduledBroadcasts failed", res.status, body?.responseMessage);
    return;
  }

  const sent = body.data?.sent ?? body.data?.dispatched ?? 0;
  if (sent > 0) console.log(`[ookaro-worker] scheduledBroadcasts - sent ${sent} due broadcast(s)`);
}
