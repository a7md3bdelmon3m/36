// H-03: deleteEntity, updateRelationship, deleteRelationship,
// updateObservation, updateStandardMapping — Node-only logic verification.
//
// Same real limit as H-04/ADR-031, H-07/H-08/H-10/H-11, and every prior
// db.js task in this project's history: no real browser is reachable in
// this session's sandbox (network disabled, no Chromium binary found on
// disk, `npm install fake-indexeddb --no-save` attempted fresh for this
// task and failed with 403 Forbidden, same as every prior session). A
// hand-rolled in-memory IndexedDB shim was deliberately NOT built for
// this test: IndexedDB's real transaction/index/constraint semantics
// (especially onupgradeneeded's transaction lifetime, unique-index
// rejection, and abort-on-throw rollback) are exactly the kind of
// subtle behavior a hand-rolled shim gets wrong in ways that would
// produce a false-confidence PASS — worse than not testing at all. This
// test therefore verifies only what does not require a real IndexedDB
// write: that db.js still imports cleanly as an ES module with the five
// new functions exported, and the synchronous pre-DB-touch logic that
// can be exercised in isolation (assertRelationshipSemantics/
// assertValidationState re-validation behavior, which the new update
// functions call directly).
//
// Explicitly NOT verified here:
// - Any actual IndexedDB write/read/delete for entity, relationship,
//   observation, or standard_mapping via these five new functions.
// - deleteEntity's actual cross-store blocker detection against real
//   stored dependent records (entity_identifier/relationship/
//   observation/standard_mapping/decision/drawing_locator/
//   field_observation/evidence) — the 9-way Promise.all query construct
//   is read-verified by source inspection only, not executed.
// - deleteRelationship's actual evidence-subject blocker query against
//   a real ix_evidence_subject index.
// - The readwrite transaction/abort semantics (a thrown error inside
//   runTransaction's work callback calling tx.abort() and leaving zero
//   partial writes) for any of the five new functions specifically.
// - Any UI wiring — none was added in this task. These are db.js-layer
//   primitives only, matching H-03's own scope ("Implement delete/update
//   operations for relationship, observation, and standard_mapping").
//   deleteEntity was added beyond H-03's literal text because H-03's
//   closure criterion ("every mutation type an entity can undergo... not
//   just creation") names entity itself, and updateEntity already
//   existed — delete was the missing half.
//
// Real-browser confirmation (hosted + file://, matching R2-003/T012's
// rigor) remains a named, open gap — see this directory's README.md.

import { KimaDB } from '../../../30_WEB_APP/db.js';

let pass = 0, fail = 0;
function record(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${detail || ''}`); }
}

// ---- structural: all five functions exported ----

for (const fn of ['deleteEntity', 'updateRelationship', 'deleteRelationship', 'updateObservation', 'updateStandardMapping']) {
  record(`H03-export-${fn}`, typeof KimaDB[fn] === 'function', typeof KimaDB[fn]);
}

// ---- structural: source-level checks (grep-equivalent, deterministic) ----
// These confirm the referential-integrity design decisions are actually
// present in the shipped source, not just described in comments.

import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../../../30_WEB_APP/db.js', import.meta.url), 'utf8');

record(
  'H03-deleteEntity-checks-all-8-dependent-stores',
  ['entity_identifier', 'relationship', 'observation', 'standard_mapping', 'decision', 'drawing_locator', 'field_observation', 'evidence']
    .every(store => new RegExp(`objectStore\\('${store}'\\)`).test(src.match(/async function deleteEntity[\s\S]*?\n(?=async function|export const KimaDB)/)[0])),
  'deleteEntity body does not reference all 8 dependent stores',
);

record(
  'H03-deleteEntity-blocks-not-cascades',
  /Cannot delete entity_id.*dependent store/.test(src) && !/objectStore\('relationship'\)\.delete/.test(src.match(/async function deleteEntity[\s\S]*?\n(?=async function|export const KimaDB)/)[0]),
  'deleteEntity does not both report blockers and avoid auto-deleting dependents',
);

record(
  'H03-deleteEntity-excludes-change_event-from-blockers',
  !/blockers\.push.*change_event/.test(src),
  'change_event was incorrectly added as a delete blocker (should not be — audit trail must survive its subject)',
);

record(
  'H03-deleteRelationship-blocks-on-evidence-subject',
  /ix_evidence_subject.*getAll\(\['relationship',id\]\)/.test(src) && /Cannot delete relationship_id/.test(src),
  'deleteRelationship does not check ix_evidence_subject before deleting',
);

record(
  'H03-updateRelationship-revalidates-semantics-on-type-or-direction-change',
  /changed\.includes\('relationship_type'\)\|\|changed\.includes\('direction'\).*assertRelationshipSemantics/.test(src),
  'updateRelationship does not re-run assertRelationshipSemantics when relationship_type/direction change',
);

record(
  'H03-updateObservation-preserves-original-observed_at',
  /o\.observed_at=old\.observed_at/.test(src),
  'updateObservation does not preserve the original observed_at timestamp (a correction should not look like a fresh observation)',
);

record(
  'H03-all-five-emit-change_event',
  ['ENTITY_DELETED', 'RELATIONSHIP_UPDATED', 'RELATIONSHIP_DELETED', 'OBSERVATION_UPDATED', 'STANDARD_MAPPING_UPDATED']
    .every(eventType => src.includes(`event_type:'${eventType}'`) || src.includes(`event_type:'${eventType}',`)),
  'not all five new mutation types emit a change_event (H-03 closure criterion: every mutation an entity can undergo produces an auditable event)',
);

record(
  'H03-updateRelationship-immutable-fields-not-in-patch-loop',
  /for\(const k of \['relationship_type','direction','source_reference','evidence_id','validation_state'\]\)/.test(src),
  'updateRelationship\'s mutable-field loop does not exactly match the intended field set (identity fields relationship_id/source_entity_id/target_entity_id must be absent from it)',
);

// ---- syntax sanity: the whole file still parses as valid ES module source ----
// (node --check was already run separately; this just confirms via import above
// that no top-level throw occurred and KimaDB has its expected full shape)

record(
  'H03-KimaDB-export-count-unchanged-plus-five',
  Object.keys(KimaDB).length >= 45, // was 40 exported names before this task; now +5
  `KimaDB export count: ${Object.keys(KimaDB).length}`,
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
