# M-26 — Service Worker install/update-cycle fix

Task ID: ADR-034 (see `00_CONTROL/DECISION_LOG.md`)

## The real defect found

`service-worker.js` called `self.skipWaiting()` unconditionally on
every install, and `app.js` had zero `updatefound`/`controllerchange`
handling anywhere. Combined, a newly-deployed SW version would take
control of an already-open page immediately and silently — the user
was never told, had no way to know, and had no way to defer or
trigger the reload themselves.

This is `V3_RELEASE_GATE.txt`'s "Service Worker install/update-cycle
testing" gap, taken one step further: rather than only writing a test
for the existing behavior, the existing behavior itself was found to
be a real defect and fixed first.

## The fix

- `service-worker.js`: `self.skipWaiting()` removed from the
  unconditional `install` chain. A new `message` listener calls it
  **only** on receiving `{type: 'SKIP_WAITING'}` — the sole trigger
  for a waiting worker to activate.
- `app.js`: `registerServiceWorkerIfHosted` now listens for
  `updatefound` (and separately checks `registration.waiting` right
  after registering, for the case where an update finished installing
  before this page load even ran) and shows a persistent update banner
  — but **only** when `navigator.serviceWorker.controller` is
  non-null, i.e. only when this page is already controlled by a prior
  worker version. On first install ever for this origin, `controller`
  is `null` and no banner appears, since nothing is stale yet.
- `index.html`/`styles.css`: `#sw-update-banner` — a persistent (no
  auto-dismiss timer, unlike `.toast`) banner with a reload button.
- Clicking reload posts `SKIP_WAITING` to the waiting worker;
  `controllerchange` (fired once the new worker actually takes over)
  triggers `location.reload()`, guarded against firing twice.

## A design mistake caught and corrected mid-task

The first draft of this fix left `self.skipWaiting()` in `install`
**unconditionally**, and additionally sent the `SKIP_WAITING` message
from the banner's click handler — with a comment claiming the message
was "technically redundant" to the automatic call. That was wrong: if
`skipWaiting()` already runs automatically on install, the new worker
activates and takes control **before the user ever sees the banner**,
making the banner cosmetic rather than functional — exactly the
silent-takeover behavior this task exists to fix, just delayed by a
few hundred milliseconds. Caught during self-review, not by any
external check, before this file was written. The unconditional call
was removed; `SKIP_WAITING` via `message` is now the *only* path to
activation for a worker found via `updatefound`/`waiting`.

## Verification: Node-logic only, real limits real and named

No real ServiceWorkerContainer/browser is reachable in this sandbox —
reconfirmed fresh for this task (no Chromium binary, network disabled).
`00_CONTROL/tasks/M-26-sw-update-cycle/node_logic_test.mjs`, **12/12
PASS**, three tiers:

1. Source-string confirmation that the exact defect pattern
   (`.then(() => self.skipWaiting())` chained unconditionally) is
   genuinely gone, `skipWaiting()` now appears exactly once (inside the
   message handler), the cache-population behavior is unchanged, and
   `clients.claim()` (still correct for first-install) remains.
2. Source-string confirmation the new `app.js` listeners
   (`updatefound`, `controllerchange` with a reload guard, the
   controller-presence check appearing in both banner-triggering
   branches) and the new HTML markup are present and structured as
   described.
3. A **logic-equivalence simulation** (not a real API mock) of the
   banner-show decision for the three cases that matter: first install
   (no controller → no banner), genuine update with an existing
   controller (→ banner), and a waiting worker found with no controller
   present (→ no banner — the exact case a naive `if
   (registration.waiting)` alone, without the controller check, would
   get wrong).

**Explicitly NOT verified**, named and not glossed over:

- The real `updatefound` event actually firing in a real browser when
  a new `service-worker.js` is deployed and re-fetched by the browser's
  own periodic update check.
- The real `controllerchange` event actually firing after a real
  `postMessage`/`skipWaiting()` round-trip.
- The banner actually rendering visibly and the reload actually
  occurring end-to-end in a real tab.
- Multi-tab behavior: whether a second open tab (not the one that
  clicked reload) also gets its own `controllerchange` and reloads
  correctly — expected to work per the Service Worker spec
  (`clients.claim()` + `controllerchange` fire per-client), but
  unverified here.
- Whether `cache.addAll(SHELL_ASSETS)` with a changed asset list
  (e.g. a future `CACHE_NAME` bump adding a new file) still installs
  cleanly under the new non-auto-skipWaiting flow — logically it
  should, since only the *activation* timing changed, not the install
  step itself, but this is reasoning from source, not an execution.

## Gap-register status

New row **M-26**: PARTIALLY CLOSED. The defect fix itself (removing
the silent unconditional `skipWaiting()`) is a real, independently
correct improvement regardless of test execution — an app that used to
silently swap live code under an open tab now requires explicit user
consent to do so. Real-browser confirmation of the full event sequence
remains a named, open gap.
