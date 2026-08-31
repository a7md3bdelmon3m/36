// H-07 (P&ID locator), H-08 (field observation), H-10 (retention/
// resolvability), H-11 (migration registry) — Node-only logic
// verification.
//
// Same real limit as H-04/ADR-031: no real browser is reachable in this
// session's sandbox (network disabled, no Chromium binary found, and
// `npm install fake-indexeddb --no-save` was attempted fresh in this
// task — not assumed from ADR-031's prior result — and failed with the
// same 403 Forbidden). This test therefore verifies only the parts of
// db.js's new functions that do not require a real IndexedDB write: the
// synchronous pre-DB-touch validation guards, the exported schema
// constants, and the migration registry's own internal consistency.
//
// Explicitly NOT verified here (see this directory's README.md for the
// full list): any actual IndexedDB write/read for drawing,
// drawing_locator, field_observation, or the retention_status field;
// the four new forms' DOM submission handlers actually firing;
// navigateEntityToDrawings' join logic against real stored rows;
// getEvidenceResolvability's actual multi-artifact resolution logic
// against real data; the onupgradeneeded handler actually creating the
// three new object stores on a real browser's IndexedDB.

import { KimaDB } from '../../../30_WEB_APP/db.js';

let pass = 0, fail = 0;
function record(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${detail || ''}`); }
}

// ---- H-11: migration registry ----

record(
  'H11-1-registry-exported',
  Array.isArray(KimaDB.MIGRATION_REGISTRY) && KimaDB.MIGRATION_REGISTRY.length >= 2,
  JSON.stringify(KimaDB.MIGRATION_REGISTRY),
);

record(
  'H11-2-registry-has-exactly-one-entry-per-version-through-DB_VERSION',
  KimaDB.MIGRATION_REGISTRY.every((m, i, arr) => i === 0 || m.to_version === arr[i - 1].to_version + 1)
    && KimaDB.MIGRATION_REGISTRY[KimaDB.MIGRATION_REGISTRY.length - 1].to_version === KimaDB.DB_VERSION,
  `registry versions: ${KimaDB.MIGRATION_REGISTRY.map((m) => m.to_version).join(',')}, DB_VERSION: ${KimaDB.DB_VERSION}`,
);

record(
  'H11-3-migrationsBetween-returns-correct-slice',
  (() => {
    const entries = KimaDB.migrationsBetween(6, 8);
    return entries.length === 2 && entries[0].to_version === 7 && entries[1].to_version === 8;
  })(),
);

record(
  'H11-4-migrationsBetween-throws-on-registry-gap',
  (() => {
    try {
      KimaDB.migrationsBetween(3, 8); // v4/v5/v6 predate this registry — no entries exist for them
      return false;
    } catch (e) {
      return /Migration registry gap/.test(e.message);
    }
  })(),
);

record(
  'H11-5-v8-entry-names-the-three-new-stores',
  (() => {
    const v8 = KimaDB.MIGRATION_REGISTRY.find((m) => m.to_version === 8);
    return v8 && ['drawing', 'drawing_locator', 'field_observation'].every((s) => v8.stores_added.includes(s));
  })(),
);

// ---- H-07: drawing / drawing_locator ----

record(
  'H07-1-createDrawing-throws-before-db-touch-when-drawing_number-missing',
  await (async () => {
    try { await KimaDB.createDrawing({}); return false; }
    catch (e) { return /drawing_number is required/.test(e.message); }
  })(),
);

record(
  'H07-2-createDrawingLocator-throws-before-db-touch-when-entity_id-missing',
  await (async () => {
    try { await KimaDB.createDrawingLocator({ drawing_id: 'dwg_x', evidence_id: 'evd_x' }); return false; }
    catch (e) { return /entity_id and drawing_id are required/.test(e.message); }
  })(),
);

record(
  'H07-3-createDrawingLocator-throws-before-db-touch-when-evidence_id-missing',
  // This is the literal implementation of PNID_NAVIGATION_SPEC.md's
  // "No P&ID link is considered authoritative without a source/evidence
  // reference" — evidence_id must be checked and rejected even before
  // entity_id/drawing_id existence is checked against the DB.
  await (async () => {
    try { await KimaDB.createDrawingLocator({ entity_id: 'ent_x', drawing_id: 'dwg_x' }); return false; }
    catch (e) { return /evidence_id is required/.test(e.message) && /no P&ID link is authoritative without evidence/.test(e.message); }
  })(),
);

// ---- H-08: field_observation ----

record(
  'H08-1-createFieldObservation-throws-before-db-touch-when-entity_id-missing',
  await (async () => {
    try { await KimaDB.createFieldObservation({ value: '82' }); return false; }
    catch (e) { return /entity_id and value are required/.test(e.message); }
  })(),
);

record(
  'H08-2-createFieldObservation-throws-before-db-touch-when-value-missing',
  await (async () => {
    try { await KimaDB.createFieldObservation({ entity_id: 'ent_x' }); return false; }
    catch (e) { return /entity_id and value are required/.test(e.message); }
  })(),
);

record(
  'H08-3-createFieldObservation-rejects-invalid-validation_state-before-db-touch',
  // assertValidationState runs before any DB call in every other
  // create* function in db.js (createEvidence, createObservation,
  // createStandardMapping) — confirming createFieldObservation follows
  // the same existing pattern rather than inventing a new one.
  await (async () => {
    try { await KimaDB.createFieldObservation({ entity_id: 'ent_x', value: '1', validation_state: 'NOT_A_REAL_STATE' }); return false; }
    catch (e) { return /Invalid validation_state/.test(e.message); }
  })(),
);

record(
  'H08-4-value-zero-is-not-treated-as-missing',
  // a.value===undefined check (not !a.value) — value of 0 or '' must
  // still pass the presence guard, since 0 is a legitimate field reading.
  // This only tests that the guard is NOT triggered; it will fail later
  // for lack of a real entity_id, at the DB layer this test cannot reach.
  await (async () => {
    try {
      await KimaDB.createFieldObservation({ entity_id: 'ent_nonexistent', value: 0 });
      return false; // should not reach here without a real DB
    } catch (e) {
      // Must NOT be the presence-guard error; must be a downstream (DB-layer) error instead.
      return !/entity_id and value are required/.test(e.message);
    }
  })(),
);

// ---- H-10: retention / resolvability ----

record(
  'H10-1-RETENTION_STATUSES-exported-and-correct',
  Array.isArray(KimaDB.RETENTION_STATUSES)
    && ['ACTIVE', 'ARCHIVED', 'UNAVAILABLE'].every((s) => KimaDB.RETENTION_STATUSES.includes(s)),
  JSON.stringify(KimaDB.RETENTION_STATUSES),
);

record(
  'H10-2-setArtifactRetentionStatus-rejects-invalid-status-before-db-touch',
  await (async () => {
    try { await KimaDB.setArtifactRetentionStatus('art_x', 'DELETED_FOREVER'); return false; }
    catch (e) { return /Invalid retention_status/.test(e.message); }
  })(),
);

// ---- Cross-cutting: STORE_NAMES / backup format consistency ----

{
  const src = await (await import('node:fs/promises')).readFile(
    new URL('../../../30_WEB_APP/db.js', import.meta.url),
    'utf8',
  );
  record(
    'CROSS-1-STORE_NAMES-includes-all-three-new-stores',
    ['drawing', 'drawing_locator', 'field_observation'].every((s) => src.includes(`'${s}'`)),
  );
  record(
    'CROSS-2-exportBackup-uses-V8-format-string',
    src.includes("format:'KIMA_EIS_BACKUP_V8'"),
  );
  record(
    'CROSS-3-importBackup-still-accepts-V7-for-backward-compat',
    src.includes('KIMA_EIS_BACKUP_V7') && src.includes('KIMA_EIS_BACKUP_V8'),
  );
  record(
    'CROSS-4-drawing_locator-import-validation-enforces-evidence_id',
    /Invalid backup drawing_locator reference: evidence_id required/.test(src),
  );
}

console.log(`\nH07_H08_H10_H11_NODE_LOGIC_TEST=${fail === 0 ? 'PASS' : 'FAIL'} (${pass}/${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
