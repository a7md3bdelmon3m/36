const { connectToNewTab } = require('./cdp.js');

const CDP_BASE = 'http://localhost:9227';
// Edit this to the actual absolute path of your 30_WEB_APP/index.html before running.
const APP_URL = 'file:///REPLACE/WITH/PATH/TO/30_WEB_APP/index.html';

const results = [];
function record(id, ok, detail) {
  results.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${id}: ${detail}`);
}

async function main() {
  const page = await connectToNewTab(CDP_BASE);
  await page.navigate(APP_URL);

  const loadErrors = page.getConsole().filter((l) => l.startsWith('[error]') || l.startsWith('[exception]'));
  record('F-R2-1-load', loadErrors.length === 0, `console errors=${loadErrors.length} ${JSON.stringify(loadErrors)}`);

  // Under file://, fetch() of a relative sibling file is same-origin (file://) and should work
  // with --allow-file-access-from-files. Construct a File object directly instead, to avoid
  // depending on fetch() semantics under file:// (which vary by flag) — this is what a real
  // user's file-picker interaction produces anyway.
  const importUnderFile = await page.evaluate(`
    (async () => {
      const csvText = 'entity_type,canonical_name,display_name,context,namespace,identifier\\n' +
        'Pump,PUMP-301-A,مضخة 301-A,,P&ID-TAG,PV-3001\\n' +
        'Valve,VALVE-301-A,صمام 301-A,,P&ID-TAG,PV-3002\\n';
      const file = new File([csvText], 'inline_fixture.csv', { type: 'text/csv' });
      const mod = await import('./import.js');
      const preview = await mod.ImportPipeline.previewImport(file);
      const result = await mod.ImportPipeline.commitImport(preview);
      const dbMod = await import('./db.js');
      const entities = await dbMod.KimaDB.listEntities();
      return {
        rowCount: preview.plan.rows.length,
        conflictCount: preview.plan.conflicts.length,
        committedCount: result.committed.length,
        totalEntities: entities.length,
      };
    })()
  `);
  record('F-R2-2-import-under-file', importUnderFile.rowCount === 2 && importUnderFile.conflictCount === 0 && importUnderFile.committedCount === 2 && importUnderFile.totalEntities === 2, JSON.stringify(importUnderFile));

  // Reload and confirm persistence under file:// too
  await page.navigate(APP_URL);
  const afterReload = await page.evaluate(`
    (async () => {
      const mod = await import('./db.js');
      const entities = await mod.KimaDB.listEntities();
      return entities.length;
    })()
  `);
  record('F-R2-3-persists-after-reload', afterReload === 2, `entities after reload=${afterReload}`);

  const finalErrors = page.getConsole().filter((l) => l.startsWith('[error]') || l.startsWith('[exception]'));
  record('F-R2-4-no-console-errors', finalErrors.length === 0, `errors=${finalErrors.length}`);

  await page.close();

  console.log('\n=== SUMMARY (file://, R2) ===');
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('FAILED:', failed.map((f) => f.id).join(', '));
    process.exit(1);
  } else {
    console.log('ALL FILE:// R2 TESTS PASSED');
  }
}

main().catch((err) => {
  console.error('HARNESS ERROR:', err);
  process.exit(2);
});
