import { db } from "../lib/db.js";
import { sqlDateTime, castConfigValue, renderTemplate } from "../lib/generalData.js";
import { notifyUser } from "../lib/notify.js";

/**
 * Cart-abandonment recovery nudges - ookaro-worker's first real job, closing a gap
 * flagged repeatedly across this project's own history ("the cart-abandonment
 * auto-trigger... still needs a scheduled background job").
 *
 * Confirmed before writing a line of this: adding to cart never reserves real stock or a
 * delivery slot (both only ever move at real order placement - see placeOrder()/
 * cancelOrder() in ookaro-api's orderModel.js) - so this job is purely a notification
 * nudge, nothing to release. `carts.abandoned_at`/`recovery_notified_at`/
 * `recovery_attempts`/`is_recovered` and the `ix_carts_abandoned` index all already
 * existed, fully built for exactly this, with zero reader/writer anywhere until now -
 * this project's own well-established "schema anticipates the feature before code" shape.
 *
 * Deliberately a flat cap (MAX_REMINDERS) rather than a config row for every nuance -
 * not everything needs to be admin-tunable, this one's a reasonable fixed judgment call.
 */
const MAX_REMINDERS = 2;
const EVENT_CODE = "cart_abandoned";

async function getAbandonmentHours() {
  const [rows] = await db().query(
    `SELECT setting_value, value_type FROM config_settings
     WHERE scope_type = 'global' AND setting_key = 'cart_abandonment_hours' LIMIT 1`
  );
  if (!rows.length) return 2;
  return castConfigValue(rows[0].setting_value, rows[0].value_type) ?? 2;
}

async function getReminderTemplate() {
  const [rows] = await db().query(
    `SELECT ne.id AS notification_event_id, nt.title_template, nt.body_template, nt.action_type, nt.action_value
     FROM notification_events ne
     LEFT JOIN notification_templates nt ON nt.notification_event_id = ne.id AND nt.channel = 'push' AND nt.language_code = 'en' AND nt.is_active = 1
     WHERE ne.code = ? AND ne.is_active = 1 LIMIT 1`,
    [EVENT_CODE]
  );
  return rows.length ? rows[0] : null;
}

/** First-reminder candidates: still active, never abandoned before, idle past the
 *  threshold, has at least one real item, belongs to a real (non-guest) account - a
 *  guest has no persistent identity to notify. */
async function getFirstReminderCandidates(hours) {
  const [rows] = await db().query(
    `SELECT c.id, c.user_id, (SELECT COUNT(*) FROM cart_items ci WHERE ci.cart_id = c.id) AS item_count
     FROM carts c
     WHERE c.cart_status = 'active' AND c.abandoned_at IS NULL AND c.user_id IS NOT NULL
       AND c.updated_at <= DATE_SUB(NOW(), INTERVAL ? HOUR)
       AND EXISTS (SELECT 1 FROM cart_items ci WHERE ci.cart_id = c.id)`,
    [hours]
  );
  return rows.filter((r) => Number(r.item_count) > 0);
}

/** Repeat-reminder candidates: already nudged once, still not recovered, still active,
 *  under the attempt cap, and it's been another full interval since the last nudge. */
async function getRepeatReminderCandidates(hours) {
  const [rows] = await db().query(
    `SELECT c.id, c.user_id, (SELECT COUNT(*) FROM cart_items ci WHERE ci.cart_id = c.id) AS item_count
     FROM carts c
     WHERE c.cart_status = 'active' AND c.abandoned_at IS NOT NULL AND c.is_recovered = 0
       AND c.user_id IS NOT NULL AND c.recovery_attempts < ? AND c.recovery_attempts > 0
       AND c.recovery_notified_at <= DATE_SUB(NOW(), INTERVAL ? HOUR)
       AND EXISTS (SELECT 1 FROM cart_items ci WHERE ci.cart_id = c.id)`,
    [MAX_REMINDERS, hours]
  );
  return rows.filter((r) => Number(r.item_count) > 0);
}

async function remindCart(cart, template) {
  const now = sqlDateTime();
  const vars = { item_count: cart.item_count };

  await notifyUser({
    userId: cart.user_id,
    notificationEventId: template.notification_event_id,
    title: template.title_template ? renderTemplate(template.title_template, vars) : "You left something behind!",
    body: template.body_template ? renderTemplate(template.body_template, vars) : null,
    actionType: template.action_type || "cart",
    actionValue: template.action_value,
    referenceType: "carts",
    referenceId: cart.id,
    source: "cart_abandonment",
  });

  await db().query(
    `UPDATE carts
     SET abandoned_at = COALESCE(abandoned_at, ?), recovery_notified_at = ?, recovery_attempts = recovery_attempts + 1
     WHERE id = ?`,
    [now, now, cart.id]
  );
}

/** A cart that converted to a real order after being marked abandoned - pure bookkeeping,
 *  the `cart_status='active'` filter on both reminder queries above already naturally
 *  stops reminding it, this just reflects that outcome on the row itself for reporting. */
async function reconcileRecoveredCarts() {
  const [result] = await db().query(
    `UPDATE carts SET is_recovered = 1
     WHERE abandoned_at IS NOT NULL AND is_recovered = 0 AND cart_status = 'converted'`
  );
  return result.affectedRows;
}

export async function runCartAbandonmentJob() {
  const startedAt = new Date();
  const hours = await getAbandonmentHours();
  const template = await getReminderTemplate();
  if (!template) {
    console.error(`[cartAbandonment] no '${EVENT_CODE}' notification_event found - skipping this run`);
    return;
  }

  const [firstTime, repeats] = await Promise.all([
    getFirstReminderCandidates(hours),
    getRepeatReminderCandidates(hours),
  ]);

  let sent = 0;
  for (const cart of [...firstTime, ...repeats]) {
    try {
      await remindCart(cart, template);
      sent++;
    } catch (err) {
      console.error(`[cartAbandonment] failed to remind cart ${cart.id}`, err);
    }
  }

  const recovered = await reconcileRecoveredCarts();

  console.log(
    `[cartAbandonment] run finished in ${Date.now() - startedAt.getTime()}ms - ` +
    `${firstTime.length} first-time + ${repeats.length} repeat reminder(s) attempted, ${sent} sent, ${recovered} cart(s) reconciled as recovered`
  );
}
