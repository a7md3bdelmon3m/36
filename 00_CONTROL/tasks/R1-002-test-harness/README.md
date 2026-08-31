# R1-002 Test Harness (dependency-free CDP driver)

Written because this sandbox had no network access to install Puppeteer
and no cached copy of the library — only a cached Chrome 131.0.6778.204
binary. `cdp.js` is a ~70-line DevTools Protocol client using Node 22's
built-in `WebSocket` global; no npm install required.

## Files

- `cdp.js` — minimal CDP client (navigate, evaluate JS, capture console).
- `test_r1002_hosted.js` — Suite A equivalent (http://localhost served
  mode) + all R1-002 acceptance tests. Expects the app served at
  `http://localhost:8899/index.html` and Chrome's CDP endpoint at
  `http://localhost:9224` (edit the constants at the top of the file to
  match whatever ports you actually launch with).
- `test_r1002_file.js` — Suite B equivalent (`file://` mode, no server).
  Expects Chrome's CDP endpoint at `http://localhost:9223` and edits the
  `APP_URL` constant to point at your local `30_WEB_APP/index.html` path.

## How to rerun (example)

```bash
# Hosted suite
cd 30_WEB_APP && python3 -m http.server 8899 &
/path/to/chrome --headless=new --remote-debugging-port=9224 \
  --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --user-data-dir=/tmp/some-profile about:blank &
sleep 3
node 00_CONTROL/tasks/R1-002-test-harness/test_r1002_hosted.js

# file:// suite (separate Chrome instance/profile recommended)
/path/to/chrome --headless=new --remote-debugging-port=9223 \
  --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --allow-file-access-from-files \
  --user-data-dir=/tmp/some-other-profile about:blank &
sleep 3
node 00_CONTROL/tasks/R1-002-test-harness/test_r1002_file.js
```

Each script exits non-zero if any check fails, and prints a raw
PASS/FAIL line per check plus a final summary — matching the evidence
style required by `MASTER_PROJECT_CONTRACT.md`'s "no release without
objective evidence" principle.

## Open decision (see R1-002-TASK_RESULT.md, Unresolved issues)

Whether to promote this into a lightweight in-repo test runner reachable
from the phone itself (vs. continuing to run it from an external sandbox
each session) is not yet decided. It is kept here, versioned, so a future
task can make that call deliberately rather than rewriting a harness from
scratch each time.
