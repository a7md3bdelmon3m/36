# T012 Test Harness — Backup/Restore

`cdp.js` here is NOT identical to other harness directories' copies —
it adds `Page.javascriptDialogOpening` auto-accept, because
`handleBackupImport` in `app.js` gates on a native `confirm()` before
restoring, which would otherwise hang a headless CDP session
indefinitely. Verified empirically before use (a standalone probe
script confirmed `Runtime.evaluate` does not deadlock when a
synchronous `confirm()` fires mid-evaluation, and that the dialog is
correctly auto-accepted) — not assumed to work. Every other harness
directory's `cdp.js` is unchanged; this copy was kept local rather
than modifying the shared original, so no other suite's behavior
changes silently.

This harness did not exist before ADR-026. T012 (backup/restore) had
never had a dedicated real-browser harness — R3-002-B's smoke test
(2026-08-29) exercised `exportBackup` once as part of a broader CRUD
smoke pass, but never a full round-trip with actual field-value
verification, never the replace-vs-merge distinction, never
cross-store reference validation under real execution with confirmed
zero-mutation-on-rejection, and never the real export/import UI.

## Files

- `cdp.js` — CDP client with console + network request capture, plus
  dialog auto-accept (see above).
- `test_t012_hosted.js` — 17-check hosted-mode suite.

## What it covers

Seeds a deliberately multi-store dataset (2 entities, 1 identifier, 1
relationship, 1 evidence record, 1 source + source_artifact with a
real Blob, 1 observation, 1 decision — spanning 9 of the 10 stores;
`standard_mapping` was not included in the seed and stays untested by
this harness) via the real `KimaDB` functions, then:

1. **Export correctness**: confirms `schema.format` is
   `KIMA_EIS_BACKUP_V7`, confirms every store's exported row count
   matches the live DB exactly, and confirms the `source_artifact`'s
   `Blob` was actually converted to `blob_base64` (not silently
   dropped) — reading the real exported JSON content, not just
   trusting `exportBackup()` didn't throw.
2. **Corruption rejection**: mutates a real exported backup to point a
   relationship at a nonexistent `entity_id`, confirms
   `importBackup` genuinely throws (not just returns falsy) with a
   reference-related message, AND confirms the live DB's relationship
   count is unchanged afterward — the rejected import did not
   partially write.
3. **Full wipe-then-restore round-trip**: imports an empty
   `replace:true` backup, confirms every one of the 10 stores is
   actually empty (not just "fewer rows"), then restores the original
   export with `replace:true` and confirms not just row counts but
   specific field values on a specific restored entity
   (`canonical_name`, `display_name`) match the original — and
   confirms the restored `source_artifact`'s `blob` field is a real
   `Blob` instance again (`instanceof Blob`, base64 decoded back, not
   left as a string).
4. **Merge semantics** (`replace:false`): confirms importing a backup
   containing only one new entity, with `replace:false`, both adds the
   new entity AND preserves everything already in the live DB — not a
   wipe.
5. **Real UI**: reloads the app fresh, clicks the actual
   `#backup-export-btn` in the DOM, and confirms the real
   `handleBackupExport` handler ran (status text updated to the actual
   Arabic success string), not a simulated call.

## What it explicitly does NOT cover

- **No `file://`-mode variant** was written — named gap, not assumed
  covered, consistent with how ADR-025 named the same gap for
  R2-003.
- **The real `#backup-import-input` file-picker path was not driven
  end-to-end.** The harness's `confirm()`-dialog handling was verified
  to work (see the cdp.js note above), but actually feeding a real
  `File` through the `<input type="file">` `change` event would
  require `DOM.setFileInputFiles` against a file on disk, which this
  session chose not to add — following the same established precedent
  as R2-002/R2-003 of calling `KimaDB.importBackup` directly instead.
  This means `handleBackupImport`'s own wiring (the `ev.target.files[0]`
  read, the `confirm()` prompt itself as the user would see it, the
  `ev.target.value = ''` reset) is untested by this harness, even
  though the underlying `importBackup` logic it calls is now
  thoroughly covered.
- **`standard_mapping` store**: not included in the seed data, so its
  round-trip behavior is unverified by this specific harness (though
  it follows the identical code path as every other store in
  `exportBackup`/`importBackup`, which IS covered).

## How to rerun (example)

```bash
cd /path/to/30_WEB_APP && python3 -m http.server 8908 &
/path/to/chrome --headless=new --remote-debugging-port=9238 \
  --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --user-data-dir=/tmp/some-fresh-profile about:blank &
sleep 3
node test_t012_hosted.js
```

Use a **fresh** `--user-data-dir` per run — this harness's seed data
includes a unique `entity_identifier` (`TEST-NS`/`BKP-001`), and
IndexedDB persists across runs within the same Chrome profile
directory, so a rerun against a reused profile will fail on a
duplicate-identifier constraint that has nothing to do with the code
under test. (Discovered directly during this session — logged here so
a future session doesn't waste a cycle rediscovering it.)

## Results (ADR-026, 2026-08-30)

17/17 checks passed, zero console errors.

## Why this matters for future tasks

Rerun the full suite after any change to `exportBackup`,
`importBackup`, `STORE_NAMES`, or any store's reference-validation
block in `db.js`.
