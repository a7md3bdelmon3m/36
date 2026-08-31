const { connectToNewTab } = require('./cdp.js');

const CDP_BASE = 'http://localhost:9224';
const APP_URL = 'http://localhost:8899/index.html';

const results = [];
function record(id, ok, detail) {
  results.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${id}: ${detail}`);
}

async function main() {
  const page = await connectToNewTab(CDP_BASE);

  // ---- Suite A (re-run, R1-001 regression) ----
  await page.navigate(APP_URL);
  const consoleAfterLoad = page.getConsole();
  const errors = consoleAfterLoad.filter((l) => l.startsWith('[error]') || l.startsWith('[exception]'));
  record('A1', errors.length === 0, `console errors=${errors.length} ${JSON.stringify(errors)}`);

  // Create entity 1 (Pump)
  const createEntity1 = await page.evaluate(`
    (async () => {
      const form = document.querySelector('#entity-form');
      form.entity_type.value = 'Pump';
      form.canonical_name.value = 'PUMP-101-A';
      form.display_name.value = 'مضخة التغذية الرئيسية 101-A';
      form.context.value = '';
      form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      return document.querySelectorAll('.entity-row').length;
    })()
  `);
  record('A2', createEntity1 === 1, `rows=${createEntity1}`);

  const a3fields = await page.evaluate(`
    (async () => {
      const mod = await import('./db.js');
      const list = await mod.KimaDB.listEntities();
      return Object.keys(list[0]).sort();
    })()
  `);
  const expectedFields = ['canonical_name','context','created_at','display_name','entity_id','entity_type','status','updated_at'].sort();
  record('A3', JSON.stringify(a3fields) === JSON.stringify(expectedFields), JSON.stringify(a3fields));

  await page.evaluate(`
    (async () => {
      const mod = await import('./db.js');
      const list = await mod.KimaDB.listEntities();
      window.__entity1Id = list[0].entity_id;
      document.querySelector('.entity-row').click();
      await new Promise(r => setTimeout(r, 200));
    })()
  `);

  const a4 = await page.evaluate(`
    (async () => {
      const form = document.querySelector('#identifier-form');
      form.namespace.value = 'P&ID-TAG';
      form.identifier.value = 'PV-1042';
      form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      const mod = await import('./db.js');
      const ids = await mod.KimaDB.listIdentifiersForEntity(window.__entity1Id);
      return ids.length;
    })()
  `);
  record('A4', a4 === 1, `rows=${a4}`);

  const a5 = await page.evaluate(`
    (async () => {
      const form = document.querySelector('#identifier-form');
      form.namespace.value = 'P&ID-TAG';
      form.identifier.value = 'PV-1042';
      form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      const mod = await import('./db.js');
      const ids = await mod.KimaDB.listIdentifiersForEntity(window.__entity1Id);
      const toast = document.querySelector('.toast--error');
      return { rows: ids.length, toastText: toast ? toast.textContent : null, crashed: !document.body };
    })()
  `);
  record('A5', a5.rows === 1 && !!a5.toastText, `rows=${a5.rows} toast="${a5.toastText}"`);

  // A6: data persists after full page reload
  await page.navigate(APP_URL);
  const a6 = await page.evaluate(`document.querySelectorAll('.entity-row').length`);
  record('A6', a6 === 1, `rows after reload=${a6}`);
  // Re-fetch entity1 id after reload (DOM was rebuilt) for subsequent steps.
  await page.evaluate(`
    (async () => {
      const mod = await import('./db.js');
      const list = await mod.KimaDB.listEntities();
      window.__entity1Id = list[0].entity_id;
    })()
  `);

  const a7 = await page.evaluate(`document.documentElement.getAttribute('dir')`);
  record('A7', a7 === 'rtl', `dir=${a7}`);

  const a8 = await page.evaluate(`
    (async () => {
      const regs = await navigator.serviceWorker.getRegistrations();
      return regs.length;
    })()
  `);
  record('A8', a8 >= 1, `registrations=${a8}`);

  // ---- R1-002 new tests ----

  // Create second entity (Valve) as relationship target
  const createEntity2 = await page.evaluate(`
    (async () => {
      const form = document.querySelector('#entity-form');
      form.entity_type.value = 'Valve';
      form.canonical_name.value = 'VALVE-101-A';
      form.display_name.value = 'صمام العزل 101-A';
      form.context.value = '';
      form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      const mod = await import('./db.js');
      const list = await mod.KimaDB.listEntities();
      return list.length;
    })()
  `);
  record('R002-1', createEntity2 === 2, `entity count=${createEntity2}`);

  // Re-select entity 1, verify relationship form now present with entity2 as an option
  const relFormPresent = await page.evaluate(`
    (async () => {
      document.querySelectorAll('.entity-row').forEach(row => {
        if (row.dataset.entityId === window.__entity1Id) row.click();
      });
      await new Promise(r => setTimeout(r, 250));
      const form = document.querySelector('#relationship-form');
      return !!form;
    })()
  `);
  record('R002-2', relFormPresent === true, `relationship form present=${relFormPresent}`);

  // Create relationship entity1 -> entity2 (piping)
  const relCreate = await page.evaluate(`
    (async () => {
      const mod = await import('./db.js');
      const list = await mod.KimaDB.listEntities();
      const e2 = list.find(e => e.entity_id !== window.__entity1Id);
      window.__entity2Id = e2.entity_id;
      const form = document.querySelector('#relationship-form');
      form.relationship_type.value = 'piping';
      form.target_entity_id.value = window.__entity2Id;
      form.direction.value = 'forward';
      form.source_reference.value = 'P&ID-204 rev C';
      form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      const rels = await mod.KimaDB.listRelationshipsForEntity(window.__entity1Id);
      return { count: rels.length, type: rels[0] ? rels[0].relationship_type : null, validation_state: rels[0] ? rels[0].validation_state : null };
    })()
  `);
  record('R002-3', relCreate.count === 1 && relCreate.type === 'piping', JSON.stringify(relCreate));
  record('R002-4-default-validation-state', relCreate.validation_state === 'UNREVIEWED', `validation_state=${relCreate.validation_state}`);

  // Reject relationship referencing non-existent entity_id (direct db.js call, bypassing UI select restriction)
  const relReject = await page.evaluate(`
    (async () => {
      const mod = await import('./db.js');
      try {
        await mod.KimaDB.createRelationship({
          source_entity_id: window.__entity1Id,
          target_entity_id: 'ent_does_not_exist_999',
          relationship_type: 'connection',
        });
        return { rejected: false };
      } catch (err) {
        return { rejected: true, message: err.message };
      }
    })()
  `);
  record('R002-5', relReject.rejected === true && /does not exist/.test(relReject.message), JSON.stringify(relReject));

  // Register a source
  const sourceReg = await page.evaluate(`
    (async () => {
      document.querySelectorAll('.entity-row').forEach(row => {
        if (row.dataset.entityId === window.__entity1Id) row.click();
      });
      await new Promise(r => setTimeout(r, 250));
      const details = document.querySelector('.evidence-registration');
      details.open = true;
      const form = document.querySelector('#source-form');
      form.source_type.value = 'P&ID';
      form.source_name.value = 'P&ID-204 rev C';
      form.source_version.value = 'rev C';
      form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      const mod = await import('./db.js');
      const sources = await mod.KimaDB.listSources();
      return { count: sources.length, hasChecksum: sources.length > 0 ? !!sources[0].checksum_sha256 : false, checksumLen: sources.length > 0 ? sources[0].checksum_sha256.length : 0 };
    })()
  `);
  record('R002-6', sourceReg.count === 1 && sourceReg.hasChecksum && sourceReg.checksumLen === 64, JSON.stringify(sourceReg));

  // Create evidence referencing the registered source
  const evidenceCreate = await page.evaluate(`
    (async () => {
      const mod = await import('./db.js');
      const sources = await mod.KimaDB.listSources();
      window.__sourceId = sources[0].source_id;
      const details = document.querySelector('.evidence-registration');
      details.open = true;
      const form = document.querySelector('#evidence-form');
      form.source_id.value = window.__sourceId;
      form.evidence_type.value = 'drawing_excerpt';
      form.locator.value = 'Sheet 2, Zone C4';
      form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      const evList = await mod.KimaDB.listEvidence();
      return { count: evList.length, source_id: evList[0] ? evList[0].source_id : null, validation_state: evList[0] ? evList[0].validation_state : null };
    })()
  `);
  record('R002-7', evidenceCreate.count === 1 && evidenceCreate.source_id === undefined ? false : evidenceCreate.count === 1, JSON.stringify(evidenceCreate));
  record('R002-7b-source-linkage', evidenceCreate.source_id === (await page.evaluate('window.__sourceId')), `evidence.source_id matches registered source`);
  record('R002-8-default-validation-state', evidenceCreate.validation_state === 'UNREVIEWED', `validation_state=${evidenceCreate.validation_state}`);

  // Reject evidence referencing non-existent source_id
  const evReject = await page.evaluate(`
    (async () => {
      const mod = await import('./db.js');
      try {
        await mod.KimaDB.createEvidence({
          source_id: 'src_does_not_exist_999',
          locator: 'x',
          evidence_type: 'field_note',
        });
        return { rejected: false };
      } catch (err) {
        return { rejected: true, message: err.message };
      }
    })()
  `);
  record('R002-9', evReject.rejected === true && /does not exist/.test(evReject.message), JSON.stringify(evReject));

  // Create a relationship linked to that evidence, verify linkage appears in ledger panel
  const relWithEvidence = await page.evaluate(`
    (async () => {
      const mod = await import('./db.js');
      const evList = await mod.KimaDB.listEvidence();
      const rel = await mod.KimaDB.createRelationship({
        source_entity_id: window.__entity1Id,
        target_entity_id: window.__entity2Id,
        relationship_type: 'reference',
        evidence_id: evList[0].evidence_id,
      });
      // re-render ledger panel for entity1
      document.querySelectorAll('.entity-row').forEach(row => {
        if (row.dataset.entityId === window.__entity1Id) row.click();
      });
      await new Promise(r => setTimeout(r, 300));
      const panelHtml = document.querySelector('#ledger-panel').innerHTML;
      return { evidence_id: rel.evidence_id, panelShowsLinkedBadge: panelHtml.includes('مرتبط بدليل'), panelShowsEvidenceSection: panelHtml.includes('الأدلة المرتبطة') };
    })()
  `);
  record('R002-10', !!relWithEvidence.evidence_id && relWithEvidence.panelShowsLinkedBadge && relWithEvidence.panelShowsEvidenceSection, JSON.stringify(relWithEvidence));

  // Reject relationship referencing non-existent evidence_id
  const relEvReject = await page.evaluate(`
    (async () => {
      const mod = await import('./db.js');
      try {
        await mod.KimaDB.createRelationship({
          source_entity_id: window.__entity1Id,
          target_entity_id: window.__entity2Id,
          relationship_type: 'reference',
          evidence_id: 'evd_does_not_exist_999',
        });
        return { rejected: false };
      } catch (err) {
        return { rejected: true, message: err.message };
      }
    })()
  `);
  record('R002-11', relEvReject.rejected === true && /does not exist/.test(relEvReject.message), JSON.stringify(relEvReject));

  // Reject invalid relationship_type (bypassing UI select)
  const relTypeReject = await page.evaluate(`
    (async () => {
      const mod = await import('./db.js');
      try {
        await mod.KimaDB.createRelationship({
          source_entity_id: window.__entity1Id,
          target_entity_id: window.__entity2Id,
          relationship_type: 'not_a_real_type',
        });
        return { rejected: false };
      } catch (err) {
        return { rejected: true, message: err.message };
      }
    })()
  `);
  record('R002-12', relTypeReject.rejected === true && /Invalid relationship_type/.test(relTypeReject.message), JSON.stringify(relTypeReject));

  // Final: no console errors accumulated across the whole run
  const finalConsole = page.getConsole();
  const finalErrors = finalConsole.filter((l) => l.startsWith('[error]') || l.startsWith('[exception]'));
  record('R002-13-no-console-errors', finalErrors.length === 0, `errors=${finalErrors.length} ${JSON.stringify(finalErrors)}`);

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
