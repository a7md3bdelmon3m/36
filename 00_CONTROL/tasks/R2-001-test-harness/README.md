# R2-001 Test Harness

Same dependency-free raw-CDP driver pattern as
`00_CONTROL/tasks/R1-002-test-harness/` (`cdp.js` is an identical copy —
kept alongside rather than shared to avoid one task's harness silently
depending on another task's directory; see R2-001-TASK_RESULT.md's
Unresolved issues for the note about consolidating this later).

## Files

- `cdp.js` — minimal CDP client (see R1-002-test-harness/README.md for
  full explanation of why this exists instead of Puppeteer).
- `test_r2001_hosted.js` — the 17-check hosted-mode suite covering
  T001–T003 and all R2-001 acceptance criteria. Expects the app served
  with the three CSV fixtures below copied alongside `index.html`, at
  `http://localhost:8900`, and Chrome's CDP endpoint at
  `http://localhost:9226` (edit constants at top to match your setup).
- `test_r2001_file.js` — the 4-check `file://`-mode suite. Edit the
  `APP_URL` placeholder at the top to your actual `30_WEB_APP/
  index.html` path before running. Expects Chrome's CDP endpoint at
  `http://localhost:9227`.
- `fixture_good.csv` — 3 well-formed rows, no conflicts.
- `fixture_dup_in_file.csv` — 2 rows sharing one `[namespace,
  identifier]` key (tests BLOCKER conflict classification — both rows
  must be flagged, not just the second one; see TASK_RESULT.md's
  Decisions for why this specific case matters).
- `fixture_reordered.csv` — `fixture_good.csv`'s 3 rows in a different
  order (tests row-position independence / idempotent re-import after
  reordering).

## How to rerun (example)

```bash
# Hosted suite — copy fixtures next to the app first
cp fixture_*.csv /path/to/30_WEB_APP/
cd /path/to/30_WEB_APP && python3 -m http.server 8900 &
/path/to/chrome --headless=new --remote-debugging-port=9226 \
  --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --user-data-dir=/tmp/some-profile about:blank &
sleep 3
node test_r2001_hosted.js

# file:// suite — no server, no fixture files needed (fixture content
# is inlined in the test script as an in-memory File object)
/path/to/chrome --headless=new --remote-debugging-port=9227 \
  --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --allow-file-access-from-files \
  --user-data-dir=/tmp/some-other-profile about:blank &
sleep 3
node test_r2001_file.js
```

Each script exits non-zero if any check fails and prints a PASS/FAIL
line per check plus a summary.

## Why this matters for future tasks

This suite's first run found a real bug (partial-BLOCKER commit on
duplicate in-file identifiers) that a purely code-review pass would
likely have missed, because the bug only manifests when you actually
run the commit path against real data and count the resulting rows.
Keep running the full suite (not just spot-checking a few cases) after
any change to `import.js`'s conflict-detection or identity-resolution
logic.
