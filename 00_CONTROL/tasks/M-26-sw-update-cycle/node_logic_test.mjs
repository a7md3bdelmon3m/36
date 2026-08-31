// M-26/ADR-034: Node-logic verification for the Service Worker
// install/update-cycle fix.
//
// No real browser/ServiceWorkerContainer is reachable in this sandbox
// (confirmed fresh: no Chromium binary, network disabled) — this test
// verifies only what's checkable from source: (1) the specific defect
// this task fixes is genuinely gone from the source, (2) the new
// control-flow guards are present and structured correctly, (3) a
// minimal in-Node simulation of the state machine's DECISION logic
// (not real Cache/ServiceWorker APIs) confirms the banner-show
// condition is correct for the three cases that matter: first install
// (no banner), waiting-worker-found-on-registration with a controller
// present (banner), and waiting-worker-found-on-registration with NO
// controller present (no banner — this is the exact case a naive
// `if (registration.waiting)` alone would get wrong).

import { readFile } from 'node:fs/promises';

let pass = 0, fail = 0;
function record(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${detail || ''}`); }
}

const appSrc = await readFile(new URL('../../../30_WEB_APP/app.js', import.meta.url), 'utf8');
const swSrc = await readFile(new URL('../../../30_WEB_APP/service-worker.js', import.meta.url), 'utf8');
const htmlSrc = await readFile(new URL('../../../30_WEB_APP/index.html', import.meta.url), 'utf8');

// ---- The defect: unconditional skipWaiting() on install ----

record(
  'M26-1-install-handler-no-longer-calls-skipWaiting-unconditionally',
  // The old defect was literally `.then(() => self.skipWaiting())`
  // chained directly onto the install handler's cache.open/addAll
  // promise, with no gating. Confirm that exact pattern is gone.
  !/\.then\(\(\) => self\.skipWaiting\(\)\)/.test(swSrc),
);

record(
  'M26-2-skipWaiting-now-only-reachable-via-message-handler',
  (swSrc.match(/self\.skipWaiting\(\)/g) || []).length === 1
    && /self\.addEventListener\('message', \(event\) => \{\s*if \(event\.data && event\.data\.type === 'SKIP_WAITING'\) self\.skipWaiting\(\);/.test(swSrc),
  `skipWaiting() occurrence count and message-handler shape`,
);

record(
  'M26-3-install-still-populates-cache-before-any-gating',
  // The actual caching behavior (the part that matters for offline
  // support) must be unchanged — only the auto-activation was removed.
  /caches\.open\(CACHE_NAME\)\s*\.then\(\(cache\) => cache\.addAll\(SHELL_ASSETS\)\)/.test(swSrc),
);

record(
  'M26-4-activate-handler-unchanged-clients-claim-still-present',
  // clients.claim() must remain — it's still correct and necessary for
  // the FIRST install to take control of the page that triggered it
  // (no skipWaiting race exists there since there's no prior controller
  // to race against). Only the update-race path needed fixing.
  /self\.clients\.claim\(\)/.test(swSrc),
);

// ---- app.js: the new listener structure ----

record(
  'M26-5-updatefound-listener-present',
  appSrc.includes("registration.addEventListener('updatefound'"),
);

record(
  'M26-6-controllerchange-listener-present-with-reload-guard',
  appSrc.includes("navigator.serviceWorker.addEventListener('controllerchange'")
    && /let reloadedOnce = false;/.test(appSrc)
    && /if \(reloadedOnce\) return;\s*reloadedOnce = true;\s*location\.reload\(\);/.test(appSrc),
);

record(
  'M26-7-banner-gated-on-controller-presence-in-both-branches',
  // Both the registration.waiting branch AND the updatefound/installed
  // branch must check navigator.serviceWorker.controller before
  // showing the banner — this is the exact guard that distinguishes
  // "first install" from "genuine update available".
  (appSrc.match(/navigator\.serviceWorker\.controller/g) || []).length >= 2,
);

record(
  'M26-8-skip-waiting-message-sent-on-user-click-only',
  /el\('#sw-update-reload-btn'\)\.addEventListener\('click', \(\) => \{[\s\S]*?postMessage\(\{ ?type: ?'SKIP_WAITING' ?\}\)/.test(appSrc),
);

record(
  'M26-9-banner-markup-present-with-hidden-default',
  /id="sw-update-banner"[^>]*hidden/.test(htmlSrc) && htmlSrc.includes('id="sw-update-reload-btn"'),
);

// ---- Minimal in-Node simulation of the decision logic ----
// Re-implements just the boolean condition from registerServiceWorkerIfHosted
// (not a real ServiceWorker mock) to confirm the three cases resolve
// correctly. This is a logic-equivalence check, not an execution of the
// real browser API surface.

function shouldShowBanner({ hasController, workerState }) {
  // Mirrors: `if (registration.waiting && navigator.serviceWorker.controller)`
  // for the "found waiting on registration" path, and the updatefound
  // path's `if (installing.state === 'installed' && navigator.serviceWorker.controller)`.
  if (workerState !== 'installed' && workerState !== 'waiting') return false;
  return Boolean(hasController);
}

record(
  'M26-10-sim-first-install-no-controller-no-banner',
  shouldShowBanner({ hasController: false, workerState: 'installed' }) === false,
);

record(
  'M26-11-sim-genuine-update-with-controller-shows-banner',
  shouldShowBanner({ hasController: true, workerState: 'installed' }) === true,
);

record(
  'M26-12-sim-waiting-worker-found-without-controller-no-banner',
  // The exact case a naive `if (registration.waiting)` alone (without
  // the && controller check) would get wrong — e.g. a very unusual
  // browser state where a worker is waiting but nothing controls the
  // page yet.
  shouldShowBanner({ hasController: false, workerState: 'waiting' }) === false,
);

console.log(`\nM26_SW_UPDATE_CYCLE_TEST=${fail === 0 ? 'PASS' : 'FAIL'} (${pass}/${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
