const { connectToNewTab } = require('./cdp.js');

const CDP_BASE = 'http://127.0.0.1:9239';
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
  record('F-R3-1-load', loadErrors.length === 0, `console errors=${loadErrors.length} ${JSON.stringify(loadErrors)}`);

  const seed = await page.evaluate(`
    (async () => {
      const dbMod = await import('./db.js');
      for (let i = 1; i <= 5; i++) {
        await dbMod.KimaDB.createEntity({
          entity_type: i % 2 === 0 ? 'Valve' : 'Pump',
          canonical_name: 'FTAG-' + i,
          display_name: 'عنصر ' + i,
          context: i === 1 ? 'Plant B / Area 1' : null,
        });
      }
      return 'seeded';
    })()
  `);
  record('F-R3-2-seed', seed === 'seeded', seed);

  await page.navigate(APP_URL);

  const searchCheck = await page.evaluate(`
    (async () => {
      const input = document.querySelector('#explorer-search-input');
      input.value = 'FTAG-3';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      return document.querySelectorAll('.entity-row').length;
    })()
  `);
  record('F-R3-3-search-under-file', searchCheck === 1, `matches=${searchCheck}`);

  const contextCheck = await page.evaluate(`
    (async () => {
      const dbMod = await import('./db.js');
      const parsed = dbMod.KimaDB.parseContextHierarchy('Plant B / Area 1');
      return parsed.levels;
    })()
  `);
  record('F-R3-4-context-parse-under-file', JSON.stringify(contextCheck) === JSON.stringify(['Plant B', 'Area 1']), JSON.stringify(contextCheck));

  const allUrls = page.getRequestUrls();
  const nonFile = allUrls.filter((u) => !u.startsWith('file://') && !u.startsWith('data:') && !u.startsWith('blob:'));
  record('F-R3-5-zero-network-under-file', nonFile.length === 0, `non-file requests=${JSON.stringify(nonFile)}`);

  const finalErrors = page.getConsole().filter((l) => l.startsWith('[error]') || l.startsWith('[exception]'));
  record('F-R3-6-no-console-errors', finalErrors.length === 0, `errors=${finalErrors.length}`);

  await page.close();

  console.log('\n=== SUMMARY (file://, R3-001) ===');
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('FAILED:', failed.map((f) => f.id).join(', '));
    process.exit(1);
  } else {
    console.log('ALL FILE:// R3-001 TESTS PASSED');
  }
}

main().catch((err) => {
  console.error('HARNESS ERROR:', err);
  process.exit(2);
});
