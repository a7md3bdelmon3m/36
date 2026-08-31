// T013 — Offline operation — real-Chromium hosted-mode harness.
//
// Covers the three checks named in 16_TESTING/GATE_D_TEST_MATRIX_T001-T016.md's
// T013 section:
//   T013-1: Service Worker registers under http(s).
//   T013-2: after registration, cutting the network and reloading, the app
//           still works fully (app shell loads, UI is interactive, IndexedDB
//           data survives — offline persistence, not just a cached shell).
//   T013-3: CACHE_NAME (from service-worker.js — read directly, not
//           hardcoded, so this harness never silently drifts from the real
//           file) is genuinely present in Cache Storage with all
//           SHELL_ASSETS entries.
//
// IMPORTANT — real-network-cutoff methodology (read before rerunning):
// A prior probe in this same session found that CDP's
// Network.emulateNetworkConditions({offline:true}) does NOT block fetches to
// loopback/localhost in this headless Chromium build (131.0.6778.204) —
// only non-loopback hosts. A python3 -m http.server target on localhost
// therefore stayed reachable ("status:200") through the CDP-offline flag
// while navigator.onLine correctly flipped to false — a false-negative risk
// for T013-2 specifically (it would silently pass even if the SW's
// cache-first fetch handler were broken, since the real HTTP server was
// still answering underneath it). This harness does NOT rely on
// emulateNetworkConditions for the load-bearing T013-2 evidence. Instead it
// ACTUALLY KILLS the local http.server process between the "online" and
// "offline" phases, confirmed via a direct curl-equivalent connection-refused
// check before proceeding — genuine network-layer absence, not emulation.
// CDP's setOffline() is still applied (see cdp.js) as a secondary,
// documented-as-secondary signal (navigator.onLine flips correctly), never
// as the sole evidence for the offline-reload claim.
//
// This mirrors the project's existing discipline (ADR-026 verified its new
// confirm()-dialog CDP mechanism with a standalone probe before trusting it
// in the real suite) — this harness's own offline mechanism was probed the
// same way before being relied on here, and the probe's finding is recorded
// above rather than silently worked around.

const { connectToNewTab } = require('./cdp.js');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const APP_DIR = path.resolve(__dirname, '../../../30_WEB_APP');
const PORT = 8931;
const CDP_PORT = 9331;
const BASE = `http://localhost:${PORT}`;
const CDP_BASE = `http://localhost:${CDP_PORT}`;
const PROFILE_DIR = `/tmp/t013-harness-profile-${Date.now()}`;

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} — ${name}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/home/claude/.cache/puppeteer/chrome/linux-131.0.6778.204/chrome-linux64/chrome',
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error('No Chrome binary found — set CHROME_PATH');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHttp(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status) return true;
    } catch (e) {
      // not up yet
    }
    await sleep(150);
  }
  return false;
}

async function waitForConnectionRefused(url, timeoutMs) {
  // Confirms the server is GENUINELY down (real network-layer absence),
  // not just slow — polls until fetch throws a connection-level error.
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fetch(url);
      // still reachable — wait and retry
    } catch (e) {
      return true;
    }
    await sleep(100);
  }
  return false;
}

async function main() {
  // Read the real CACHE_NAME and SHELL_ASSETS from the actual product file —
  // never hardcode these, so a future cache-version bump can't silently make
  // this harness pass against a stale expectation.
  const swSource = fs.readFileSync(path.join(APP_DIR, 'service-worker.js'), 'utf8');
  const cacheNameMatch = swSource.match(/CACHE_NAME\s*=\s*'([^']+)'/);
  if (!cacheNameMatch) throw new Error('Could not read CACHE_NAME from service-worker.js');
  const CACHE_NAME = cacheNameMatch[1];

  const shellAssetsMatch = swSource.match(/SHELL_ASSETS\s*=\s*\[([\s\S]*?)\]/);
  if (!shellAssetsMatch) throw new Error('Could not read SHELL_ASSETS from service-worker.js');
  const SHELL_ASSETS = shellAssetsMatch[1]
    .split(',')
    .map((s) => s.trim().replace(/^'|'$/g, ''))
    .filter(Boolean);

  record('T013-0-read-real-cache-name-and-assets', true, { CACHE_NAME, assetCount: SHELL_ASSETS.length });

  // --- Phase 1: start server + browser, load app fresh, register SW ---
  const httpProc = spawn('python3', ['-m', 'http.server', String(PORT)], {
    cwd: APP_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const chromePath = findChrome();
  const chromeProc = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    `--user-data-dir=${PROFILE_DIR}`,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  try {
    const httpUp = await waitForHttp(`${BASE}/index.html`, 5000);
    record('T013-0a-http-server-up', httpUp, `port ${PORT}`);

    let cdpUp = false;
    for (let i = 0; i < 30; i++) {
      try {
        const r = await fetch(`${CDP_BASE}/json/version`);
        if (r.ok) { cdpUp = true; break; }
      } catch (e) {}
      await sleep(150);
    }
    record('T013-0b-chrome-devtools-up', cdpUp, `port ${CDP_PORT}`);

    const client = await connectToNewTab(CDP_BASE);

    // Fresh load — SW should register (app.js: registerServiceWorkerIfHosted).
    await client.navigate(`${BASE}/index.html`);
    await sleep(1500); // allow SW registration + activation to settle

    const consoleErrorsInitial = client.getConsole().filter((l) => l.startsWith('[error]') || l.startsWith('[exception]'));
    record('T013-1-load-clean', consoleErrorsInitial.length === 0, { errors: consoleErrorsInitial });

    // T013-1: SW registers under http(s)
    const swInfo = await client.evaluate(`
      navigator.serviceWorker.getRegistration().then(reg => {
        if (!reg) return { registered: false };
        return {
          registered: true,
          scope: reg.scope,
          activeState: reg.active ? reg.active.state : null,
          scriptURL: reg.active ? reg.active.scriptURL : null,
        };
      })
    `);
    record('T013-1-service-worker-registers', swInfo.registered === true && swInfo.activeState === 'activated', swInfo);

    // T013-3: real Cache Storage contains CACHE_NAME with all shell assets
    const cacheInfo = await client.evaluate(`
      caches.open(${JSON.stringify(CACHE_NAME)}).then(async (cache) => {
        const keys = await cache.keys();
        return keys.map(k => new URL(k.url).pathname.replace(/^\\//, './'));
      })
    `);
    const cachedSet = new Set(cacheInfo);
    const expectedSet = new Set(SHELL_ASSETS.map((a) => a.replace(/^\.\//, './')));
    const missing = [...expectedSet].filter((a) => {
      // compare by basename since cache keys are absolute paths, assets are relative
      const base = a.replace(/^\.\//, '');
      return ![...cachedSet].some((c) => c.replace(/^\.\//, '').endsWith(base));
    });
    record('T013-3-cache-storage-has-shell-assets', missing.length === 0, {
      cacheName: CACHE_NAME,
      cachedCount: cacheInfo.length,
      expectedCount: SHELL_ASSETS.length,
      missing,
    });

    // Seed a small piece of real IndexedDB data BEFORE going offline, so
    // T013-2 can confirm data survives a real offline reload (not just that
    // the shell HTML loads) — this is the difference between "cached page"
    // and "the app actually works offline" per the project's own PWA claim.
    const seedResult = await client.evaluate(`
      (async () => {
        try {
          const dbMod = await import('./db.js');
          const K = dbMod.KimaDB;
          const result = await K.createEntityWithIdentifier({
            entity_type: 'equipment',
            canonical_name: 'T013-OFFLINE-TEST-PUMP',
            display_name: 'T013 Offline Test Pump',
            context: 'PlantX/AreaY',
            namespace: 'TEST-NS',
            identifier: 'T013-OFFLINE-1',
          });
          return { ok: true, entityId: result.entity.entity_id };
        } catch (e) {
          return { ok: false, reason: e.message };
        }
      })()
    `);
    record('T013-seed-entity-before-offline', seedResult.ok === true, seedResult);

    await client.close();

    // --- Phase 2: ACTUALLY kill the HTTP server — genuine network cutoff ---
    httpProc.kill('SIGKILL');
    const trulyDown = await waitForConnectionRefused(`${BASE}/index.html`, 5000);
    record('T013-2a-server-genuinely-killed', trulyDown, 'confirmed connection-refused, not emulated');

    // Reconnect a fresh tab (browser + SW + Cache Storage persist across this;
    // only the origin server is gone) and reload the app with the server dead.
    const client2 = await connectToNewTab(CDP_BASE);
    // Also apply CDP-level offline flag as the documented secondary signal
    // (navigator.onLine correctness) — NOT relied on for T013-2's pass/fail.
    await client2.setOffline(true);

    let navigateError = null;
    try {
      await client2.navigate(`${BASE}/index.html`);
    } catch (e) {
      navigateError = e.message;
    }

    const readyState = await client2.evaluate('document.readyState').catch(() => 'unknown');
    const bodyLength = await client2.evaluate(
      'document.body ? document.body.innerHTML.length : 0'
    ).catch(() => 0);
    const titleText = await client2.evaluate('document.title').catch(() => '');
    const onlineFlag = await client2.evaluate('navigator.onLine').catch(() => null);

    record('T013-2-offline-reload-serves-real-app-shell', readyState === 'complete' && bodyLength > 1000, {
      navigateError, readyState, bodyLength, titleText, onlineFlagDuringOffline: onlineFlag,
      note: 'server process was SIGKILLed before this reload — genuine cutoff, not CDP emulation',
    });

    // Confirm the previously-seeded entity is still readable from IndexedDB
    // while genuinely offline — this is the real "app still works offline"
    // claim, not just "the HTML byte stream loaded from cache".
    const readBack = await client2.evaluate(`
      (async () => {
        try {
          const dbMod = await import('./db.js');
          const K = dbMod.KimaDB;
          const all = await K.listEntities();
          const match = all.find(e => e.canonical_name === 'T013-OFFLINE-TEST-PUMP');
          return { ok: true, totalEntities: all.length, matchFound: !!match, matchDisplayName: match ? match.display_name : null };
        } catch (e) {
          return { ok: false, reason: e.message };
        }
      })()
    `).catch((e) => ({ ok: false, reason: e.message }));
    record('T013-2b-indexeddb-data-readable-while-offline', readBack.ok === true && readBack.matchFound === true, readBack);

    const consoleErrorsOffline = client2.getConsole().filter((l) => l.startsWith('[error]') || l.startsWith('[exception]'));
    record('T013-4-zero-console-errors-during-offline-reload', consoleErrorsOffline.length === 0, { errors: consoleErrorsOffline });

    await client2.setOffline(false);
    await client2.close();

  } finally {
    try { chromeProc.kill('SIGKILL'); } catch (e) {}
    try { httpProc.kill('SIGKILL'); } catch (e) {}
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  if (passed !== results.length) process.exit(1);
}

main().catch((e) => {
  console.error('HARNESS ERROR', e);
  process.exit(1);
});
