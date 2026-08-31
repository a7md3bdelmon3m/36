/**
 * R3-002 hosted-mode test harness — context bar as navigational filter.
 * Same dependency-free raw-CDP driver pattern as R1-002/R2-001/R2-002/
 * R3-001 (this directory's cdp.js is an unmodified copy of
 * R3-001-test-harness/cdp.js — network-monitoring-capable).
 *
 * Seeds entities directly via KimaDB.createEntity for determinism,
 * reloads so app.js's real init() path renders them, then drives the
 * REAL DOM: clicking an entity row to populate the context bar,
 * clicking a breadcrumb segment to narrow the explorer, reading back
 * the actually-rendered entity list, clicking the clear control, and
 * checking regression against ordinary search/type-filter and
 * context-less entities. Never re-implements the filter predicate —
 * only drives the UI and reads back rendered state.
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
  record('R3002-0-load', loadErrors.length === 0, `console errors=${loadErrors.length} ${JSON.stringify(loadErrors)}`);

  // ---- Seed 6 entities: three share PlantA/AreaB, one diverges at
  // Area (PlantA/AreaZ), one has only Plant-level context (PlantC),
  // one has unstructured (no-slash) context — covers acceptance
  // criterion 4 (no regression for entities with no/unstructured context).
  const seed = await page.evaluate(`
    (async () => {
      const dbMod = await import('./db.js');
      const specs = [
        { entity_type: 'Pump', canonical_name: 'PA1', display_name: 'Pump A1', context: 'PlantA/AreaB/UnitC' },
        { entity_type: 'Pump', canonical_name: 'PA2', display_name: 'Pump A2', context: 'PlantA/AreaB/UnitD' },
        { entity_type: 'Sensor', canonical_name: 'SA3', display_name: 'Sensor A3', context: 'PlantA/AreaB' },
        { entity_type: 'Valve', canonical_name: 'VB1', display_name: 'Valve B1', context: 'PlantA/AreaZ' },
        { entity_type: 'Pump', canonical_name: 'PC1', display_name: 'Pump C1', context: 'PlantC' },
        { entity_type: 'Pump', canonical_name: 'LOOSE1', display_name: 'Loose Item', context: 'no slashes here' },
      ];
      const created = [];
      for (const spec of specs) {
        created.push(await dbMod.KimaDB.createEntity(spec));
      }
      return created.length;
    })()
  `);
  record('R3002-seed', seed === 6, `created=${seed}`);

  // Reload so app.js's normal init() path loads the seeded data through the real UI flow.
  await page.navigate(APP_URL);

  const initialCount = await page.evaluate(`document.querySelector('#entity-count').textContent`);
  record('R3002-1-initial-count', initialCount === '6', `count badge=${initialCount}`);

  const barHiddenInitially = await page.evaluate(`document.querySelector('#context-bar').hidden`);
  record('R3002-2-context-bar-hidden-initially', barHiddenInitially === true, `hidden=${barHiddenInitially}`);

  const indicatorHiddenInitially = await page.evaluate(`document.querySelector('#explorer-context-filter').hidden`);
  record('R3002-3-no-active-filter-initially', indicatorHiddenInitially === true, `hidden=${indicatorHiddenInitially}`);

  // Real DOM click on the Pump A1 row.
  const clickedRow = await page.evaluate(`
    (() => {
      const rows = [...document.querySelectorAll('.entity-row')];
      const row = rows.find(r => r.querySelector('.entity-row__canonical')?.textContent === 'PA1');
      if (!row) return false;
      row.click();
      return true;
    })()
  `);
  record('R3002-4-clicked-PA1-row', clickedRow === true, `clicked=${clickedRow}`);
  await new Promise((r) => setTimeout(r, 200));

  const barAfterSelect = await page.evaluate(`
    JSON.stringify({
      hidden: document.querySelector('#context-bar').hidden,
      segs: [...document.querySelectorAll('.context-bar__segment')].map(s => s.textContent),
    })
  `);
  const barState = JSON.parse(barAfterSelect);
  record('R3002-5-context-bar-shows-3-segments',
    barState.hidden === false && JSON.stringify(barState.segs) === JSON.stringify(['PlantA', 'AreaB', 'UnitC']),
    barAfterSelect);

  // Click the "AreaB" breadcrumb segment (2nd of 3 levels).
  const clickedSegment = await page.evaluate(`
    (() => {
      const segs = [...document.querySelectorAll('.context-bar__segment')];
      const target = segs.find(s => s.textContent === 'AreaB');
      if (!target) return false;
      target.click();
      return true;
    })()
  `);
  record('R3002-6-clicked-AreaB-segment', clickedSegment === true, `clicked=${clickedSegment}`);
  await new Promise((r) => setTimeout(r, 200));

  const afterDrillDown = await page.evaluate(`
    JSON.stringify({
      names: [...document.querySelectorAll('.entity-row .entity-row__canonical')].map(n => n.textContent).sort(),
      countBadge: document.querySelector('#entity-count').textContent,
      indicatorHidden: document.querySelector('#explorer-context-filter').hidden,
      indicatorText: document.querySelector('#explorer-context-filter').textContent,
    })
  `);
  const drillState = JSON.parse(afterDrillDown);
  record('R3002-7-narrows-to-exactly-PA1-PA2-SA3',
    JSON.stringify(drillState.names) === JSON.stringify(['PA1', 'PA2', 'SA3']),
    afterDrillDown);
  record('R3002-8-excludes-VB1-same-plant-different-area',
    !drillState.names.includes('VB1'), `names=${JSON.stringify(drillState.names)}`);
  record('R3002-9-excludes-PC1-prefix-too-short',
    !drillState.names.includes('PC1'), `names=${JSON.stringify(drillState.names)}`);
  record('R3002-10-filter-indicator-visible-and-labeled',
    drillState.indicatorHidden === false && drillState.indicatorText.includes('PlantA') && drillState.indicatorText.includes('AreaB'),
    drillState.indicatorText);

  // Acceptance criterion 3: filter indicator visible independent of
  // current selection — select a DIFFERENT entity while filter active,
  // context bar breadcrumb changes but filter indicator must persist.
  const clickedOther = await page.evaluate(`
    (() => {
      const rows = [...document.querySelectorAll('.entity-row')];
      const row = rows.find(r => r.querySelector('.entity-row__canonical')?.textContent === 'SA3');
      if (!row) return false;
      row.click();
      return true;
    })()
  `);
  record('R3002-11-selected-different-entity-while-filtered', clickedOther === true, `clicked=${clickedOther}`);
  await new Promise((r) => setTimeout(r, 200));

  const indicatorAfterReselect = await page.evaluate(`
    JSON.stringify({
      hidden: document.querySelector('#explorer-context-filter').hidden,
      text: document.querySelector('#explorer-context-filter').textContent,
    })
  `);
  const reselectState = JSON.parse(indicatorAfterReselect);
  record('R3002-12-filter-indicator-persists-across-reselection',
    reselectState.hidden === false && reselectState.text.includes('AreaB'),
    indicatorAfterReselect);

  // Click the clear control.
  const clickedClear = await page.evaluate(`
    (() => {
      const btn = document.querySelector('#explorer-context-filter-clear');
      if (!btn) return false;
      btn.click();
      return true;
    })()
  `);
  record('R3002-13-clicked-clear-control', clickedClear === true, `clicked=${clickedClear}`);
  await new Promise((r) => setTimeout(r, 200));

  const afterClear = await page.evaluate(`
    JSON.stringify({
      names: [...document.querySelectorAll('.entity-row .entity-row__canonical')].map(n => n.textContent).sort(),
      indicatorHidden: document.querySelector('#explorer-context-filter').hidden,
    })
  `);
  const clearState = JSON.parse(afterClear);
  record('R3002-14-full-list-restored-after-clear', clearState.names.length === 6, `names=${JSON.stringify(clearState.names)}`);
  record('R3002-15-indicator-hidden-after-clear', clearState.indicatorHidden === true, `hidden=${clearState.indicatorHidden}`);

  // Regression: normal type filter still works standalone with context filter cleared.
  await page.evaluate(`
    (() => {
      const sel = document.querySelector('#explorer-filter-type');
      sel.value = 'Sensor';
      sel.dispatchEvent(new Event('change'));
    })()
  `);
  await new Promise((r) => setTimeout(r, 200));
  const afterTypeFilter = await page.evaluate(`JSON.stringify([...document.querySelectorAll('.entity-row .entity-row__canonical')].map(n => n.textContent))`);
  record('R3002-16-type-filter-still-works-standalone', afterTypeFilter === '["SA3"]', afterTypeFilter);

  await page.evaluate(`
    (() => {
      const sel = document.querySelector('#explorer-filter-type');
      sel.value = '';
      sel.dispatchEvent(new Event('change'));
    })()
  `);
  await new Promise((r) => setTimeout(r, 200));

  // Regression: no-slash context entity renders with no fake breadcrumb.
  const looseBreadcrumb = await page.evaluate(`
    (() => {
      const rows = [...document.querySelectorAll('.entity-row')];
      const row = rows.find(r => r.querySelector('.entity-row__canonical')?.textContent === 'LOOSE1');
      return row ? !!row.querySelector('.entity-row__context') : null;
    })()
  `);
  record('R3002-17-no-slash-context-entity-has-no-breadcrumb', looseBreadcrumb === false, `hasBreadcrumb=${looseBreadcrumb}`);

  const finalErrors = page.getConsole().filter((l) => l.startsWith('[error]') || l.startsWith('[exception]'));
  record('R3002-18-zero-console-errors-throughout', finalErrors.length === 0, `errors=${JSON.stringify(finalErrors)}`);

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
