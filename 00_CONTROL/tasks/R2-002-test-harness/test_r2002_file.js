const { connectToNewTab } = require('./cdp.js');

const CDP_BASE = 'http://localhost:9231';
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
  record('F-R2002-1-load', loadErrors.length === 0, `console errors=${loadErrors.length} ${JSON.stringify(loadErrors)}`);

  const libCheck = await page.evaluate(`typeof XLSX !== 'undefined' && typeof XLSX.read === 'function'`);
  record('F-R2002-2-xlsx-lib-loaded-under-file', libCheck === true, `xlsx available under file://=${libCheck}`);

  const xlsxImportUnderFile = await page.evaluate(`
    (async () => {
      const data = [
        ['entity_type', 'canonical_name', 'display_name', 'context', 'namespace', 'identifier'],
        ['Pump', 'PUMP-701-A', 'مضخة 701-A', '', 'P&ID-TAG', 'PV-7001'],
      ];
      const ws = XLSX.utils.aoa_to_sheet(data);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
      const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
      const file = new File([buf], 'file_test.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

      const importMod = await import('./import.js');
      const preview = await importMod.ImportPipeline.previewImport(file);
      const result = await importMod.ImportPipeline.commitImport(preview);
      const dbMod = await import('./db.js');
      const entities = await dbMod.KimaDB.listEntities();
      return { committedCount: result.committed.length, totalEntities: entities.length };
    })()
  `);
  record('F-R2002-3-xlsx-import-under-file', xlsxImportUnderFile.committedCount === 1 && xlsxImportUnderFile.totalEntities === 1, JSON.stringify(xlsxImportUnderFile));

  const allUrls = page.getRequestUrls();
  const nonLocalOrFile = allUrls.filter((u) => !u.startsWith('file://') && !u.startsWith('data:') && !u.startsWith('blob:'));
  record('F-R2002-4-zero-network-under-file', nonLocalOrFile.length === 0, `non-file requests=${JSON.stringify(nonLocalOrFile)}`);

  const finalErrors = page.getConsole().filter((l) => l.startsWith('[error]') || l.startsWith('[exception]'));
  record('F-R2002-5-no-console-errors', finalErrors.length === 0, `errors=${finalErrors.length}`);

  await page.close();

  console.log('\n=== SUMMARY (file://, R2-002) ===');
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('FAILED:', failed.map((f) => f.id).join(', '));
    process.exit(1);
  } else {
    console.log('ALL FILE:// R2-002 TESTS PASSED');
  }
}

main().catch((err) => {
  console.error('HARNESS ERROR:', err);
  process.exit(2);
});
