const { connectToNewTab } = require('./cdp.js');

const CDP_BASE = 'http://localhost:9226';
const APP_URL = 'http://localhost:8900/index.html';

const results = [];
function record(id, ok, detail) {
  results.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${id}: ${detail}`);
}

async function main() {
  const page = await connectToNewTab(CDP_BASE);
  await page.navigate(APP_URL);

  const loadErrors = page.getConsole().filter((l) => l.startsWith('[error]') || l.startsWith('[exception]'));
  record('R2-0-load', loadErrors.length === 0, `console errors=${loadErrors.length} ${JSON.stringify(loadErrors)}`);

  // Baseline entity/identifier counts before any import (regression check: R1 manual forms untouched).
  const baseline = await page.evaluate(`
    (async () => {
      const mod = await import('./db.js');
      const entities = await mod.KimaDB.listEntities();
      return entities.length;
    })()
  `);
  record('R2-0-baseline', baseline === 0, `entities before any import=${baseline}`);

  // ---- T001: source fingerprint ----
  const t001 = await page.evaluate(`
    (async () => {
      const mod = await import('./import.js');
      const text1 = await (await fetch('./fixture_good.csv')).text();
      const file1 = new File([text1], 'fixture_good.csv', { type: 'text/csv' });
      const file1b = new File([text1], 'fixture_good.csv', { type: 'text/csv' }); // same bytes, separate File instance
      const dbMod = await import('./db.js');
      const buf1 = await file1.arrayBuffer();
      const buf1b = await file1b.arrayBuffer();
      const fp1 = await dbMod.KimaDB.sha256HexBytes(buf1);
      const fp1b = await dbMod.KimaDB.sha256HexBytes(buf1b);

      const text2 = await (await fetch('./fixture_dup_in_file.csv')).text();
      const file2 = new File([text2], 'fixture_dup_in_file.csv', { type: 'text/csv' });
      const buf2 = await file2.arrayBuffer();
      const fp2 = await dbMod.KimaDB.sha256HexBytes(buf2);

      return { fp1, fp1b, fp2, sameFileStable: fp1 === fp1b, differentFileDiffers: fp1 !== fp2, fp1Length: fp1.length };
    })()
  `);
  record('T001-fingerprint-stable', t001.sameFileStable && t001.fp1Length === 64, JSON.stringify(t001));
  record('T001-fingerprint-differs', t001.differentFileDiffers, `fp1=${t001.fp1.slice(0,12)} fp2=${t001.fp2.slice(0,12)}`);

  // ---- Preview mutates nothing ----
  const beforePreview = await page.evaluate(`
    (async () => {
      const mod = await import('./db.js');
      return { entities: (await mod.KimaDB.listEntities()).length, sources: (await mod.KimaDB.listSources()).length };
    })()
  `);

  const previewRes = await page.evaluate(`
    (async () => {
      const mod = await import('./import.js');
      const text = await (await fetch('./fixture_good.csv')).text();
      const file = new File([text], 'fixture_good.csv', { type: 'text/csv' });
      const preview = await mod.ImportPipeline.previewImport(file);
      window.__preview_good = preview;
      return {
        checksum: preview.checksum,
        rowCount: preview.plan.rows.length,
        conflictCount: preview.plan.conflicts.length,
        unmapped: preview.headerReport.unmapped.length,
      };
    })()
  `);
  record('R2-preview-shape', previewRes.rowCount === 3 && previewRes.conflictCount === 0 && previewRes.unmapped === 0, JSON.stringify(previewRes));

  const afterPreview = await page.evaluate(`
    (async () => {
      const mod = await import('./db.js');
      return { entities: (await mod.KimaDB.listEntities()).length, sources: (await mod.KimaDB.listSources()).length };
    })()
  `);
  record('R2-preview-no-mutation', beforePreview.entities === afterPreview.entities && beforePreview.sources === afterPreview.sources, `before=${JSON.stringify(beforePreview)} after=${JSON.stringify(afterPreview)}`);

  // ---- T002: deterministic import (commit) ----
  const commit1 = await page.evaluate(`
    (async () => {
      const mod = await import('./import.js');
      const result = await mod.ImportPipeline.commitImport(window.__preview_good);
      const dbMod = await import('./db.js');
      const entities = await dbMod.KimaDB.listEntities();
      return { committedCount: result.committed.length, skippedCount: result.skipped.length, totalEntities: entities.length };
    })()
  `);
  record('T002-deterministic-import', commit1.committedCount === 3 && commit1.skippedCount === 0 && commit1.totalEntities === 3, JSON.stringify(commit1));

  // Verify all required CANONICAL_ENTITY_CONTRACT.md fields populated + original values preserved
  const fieldsCheck = await page.evaluate(`
    (async () => {
      const mod = await import('./db.js');
      const entities = await mod.KimaDB.listEntities();
      const pump = entities.find(e => e.canonical_name === 'PUMP-101-A');
      const ids = await mod.KimaDB.listIdentifiersForEntity(pump.entity_id);
      return {
        hasAllFields: !!(pump.entity_id && pump.entity_type && pump.canonical_name && pump.display_name && pump.status && pump.created_at && pump.updated_at),
        contextPreserved: pump.context === 'وحدة 100',
        displayNamePreserved: pump.display_name === 'مضخة التغذية الرئيسية 101-A',
        identifierRecorded: ids.length === 1 && ids[0].namespace === 'P&ID-TAG' && ids[0].identifier === 'PV-1042',
      };
    })()
  `);
  record('T002-fields-and-provenance', fieldsCheck.hasAllFields && fieldsCheck.contextPreserved && fieldsCheck.displayNamePreserved && fieldsCheck.identifierRecorded, JSON.stringify(fieldsCheck));

  // ---- T003: idempotent re-import (same file, second time) ----
  const reimport = await page.evaluate(`
    (async () => {
      const mod = await import('./import.js');
      const text = await (await fetch('./fixture_good.csv')).text();
      const file = new File([text], 'fixture_good.csv', { type: 'text/csv' });
      const preview2 = await mod.ImportPipeline.previewImport(file);
      const result2 = await mod.ImportPipeline.commitImport(preview2);
      const dbMod = await import('./db.js');
      const entities = await dbMod.KimaDB.listEntities();
      const allIds = [];
      for (const e of entities) {
        const ids = await dbMod.KimaDB.listIdentifiersForEntity(e.entity_id);
        allIds.push(...ids);
      }
      return {
        committedActions: result2.committed.map(c => c.action),
        totalEntitiesAfterReimport: entities.length,
        totalIdentifiersAfterReimport: allIds.length,
      };
    })()
  `);
  record('T003-idempotent-reimport-no-dup-entities', reimport.totalEntitiesAfterReimport === 3, `entities after 2nd import=${reimport.totalEntitiesAfterReimport}`);
  record('T003-idempotent-reimport-no-dup-identifiers', reimport.totalIdentifiersAfterReimport === 3, `identifiers after 2nd import=${reimport.totalIdentifiersAfterReimport}`);
  record('T003-idempotent-reimport-update-path', reimport.committedActions.every(a => a === 'update'), `actions=${JSON.stringify(reimport.committedActions)}`);

  // ---- Conflict classification: duplicate identifier within same file -> BLOCKER, not committed ----
  const conflictTest = await page.evaluate(`
    (async () => {
      const mod = await import('./import.js');
      const text = await (await fetch('./fixture_dup_in_file.csv')).text();
      const file = new File([text], 'fixture_dup_in_file.csv', { type: 'text/csv' });
      const preview = await mod.ImportPipeline.previewImport(file);
      const dbMod = await import('./db.js');
      const before = (await dbMod.KimaDB.listEntities()).length;
      const result = await mod.ImportPipeline.commitImport(preview);
      const after = (await dbMod.KimaDB.listEntities()).length;
      return {
        conflictSeverities: preview.plan.conflicts.map(c => c.severity),
        committedCount: result.committed.length,
        skippedCount: result.skipped.length,
        entitiesBefore: before,
        entitiesAfter: after,
      };
    })()
  `);
  record('R2-conflict-blocker-detected', conflictTest.conflictSeverities.includes('BLOCKER'), JSON.stringify(conflictTest.conflictSeverities));
  record('R2-conflict-blocker-not-committed', conflictTest.entitiesAfter === conflictTest.entitiesBefore, `before=${conflictTest.entitiesBefore} after=${conflictTest.entitiesAfter}`);

  // ---- Row-position independence: reordered CSV still resolves to the same 3 existing entities (idempotent, order-invariant) ----
  const reorderTest = await page.evaluate(`
    (async () => {
      const mod = await import('./import.js');
      const text = await (await fetch('./fixture_reordered.csv')).text();
      const file = new File([text], 'fixture_reordered.csv', { type: 'text/csv' });
      const preview = await mod.ImportPipeline.previewImport(file);
      const result = await mod.ImportPipeline.commitImport(preview);
      const dbMod = await import('./db.js');
      const entities = await dbMod.KimaDB.listEntities();
      return {
        actions: result.committed.map(c => c.action),
        totalEntities: entities.length,
      };
    })()
  `);
  record('R2-row-position-independence', reorderTest.totalEntities === 3 && reorderTest.actions.every(a => a === 'update'), JSON.stringify(reorderTest));

  // ---- UI wiring smoke check: form elements exist and are reachable ----
  const uiCheck = await page.evaluate(`
    (async () => {
      return {
        fileInput: !!document.querySelector('#import-file-input'),
        resultHost: !!document.querySelector('#import-result'),
        commitBtn: !!document.querySelector('#import-commit-btn'),
        commitBtnHiddenInitially: document.querySelector('#import-commit-btn').hidden,
      };
    })()
  `);
  record('R2-ui-elements-present', uiCheck.fileInput && uiCheck.resultHost && uiCheck.commitBtn, JSON.stringify(uiCheck));

  // ---- Regression: R1-001/R1-002 manual entity creation still works ----
  const regressionCheck = await page.evaluate(`
    (async () => {
      const form = document.querySelector('#entity-form');
      form.entity_type.value = 'Sensor';
      form.canonical_name.value = 'TT-9001';
      form.display_name.value = 'مستشعر حرارة يدوي';
      form.context.value = '';
      form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      const mod = await import('./db.js');
      const entities = await mod.KimaDB.listEntities();
      return entities.length;
    })()
  `);
  record('R2-regression-manual-create-still-works', regressionCheck === 4, `entities after manual create=${regressionCheck} (expected 4: 3 imported + 1 manual)`);

  const finalErrors = page.getConsole().filter((l) => l.startsWith('[error]') || l.startsWith('[exception]'));
  record('R2-no-console-errors-overall', finalErrors.length === 0, `errors=${finalErrors.length} ${JSON.stringify(finalErrors)}`);

  await page.close();

  console.log('\n=== SUMMARY ===');
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('FAILED:', failed.map((f) => f.id).join(', '));
    process.exit(1);
  } else {
    console.log('ALL TESTS PASSED');
  }
}

main().catch((err) => {
  console.error('HARNESS ERROR:', err);
  process.exit(2);
});
