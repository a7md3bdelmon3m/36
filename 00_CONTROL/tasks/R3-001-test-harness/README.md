# R3-001 Test Harness

Same dependency-free raw-CDP driver pattern as the prior three harness
directories; `cdp.js` here is an unmodified copy of
`R2-002-test-harness/cdp.js` (network-monitoring-capable — used here to
verify R3-001 introduced zero new network dependencies, same as its
R2-002 precedent).

## Files

- `cdp.js` — CDP client with console + network request capture.
- `test_r3001_hosted.js` — 21-check hosted-mode suite. Seeds 25
  entities directly via `KimaDB.createEntity` (not through the UI form,
  for speed/determinism), then exercises search (exact/prefix/
  normalized), type/status filters (including combined AND), sort
  (both directions), pagination (page sizes, no overlap, boundary
  button states), empty-result state, and context-hierarchy parsing/
  display. Expects the app at `http://localhost:8908` and Chrome's CDP
  endpoint at `http://localhost:9238` (edit constants at top).
- `test_r3001_file.js` — 6-check `file://`-mode suite, smaller seed (5
  entities), same core coverage scaled down. Edit the `APP_URL`
  placeholder before running.

## How to rerun (example)

```bash
cd /path/to/30_WEB_APP && python3 -m http.server 8908 &
/path/to/chrome --headless=new --remote-debugging-port=9238 \
  --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --user-data-dir=/tmp/some-profile about:blank &
sleep 3
node test_r3001_hosted.js

/path/to/chrome --headless=new --remote-debugging-port=9239 \
  --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --allow-file-access-from-files \
  --user-data-dir=/tmp/some-other-profile about:blank &
sleep 3
node test_r3001_file.js
```

## Why this matters for future tasks

This suite's first run found two real bugs — one in the test script
itself (a seed spec that computed a `status` value but never attached
it to the created entity, silently making the combined-filter test
seed data wrong) and one in the actual application
(`parseContextHierarchy` treating any string with zero `/` characters
as a valid one-level hierarchy instead of unstructured text, which
would have shown fake breadcrumbs for ordinary free-text `context`
values). Both are documented in detail in
`R3-001-TASK_RESULT.md`'s Decisions section. Rerun the full suite (not
a subset) after any change to `searchEntities`, `parseContextHierarchy`,
or the explorer rendering logic in `app.js`.
