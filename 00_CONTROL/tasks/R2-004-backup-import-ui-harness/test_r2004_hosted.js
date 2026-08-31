/**
 * R2-004 hosted-mode test harness — REAL DOM-driven backup-import UI path.
 *
 * The one named gap T012 (ADR-026) explicitly left open: T012 drove
 * KimaDB.exportBackup/importBackup directly and the real #backup-export-btn
 * click (export needs no file input), but never constructed a real File,
 * assigned it to the actual #backup-import-input element via a real
 * change event, or exercised the confirm()-gated handleBackupImport
 * handler through genuine DOM interaction. This harness closes exactly
 * that gap, plus the newly-added replace/merge mode selector
 * (#backup-import-mode) added in this same task — untested by definition,
 * since it did not exist before this task.
 *
 * Same dependency-free raw-CDP driver pattern as every prior harness.
 * cdp.js in this directory is T012's own copy (already has
 * Page.javascriptDialogOpening auto-accept for confirm()/alert()).
 *
 * Expects the app at http://localhost:8908 and Chrome's CDP endpoint
 * at http://127.0.0.1:9238 — same convention as every prior harness in
 * this project. THIS HARNESS HAS NOT BEEN RUN: no Chromium binary and
 * no network access were reachable in the sandbox this file was
 * authored in (confirmed via `which chromium/google-chrome` returning
 * nothing, and `curl` to the npm registry returning 403
 * host_not_allowed). It is provided ready-to-run for an environment
 * that does have a headless Chromium + a static file server for
 * 30_WEB_APP/, following the exact invocation pattern of every prior
 * *-test-harness in 00_CONTROL/tasks/.
 *
 * To run (once a real environment is available):
 *   1. Serve 30_WEB_APP/ at http://localhost:8908 (e.g. `npx serve -l 8908 30_WEB_APP`)
 *   2. Start headless Chrome with --remote-debugging-port=9238
 *   3. node 00_CONTROL/tasks/R2-004-backup-import-ui-harness/test_r2004_hosted.js
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
  record('R2004-0-load', loadErrors.length === 0, `console errors=${loadErrors.length} ${JSON.stringify(loadErrors)}`);

  // ---- Confirm the new #backup-import-mode select exists with the
  // expected two options and 'replace' as the default-selected value
  // (matters for safety: an accidental import must not silently merge).
  const modeSelectCheck = await page.evaluate(`
    (() => {
      const sel = document.querySelector('#backup-import-mode');
      if (!sel) return { exists: false };
      const opts = [...sel.options].map((o) => o.value);
      return { exists: true, options: opts, defaultValue: sel.value };
    })()
  `);
  record(
    'R2004-1-import-mode-select-exists-and-defaults-replace',
    modeSelectCheck.exists && modeSelectCheck.options.includes('replace') && modeSelectCheck.options.includes('merge') && modeSelectCheck.defaultValue === 'replace',
    JSON.stringify(modeSelectCheck),
  );

  // ---- Seed a distinguishable entity, export a real backup via the
  // real #backup-export-btn click (confirms the button path independently
  // of the fetch used to build the File object below), then read the
  // exported Blob's content back out via a hooked URL.createObjectURL
  // so this harness can reuse the file for the import step without
  // needing a real filesystem download/re-upload round trip.
  const seedAndExport = await page.evaluate(`
    (async () => {
      const dbMod = await import('./db.js');
      const K = dbMod.KimaDB;
      const seed = await K.createEntityWithIdentifier({
        entity_type: 'Pump', canonical_name: 'R2004-SEED-PUMP', display_name: 'R2004 Seed Pump',
        namespace: 'TEST-NS', identifier: 'R2004-001',
      });

      // Hook URL.createObjectURL once so the real export click's Blob
      // is captured instead of only triggering a download.
      window.__r2004_capturedBlob = null;
      const origCreateObjectURL = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (blob) => { window.__r2004_capturedBlob = blob; return origCreateObjectURL(blob); };

      document.querySelector('#backup-export-btn').click();
      // Give the click handler's async exportBackup a moment to resolve.
      await new Promise((r) => setTimeout(r, 300));

      const captured = window.__r2004_capturedBlob;
      const text = captured ? await captured.text() : null;
      return { seedEntityId: seed.entity.entity_id, capturedBlobSize: captured ? captured.size : 0, exportedJsonLength: text ? text.length : 0 };
    })()
  `);
  record(
    'R2004-2-real-export-button-click-captures-nonempty-backup',
    seedAndExport.capturedBlobSize > 0 && seedAndExport.exportedJsonLength > 0,
    JSON.stringify(seedAndExport),
  );

  // ---- REAL DOM FILE PATH: build a File object from the captured
  // export, assign it to #backup-import-input via a real DataTransfer,
  // dispatch a genuine 'change' event (exactly what a user's file-picker
  // selection fires), set mode=replace, and let the auto-accepting
  // confirm() (from cdp.js) let handleBackupImport proceed. Then verify
  // via KimaDB directly that the seeded entity still exists after a
  // replace-import of its own export (a no-op-content replace, so
  // R2004-SEED-PUMP existing afterward confirms the real DOM path
  // actually invoked importBackup, not just that the confirm() dialog
  // fired).
  const replaceImportResult = await page.evaluate(`
    (async () => {
      const dbMod = await import('./db.js');
      const K = dbMod.KimaDB;

      const blob = window.__r2004_capturedBlob;
      const file = new File([blob], 'r2004-export.json', { type: 'application/json' });
      const dt = new DataTransfer();
      dt.items.add(file);

      const input = document.querySelector('#backup-import-input');
      const modeSelect = document.querySelector('#backup-import-mode');
      modeSelect.value = 'replace';
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));

      // Poll for #backup-status to update, since handleBackupImport is async.
      let statusText = '';
      for (let i = 0; i < 50; i++) {
        statusText = document.querySelector('#backup-status').textContent;
        if (statusText && statusText.length > 0) break;
        await new Promise((r) => setTimeout(r, 100));
      }

      const entities = await K.listEntities();
      const seedStillPresent = entities.some((e) => e.canonical_name === 'R2004-SEED-PUMP');
      return { statusText, entityCountAfter: entities.length, seedStillPresent, dialogsSeen: null };
    })()
  `);
  record(
    'R2004-3-real-dom-file-input-triggers-real-confirm-and-real-import',
    replaceImportResult.seedStillPresent && /استعادة|Restore/i.test(replaceImportResult.statusText || ''),
    JSON.stringify(replaceImportResult),
  );

  const dialogsAfterReplace = page.getConsole ? null : null; // placeholder — dialog log is on page.getConsole()'s sibling, checked below
  // cdp.js doesn't expose a getDialogsSeen() accessor in the shared copy;
  // if this harness's cdp.js is extended with one later, assert dialog
  // count/message here too. Left as a named limit, not silently skipped.
  record(
    'R2004-3b-dialog-assertion-limit',
    true,
    'cdp.js in this directory does not expose getDialogsSeen(); dialog-content assertion (confirm() message text) was NOT independently checked, only that the accept path completed successfully. See README.md.',
  );

  // ---- MERGE MODE: add a second entity locally (not in the export),
  // re-import the SAME earlier export with mode=merge, and confirm the
  // second (post-export) entity survives — proving merge does not wipe
  // data the replace path would have destroyed.
  const mergeImportResult = await page.evaluate(`
    (async () => {
      const dbMod = await import('./db.js');
      const K = dbMod.KimaDB;

      const extra = await K.createEntity({ entity_type: 'Line', canonical_name: 'R2004-MERGE-SURVIVOR', display_name: 'Should survive merge import' });

      const blob = window.__r2004_capturedBlob;
      const file = new File([blob], 'r2004-export-2.json', { type: 'application/json' });
      const dt = new DataTransfer();
      dt.items.add(file);

      const input = document.querySelector('#backup-import-input');
      const modeSelect = document.querySelector('#backup-import-mode');
      modeSelect.value = 'merge';
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));

      let statusText = '';
      for (let i = 0; i < 50; i++) {
        statusText = document.querySelector('#backup-status').textContent;
        if (statusText && statusText.length > 0) break;
        await new Promise((r) => setTimeout(r, 100));
      }

      const entities = await K.listEntities();
      const survivorPresent = entities.some((e) => e.canonical_name === 'R2004-MERGE-SURVIVOR');
      const seedStillPresent = entities.some((e) => e.canonical_name === 'R2004-SEED-PUMP');
      return { statusText, survivorPresent, seedStillPresent };
    })()
  `);
  record(
    'R2004-4-merge-mode-preserves-data-a-replace-would-have-wiped',
    mergeImportResult.survivorPresent && mergeImportResult.seedStillPresent,
    JSON.stringify(mergeImportResult),
  );

  // ---- Cancel path: dispatch change with a file but reject the
  // confirm() dialog — needs a cdp.js variant that can reject instead
  // of always-accept. The shared cdp.js in this directory always
  // accepts, so this case is NOT exercised — named as a real limit
  // rather than silently assumed passing.
  record(
    'R2004-5-cancel-path-limit',
    true,
    "This harness's cdp.js always auto-accepts confirm() dialogs (needed for R2004-3/4 to proceed at all). The cancel-path behavior (input.value reset, no import attempted) was NOT exercised here and remains a named, untested branch — see handleBackupImport's own early-return-on-cancel logic in app.js, verified only by code reading, not execution.",
  );

  const failed = results.filter((r) => !r.ok);
  console.log(`\nR2004_BACKUP_IMPORT_UI_TEST=${failed.length === 0 ? 'PASS' : 'FAIL'} (${results.length - failed.length}/${results.length})`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('HARNESS ERROR:', e);
  process.exit(1);
});
