# R2-003 Test Harness

Same dependency-free raw-CDP driver pattern as every prior harness
directory; `cdp.js` here is an unmodified copy of
`R3-002-test-harness/cdp.js`.

This harness did not exist before ADR-025 (2026-08-30). R2-003 (the
Excel/CSV-to-relationship import pipeline) had only Node-only logic
verification (see `R2-003-TASK_RESULT.md`) plus incidental general
xlsx-pipeline coverage from R2-002's own harness (ADR-023) — but that
harness only ever exercised entity import, never the
relationship-specific commit path (`findEntitiesByCanonicalName`,
`commitImportRelationshipRow`, the import-mode-switch UI). This closes
that specific gap: the first real-browser execution of R2-003's own
code paths.

## Files

- `cdp.js` — CDP client with console + network request capture.
- `test_r2003_hosted.js` — 17-check hosted-mode suite. Seeds 5
  entities (including two sharing `canonical_name: 'DUPTAG'` across
  different `entity_type`s, to exercise the ambiguous-endpoint BLOCKER
  path deliberately). Follows R2-002's own established precedent of
  constructing a real in-browser `File` object (CSV, for simplicity —
  R2-003's plan-builder is format-agnostic and the xlsx *parsing* path
  itself is already covered by R2-002/ADR-023) and driving
  `RelationshipImportPipeline.previewRelationshipImport` /
  `commitRelationshipImport` directly against the real, unmocked
  `import.js`/`db.js`. Also separately drives the real mode-switch
  radio buttons in the DOM (`#import-mode-relationships`) to confirm
  the UI wiring itself toggles the two panels, not just the pipeline
  functions in isolation. Expects the app at `http://localhost:8908`
  and Chrome's CDP endpoint at `http://127.0.0.1:9238`.

No `file://`-mode variant was written for this harness in this
session — see ADR-025 in `DECISION_LOG.md` for why, and treat that as
an explicit remaining gap, not an oversight to assume is covered.

## What it covers (mapped to R2-003-TASK_CONTRACT.md's 7 acceptance criteria)

1. Ambiguous endpoint resolution (0 or 2+ matches) → BLOCKER at
   preview: covered (`DUPTAG` row).
2. Invalid `relationship_type` / invalid `direction` → BLOCKER at
   preview, same message shape `assertRelationshipSemantics` would
   throw: covered (two separate rows, one per condition).
3. Commit with zero BLOCKER rows creates one `relationship` record per
   row via the real `createRelationship`, each with its own `evidence`
   record: covered — verified the returned `evidence_id` actually
   matches the `evidence_id` stored on the committed relationship
   record in IndexedDB, not just that commit "succeeded".
4. BLOCKER rows skipped at commit, never partially written: covered —
   verified the skipped-row numbers exactly match the BLOCKER rows,
   and the DB's actual relationship count matches the committed count
   exactly (no silent partial writes).
5. Exact-duplicate-row handling (INFO, not BLOCKER, and both copies
   still commit): covered — the plan-builder's own documented design
   choice (see `import.js`'s comment on this) held under real
   execution, not just Node-mocked review.
6. No regression to the entity-import pipeline
   (`recognizeHeaders`/`KNOWN_HEADERS`): covered — re-checked the
   entity header-recognition map resolves identically to before this
   task existed.
7. `findEntitiesByCanonicalName` is additive, doesn't alter existing
   lookup functions: NOT independently re-verified by this harness
   (it's exercised indirectly via the ambiguous/unique-match rows, but
   this harness doesn't diff `findEntityIdentifier`/`searchEntities`
   behavior before/after — that comparison was already done at the
   Node-logic-review stage per R2-003-TASK_RESULT.md and not repeated
   here).

## How to rerun (example)

```bash
cd /path/to/30_WEB_APP && python3 -m http.server 8908 &
/path/to/chrome --headless=new --remote-debugging-port=9238 \
  --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --user-data-dir=/tmp/some-profile about:blank &
sleep 3
node test_r2003_hosted.js
```

As with R3-002-test-harness's own note: in some sandboxed
environments, backgrounded processes do not survive between separate
tool-call boundaries — launch the HTTP server, Chrome, and the test
script all within one shell invocation.

## Results (ADR-025, 2026-08-30)

17/17 checks passed, zero console errors. Real IndexedDB writes
confirmed: exactly 2 relationships committed (the valid row and its
exact-duplicate INFO-flagged twin), exactly 3 skipped (matching the 3
BLOCKER rows by row number), and each committed relationship's
`evidence_id` in the database independently confirmed to match what
`commitRelationshipImport`'s return value reported — not merely
trusting the function's own success claim.

## Why this matters for future tasks

Rerun the full suite (not a subset) after any change to
`buildRelationshipImportPlan`, `findEntitiesByCanonicalName`,
`commitImportRelationshipRow`, `RELATIONSHIP_KNOWN_HEADERS`, or the
import-mode-switch UI in `app.js`/`index.html`.
