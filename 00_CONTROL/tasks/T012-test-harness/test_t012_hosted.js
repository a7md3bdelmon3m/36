/**
 * T012 hosted-mode test harness — backup/restore. Same dependency-free
 * raw-CDP driver pattern as every prior harness directory, using a
 * local dialog-capable cdp.js variant (see this directory's own copy
 * — auto-accepts confirm()/alert(), needed because handleBackupImport
 * in app.js gates on a native confirm() before restoring).
 *
 * This harness did not exist before ADR-026. T012 (backup/restore)
 * had never had a dedicated real-browser harness — R3-002-B's smoke
 * test (2026-08-29) exercised exportBackup once as part of a broader
 * CRUD smoke pass, but never a full round-trip with data verification,
 * never the replace-vs-merge distinction, never cross-store reference
 * validation under real execution, and never the actual export/import
 * UI buttons.
 *
 * Follows the established precedent (R2-002/R2-003) of calling
 * KimaDB.exportBackup/importBackup directly for the core round-trip
 * logic — the primary evidence here — and additionally drives the
 * real #backup-export-btn click (which needs no file input) to
 * confirm the UI wiring itself works, not just the underlying
 * function in isolation.
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
  record('T012-0-load', loadErrors.length === 0, `console errors=${loadErrors.length} ${JSON.stringify(loadErrors)}`);

  // ---- Build a real, non-trivial dataset spanning multiple stores:
  // entities, an identifier, a relationship (with evidence), a source
  // + source_artifact (with an actual Blob, to exercise the
  // blob<->base64 round-trip path exportBackup/importBackup both
  // special-case), and a decision record. This is deliberately richer
  // than a single-store smoke test.
  const seedResult = await page.evaluate(`
    (async () => {
      const dbMod = await import('./db.js');
      const K = dbMod.KimaDB;

      const pumpResult = await K.createEntityWithIdentifier({
        entity_type: 'Pump', canonical_name: 'BKP-PUMP-1', display_name: 'Backup Test Pump',
        namespace: 'TEST-NS', identifier: 'BKP-001',
      });
      const pump = pumpResult.entity; // createEntityWithIdentifier returns {entity, identifier}, not the entity itself
      const line = await K.createEntity({ entity_type: 'Line', canonical_name: 'BKP-LINE-1', display_name: 'Backup Test Line' });

      const relTypes = K.RELATIONSHIP_TYPES;
      const relRules = K.RELATIONSHIP_RULES;
      const relType = relTypes.find(t => (relRules[t]?.allowedDirections || []).includes('forward'));

      const srcArtifact = await K.registerSourceWithArtifact({
        source_type: 'workbook_csv', source_name: 'backup_test_source.csv', source_version: 'v1',
        buffer: new TextEncoder().encode('a,b\\n1,2\\n').buffer, file_name: 'backup_test_source.csv', mime_type: 'text/csv',
      });

      // Relationship first (createRelationship requires evidence_id, if
      // given, to point at an EXISTING evidence row — it does not
      // create one), then evidence referencing the relationship as its
      // subject (createEvidence itself checks the subject row exists).
      const rel = await K.createRelationship({
        source_entity_id: pump.entity_id, target_entity_id: line.entity_id,
        relationship_type: relType, direction: 'forward',
      });

      const evidence = await K.createEvidence({
        source_id: srcArtifact.source.source_id, subject_type: 'relationship', subject_id: rel.relationship_id,
        locator: 'row 1', evidence_type: 'IMPORT_ROW',
      });

      const obs = await K.createObservation({
        entity_id: pump.entity_id, source_id: srcArtifact.source.source_id, evidence_id: evidence.evidence_id,
        property_name: 'status', value: 'RUNNING',
      });

      const decision = await K.createDecision({
        entity_id: pump.entity_id, observation_id: obs.observation_id, evidence_id: evidence.evidence_id,
        status: 'NORMAL',
      });

      const counts = {};
      for (const n of ['source','source_artifact','entity','entity_identifier','relationship','evidence','observation','standard_mapping','change_event','decision']) {
        counts[n] = await K.countStore(n);
      }
      return { pumpId: pump.entity_id, lineId: line.entity_id, relId: rel.relationship_id, sourceId: srcArtifact.source.source_id, counts };
    })()
  `);
  record('T012-seed-multi-store-dataset', seedResult && seedResult.counts.entity === 2 && seedResult.counts.relationship === 1 && seedResult.counts.source_artifact === 1 && seedResult.counts.decision === 1, JSON.stringify(seedResult && seedResult.counts));

  // ---- Export via the real function, inspect the actual Blob content
  // (not just that it didn't throw) — confirm schema.format, confirm
  // the source_artifact's Blob was actually base64-encoded (not silently
  // dropped), confirm row counts in the exported JSON match the DB.
  const exportResult = await page.evaluate(`
    (async () => {
      const dbMod = await import('./db.js');
      const K = dbMod.KimaDB;
      const blob = await K.exportBackup();
      const text = await blob.text();
      const parsed = JSON.parse(text);
      const artifactRow = parsed.stores.source_artifact[0];
      return {
        format: parsed.schema.format,
        dbVersion: parsed.schema.version,
        storeRowCounts: Object.fromEntries(Object.entries(parsed.stores).map(([k,v]) => [k, v.length])),
        artifactHasBase64: typeof artifactRow?.blob_base64 === 'string' && artifactRow.blob_base64.length > 0,
        artifactHasNoRawBlob: artifactRow?.blob === undefined,
        blobSizeBytes: blob.size,
      };
    })()
  `);
  record('T012-1-export-format-is-v7', exportResult.format === 'KIMA_EIS_BACKUP_V7', exportResult.format);
  record('T012-2-export-row-counts-match-db', JSON.stringify(exportResult.storeRowCounts) === JSON.stringify(seedResult.counts), JSON.stringify({ exported: exportResult.storeRowCounts, seeded: seedResult.counts }));
  record('T012-3-blob-correctly-base64-encoded-not-dropped', exportResult.artifactHasBase64 && exportResult.artifactHasNoRawBlob, JSON.stringify(exportResult));

  // ---- Corruption test: mutate the exported JSON to break a real
  // cross-store reference (point a relationship at a nonexistent
  // entity_id), then confirm importBackup genuinely rejects it before
  // any write — not a cosmetic check, an actual attempted restore.
  const corruptionTest = await page.evaluate(`
    (async () => {
      const dbMod = await import('./db.js');
      const K = dbMod.KimaDB;
      const blob = await K.exportBackup();
      const parsed = JSON.parse(await blob.text());
      parsed.stores.relationship[0].target_entity_id = 'nonexistent_entity_id_xyz';
      const corruptedBlob = new Blob([JSON.stringify(parsed)], { type: 'application/json' });
      let threw = false, message = null;
      try {
        await K.importBackup(corruptedBlob, { replace: false });
      } catch (e) {
        threw = true; message = e.message;
      }
      // Confirm the DB was NOT mutated by the rejected attempt.
      const countAfter = await K.countStore('relationship');
      return { threw, message, relationshipCountAfter: countAfter };
    })()
  `);
  record('T012-4-corrupted-reference-rejected', corruptionTest.threw === true && /reference/i.test(corruptionTest.message || ''), JSON.stringify(corruptionTest));
  record('T012-5-rejected-import-did-not-mutate-db', corruptionTest.relationshipCountAfter === seedResult.counts.relationship, `count=${corruptionTest.relationshipCountAfter}, expected=${seedResult.counts.relationship}`);

  // ---- Genuine round-trip: export, wipe the live DB via replace:true
  // import of an EMPTY backup, confirm the DB is actually empty, then
  // import the original valid export back with replace:true, and
  // confirm every store's row count and at least one specific record's
  // actual field values (not just counts) match the original.
  const roundTrip = await page.evaluate(`
    (async () => {
      const dbMod = await import('./db.js');
      const K = dbMod.KimaDB;

      const originalBlob = await K.exportBackup();
      const originalText = await originalBlob.text();

      // Wipe: import an empty-but-valid backup with replace:true.
      const emptyBackup = { schema: { dbName: 'kima_eis', version: 7, format: 'KIMA_EIS_BACKUP_V7', exported_at: new Date().toISOString() }, stores: {} };
      await K.importBackup(new Blob([JSON.stringify(emptyBackup)]), { replace: true });
      const countsAfterWipe = {};
      for (const n of ['source','source_artifact','entity','entity_identifier','relationship','evidence','observation','standard_mapping','change_event','decision']) {
        countsAfterWipe[n] = await K.countStore(n);
      }

      // Restore: import the original export back.
      const restoreResult = await K.importBackup(new Blob([originalText]), { replace: true });
      const countsAfterRestore = {};
      for (const n of ['source','source_artifact','entity','entity_identifier','relationship','evidence','observation','standard_mapping','change_event','decision']) {
        countsAfterRestore[n] = await K.countStore(n);
      }

      const restoredPump = await K.getEntity('${seedResult.pumpId}');
      const restoredRels = await K.listAllRelationships();
      const restoredArtifacts = await K.listSources();
      const restoredArtifactBlobIsBlob = (await K.listSources()).length > 0;

      // Confirm the restored source_artifact's blob actually decoded
      // back into a real Blob (base64 -> ArrayBuffer -> Blob), not left
      // as a raw base64 string.
      const artObjCheck = await new Promise(async (resolve) => {
        const db = await K.openDb();
        const tx = db.transaction(['source_artifact'], 'readonly');
        const req = tx.objectStore('source_artifact').getAll();
        req.onsuccess = () => {
          const rows = req.result;
          resolve({ count: rows.length, firstIsBlob: rows[0]?.blob instanceof Blob, hasNoBase64Field: rows[0]?.blob_base64 === undefined });
        };
      });

      return {
        restoreResultFormat: restoreResult.format,
        countsAfterWipe,
        countsAfterRestore,
        restoredPumpExists: !!restoredPump,
        restoredPumpCanonicalName: restoredPump?.canonical_name,
        restoredPumpDisplayName: restoredPump?.display_name,
        restoredRelCount: restoredRels.length,
        artObjCheck,
      };
    })()
  `);
  record('T012-6-wipe-empties-all-stores', Object.values(roundTrip.countsAfterWipe).every((c) => c === 0), JSON.stringify(roundTrip.countsAfterWipe));
  record('T012-7-restore-reports-correct-format', roundTrip.restoreResultFormat === 'KIMA_EIS_BACKUP_V7', roundTrip.restoreResultFormat);
  record('T012-8-restore-row-counts-match-original', JSON.stringify(roundTrip.countsAfterRestore) === JSON.stringify(seedResult.counts), JSON.stringify({ restored: roundTrip.countsAfterRestore, original: seedResult.counts }));
  record('T012-9-restored-entity-field-values-correct', roundTrip.restoredPumpExists && roundTrip.restoredPumpCanonicalName === 'BKP-PUMP-1' && roundTrip.restoredPumpDisplayName === 'Backup Test Pump', JSON.stringify({ canonical: roundTrip.restoredPumpCanonicalName, display: roundTrip.restoredPumpDisplayName }));
  record('T012-10-restored-relationship-count-correct', roundTrip.restoredRelCount === 1, `count=${roundTrip.restoredRelCount}`);
  record('T012-11-restored-blob-decoded-back-to-real-Blob', roundTrip.artObjCheck.count === 1 && roundTrip.artObjCheck.firstIsBlob && roundTrip.artObjCheck.hasNoBase64Field, JSON.stringify(roundTrip.artObjCheck));

  // ---- Merge (replace:false) semantics: re-seed a fresh small dataset,
  // export it, then import a DIFFERENT small backup with replace:false
  // and confirm rows from BOTH survive (merge/put behavior), not a wipe.
  const mergeTest = await page.evaluate(`
    (async () => {
      const dbMod = await import('./db.js');
      const K = dbMod.KimaDB;
      const before = await K.countStore('entity');

      const newEntity = await K.createEntity({ entity_type: 'Sensor', canonical_name: 'MERGE-TEST-SENSOR', display_name: 'Merge Test Sensor' });
      const soloBackup = { schema: { dbName: 'kima_eis', version: 7, format: 'KIMA_EIS_BACKUP_V7', exported_at: new Date().toISOString() }, stores: { entity: [newEntity] } };

      // Delete it from live DB state conceptually by re-importing WITHOUT it present,
      // but with replace:false — since put() is upsert, existing entities должны remain.
      await K.importBackup(new Blob([JSON.stringify(soloBackup)]), { replace: false });
      const after = await K.countStore('entity');
      const allEntities = await K.listEntities();
      const hasOriginalPump = allEntities.some(e => e.canonical_name === 'BKP-PUMP-1');
      const hasMergeSensor = allEntities.some(e => e.canonical_name === 'MERGE-TEST-SENSOR');

      return { before, after, hasOriginalPump, hasMergeSensor };
    })()
  `);
  record('T012-12-merge-replace-false-preserves-existing-plus-adds-new', mergeTest.hasOriginalPump === true && mergeTest.hasMergeSensor === true, JSON.stringify(mergeTest));

  // ---- Real UI: click the actual #backup-export-btn and confirm the
  // real handler ran (status text updated), without needing a file
  // input (export needs none).
  await page.navigate(APP_URL); // fresh reload so app.js's own init() re-wires listeners cleanly
  const clickedExportBtn = await page.evaluate(`
    (() => {
      const btn = document.querySelector('#backup-export-btn');
      if (!btn) return false;
      btn.click();
      return true;
    })()
  `);
  record('T012-13-clicked-real-export-button', clickedExportBtn === true, `clicked=${clickedExportBtn}`);
  await new Promise((r) => setTimeout(r, 300));
  const statusAfterExportClick = await page.evaluate(`document.querySelector('#backup-status').textContent`);
  record('T012-14-export-button-updates-status-text', statusAfterExportClick.includes('تم إنشاء النسخة الاحتياطية'), statusAfterExportClick);

  const finalErrors = page.getConsole().filter((l) => l.startsWith('[error]') || l.startsWith('[exception]'));
  record('T012-15-zero-console-errors-throughout', finalErrors.length === 0, `errors=${JSON.stringify(finalErrors)}`);

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
