import { db } from "./db.js";
import { sqlDateTime } from "./generalData.js";
import { sendMulticast, isDeadTokenError } from "./fcm.js";

/**
 * The narrow slice of ookaro-api's notificationDispatchModel.js/pushDeliveryModel.js this
 * worker actually needs - copied (not imported, separate process) and trimmed to exactly
 * one path: write one `notifications` row for one user, then push it. No broadcast/admin
 * fan-out machinery here, this worker never needs it.
 */

async function getActiveDeviceTokens(userId) {
  const [rows] = await db().query(
    `SELECT id, fcm_token FROM user_devices
     WHERE user_id = ? AND is_active = 1 AND fcm_token IS NOT NULL AND fcm_token != ''`,
    [userId]
  );
  return rows;
}

async function recordDelivery({ notificationId, userId, destination, status, providerMessageId, errorCode, errorMessage, now }) {
  await db().query(
    `INSERT INTO notification_deliveries
      (notification_id, user_id, channel, provider, destination, delivery_status,
       provider_message_id, attempt_count, error_code, error_message, sent_at, created_at)
     VALUES (?, ?, 'push', 'fcm', ?, ?, ?, 1, ?, ?, ?, ?)`,
    [notificationId, userId, destination, status, providerMessageId, errorCode, errorMessage, status === "sent" ? now : null, now]
  );
}

/** Writes one `notifications` row, then pushes it to every active device for that user -
 *  in that order, never the reverse (a push is a real external side effect, the in-app
 *  row is the thing that must exist first regardless of whether the push itself lands). */
export async function notifyUser({ userId, notificationEventId, title, body, actionType, actionValue, referenceType, referenceId, source }) {
  const now = sqlDateTime();

  const [result] = await db().query(
    `INSERT INTO notifications
      (user_id, notification_event_id, title, body, action_type, action_value,
       reference_type, reference_id, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, notificationEventId ?? null, title, body ?? null, actionType ?? null, actionValue ?? null,
     referenceType ?? null, referenceId ?? null, source, now]
  );
  const notificationId = result.insertId;

  const devices = await getActiveDeviceTokens(userId);
  if (!devices.length) return { notificationId, pushed: false };

  let fcmResult;
  try {
    fcmResult = await sendMulticast(devices.map((d) => d.fcm_token), { title, body, data: { reference_type: referenceType || "", reference_id: referenceId != null ? String(referenceId) : "", notification_id: String(notificationId) } });
  } catch (err) {
    console.error("[ookaro-worker] sendMulticast failed", err);
    for (const device of devices) {
      await recordDelivery({ notificationId, userId, destination: device.fcm_token, status: "failed", errorCode: err.code || null, errorMessage: err.message, now });
    }
    return { notificationId, pushed: false, error: true };
  }

  const deadDeviceIds = [];
  for (let i = 0; i < devices.length; i++) {
    const device = devices[i];
    const r = fcmResult.responses[i];
    await recordDelivery({
      notificationId, userId, destination: device.fcm_token,
      status: r.success ? "sent" : "failed",
      providerMessageId: r.success ? r.messageId : null,
      errorCode: r.success ? null : r.error?.code || null,
      errorMessage: r.success ? null : r.error?.message || null,
      now,
    });
    if (!r.success && isDeadTokenError(r.error)) deadDeviceIds.push(device.id);
  }

  if (deadDeviceIds.length) {
    await db().query(
      `UPDATE user_devices SET is_active = 0, updated_at = ? WHERE id IN (${deadDeviceIds.map(() => "?").join(",")})`,
      [now, ...deadDeviceIds]
    );
  }

  return { notificationId, pushed: true, successCount: fcmResult.successCount, failureCount: fcmResult.failureCount };
}
