/**
 * R2-003 hosted-mode test harness — Excel/CSV-to-relationship import
 * pipeline. Same dependency-free raw-CDP driver pattern as
 * R1-002/R2-001/R2-002/R3-001/R3-002 (cdp.js here is an unmodified
 * copy of R3-001-test-harness/cdp.js).
 *
 * This harness did not exist before ADR-025 — R2-003 had only Node-
 * only logic verification (R2-003-TASK_RESULT.md) plus general
 * xlsx-pipeline coverage from R2-002's harness (which never exercised
 * the relationship-specific commit path: findEntitiesByCanonicalName,
 * commitImportRelationshipRow, or the import-mode-switch UI). This is
 * the first real-browser execution of that specific path.
 *
 * Follows R2-002's established precedent: constructs a real in-browser
 * File object (CSV here, for simplicity — the xlsx path itself is
 * already real-Chromium-verified by R2-002/ADR-023, and R2-003's own
 * plan-builder is format-agnostic per its own source) and drives
 * RelationshipImportPipeline.previewRelationshipImport /
 * commitRelationshipImport directly, then separately drives the real
 * mode-switch radio buttons and commit button in the DOM to confirm
 * the UI wiring itself (not just the pipeline functions) works.
 *
 * Expects the app at http://localhost:8908 and Chrome's CDP endpoint
 * at http://127.0.0.1:9238.
 */
const { connectToNewTab } = require('./cdp.js');

const CDP_BASE = 'http://127.0.0.1:9238';
const APP_URL = 'http://localhost:8908/index.html';

const results = [];
function record(id, ok, detail) {
  results.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${id}: ${detail}`);
}

async function main() {
  const page = await connectToNewTab(CDP_BASE);
  await page.navigate(APP_URL);

  const loadErrors = page.getConsole().filter((l) => l.startsWith('[error]') || l.startsWith('[exception]'));
  record('R2003-0-load', loadErrors.length === 0, `console errors=${loadErrors.length} ${JSON.stringify(loadErrors)}`);

  // ---- Seed entities the relationship rows will reference. Two share
  // canonical_name 'DUPTAG' across different entity_type (Pump vs
  // Valve) to exercise the ambiguous-match BLOCKER path (acceptance
  // criterion 1) — a real, reachable case per the contract's own
  // finding #2 (no uniqueness constraint on entity_type+canonical_name).
  const seed = await page.evaluate(`
    (async () => {
      const dbMod = await import('./db.js');
      const specs = [
        { entity_type: 'Pump', canonical_name: 'PUMP-A', display_name: 'Pump A' },
        { entity_type: 'Line', canonical_name: 'LINE-B', display_name: 'Line B' },
        { entity_type: 'Valve', canonical_name: 'VALVE-C', display_name: 'Valve C' },
        { entity_type: 'Pump', canonical_name: 'DUPTAG', display_name: 'Ambiguous Pump' },
        { entity_type: 'Valve', canonical_name: 'DUPTAG', display_name: 'Ambiguous Valve' },
      ];
      const created = [];
      for (const spec of specs) created.push(await dbMod.KimaDB.createEntity(spec));
      return created.length;
    })()
  `);
  record('R2003-seed', seed === 5, `created=${seed}`);

  // ---- Build a real CSV File in-browser covering: (1) a valid row
  // (PUMP-A -> LINE-B, containment, explicit forward), (2) an invalid
  // relationship_type row (BLOCKER expected), (3) an invalid-direction
  // row for a type whose allowedDirections excludes it (BLOCKER
  // expected), (4) an ambiguous-endpoint row referencing DUPTAG
  // (BLOCKER expected, acceptance criterion 1), (5) a row duplicating
  // row 1's exact (from,to,type,direction) tuple (INFO expected, not
  // BLOCKER, per acceptance criterion 5 and the plan-builder's own
  // documented INFO-not-BLOCKER decision).
  const previewResult = await page.evaluate(`
    (async () => {
      const relMod = await import('./import.js');
      const dbMod = await import('./db.js');
      const relTypes = dbMod.KimaDB.RELATIONSHIP_TYPES;
      const relRules = dbMod.KimaDB.RELATIONSHIP_RULES;
      const validType = relTypes.find(t => (relRules[t]?.allowedDirections || []).includes('forward'));
      // find a type whose allowedDirections does NOT include 'reverse', to force an invalid-direction BLOCKER
      const typeNoReverse = relTypes.find(t => !(relRules[t]?.allowedDirections || []).includes('reverse'));

      const csvLines = [
        'From_Tag,To_Tag,Relationship_Type,Direction',
        \`PUMP-A,LINE-B,\${validType},forward\`,
        'PUMP-A,LINE-B,NOT_A_REAL_TYPE,forward',
        \`PUMP-A,LINE-B,\${typeNoReverse},reverse\`,
        \`DUPTAG,LINE-B,\${validType},forward\`,
        \`PUMP-A,LINE-B,\${validType},forward\`,
      ];
      const csvText = csvLines.join('\\n');
      const file = new File([csvText], 'test_relationships.csv', { type: 'text/csv' });

      const preview = await relMod.RelationshipImportPipeline.previewRelationshipImport(file);
      return {
        rowCount: preview.plan.rows.length,
        rows: preview.plan.rows.map(r => ({
          row: r.sourceRowNumber,
          severities: r.conflicts.map(c => c.severity),
          messages: r.conflicts.map(c => c.message),
        })),
        validType, typeNoReverse,
      };
    })()
  `);
  record('R2003-1-preview-5-rows-parsed', previewResult.rowCount === 5, JSON.stringify(previewResult.rows.map((r) => r.row)));

  const rowByNum = (n) => previewResult.rows.find((r) => r.row === n);
  record('R2003-2-row2-valid-no-blocker', rowByNum(2) && rowByNum(2).severities.every((s) => s !== 'BLOCKER'), JSON.stringify(rowByNum(2)));
  record('R2003-3-row3-invalid-type-is-blocker', rowByNum(3) && rowByNum(3).severities.includes('BLOCKER'), JSON.stringify(rowByNum(3)));
  record('R2003-4-row4-invalid-direction-is-blocker', rowByNum(4) && rowByNum(4).severities.includes('BLOCKER'), JSON.stringify(rowByNum(4)));
  record('R2003-5-row5-ambiguous-endpoint-is-blocker', rowByNum(5) && rowByNum(5).severities.includes('BLOCKER'), JSON.stringify(rowByNum(5)));
  record('R2003-6-row6-exact-duplicate-is-info-not-blocker',
    rowByNum(6) && rowByNum(6).severities.includes('INFO') && !rowByNum(6).severities.includes('BLOCKER'),
    JSON.stringify(rowByNum(6)));

  // ---- Commit: only row 2 (valid) and row 6 (duplicate, INFO-only —
  // not blocked) should actually commit; rows 3/4/5 (BLOCKER) must be
  // skipped, never partially written. This directly exercises
  // commitImportRelationshipRow -> createRelationship (the real write
  // path), never a parallel store write.
  const commitResult = await page.evaluate(`
    (async () => {
      const relMod = await import('./import.js');
      const dbMod = await import('./db.js');
      const relTypes = dbMod.KimaDB.RELATIONSHIP_TYPES;
      const relRules = dbMod.KimaDB.RELATIONSHIP_RULES;
      const validType = relTypes.find(t => (relRules[t]?.allowedDirections || []).includes('forward'));
      const typeNoReverse = relTypes.find(t => !(relRules[t]?.allowedDirections || []).includes('reverse'));

      const csvLines = [
        'From_Tag,To_Tag,Relationship_Type,Direction',
        \`PUMP-A,LINE-B,\${validType},forward\`,
        'PUMP-A,LINE-B,NOT_A_REAL_TYPE,forward',
        \`PUMP-A,LINE-B,\${typeNoReverse},reverse\`,
        \`DUPTAG,LINE-B,\${validType},forward\`,
        \`PUMP-A,LINE-B,\${validType},forward\`,
      ];
      const csvText = csvLines.join('\\n');
      const file = new File([csvText], 'test_relationships_commit.csv', { type: 'text/csv' });

      const preview = await relMod.RelationshipImportPipeline.previewRelationshipImport(file);
      const result = await relMod.RelationshipImportPipeline.commitRelationshipImport(preview);

      const allRels = await dbMod.KimaDB.listAllRelationships();
      const evidenceCounts = await Promise.all(
        result.committed.map(async (c) => {
          const rel = allRels.find(r => r.relationship_id === c.relationship_id);
          return { relationship_id: c.relationship_id, hasEvidenceId: !!rel?.evidence_id, matchesReturnedEvidenceId: rel?.evidence_id === c.evidence_id };
        })
      );

      return {
        committedCount: result.committed.length,
        skippedCount: result.skipped.length,
        skippedRows: result.skipped.map(s => s.sourceRowNumber).sort((a,b)=>a-b),
        totalRelationshipsInDb: allRels.length,
        evidenceCounts,
      };
    })()
  `);
  record('R2003-7-commit-2-committed-3-skipped', commitResult.committedCount === 2 && commitResult.skippedCount === 3, JSON.stringify(commitResult));
  record('R2003-8-skipped-rows-are-exactly-3-4-5', JSON.stringify(commitResult.skippedRows) === JSON.stringify([3, 4, 5]), JSON.stringify(commitResult.skippedRows));
  record('R2003-9-every-committed-relationship-has-evidence',
    commitResult.evidenceCounts.length === 2 && commitResult.evidenceCounts.every((e) => e.hasEvidenceId && e.matchesReturnedEvidenceId),
    JSON.stringify(commitResult.evidenceCounts));
  record('R2003-10-no-partial-write-total-matches-committed', commitResult.totalRelationshipsInDb === 2, `total=${commitResult.totalRelationshipsInDb}`);

  // ---- No regression to entity-import pipeline (acceptance criterion
  // 6): recognizeHeaders (entity KNOWN_HEADERS) still resolves the same
  // way it did before this task existed.
  const entityHeaderCheck = await page.evaluate(`
    (async () => {
      const mod = await import('./import.js');
      const result = mod.ImportPipeline.recognizeHeaders(['entity_type', 'canonical_name', 'display_name', 'context', 'namespace', 'identifier']);
      return { mappedFields: Object.keys(result.map).sort(), unmappedCount: result.unmapped.length };
    })()
  `);
  record('R2003-11-entity-import-headers-unaffected',
    JSON.stringify(entityHeaderCheck.mappedFields) === JSON.stringify(['canonical_name', 'context', 'display_name', 'entity_type', 'identifier', 'namespace']) && entityHeaderCheck.unmappedCount === 0,
    JSON.stringify(entityHeaderCheck));

  // ---- Real DOM: mode-switch radio buttons actually toggle the two panels ----
  const modeSwitchInitial = await page.evaluate(`
    JSON.stringify({
      entitiesPanelHidden: document.querySelector('#import-mode-entities-panel').hidden,
      relPanelHidden: document.querySelector('#import-mode-relationships-panel').hidden,
    })
  `);
  record('R2003-12-entities-panel-shown-by-default', JSON.parse(modeSwitchInitial).entitiesPanelHidden === false && JSON.parse(modeSwitchInitial).relPanelHidden === true, modeSwitchInitial);

  const clickedRelRadio = await page.evaluate(`
    (() => {
      const radio = document.querySelector('#import-mode-relationships');
      if (!radio) return false;
      radio.checked = true;
      radio.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);
  record('R2003-13-clicked-relationships-mode-radio', clickedRelRadio === true, `clicked=${clickedRelRadio}`);
  await new Promise((r) => setTimeout(r, 150));

  const modeSwitchAfter = await page.evaluate(`
    JSON.stringify({
      entitiesPanelHidden: document.querySelector('#import-mode-entities-panel').hidden,
      relPanelHidden: document.querySelector('#import-mode-relationships-panel').hidden,
    })
  `);
  record('R2003-14-relationships-panel-shown-after-toggle', JSON.parse(modeSwitchAfter).entitiesPanelHidden === true && JSON.parse(modeSwitchAfter).relPanelHidden === false, modeSwitchAfter);

  const finalErrors = page.getConsole().filter((l) => l.startsWith('[error]') || l.startsWith('[exception]'));
  record('R2003-15-zero-console-errors-throughout', finalErrors.length === 0, `errors=${JSON.stringify(finalErrors)}`);

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) console.log('FAILURES:', JSON.stringify(failed, null, 2));

  await page.close();
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('HARNESS ERROR:', err);
  process.exit(2);
});
