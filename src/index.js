import "./env.js";
import cron from "node-cron";
import { runCartAbandonmentJob } from "./jobs/cartAbandonment.js";
import { runScheduledBroadcastsJob } from "./jobs/scheduledBroadcasts.js";
import { runOfferExpiryJob } from "./jobs/offerExpiry.js";
import { runStuckPaymentsJob } from "./jobs/stuckPayments.js";
import { runAutoSettlementsJob } from "./jobs/autoSettlements.js";
import { runPaymentNudgesJob } from "./jobs/paymentNudges.js";
import { runPaymentAutoCancelJob } from "./jobs/paymentAutoCancel.js";

/**
 * ookaro-worker's entry point - a plain long-running Node process (`npm start`), never a
 * serverless/edge function, matching ookaro-api's own "Node runtime, never Edge" rule
 * extended to this sibling project. Runs on the VPS alongside ookaro-api (pm2/systemd, see
 * ecosystem.config.cjs), not inside it.
 */

const JOBS = [
  {
    name: "scheduledBroadcasts",
    cron: process.env.SCHEDULED_BROADCASTS_CRON || "* * * * *",
    run: runScheduledBroadcastsJob,
  },
  {
    name: "offerExpiry",
    cron: process.env.OFFER_EXPIRY_CRON || "* * * * *",
    run: runOfferExpiryJob,
  },
  {
    name: "stuckPayments",
    cron: process.env.STUCK_PAYMENTS_CRON || "*/10 * * * *",
    run: runStuckPaymentsJob,
  },
  {
    name: "autoSettlements",
    cron: process.env.AUTO_SETTLEMENTS_CRON || "0 * * * *",
    run: runAutoSettlementsJob,
  },
  {
    name: "paymentAutoCancel",
    cron: process.env.PAYMENT_AUTO_CANCEL_CRON || "*/10 * * * *",
    run: runPaymentAutoCancelJob,
  },
  {
    name: "paymentNudges",
    cron: process.env.PAYMENT_NUDGES_CRON || "*/5 * * * *",
    run: runPaymentNudgesJob,
  },
  {
    name: "cartAbandonment",
    cron: process.env.CART_ABANDONMENT_CRON || "*/15 * * * *",
    run: runCartAbandonmentJob,
  },
];

for (const job of JOBS) {
  console.log(`[ookaro-worker] ${job.name} scheduled "${job.cron}"`);
  cron.schedule(job.cron, () => {
    job.run().catch((err) => console.error(`[ookaro-worker] ${job.name} crashed`, err));
  });
  // Run once immediately on boot too, so a fresh start doesn't wait a full interval.
  job.run().catch((err) => console.error(`[ookaro-worker] ${job.name} initial run crashed`, err));
}
