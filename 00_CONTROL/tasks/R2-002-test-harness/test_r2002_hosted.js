const { connectToNewTab } = require('./cdp.js');

const CDP_BASE = 'http://localhost:9230';
const APP_URL = 'http://localhost:8902/index.html';

const results = [];
function record(id, ok, detail) {
  results.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${id}: ${detail}`);
}

async function main() {
  const page = await connectToNewTab(CDP_BASE);
  await page.navigate(APP_URL);

  const loadErrors = page.getConsole().filter((l) => l.startsWith('[error]') || l.startsWith('[exception]'));
  record('R2002-0-load', loadErrors.length === 0, `console errors=${loadErrors.length} ${JSON.stringify(loadErrors)}`);

  // ---- XLSX library actually loaded locally, globally available ----
  const libCheck = await page.evaluate(`
    (() => {
      return { xlsxDefined: typeof XLSX !== 'undefined', hasUtils: typeof XLSX !== 'undefined' && typeof XLSX.utils !== 'undefined', hasRead: typeof XLSX !== 'undefined' && typeof XLSX.read === 'function' };
    })()
  `);
  record('R2002-1-xlsx-lib-loaded', libCheck.xlsxDefined && libCheck.hasUtils && libCheck.hasRead, JSON.stringify(libCheck));

  // ---- Zero CDN network requests across the whole session so far ----
  const urlsAfterLoad = page.getRequestUrls();
  const nonLocalUrls = urlsAfterLoad.filter((u) => !u.startsWith('http://localhost') && !u.startsWith('data:'));
  record('R2002-2-zero-cdn-requests-on-load', nonLocalUrls.length === 0, `non-local requests=${JSON.stringify(nonLocalUrls)}`);

  // ---- detectFormat correctness ----
  const formatDetect = await page.evaluate(`
    (async () => {
      const mod = await import('./import.js');
      return {
        xlsxByExt: mod.ImportPipeline.detectFormat({ name: 'data.xlsx', type: '' }),
        xlsByExt: mod.ImportPipeline.detectFormat({ name: 'data.xls', type: '' }),
        csvByExt: mod.ImportPipeline.detectFormat({ name: 'data.csv', type: '' }),
        unknownDefaultsCsv: mod.ImportPipeline.detectFormat({ name: 'data.txt', type: '' }),
      };
    })()
  `);
  record('R2002-3-format-detection', formatDetect.xlsxByExt === 'xlsx' && formatDetect.xlsByExt === 'xlsx' && formatDetect.csvByExt === 'csv' && formatDetect.unknownDefaultsCsv === 'csv', JSON.stringify(formatDetect));

  // ---- Build a real .xlsx file in-browser using the vendored library itself, then run it through the full pipeline ----
  const xlsxImport = await page.evaluate(`
    (async () => {
      // Build a workbook identical in content to R2-001's fixture_good.csv
      const data = [
        ['entity_type', 'canonical_name', 'display_name', 'context', 'namespace', 'identifier'],
        ['Pump', 'PUMP-401-A', 'مضخة 401-A', 'وحدة 400', 'P&ID-TAG', 'PV-4001'],
        ['Valve', 'VALVE-401-A', 'صمام 401-A', '', 'P&ID-TAG', 'PV-4002'],
        ['Pump', 'PUMP-402-B', 'مضخة 402-B', '', 'P&ID-TAG', 'PV-4003'],
      ];
      const ws = XLSX.utils.aoa_to_sheet(data);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
      const wbBuffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
      const file = new File([wbBuffer], 'test_workbook.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

      const importMod = await import('./import.js');
      const preview = await importMod.ImportPipeline.previewImport(file);
      const result = await importMod.ImportPipeline.commitImport(preview);

      const dbMod = await import('./db.js');
      const entities = await dbMod.KimaDB.listEntities();

      return {
        format: preview.format,
        usedSheet: preview.usedSheet,
        ignoredSheets: preview.ignoredSheets,
        rowCount: preview.plan.rows.length,
        conflictCount: preview.plan.conflicts.length,
        committedCount: result.committed.length,
        totalEntities: entities.length,
      };
    })()
  `);
  record('R2002-4-xlsx-full-pipeline', xlsxImport.format === 'xlsx' && xlsxImport.rowCount === 3 && xlsxImport.conflictCount === 0 && xlsxImport.committedCount === 3 && xlsxImport.totalEntities === 3, JSON.stringify(xlsxImport));
  record('R2002-4b-single-sheet-used', xlsxImport.usedSheet === 'Sheet1' && Array.isArray(xlsxImport.ignoredSheets) && xlsxImport.ignoredSheets.length === 0, JSON.stringify({ usedSheet: xlsxImport.usedSheet, ignoredSheets: xlsxImport.ignoredSheets }));

  // ---- T001-equivalent: xlsx fingerprint stable/differs ----
  const fpCheck = await page.evaluate(`
    (async () => {
      const data1 = [['a','b'],['1','2']];
      const ws1 = XLSX.utils.aoa_to_sheet(data1);
      const wb1 = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb1, ws1, 'S');
      const buf1 = XLSX.write(wb1, { type: 'array', bookType: 'xlsx' });
      const buf1b = XLSX.write(wb1, { type: 'array', bookType: 'xlsx' });

      const data2 = [['a','b'],['9','9']];
      const ws2 = XLSX.utils.aoa_to_sheet(data2);
      const wb2 = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb2, ws2, 'S');
      const buf2 = XLSX.write(wb2, { type: 'array', bookType: 'xlsx' });

      const dbMod = await import('./db.js');
      const fp1 = await dbMod.KimaDB.sha256HexBytes(buf1);
      const fp1b = await dbMod.KimaDB.sha256HexBytes(buf1b);
      const fp2 = await dbMod.KimaDB.sha256HexBytes(buf2);
      return { stable: fp1 === fp1b, differs: fp1 !== fp2 };
    })()
  `);
  record('R2002-5-xlsx-fingerprint-stable', fpCheck.stable, JSON.stringify(fpCheck));
  record('R2002-5b-xlsx-fingerprint-differs', fpCheck.differs, JSON.stringify(fpCheck));

  // ---- T003-equivalent: idempotent re-import of the same .xlsx content ----
  const reimportXlsx = await page.evaluate(`
    (async () => {
      const data = [
        ['entity_type', 'canonical_name', 'display_name', 'context', 'namespace', 'identifier'],
        ['Pump', 'PUMP-401-A', 'مضخة 401-A', 'وحدة 400', 'P&ID-TAG', 'PV-4001'],
        ['Valve', 'VALVE-401-A', 'صمام 401-A', '', 'P&ID-TAG', 'PV-4002'],
        ['Pump', 'PUMP-402-B', 'مضخة 402-B', '', 'P&ID-TAG', 'PV-4003'],
      ];
      const ws = XLSX.utils.aoa_to_sheet(data);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
      const wbBuffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
      const file = new File([wbBuffer], 'test_workbook.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

      const importMod = await import('./import.js');
      const preview2 = await importMod.ImportPipeline.previewImport(file);
      const result2 = await importMod.ImportPipeline.commitImport(preview2);

      const dbMod = await import('./db.js');
      const entities = await dbMod.KimaDB.listEntities();

      return { actions: result2.committed.map(c => c.action), totalEntities: entities.length };
    })()
  `);
  record('R2002-6-xlsx-idempotent-reimport', reimportXlsx.totalEntities === 3 && reimportXlsx.actions.every(a => a === 'update'), JSON.stringify(reimportXlsx));

  // ---- Multi-sheet workbook: first sheet processed, others reported as ignored (not silently dropped) ----
  const multiSheet = await page.evaluate(`
    (async () => {
      const wb = XLSX.utils.book_new();
      const ws1 = XLSX.utils.aoa_to_sheet([
        ['entity_type', 'canonical_name', 'display_name', 'context', 'namespace', 'identifier'],
        ['Sensor', 'TT-501', 'مستشعر 501', '', 'P&ID-TAG', 'TT-501'],
      ]);
      const ws2 = XLSX.utils.aoa_to_sheet([['unrelated','sheet'],['x','y']]);
      XLSX.utils.book_append_sheet(wb, ws1, 'Entities');
      XLSX.utils.book_append_sheet(wb, ws2, 'Notes');
      const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
      const file = new File([buf], 'multi.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

      const importMod = await import('./import.js');
      const preview = await importMod.ImportPipeline.previewImport(file);
      return { usedSheet: preview.usedSheet, ignoredSheets: preview.ignoredSheets, rowCount: preview.plan.rows.length };
    })()
  `);
  record('R2002-7-multi-sheet-first-used-rest-reported', multiSheet.usedSheet === 'Entities' && JSON.stringify(multiSheet.ignoredSheets) === JSON.stringify(['Notes']) && multiSheet.rowCount === 1, JSON.stringify(multiSheet));

  // ---- Conflict classification still works identically for xlsx (duplicate identifier within file) ----
  const xlsxConflict = await page.evaluate(`
    (async () => {
      const data = [
        ['entity_type', 'canonical_name', 'display_name', 'context', 'namespace', 'identifier'],
        ['Pump', 'PUMP-601-A', 'مضخة 601-A', '', 'P&ID-TAG', 'PV-6001'],
        ['Valve', 'VALVE-601-A', 'صمام 601-A', '', 'P&ID-TAG', 'PV-6001'],
      ];
      const ws = XLSX.utils.aoa_to_sheet(data);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
      const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
      const file = new File([buf], 'dup.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

      const importMod = await import('./import.js');
      const dbMod = await import('./db.js');
      const before = (await dbMod.KimaDB.listEntities()).length;
      const preview = await importMod.ImportPipeline.previewImport(file);
      const result = await importMod.ImportPipeline.commitImport(preview);
      const after = (await dbMod.KimaDB.listEntities()).length;

      return { severities: preview.plan.conflicts.map(c => c.severity), before, after };
    })()
  `);
  record('R2002-8-xlsx-blocker-conflict-detected', xlsxConflict.severities.every(s => s === 'BLOCKER') && xlsxConflict.severities.length === 2, JSON.stringify(xlsxConflict.severities));
  record('R2002-9-xlsx-blocker-not-committed', xlsxConflict.after === xlsxConflict.before, `before=${xlsxConflict.before} after=${xlsxConflict.after}`);

  // ---- Zero CDN requests across the ENTIRE session (including all xlsx operations above) ----
  const allUrls = page.getRequestUrls();
  const allNonLocal = allUrls.filter((u) => !u.startsWith('http://localhost') && !u.startsWith('data:') && !u.startsWith('blob:'));
  record('R2002-10-zero-cdn-requests-entire-session', allNonLocal.length === 0, `non-local requests=${JSON.stringify(allNonLocal)}`);

  const finalErrors = page.getConsole().filter((l) => l.startsWith('[error]') || l.startsWith('[exception]'));
  record('R2002-11-no-console-errors', finalErrors.length === 0, `errors=${finalErrors.length} ${JSON.stringify(finalErrors)}`);

  await page.close();

  console.log('\n=== SUMMARY (R2-002) ===');
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('FAILED:', failed.map((f) => f.id).join(', '));
    process.exit(1);
  } else {
    console.log('ALL R2-002 TESTS PASSED');
  }
}

main().catch((err) => {
  console.error('HARNESS ERROR:', err);
  process.exit(2);
});
