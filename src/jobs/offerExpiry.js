import { db } from "../lib/db.js";

/**
 * Marks delivery offers that timed out without a response as 'expired'. Until this job,
 * a dead offer only changed status when someone happened to act on it, so the database
 * kept showing "offered" for offers that had already died. Only rows still literally
 * 'offered' and past their deadline are touched - accepted, rejected and lost offers are
 * never changed.
 */
export async function runOfferExpiryJob() {
  const [res] = await db().query(
    `UPDATE order_assignments
     SET assignment_status = 'expired'
     WHERE assignment_status = 'offered' AND expires_at <= NOW()`
  );

  if (res.affectedRows > 0) {
    console.log(`[ookaro-worker] offerExpiry - expired ${res.affectedRows} offer(s)`);
  }
}
