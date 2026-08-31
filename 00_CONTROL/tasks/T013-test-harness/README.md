# T013 Test Harness — Offline Operation

`cdp.js` here is NOT identical to other harness directories' copies — it adds
a `setOffline(bool)` method wrapping `Network.emulateNetworkConditions`. See
the important methodology note below before trusting that method for
anything load-bearing. Every other harness directory's `cdp.js` is
unchanged; this copy was kept local rather than modifying the shared
original, so no other suite's behavior changes silently — same precedent
T012-test-harness set for its own `confirm()`-dialog addition.

This harness did not exist before this session. T013 (offline operation)
had zero real-browser evidence — `16_TESTING/GATE_D_TEST_MATRIX_T001-T016.md`
listed T013-1/2/3 as either "re-verification only" or "never tested," and
`V3_GAP_REGISTER.txt`'s M-10 was OPEN.

## Important methodology note — read before rerunning or extending

A standalone probe run in this session found that CDP's
`Network.emulateNetworkConditions({offline:true})` does **not** block
`fetch()` calls to `localhost`/loopback targets in this headless Chromium
build (131.0.6778.204) — only non-loopback hosts (confirmed separately:
a fetch to `192.0.2.1` genuinely failed while the loopback fetch to the
local `python3 -m http.server` target kept returning `200`, even with a
cache-busting query param and even though `navigator.onLine` correctly
reported `false` throughout). This is a real, empirically-confirmed gap in
the emulation mechanism for this environment, not an assumption.

**Consequence for this harness's design**: `setOffline()` is applied and
its `navigator.onLine` effect is checked as a secondary, explicitly
non-load-bearing signal, but it is never the mechanism this harness relies
on to prove "the app is genuinely offline." Instead, the harness **kills
the actual `http.server` child process** (`SIGKILL`) between the seed phase
and the reload phase, and separately confirms via polling that the origin
is truly unreachable (connection-refused, not just slow) before reloading
the page. This is a real network-layer absence, the same kind a phone in
airplane mode would produce, not emulation. A future session extending
this harness (or copying its `cdp.js`) should not assume
`emulateNetworkConditions` alone is sufficient evidence for any
localhost-hosted-mode offline test — verify against a non-loopback probe
first, the way this session did, before relying on it.

## Files

- `cdp.js` — CDP client with console + network request capture, plus
  `setOffline()` (see caveat above).
- `test_t013_hosted.js` — 11-check hosted-mode suite. Spawns its own
  `python3 -m http.server` and headless Chrome instance internally (unlike
  some earlier harnesses that expected them pre-started) so the harness can
  kill and restart the server process itself mid-run.

## What it covers

1. **T013-1 — Service Worker registers under http(s)**: fresh page load,
   confirms `navigator.serviceWorker.getRegistration()` returns a
   registration whose `active.state === 'activated'`.
2. **T013-3 — Cache Storage genuinely holds the app shell**: reads
   `CACHE_NAME` and `SHELL_ASSETS` directly out of the real
   `service-worker.js` source (never hardcoded, so a future cache-version
   bump can't silently make this harness pass against a stale expectation),
   opens that cache via the real `caches.open()` API, and confirms every
   shell asset is present as a key.
3. **T013-2 — Offline reload actually works, including data persistence**:
   seeds one real entity via `KimaDB.createEntityWithIdentifier` (called via
   `await import('./db.js')` inside the page context — the module is not
   exposed on `window`, this project's convention, matching how
   T012-test-harness accesses it), then SIGKILLs the http.server process,
   confirms genuine connection-refused, reloads the page against the dead
   server, and confirms: the real page (not an error page) loads to
   `readyState: complete` with substantial body content; and — the part
   that distinguishes "cached shell" from "the app actually works
   offline" — the previously-seeded entity is still readable via
   `KimaDB.listEntities()` after the offline reload.
4. **Zero console errors** throughout both the online and offline phases.

## What it explicitly does NOT cover

- **No `file://`-mode variant.** Service workers do not register under
  `file://` at all (by browser design, not a KIMA EIS limitation — see
  `service-worker.js`'s own header comment, which correctly notes the app
  works offline under `file://` via IndexedDB alone with no SW involved).
  A `file://` "offline" test would therefore be testing something
  different in kind, not a gap in this harness.
- **Install/update-cycle testing.** This harness only exercises a single
  fresh SW registration, never a second page load where a bumped
  `CACHE_NAME` (e.g. a hypothetical `v9`) replaces `v8` and old cache
  entries are correctly evicted (the `activate` handler's cleanup logic
  exists in the source but has no dedicated test here).
- **Real-device network toggling** (e.g. actually enabling Android's
  airplane mode) — this remains, as with every other harness in this
  project, headless-Chromium-in-this-session's-sandbox evidence only, not
  real-device evidence. No touch, no real OS-level network stack, no real
  battery/background-tab suspension behavior.
- **`Network.emulateNetworkConditions`'s own limitation is intentionally
  left unresolved**, not worked around at the CDP level — this harness
  routes around it via process-kill instead of trying to find a Chromium
  flag that fixes loopback emulation, since the process-kill approach is
  simpler and produces strictly stronger evidence anyway.

## How to rerun (example)

The harness manages its own server and browser lifecycle — just run it:

```bash
cd /path/to/00_CONTROL/tasks/T013-test-harness
CHROME_PATH=/path/to/chrome node test_t013_hosted.js
```

If `CHROME_PATH` is unset, it falls back to the Puppeteer-cached path used
in this session
(`/home/claude/.cache/puppeteer/chrome/linux-131.0.6778.204/chrome-linux64/chrome`),
which will not exist in a different environment — always pass `CHROME_PATH`
explicitly outside this exact sandbox.

Each run uses a fresh `--user-data-dir` (timestamped) and fresh ports
(8931/9331), so reruns do not collide with leftover state from a previous
run or with other harnesses' ports.

## Results (this session, 2026-08-30)

11/11 checks passed, zero console errors, on two consecutive fresh-profile
runs (rerun once deliberately to rule out a one-off pass).

## Why this matters for future tasks

Rerun the full suite after any change to `service-worker.js` (especially
`CACHE_NAME` or `SHELL_ASSETS`), `app.js`'s
`registerServiceWorkerIfHosted`, or `db.js`'s `openDb`/`listEntities`.
