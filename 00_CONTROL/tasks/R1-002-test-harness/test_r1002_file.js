const { connectToNewTab } = require('./cdp.js');

const CDP_BASE = 'http://localhost:9223';
const APP_URL = 'file:///home/claude/r2/pack/KIMA_EIS_PROJECT_PACK_V2/30_WEB_APP/index.html';

const results = [];
function record(id, ok, detail) {
  results.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${id}: ${detail}`);
}

async function main() {
  const page = await connectToNewTab(CDP_BASE);

  await page.navigate(APP_URL);
  const consoleAfterLoad = page.getConsole();
  const errors = consoleAfterLoad.filter((l) => l.startsWith('[error]') || l.startsWith('[exception]'));
  record('F1', errors.length === 0, `console errors=${errors.length} ${JSON.stringify(errors)}`);

  const f2 = await page.evaluate(`
    (async () => {
      const form = document.querySelector('#entity-form');
      form.entity_type.value = 'Pump';
      form.canonical_name.value = 'PUMP-201-B';
      form.display_name.value = 'مضخة احتياطية 201-B';
      form.context.value = '';
      form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      return document.querySelectorAll('.entity-row').length;
    })()
  `);
  record('F2', f2 === 1, `rows=${f2}`);

  await page.navigate(APP_URL);
  const f3 = await page.evaluate(`document.querySelectorAll('.entity-row').length`);
  record('F3', f3 === 1, `rows after reload=${f3}`);

  // R1-002 under file:// — relationship/evidence CRUD still functions with no server at all.
  const f4 = await page.evaluate(`
    (async () => {
      const form = document.querySelector('#entity-form');
      form.entity_type.value = 'Valve';
      form.canonical_name.value = 'VALVE-201-B';
      form.display_name.value = 'صمام 201-B';
      form.context.value = '';
      form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      const mod = await import('./db.js');
      const list = await mod.KimaDB.listEntities();
      const e1 = list.find(e => e.canonical_name === 'PUMP-201-B');
      const e2 = list.find(e => e.canonical_name === 'VALVE-201-B');
      const rel = await mod.KimaDB.createRelationship({
        source_entity_id: e1.entity_id,
        target_entity_id: e2.entity_id,
        relationship_type: 'piping',
      });
      return { relCreated: !!rel.relationship_id, validation_state: rel.validation_state };
    })()
  `);
  record('F4-relationship-under-file', f4.relCreated && f4.validation_state === 'UNREVIEWED', JSON.stringify(f4));

  const finalConsole = page.getConsole();
  const finalErrors = finalConsole.filter((l) => l.startsWith('[error]') || l.startsWith('[exception]'));
  record('F5-no-console-errors', finalErrors.length === 0, `errors=${finalErrors.length}`);

  await page.close();

  console.log('\n=== SUMMARY (file://) ===');
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('FAILED:', failed.map((f) => f.id).join(', '));
    process.exit(1);
  } else {
    console.log('ALL FILE:// TESTS PASSED');
  }
}

main().catch((err) => {
  console.error('HARNESS ERROR:', err);
  process.exit(2);
});
