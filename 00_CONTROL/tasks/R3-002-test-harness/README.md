# R3-002 Test Harness

Same dependency-free raw-CDP driver pattern as R1-002/R2-001/R2-002/
R3-001; `cdp.js` here is an unmodified copy of
`R3-001-test-harness/cdp.js` (network-monitoring-capable, though this
suite doesn't itself assert on network traffic).

This harness did not exist before ADR-024 (2026-08-30). R3-002 (the
context-bar-as-navigational-filter feature) was implemented and
logic-verified only; no real-browser harness had ever been written for
it, unlike R1-002/R2-001/R2-002/R3-001 which all had one from their
own original task. This closes that specific gap.

## Files

- `cdp.js` — CDP client with console + network request capture.
- `test_r3002_hosted.js` — 20-check hosted-mode suite. Seeds 6 entities
  directly via `KimaDB.createEntity` (three sharing `PlantA/AreaB`,
  one diverging at Area, one Plant-only, one with unstructured
  no-slash context), then drives the real DOM: selecting an entity to
  populate the context bar, clicking a breadcrumb segment to narrow
  the explorer, verifying the narrowed list is exactly right (and that
  siblings/too-short prefixes are correctly excluded), verifying the
  filter indicator is visible independent of the currently selected
  entity (acceptance criterion 3), clicking the clear control, and
  regression-checking ordinary type-filtering plus the no-slash-context
  entity's breadcrumb-free rendering. Expects the app at
  `http://localhost:8908` and Chrome's CDP endpoint at
  `http://127.0.0.1:9238`.
- `test_r3002_file.js` — 8-check `file://`-mode suite, smaller seed (3
  entities), same core drill-down/clear flow. Takes the `file://` URL
  as a CLI argument (`node test_r3002_file.js file:///path/index.html`)
  rather than a hardcoded placeholder, since file:// paths are
  environment-specific. Expects Chrome's CDP endpoint at
  `http://127.0.0.1:9239`.

## How to rerun (example)

```bash
cd /path/to/30_WEB_APP && python3 -m http.server 8908 &
/path/to/chrome --headless=new --remote-debugging-port=9238 \
  --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --user-data-dir=/tmp/some-profile about:blank &
sleep 3
node test_r3002_hosted.js

/path/to/chrome --headless=new --remote-debugging-port=9239 \
  --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --allow-file-access-from-files \
  --user-data-dir=/tmp/some-other-profile about:blank &
sleep 3
node test_r3002_file.js "file:///path/to/30_WEB_APP/index.html"
```

Note: in some sandboxed environments, backgrounded processes do not
survive between separate tool-call boundaries — launch the HTTP
server, Chrome, and the test script all within one shell invocation
(see ADR-024's own run script) rather than assuming a `&`-backgrounded
process from a prior command is still alive.

## Results (ADR-024, 2026-08-30)

28/28 checks passed: 20/20 hosted, 8/8 file://. Zero console errors
throughout either run. Confirms all 5 of R3-002's own acceptance
criteria against a real DOM for the first time: breadcrumb click
narrows the list to the exact expected prefix set (not just "some
narrower list"), the clear control restores the full list, the filter
indicator is visible independent of current selection, no regression
to type-filtering or to entities with no/unstructured context, and no
schema changes were exercised (none needed — this is UI/query-option
behavior only).

## Why this matters for future tasks

Rerun the full suite (not a subset) after any change to
`searchEntities`'s `contextLevels` handling, `parseContextHierarchy`,
`updateContextBar`, or `renderContextFilterIndicator` in `app.js`/
`db.js`.
