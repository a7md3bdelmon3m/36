// H-04 standard mapping UI — Node-only logic verification.
//
// No real browser is available in this session's sandbox (network
// disabled, no Chromium binary reachable, fake-indexeddb could not be
// installed — npm registry access returned 403). This test therefore
// verifies the pieces of createStandardMapping's own validation logic
// that do NOT require a real IndexedDB, by re-deriving the same checks
// db.js performs, against the actual VALIDATION_STATES constant
// imported from db.js itself (not a hand-copied list, so this cannot
// silently drift from the real source of truth).
//
// This is NOT a substitute for real-browser confirmation that the new
// #standard-mapping-form actually submits, that createStandardMapping
// is actually called with the right entity_id, or that the DOM row
// renders correctly. Those remain open, named gaps — see this
// directory's README.md.

import { KimaDB } from '../../../30_WEB_APP/db.js';

let pass = 0, fail = 0;
function record(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${detail || ''}`); }
}

// 1. VALIDATION_STATES is exported and contains the states the new
//    form's <select> offers.
const offered = ['UNREVIEWED', 'OBSERVED', 'VALIDATED', 'REJECTED'];
record(
  'H04-1-offered-states-are-all-valid',
  offered.every((s) => KimaDB.VALIDATION_STATES.includes(s)),
  JSON.stringify({ offered, real: KimaDB.VALIDATION_STATES }),
);

// 2. mapping_type options offered by the new form (equivalence/partial/
//    candidate) are accepted by createStandardMapping — this is NOT
//    constrained by db.js (mapping_type has no allow-list, it's a free
//    string defaulting to 'equivalence' if omitted), so this test just
//    confirms that fact rather than asserting a false constraint.
{
  const src = await (await import('node:fs/promises')).readFile(
    new URL('../../../30_WEB_APP/db.js', import.meta.url),
    'utf8',
  );
  const fn = src.match(/async function createStandardMapping\(a\)\{[\s\S]*?KimaDB\}/)?.[0]
    || src.match(/async function createStandardMapping\(a\)\{.*/)[0];
  record(
    'H04-2-mapping-type-is-free-string-defaulting-equivalence',
    fn.includes("a.mapping_type||'equivalence'"),
    'createStandardMapping should default mapping_type to equivalence when omitted, per db.js source',
  );
}

// 3. Required-field guard: createStandardMapping throws synchronously
//    (before ever touching IndexedDB) when entity_id/standard_name/
//    standard_identifier are missing — this part of the function runs
//    before any DB call, so it IS testable without a real IndexedDB.
{
  let threw = false;
  try {
    await KimaDB.createStandardMapping({ standard_name: 'x', standard_identifier: 'y' }); // missing entity_id
  } catch (e) {
    threw = /Invalid standard mapping/.test(e.message);
  }
  record('H04-3-missing-entity-id-throws-before-db-touch', threw);
}

{
  let threw = false;
  try {
    await KimaDB.createStandardMapping({ entity_id: 'ent_x', standard_identifier: 'y' }); // missing standard_name
  } catch (e) {
    threw = /Invalid standard mapping/.test(e.message);
  }
  record('H04-4-missing-standard-name-throws-before-db-touch', threw);
}

console.log(`\nH04_NODE_LOGIC_TEST=${fail === 0 ? 'PASS' : 'FAIL'} (${pass}/${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
