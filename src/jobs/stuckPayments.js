import crypto from "node:crypto";
import { db } from "../lib/db.js";
import { apiBaseUrl } from "../lib/apiClient.js";

/**
 * Online orders stuck in "awaiting payment" - the customer paid (or failed) but the
 * browser never reported back to the API, so nothing confirmed or failed the order. This
 * asks Razorpay directly what happened to each one, then hands the answer to the API's own
 * Razorpay webhook endpoint as a correctly signed event. That reuses the exact same
 * confirm/fail logic a real Razorpay callback would hit, so there is no second copy of the
 * payment rules here. The webhook records each event id, so a repeat poll never reprocesses
 * the same result.
 */

const RAZORPAY_API = "https://api.razorpay.com/v1";
const MIN_AGE_MINUTES = 10;   // give the customer's own browser callback time to arrive first
const MAX_AGE_HOURS = 24;     // older than this is not a live payment any more
const BATCH_SIZE = 50;

function basicAuthHeader() {
  const id = process.env.RAZORPAY_KEY_ID;
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!id || !secret) throw new Error("RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set");
  return `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
}

export async function fetchGatewayPayments(gatewayOrderId) {
  const res = await fetch(`${RAZORPAY_API}/orders/${encodeURIComponent(gatewayOrderId)}/payments`, {
    headers: { Authorization: basicAuthHeader() },
  });
  if (!res.ok) throw new Error(`Razorpay responded ${res.status} for order ${gatewayOrderId}`);
  const body = await res.json();
  return body.items ?? [];
}

/** The outcome that matters: a captured payment wins, else the most recent failure. */
export function settledAttempt(items) {
  return items.find((p) => p.status === "captured")
    ?? [...items].reverse().find((p) => p.status === "failed")
    ?? null;
}

export async function deliverToWebhook(attempt) {
  const event = attempt.status === "captured" ? "payment.captured" : "payment.failed";
  const body = JSON.stringify({
    entity: "event",
    event,
    payload: { payment: { entity: attempt } },
  });

  const signature = crypto
    .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET || "")
    .update(body)
    .digest("hex");

  const res = await fetch(`${apiBaseUrl()}/api/v1/public/razorpay/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Razorpay-Signature": signature,
      "X-Razorpay-Event-Id": `poll-${attempt.id}-${attempt.status}`,
    },
    body,
  });
  return res.ok;
}

export async function runStuckPaymentsJob() {
  const [stuck] = await db().query(
    `SELECT p.id AS payment_id, p.gateway_order_id, o.order_number
     FROM payments p
     JOIN orders o ON o.id = p.order_id
     JOIN workflow_stages ws ON ws.id = o.current_stage_id
     WHERE o.payment_mode = 'online'
       AND ws.is_terminal = 0
       AND p.payment_status NOT IN ('captured', 'failed')
       AND p.gateway_order_id IS NOT NULL
       AND p.created_at < NOW() - INTERVAL ${MIN_AGE_MINUTES} MINUTE
       AND p.created_at > NOW() - INTERVAL ${MAX_AGE_HOURS} HOUR
     ORDER BY p.created_at ASC
     LIMIT ${BATCH_SIZE}`
  );

  let resolved = 0;
  for (const row of stuck) {
    try {
      const attempt = settledAttempt(await fetchGatewayPayments(row.gateway_order_id));
      if (!attempt) continue; // still nothing settled at Razorpay - leave it for a later poll

      if (await deliverToWebhook(attempt)) resolved += 1;
    } catch (err) {
      console.error("[ookaro-worker] stuckPayments - could not settle", row.order_number, err.message);
    }
  }

  if (stuck.length > 0) {
    console.log(`[ookaro-worker] stuckPayments - checked ${stuck.length}, settled ${resolved}`);
  }
}
