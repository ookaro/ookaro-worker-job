import "./env.js";
import { runCartAbandonmentJob } from "./jobs/cartAbandonment.js";
import { runScheduledBroadcastsJob } from "./jobs/scheduledBroadcasts.js";
import { runOfferExpiryJob } from "./jobs/offerExpiry.js";
import { runStuckPaymentsJob } from "./jobs/stuckPayments.js";
import { runAutoSettlementsJob } from "./jobs/autoSettlements.js";
import { runPaymentNudgesJob } from "./jobs/paymentNudges.js";
import { runPaymentAutoCancelJob } from "./jobs/paymentAutoCancel.js";

/** Manual one-off run of a single job, for testing: `npm run run-job -- <name>`. Unlike
 *  index.js's long-running version, this exits once the job finishes; the DB pool would
 *  otherwise keep the event loop alive forever. */
const RUNNERS = {
  cartAbandonment: runCartAbandonmentJob,
  scheduledBroadcasts: runScheduledBroadcastsJob,
  offerExpiry: runOfferExpiryJob,
  stuckPayments: runStuckPaymentsJob,
  autoSettlements: runAutoSettlementsJob,
  paymentNudges: runPaymentNudgesJob,
  paymentAutoCancel: runPaymentAutoCancelJob,
};

const name = process.argv[2];
if (!RUNNERS[name]) {
  console.error(`Usage: npm run run-job -- <${Object.keys(RUNNERS).join("|")}>`);
  process.exit(1);
}

await RUNNERS[name]();
process.exit(0);
