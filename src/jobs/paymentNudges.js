import { db } from "../lib/db.js";
import { sqlDateTime, castConfigValue, renderTemplate } from "../lib/generalData.js";
import { notifyUser } from "../lib/notify.js";
import { fetchGatewayPayments, deliverToWebhook } from "./stuckPayments.js";

/**
 * Payment-pending nudges. A customer starts an online order, the payment gateway opens,
 * and they close it without paying. The order then sits at awaiting_payment. This sends
 * one reminder after a delay, and a second after a longer delay, and then stops.
 *
 * Signal: the order's own stage. An online order is created at awaiting_payment, and only
 * a confirmed payment moves it on, so "still awaiting_payment and past the delay" means the
 * customer has not paid. The gateway itself is not reported when it opens or closes, so we
 * never rely on that.
 *
 * Before every reminder the job re-checks, because a customer can pay after the order was
 * queried:
 *   1. Razorpay itself: if a payment is captured for this order, it is delivered to the
 *      webhook (the same path stuckPayments uses) and no reminder is sent.
 *   2. The order's current stage is re-read from the DB, so a payment confirmed in the
 *      meantime stops the reminder.
 *   3. Only the customer's most recent order is ever nudged. A newer order, paid or
 *      not, means they have moved on.
 *
 * A failed gateway attempt is deliberately not treated as paid or stopped here. The
 * existing stuckPayments job already settles failed attempts, and this job only reminds.
 *
 * Each reminder claims the order's counter atomically, so two runs never send the same one.
 */

const MAX_NUDGES = 2;
const BATCH_SIZE = 50;
// Older than this is not a live checkout any more. Matches stuckPayments' own 24 h window, so
// a stale historical order that was never paid is never suddenly nudged out of nowhere.
const MAX_AGE_HOURS = 24;

async function getConfigInt(key, fallback) {
  const [rows] = await db().query(
    `SELECT setting_value, value_type FROM config_settings
     WHERE scope_type = 'global' AND setting_key = ? LIMIT 1`,
    [key]
  );
  if (!rows.length) return fallback;
  return castConfigValue(rows[0].setting_value, rows[0].value_type) ?? fallback;
}

async function getEventTemplate(eventCode) {
  const [rows] = await db().query(
    `SELECT ne.id AS notification_event_id, nt.title_template, nt.body_template, nt.action_type
     FROM notification_events ne
     LEFT JOIN notification_templates nt ON nt.notification_event_id = ne.id AND nt.channel = 'push' AND nt.language_code = 'en' AND nt.is_active = 1
     WHERE ne.code = ? AND ne.is_active = 1 LIMIT 1`,
    [eventCode]
  );
  return rows.length ? rows[0] : null;
}

/** Orders still awaiting payment that are due for their next reminder. The user's latest
 *  order is the only one considered, so an older unpaid order never gets nudged after a
 *  newer order exists. */
async function getCandidates(firstMinutes, secondHours) {
  const [rows] = await db().query(
    `SELECT o.id, o.order_number, o.user_id, o.payment_nudge_count, o.payment_nudge_last_at,
            p.gateway_order_id
     FROM orders o
     JOIN workflow_stages ws ON ws.id = o.current_stage_id AND ws.code = 'awaiting_payment'
     JOIN payments p ON p.order_id = o.id
     WHERE o.payment_mode = 'online'
       AND o.user_id IS NOT NULL
       AND p.gateway_order_id IS NOT NULL
       AND p.payment_status <> 'captured'
       AND o.payment_nudge_count < ?
       AND o.created_at > DATE_SUB(NOW(), INTERVAL ${MAX_AGE_HOURS} HOUR)
       AND o.id = (SELECT MAX(o2.id) FROM orders o2 WHERE o2.user_id = o.user_id)
       AND (
         (o.payment_nudge_count = 0 AND o.created_at <= DATE_SUB(NOW(), INTERVAL ? MINUTE))
         OR (o.payment_nudge_count = 1 AND o.payment_nudge_last_at <= DATE_SUB(NOW(), INTERVAL ? HOUR))
       )
     ORDER BY o.created_at ASC
     LIMIT ${BATCH_SIZE}`,
    [MAX_NUDGES, firstMinutes, secondHours]
  );
  return rows;
}

/** Re-checks the live order right before sending. Returns true only if it is still the
 *  customer's latest order and still awaiting payment. */
async function stillNudgeable(orderId, userId) {
  const [rows] = await db().query(
    `SELECT ws.code AS stage_code, (SELECT MAX(o2.id) FROM orders o2 WHERE o2.user_id = ?) AS latest_order_id
     FROM orders o
     JOIN workflow_stages ws ON ws.id = o.current_stage_id
     WHERE o.id = ?`,
    [userId, orderId]
  );
  if (!rows.length) return false;
  return rows[0].stage_code === "awaiting_payment" && Number(rows[0].latest_order_id) === Number(orderId);
}

/** Confirms, against Razorpay, whether this order was paid after the query. Returns
 *  "paid" (already reconciled, do not nudge) or "unpaid" (safe to nudge). Throws if
 *  Razorpay cannot be reached, so the caller skips rather than nudging unverified. */
async function checkGatewayForPayment(gatewayOrderId) {
  const items = await fetchGatewayPayments(gatewayOrderId);
  const captured = items.find((p) => p.status === "captured");
  if (captured) {
    const delivered = await deliverToWebhook(captured);
    if (!delivered) console.error(`[paymentNudges] could not deliver captured payment for ${gatewayOrderId}`);
    return "paid";
  }
  return "unpaid";
}

/** Atomically claims the next reminder slot. A second concurrent run finds the counter
 *  already advanced and skips, so no order is ever reminded twice in the same step. */
async function claimNudge(orderId, expectedCount, now) {
  const [result] = await db().query(
    `UPDATE orders SET payment_nudge_count = payment_nudge_count + 1, payment_nudge_last_at = ?
     WHERE id = ? AND payment_nudge_count = ?`,
    [now, orderId, expectedCount]
  );
  return result.affectedRows > 0;
}

async function releaseNudge(orderId, claimedCount) {
  await db().query(
    `UPDATE orders SET payment_nudge_count = payment_nudge_count - 1
     WHERE id = ? AND payment_nudge_count = ?`,
    [orderId, claimedCount]
  );
}

async function nudgeOrder(order) {
  const attemptNo = Number(order.payment_nudge_count) + 1; // 1 or 2
  const eventCode = `payment_pending_reminder_${attemptNo}`;

  // 1. Razorpay re-check. If unreachable, the error propagates and this order is skipped.
  const gateway = await checkGatewayForPayment(order.gateway_order_id);
  if (gateway === "paid") return "paid";

  // 2. Re-read the live order: still awaiting payment, still their latest order.
  if (!(await stillNudgeable(order.id, order.user_id))) return "skipped";

  // 3. Claim the slot, so a concurrent run cannot send the same reminder twice.
  const now = sqlDateTime();
  if (!(await claimNudge(order.id, order.payment_nudge_count, now))) return "skipped";

  const template = await getEventTemplate(eventCode);
  if (!template) {
    await releaseNudge(order.id, attemptNo);
    console.error(`[paymentNudges] no '${eventCode}' notification_event found - nothing sent for ${order.order_number}`);
    return "failed";
  }

  try {
    const vars = { order_number: order.order_number };
    await notifyUser({
      userId: order.user_id,
      notificationEventId: template.notification_event_id,
      title: template.title_template ? renderTemplate(template.title_template, vars) : "Complete your payment",
      body: template.body_template ? renderTemplate(template.body_template, vars) : null,
      actionType: template.action_type || "order",
      actionValue: String(order.id),
      referenceType: "orders",
      referenceId: order.id,
      source: "payment_pending",
    });
    return "sent";
  } catch (err) {
    // Undo the claim so the next run retries this reminder instead of silently losing it.
    await releaseNudge(order.id, attemptNo);
    throw err;
  }
}

export async function runPaymentNudgesJob() {
  const startedAt = new Date();
  const firstMinutes = await getConfigInt("payment_nudge_first_minutes", 15);
  const secondHours = await getConfigInt("payment_nudge_second_hours", 3);

  const candidates = await getCandidates(firstMinutes, secondHours);
  const counts = { sent: 0, paid: 0, skipped: 0, failed: 0 };

  for (const order of candidates) {
    try {
      const outcome = await nudgeOrder(order);
      counts[outcome] = (counts[outcome] ?? 0) + 1;
    } catch (err) {
      counts.failed++;
      console.error(`[paymentNudges] could not nudge ${order.order_number}`, err.message);
    }
  }

  if (candidates.length > 0) {
    console.log(
      `[paymentNudges] run finished in ${Date.now() - startedAt.getTime()}ms - ${candidates.length} due, ` +
      `${counts.sent} sent, ${counts.paid} found paid at Razorpay, ${counts.skipped} skipped, ${counts.failed} failed`
    );
  }
}
