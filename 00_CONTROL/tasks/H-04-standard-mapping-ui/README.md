# H-04 — Standard Mapping UI (2026-08-30)

## What this task built

`30_WEB_APP/app.js` had zero UI for `standard_mapping` — `db.js`'s
`createStandardMapping`/`listStandardMappingsForEntity` existed but
were unreachable from any user action. This task added:

- A "مطابقات المعايير القياسية (Standard Mappings)" section inside
  `selectEntity`'s panel render, listing existing mappings for the
  selected entity via `standardMappingRowHtml` (new function, same
  pattern as the existing `evidenceRowHtml`/`relationshipRowHtml`).
- A `#standard-mapping-form` with fields for `standard_name`,
  `standard_identifier`, `mapping_type` (equivalence/partial/candidate),
  `validation_state` (UNREVIEWED/OBSERVED/VALIDATED/REJECTED), and
  optional `notes`.
- A submit handler calling `KimaDB.createStandardMapping` with the
  selected entity's `entity_id`, then re-rendering via `selectEntity`
  — same success/error/`toast()` pattern as every other form in this
  file (`identifier-form`, `relationship-form`, `source-form`,
  `evidence-form`).
- Added `KimaDB.listStandardMappingsForEntity(entityId)` to the
  existing `Promise.all` fetch in `selectEntity`.

## What was verified, and how

1. `node --check app.js` — clean, confirms no syntax error was
   introduced.
2. `node 30_WEB_APP/decision.test.mjs` — re-run, `PASS`, confirms no
   regression to the decision engine (untouched by this change, but
   re-run as standing discipline for any `30_WEB_APP/` edit).
3. `node_logic_test.mjs` (this directory, 4/4 checks) — verifies the
   parts of `createStandardMapping`'s own logic that do NOT require a
   real IndexedDB: the `VALIDATION_STATES` options offered by the new
   `<select>` are all valid against the real exported constant (not a
   hand-copied list); `mapping_type` is confirmed free-string
   defaulting to `'equivalence'` per the actual `db.js` source line;
   the synchronous required-field guard (`entity_id`/`standard_name`/
   `standard_identifier`) throws before any DB call for two missing-
   field cases.

## What was NOT verified — real, named gaps

- **No real browser was available in this session.** Network access
  is disabled in this sandbox's `bash_tool`, and `npm install
  fake-indexeddb` failed with a 403 (registry unreachable) — attempted
  and failed, not simply assumed unavailable. This means:
  - The `#standard-mapping-form` was never actually submitted in a
    real DOM. Whether the form's fields bind correctly, whether the
    submit handler fires, and whether `selectEntity` correctly
    re-renders afterward are all unconfirmed.
  - `createStandardMapping`'s actual IndexedDB write (the `add()` call
    inside `runTransaction`) was not exercised — only the pre-DB
    synchronous validation was testable this way.
  - `standardMappingRowHtml`'s rendered output was not visually or
    DOM-inspected — only written and `node --check`-syntax-verified.
  - Referential-integrity behavior (e.g. rejecting a non-existent
    `entity_id`) requires a real `entity` object store and was not
    exercised.
- This is the same evidence tier as every gap this project has closed
  purely via Node-only logic review before a real browser became
  available (e.g. H-05/H-06's original 2026-08-28 state before
  ADR-021/022's real-device confirmation) — **not** the "real-browser-
  verified" tier ADR-023 through ADR-027/M-16/M-17 reached. This gap
  should not be marked CLOSED in `V3_GAP_REGISTER.txt` on the strength
  of this task alone.

## Recommended next step

When a real browser (headless Chromium, per the project's existing
`00_CONTROL/tasks/*-test-harness/` pattern) or `fake-indexeddb` (once
network access is available) is reachable, a harness should: create an
entity, submit the new form, confirm the created mapping round-trips
through `listStandardMappingsForEntity` and renders in the DOM, and
confirm an invalid `entity_id` case is rejected — mirroring the rigor
`R2-003-test-harness`/`T012-test-harness` applied to their own features.
