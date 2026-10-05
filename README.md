# ookaro-worker

The background-jobs process for Ookaro. `ookaro-api` (the Next.js backend) has an
explicit architectural rule that background jobs never run inside it - this is that
separate process, a plain long-running Node app, deployed and run independently
(`npm start`, under pm2/systemd/Task Scheduler - whatever the VPS already uses for
`ookaro-api` itself).

It talks directly to the same `ookaro_db` MySQL database and sends its own FCM pushes
directly (via the same Firebase service account `ookaro-api` uses). The exception is two
jobs that call `ookaro-api`'s own HTTP endpoints, because that logic already lives there
(see "Note on the design" below).

## Setup

```
npm install
cp .env.example .env.local   # then fill in the real DB creds + Firebase service account JSON
npm start                    # runs forever, cron-scheduled
```

To run a job once by hand, without waiting for its schedule:

```
npm run run-job -- <cartAbandonment|paymentNudges|scheduledBroadcasts|offerExpiry|stuckPayments|autoSettlements>
```

The worker reads its settings from `.env.local` (not a plain `.env` - `src/env.js` loads it
explicitly). Copy every key from `.env.example`.

## Jobs

| Job | Default schedule | What it does |
|---|---|---|
| `scheduledBroadcasts` | every minute | Triggers ookaro-api's `dispatch-due` endpoint, which sends any scheduled notification broadcast that has come due. Replaces the external crontab entry that used to do this. |
| `offerExpiry` | every minute | Marks delivery offers still `offered` past their deadline as `expired`. |
| `stuckPayments` | every 10 minutes | For online orders stuck in "awaiting payment" (10 minutes to 24 hours old), asks Razorpay what happened to the payment and hands a captured or failed result to ookaro-api's own webhook, correctly signed. |
| `autoSettlements` | every hour | Creates a pending settlement for each merchant with Auto Settlement on, once its settlement cycle is due (ookaro-api does the work). Nothing is paid here - each one is marked paid later with its bank reference. |
| `cartAbandonment` | every 15 minutes | Push reminders for carts left untouched past `cart_abandonment_hours`. |
| `paymentAutoCancel` | every 10 minutes | Cancels online orders still awaiting payment after `payment_auto_cancel_hours` (default 6). Stock, slot and coupon are released, and the order shows Payment Failed with the reason "Order auto cancelled because payment was not received in the last N hours". Razorpay is asked first, so a payment that landed late is never cancelled. |
| `paymentNudges` | every 5 minutes | Reminds a customer whose online order is still unpaid at the payment gateway: once after `payment_nudge_first_minutes` (default 15), and again after `payment_nudge_second_hours` (default 3) more. Stops after two reminders. See the section below. |

Schedules are overridable with `SCHEDULED_BROADCASTS_CRON`, `OFFER_EXPIRY_CRON`,
`STUCK_PAYMENTS_CRON`, `AUTO_SETTLEMENTS_CRON`, `CART_ABANDONMENT_CRON`, `PAYMENT_NUDGES_CRON` and `PAYMENT_AUTO_CANCEL_CRON`.

**Note on the design:** most jobs talk straight to `ookaro_db`. `scheduledBroadcasts`,
`stuckPayments` and `autoSettlements` call ookaro-api over HTTP instead, because the send,
payment and settlement rules already live there. Doing it that way means no duplicate copy of them here, and the
worker and the API can't drift apart.

## Production (VPS)

```
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
pm2 logs ookaro-worker
```

`ecosystem.config.cjs` sets one instance only (two schedulers would double-send), restarts
on crash with a back-off, and writes logs to `./logs`. Set `API_BASE_URL` to the VPS URL of
ookaro-api, and use the **live** Razorpay keys and webhook secret.

## Jobs

### Cart Abandonment (`src/jobs/cartAbandonment.js`)

Finds carts with real items that have sat untouched past a configurable threshold
(`config_settings.cart_abandonment_hours`, default 2 hours - edit it live from the admin
panel's App Settings screen, same as any other config row) and sends a push reminder.

Confirmed before building this: adding an item to a cart never reserves real stock or a
delivery slot in this project - both only ever move at actual order placement. So this
job is purely a notification nudge, nothing to release.

Sends at most 2 reminders per cart (a fixed cap, not a config row - not every knob needs
to be admin-tunable). A cart that converts to a real order afterward is marked
`is_recovered=1` for reporting; it naturally stops getting reminded the moment its own
`cart_status` leaves `'active'`, regardless of that flag.

Schedule: `CART_ABANDONMENT_CRON` (default every 15 minutes).

### Payment Pending Nudges (`src/jobs/paymentNudges.js`)

For a customer who starts an online order, the gateway opens, and they close it without
paying. The order stays at `awaiting_payment`. The job sends one push reminder after
`payment_nudge_first_minutes` (default 15), and a second after `payment_nudge_second_hours`
(default 3) more, then stops. Both delays are `config_settings` rows, editable live in the
admin App Settings screen.

Before each reminder the job re-checks, so a payment made in the meantime never gets nudged:

- **Razorpay:** if a payment is captured for the order, it is delivered to the webhook (the
  same path `stuckPayments` uses) and no reminder is sent. If Razorpay cannot be reached,
  the order is skipped and not nudged unverified.
- **Live order:** the stage is re-read from the database, so a confirmed payment stops it.
- **Latest order only:** only the customer's most recent order is ever nudged. A newer
  order, paid or not, means they have moved on.

A failed gateway attempt is left to `stuckPayments` and is not treated as paid. Orders older
than 24 hours are never nudged, matching `stuckPayments`' window. Each reminder claims the
order's counter atomically, so two overlapping runs never send the same reminder twice.

Columns: `orders.payment_nudge_count` and `orders.payment_nudge_last_at` (migration 64).
Schedule: `PAYMENT_NUDGES_CRON` (default every 5 minutes).

## Conventions

Shared code is **copied** from `ookaro-api`'s own `src/lib/` (`db.js`, `generalData.js`,
`fcm.js`, the relevant slice of `notificationDispatchModel.js`/`pushDeliveryModel.js`),
not imported - this is a genuinely separate Node process and can't resolve `ookaro-api`'s
own `@/` path aliases. If the source files in `ookaro-api` change in a way that matters
here, update the copies by hand.
