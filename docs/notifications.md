# Notifications

Phone notifications from Tower (the `/m` app) through web push. Built so the next kind of alert, or the next way of
delivering one, is a small addition and not a rewrite.

## What a person sees

Tower, More, **Alerts**. One button turns notifications on for *this device*; after that the device has its own choices:

- which kinds of alert it wants (the list comes from the server, so a new category shows up without a Tower change),
- quiet hours (critical alerts can still come through),
- a cap on messages per hour.

Each device is independent: a phone and a laptop can want different things.

**iPhone:** web push works only for the installed app. Add Tower to the Home Screen (Share, Add to Home Screen) and open
it from there; the screen says so when it is opened in plain Safari. The permission prompt comes from tapping the button
(a browser rule), never from page load.

## Setting it up on the server

1. `npm run vapid` prints a key pair. Put them in the server's environment as `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`,
   plus `VAPID_SUBJECT` (`mailto:you@example.com`). **Keep the pair.** Changing it silently orphans every subscribed device.
2. Restart. Without both keys push is off and Alerts says "not set up on this server yet".
3. Open Tower, More, Alerts, turn on notifications, tap **Send a test**.

## How it works

```
fleet ──snapshot──> detectors ──events──> policy (per device) ──> channel ──> phone
                       │                      │                      │
                  detectors.ts            policy.ts            transport.ts
                  categories.ts           prefs.ts             service.ts (the loop)
```

All of it is in `src/engine/notify/`. Everything except the transport is pure (no clock, no I/O).

| File | Job |
|---|---|
| `types.ts` | `NotifyEvent`, `NotifySnapshot`, `NotifyPrefs`, `DeliveryState`, the severity ranking |
| `categories.ts` | The registry of kinds of alert: label, description, on by default, repeat cooldown |
| `detectors.ts` | Pure functions from a snapshot to events: approvals, stranded, attention (critical only), reset warnings, rate drop |
| `policy.ts` | `decide()`: switches, quiet hours, dedupe, hourly cap, digests, silent seeding |
| `prefs.ts` | Cleans what a device sends (unknown categories dropped, numbers clamped) |
| `transport.ts` | `PushTransport` interface and the web-push implementation (VAPID, 404/410 detection) |
| `service.ts` | `NotificationService`: every 30 seconds, snapshot, detect, and for each device decide and send |
| `live.ts` | The only file that knows what a `FleetManager` or `Store` looks like: builds the snapshot |
| `store.ts` | The `PushStore` interface the service needs (the real one is `Store`, table `push_subscriptions`) |

The HTTP side is `src/http/push.ts` (`/api/push/*`), the service worker `public/sw-tower.js`, and the settings screen
`public/shared/pushNotify.js` (shared, so Deck can mount it the same way).

### Behaviour worth knowing

- **A new device starts quiet.** The first pass records what is already true for it without sending, so turning alerts on
  does not fire a burst about things you already know. The same holds after a restart for any device never seen before;
  a device that was already up to date keeps its saved state and is not re-announced.
- **A standing condition is announced once.** The same key is not sent again until its category's cooldown passes
  (0 = until it clears and comes back). A condition that clears is forgotten, so it is announced again if it returns.
- **Held is not lost.** Anything held for quiet hours, the cap or a switch is not recorded as sent, so it goes out when the
  hold lifts if it is still true.
- **Three or more of one kind in a pass go as one digest** ("4 alerts: Approvals waiting").
- **A failed send is not recorded** and is tried again next pass. A 404 or 410 from the push service removes that device.
- **No credit figures in any message.** Payloads pass through Apple's and Google's servers. The rate alert compares two
  numbers and shows neither.
- **The fleet is not read when nobody is subscribed.**

## Adding things

**A new kind of alert**
1. Add an entry to `CATEGORIES` in `categories.ts` (id, label, description, `defaultOn`, `cooldownMin`).
2. Write a detector in `detectors.ts` returning `NotifyEvent[]` with a stable `key` per condition, and add it to `DETECTORS`.
3. If it needs data the snapshot does not carry, add a field to `NotifySnapshot` and fill it in `live.ts`.
4. Tests: a case in `tests/notifyDetectors.test.ts` (it already fails if a category has no detector or the reverse).

The settings list and the server-side validation pick the category up on their own.

**A new delivery channel** (Discord, e-mail): implement `PushTransport` for its kind of target and give it to the service.
The policy, dedupe and per-device choices apply unchanged. A channel with no per-device subscription (a single Discord
webhook) would want its own small store beside `push_subscriptions`.

**A new policy rule** goes in `decide()` in `policy.ts` with a case in `tests/notifyPolicy.test.ts`.

## What it does not do yet

- No notification for good news (a milestone, passing last week's total). The detector slot is there.
- The reset warnings use the watcher's `nextReset`; if the watcher is off there are none.
- Contract, warehouse and mission events are not alerts yet.
- Deck does not mount the Alerts screen yet (the module is shared, so it is a few lines).
