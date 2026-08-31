/**
 * R3-002 file://-mode test harness — smaller-scope smoke of the same
 * context-bar drill-down/clear flow, run against file:// (no HTTP
 * server), same precedent as R2-001/R2-002/R3-001's own file:// suites
 * (ES modules over file:// require --allow-file-access-from-files).
 */
const { connectToNewTab } = require('./cdp.js');

const CDP_BASE = 'http://127.0.0.1:9239';
const APP_URL = process.argv[2]; // pass the file:// URL as CLI arg

if (!APP_URL || !APP_URL.startsWith('file://')) {
  console.error('Usage: node test_r3002_file.js file:///abs/path/to/index.html');
  process.exit(2);
}

const results = [];
function record(id, ok, detail) {
  results.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${id}: ${detail}`);
}

async function main() {
  const page = await connectToNewTab(CDP_BASE);
  await page.navigate(APP_URL);

  const loadErrors = page.getConsole().filter((l) => l.startsWith('[error]') || l.startsWith('[exception]'));
  record('F-R3002-0-load', loadErrors.length === 0, `console errors=${loadErrors.length} ${JSON.stringify(loadErrors)}`);

  const seed = await page.evaluate(`
    (async () => {
      const dbMod = await import('./db.js');
      const specs = [
        { entity_type: 'Pump', canonical_name: 'FPA1', display_name: 'File Pump A1', context: 'PlantF/AreaG/UnitH' },
        { entity_type: 'Pump', canonical_name: 'FPA2', display_name: 'File Pump A2', context: 'PlantF/AreaG/UnitI' },
        { entity_type: 'Valve', canonical_name: 'FVB1', display_name: 'File Valve B1', context: 'PlantF/AreaZ' },
      ];
      const created = [];
      for (const spec of specs) created.push(await dbMod.KimaDB.createEntity(spec));
      return created.length;
    })()
  `);
  record('F-R3002-seed', seed === 3, `created=${seed}`);

  await page.navigate(APP_URL);

  const clickedRow = await page.evaluate(`
    (() => {
      const rows = [...document.querySelectorAll('.entity-row')];
      const row = rows.find(r => r.querySelector('.entity-row__canonical')?.textContent === 'FPA1');
      if (!row) return false;
      row.click();
      return true;
    })()
  `);
  record('F-R3002-1-clicked-row', clickedRow === true, `clicked=${clickedRow}`);
  await new Promise((r) => setTimeout(r, 200));

  const clickedSegment = await page.evaluate(`
    (() => {
      const segs = [...document.querySelectorAll('.context-bar__segment')];
      const target = segs.find(s => s.textContent === 'AreaG');
      if (!target) return false;
      target.click();
      return true;
    })()
  `);
  record('F-R3002-2-clicked-AreaG-segment', clickedSegment === true, `clicked=${clickedSegment}`);
  await new Promise((r) => setTimeout(r, 200));

  const afterDrillDown = await page.evaluate(`JSON.stringify([...document.querySelectorAll('.entity-row .entity-row__canonical')].map(n => n.textContent).sort())`);
  record('F-R3002-3-narrows-to-FPA1-FPA2', afterDrillDown === '["FPA1","FPA2"]', afterDrillDown);

  const clickedClear = await page.evaluate(`
    (() => {
      const btn = document.querySelector('#explorer-context-filter-clear');
      if (!btn) return false;
      btn.click();
      return true;
    })()
  `);
  record('F-R3002-4-clicked-clear', clickedClear === true, `clicked=${clickedClear}`);
  await new Promise((r) => setTimeout(r, 200));

  const afterClear = await page.evaluate(`document.querySelectorAll('.entity-row').length`);
  record('F-R3002-5-full-list-restored', afterClear === 3, `rows=${afterClear}`);

  const finalErrors = page.getConsole().filter((l) => l.startsWith('[error]') || l.startsWith('[exception]'));
  record('F-R3002-6-zero-console-errors', finalErrors.length === 0, `errors=${JSON.stringify(finalErrors)}`);

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
