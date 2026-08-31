# R2-002 Test Harness

Same dependency-free raw-CDP driver pattern as
`00_CONTROL/tasks/R1-002-test-harness/` and `R2-001-test-harness/`, with
one addition: `cdp.js` here also monitors
`Network.requestWillBeSent` events (`page.getRequestUrls()`), added
specifically to make "zero CDN requests" a TEST-VERIFIED claim rather
than an assertion from reading the code — see
R2-002-TASK_RESULT.md's External code review disposition for why this
mattered.

Consider this the most capable of the three accumulated `cdp.js`
copies; a future housekeeping task should probably make it the shared
one (see R2-002-TASK_RESULT.md's Unresolved issues).

## Files

- `cdp.js` — CDP client with console + network request capture.
- `test_r2002_hosted.js` — 14-check hosted-mode suite: xlsx library
  load, format detection, full xlsx pipeline round-trip (built via the
  library itself, not a static fixture file), fingerprinting,
  idempotent re-import, multi-sheet handling, conflict detection, and
  zero-CDN-requests verification. Expects the app at
  `http://localhost:8902` and Chrome's CDP endpoint at
  `http://localhost:9230` (edit constants at top).
- `test_r2002_file.js` — 5-check `file://`-mode suite, same coverage
  scaled down, plus a zero-network check specific to `file://`. Edit
  the `APP_URL` placeholder before running.

## How to rerun (example)

```bash
cd /path/to/30_WEB_APP && python3 -m http.server 8902 &
/path/to/chrome --headless=new --remote-debugging-port=9230 \
  --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --user-data-dir=/tmp/some-profile about:blank &
sleep 3
node test_r2002_hosted.js

/path/to/chrome --headless=new --remote-debugging-port=9231 \
  --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --allow-file-access-from-files \
  --user-data-dir=/tmp/some-other-profile about:blank &
sleep 3
node test_r2002_file.js
```

## Why the network-monitoring addition matters

The single most important thing to verify about this task's xlsx
integration was that it does NOT silently depend on network access —
that was the exact, verified failure mode found in one of the two
externally-reviewed packages during R2-002's code review (see
R2-002-TASK_RESULT.md). A code-reading review can miss a `<script
src="https://...">` tag; a live network-request assertion against a
real browser cannot.
