import { initializeApp, cert, getApps, getApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";

/**
 * Copied from ookaro-api's own src/lib/fcm.js (same reasoning as generalData.js - a
 * separate process, can't import across Next.js path aliases). The globalThis caching
 * there exists for Next.js dev-mode hot-reload; this process has no such churn, so a
 * plain module-level singleton is enough.
 */
let firebaseApp;

function getFirebaseApp() {
  if (!firebaseApp) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not configured");
    const serviceAccount = JSON.parse(raw);
    firebaseApp = getApps().length ? getApp() : initializeApp({ credential: cert(serviceAccount) });
  }
  return firebaseApp;
}

const DEAD_TOKEN_ERROR_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

export function isDeadTokenError(error) {
  return !!error && DEAD_TOKEN_ERROR_CODES.has(error.code);
}

export async function sendMulticast(tokens, { title, body, imageUrl, data = {} }) {
  if (!tokens.length) return { responses: [], successCount: 0, failureCount: 0 };

  const stringData = {};
  for (const [k, v] of Object.entries(data)) stringData[k] = v == null ? "" : String(v);
  if (imageUrl) stringData.image_url = String(imageUrl);

  const app = getFirebaseApp();
  return getMessaging(app).sendEachForMulticast({
    tokens,
    notification: { title, body: body || undefined, imageUrl: imageUrl || undefined },
    data: stringData,
  });
}
