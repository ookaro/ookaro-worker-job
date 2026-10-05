import { db } from "../lib/db.js";
import { castConfigValue } from "../lib/generalData.js";
import { apiBaseUrl, cronSecret } from "../lib/apiClient.js";
import { fetchGatewayPayments, deliverToWebhook } from "./stuckPayments.js";

/**
 * Auto-cancels online orders still awaiting payment after payment_auto_cancel_hours (default 6).
 *
 * The cancel itself lives in ookaro-api (admin/orders/{id}/auto-cancel), so the stock, slot and
 * coupon release and the admin-visible reason are written in exactly one place. This job finds
 * the candidates and, for each one, asks Razorpay first. A payment that has landed is delivered
 * to the webhook instead and never cancelled, so a late payment is not lost. If Razorpay cannot
 * be reached the order is skipped this run.
 */

const DEFAULT_HOURS = 6;
const BATCH_SIZE = 50;

async function getHours() {
  const [rows] = await db().query(
    `SELECT setting_value, value_type FROM config_settings
     WHERE scope_type = 'global' AND setting_key = 'payment_auto_cancel_hours' LIMIT 1`
  );
  if (!rows.length) return DEFAULT_HOURS;
  return castConfigValue(rows[0].setting_value, rows[0].value_type) ?? DEFAULT_HOURS;
}

async function getCandidates(hours) {
  const [rows] = await db().query(
    `SELECT o.id, o.order_number, p.gateway_order_id
     FROM orders o
     JOIN workflow_stages ws ON ws.id = o.current_stage_id AND ws.code = 'awaiting_payment'
     JOIN payments p ON p.order_id = o.id
     WHERE o.payment_mode = 'online'
       AND p.gateway_order_id IS NOT NULL
       AND p.payment_status <> 'captured'
       AND o.created_at <= DATE_SUB(NOW(), INTERVAL ? HOUR)
     ORDER BY o.created_at ASC
     LIMIT ${BATCH_SIZE}`,
    [hours]
  );
  return rows;
}

/** Returns "paid" when Razorpay holds a captured payment (delivered to the webhook instead),
 *  "unpaid" when it is safe to cancel. Throws if Razorpay cannot be reached. */
async function checkGateway(gatewayOrderId) {
  const items = await fetchGatewayPayments(gatewayOrderId);
  const captured = items.find((p) => p.status === "captured");
  if (captured) {
    await deliverToWebhook(captured);
    return "paid";
  }
  return "unpaid";
}

async function cancelViaApi(orderId) {
  const res = await fetch(`${apiBaseUrl()}/api/v1/admin/orders/${orderId}/auto-cancel`, {
    method: "POST",
    headers: { "X-Cron-Secret": cronSecret() },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.status) throw new Error(`auto-cancel responded ${res.status}: ${body?.responseMessage ?? "no body"}`);
  return body.data?.skipped === false ? "cancelled" : "skipped";
}

export async function runPaymentAutoCancelJob() {
  const startedAt = new Date();
  const hours = await getHours();
  const candidates = await getCandidates(hours);
  const counts = { cancelled: 0, paid: 0, skipped: 0, failed: 0 };

  for (const order of candidates) {
    try {
      const gateway = await checkGateway(order.gateway_order_id);
      if (gateway === "paid") {
        counts.paid++;
        continue;
      }
      counts[await cancelViaApi(order.id)]++;
    } catch (err) {
      counts.failed++;
      console.error(`[paymentAutoCancel] could not process ${order.order_number}`, err.message);
    }
  }

  if (candidates.length > 0) {
    console.log(
      `[paymentAutoCancel] run finished in ${Date.now() - startedAt.getTime()}ms - ${candidates.length} stale (after ${hours}h), ` +
      `${counts.cancelled} cancelled, ${counts.paid} found paid at Razorpay, ${counts.skipped} skipped, ${counts.failed} failed`
    );
  }
}
