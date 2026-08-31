# R2-004 — backup-import real-DOM UI harness

Task ID: ADR-033 (see `00_CONTROL/DECISION_LOG.md`)

## What this closes

The one gap T012 (ADR-026) explicitly named as not yet covered: driving
`#backup-import-input` through a real `File` + `DataTransfer` + `change`
event, not calling `KimaDB.importBackup` directly. Also covers the new
`#backup-import-mode` select (replace vs merge) added in this same task
— untested by definition, since it did not exist before this task.

## Real change made (not just a test)

`handleBackupImport` in `app.js` previously always called
`KimaDB.importBackup(f, {replace:true})` — hardcoded. `importBackup`
itself has supported `replace:false` (additive merge) since before
T012, and T012 (ADR-026) confirmed that merge semantics work correctly
at the `KimaDB` layer — but **no UI path ever exposed it**. This was a
real, unnamed gap (not previously listed in `V3_GAP_REGISTER.txt` or
`SYSTEM_OF_RECORD_MATRIX.md`), found independently while reviewing
this exact code path for the R2-004 harness.

Fixed: a `#backup-import-mode` `<select>` (options: `replace` /
`merge`, defaulting to `replace` for safety — an accidental import must
not silently merge without the user choosing that). `handleBackupImport`
now reads it and passes the corresponding `replace` boolean through,
with a `confirm()` message that differs by mode (replace's warning is
markedly more serious — "cannot be undone" — than merge's).

## Harness status: written, NOT executed

Same real limit as every prior task in this session: no Chromium
binary and no network access are reachable in this sandbox (confirmed
again for this task specifically: `which chromium chromium-browser
google-chrome` returned nothing; `curl` to the npm registry returned
`403 host_not_allowed`). `test_r2004_hosted.js` is written to the exact
invocation convention of every prior `*-test-harness` in this project
(same `cdp.js` driver, same `localhost:8908`/`127.0.0.1:9238`
endpoints) and is ready to run once a real headless-Chromium
environment is available — but it has not been run, and its results
above are not evidence of anything until it is.

### What the harness is designed to check, once run

1. `#backup-import-mode` select exists with `replace`/`merge` options,
   defaulting to `replace`.
2. The real `#backup-export-btn` click produces a genuine, non-empty
   backup `Blob` (captured via a hooked `URL.createObjectURL`, so the
   harness can reuse it without a real filesystem round-trip).
3. **The core new coverage**: building a real `File` from that blob,
   assigning it to `#backup-import-input` via a real `DataTransfer`,
   dispatching a genuine `change` event — exactly what a user's
   file-picker selection fires — with mode=`replace`, letting the
   already-auto-accepting `confirm()` (from `cdp.js`) through, and
   confirming via `KimaDB.listEntities()` directly (not the UI) that a
   seeded entity survives its own no-op replace-import — proof the real
   DOM path actually invoked `importBackup`, not just that a dialog
   fired.
4. The same real-DOM path with mode=`merge`: a second, post-export
   entity is added locally, the same earlier export is re-imported in
   merge mode, and both the original seed AND the new local entity are
   confirmed present afterward — proof merge does not wipe data a
   replace would have destroyed.

### Named limits even once this harness IS run

- **Dialog content is not asserted.** `cdp.js`'s shared driver
  auto-accepts every `confirm()`/`alert()` (necessary for the harness
  to proceed at all — a headless session has no human to click OK) but
  does not expose a `getDialogsSeen()` accessor to assert the *message
  text* differs between replace and merge. The harness notes this as
  `R2004-3b-dialog-assertion-limit` — a real gap, not silently skipped.
- **The cancel path is not exercised.** `handleBackupImport`'s
  early-return when the user clicks "Cancel" on `confirm()` (resets
  `input.value`, calls `importBackup` zero times) is verified only by
  reading the code (`if(!confirm(confirmMsg)){ev.target.value='';return;}`),
  not by execution — the same auto-accept driver that makes
  `R2004-3`/`R2004-4` possible makes the reject path impossible to
  reach with this `cdp.js` variant. A `cdp.js` fork that can reject
  dialogs on demand would be needed to close this specifically.
- **A malformed/corrupted file is not tested through the real input.**
  `importBackup`'s validation logic (reference checks, format-string
  check) was already real-browser-verified directly in T012 — this
  harness does not repeat that, since its purpose is the DOM
  wiring specifically, not re-proving `importBackup`'s own correctness.

## Gap-register status

`V3_RELEASE_GATE.txt`'s "real `#backup-import-input` file-picker+`confirm()`
UI path" line: stays as a named open item until this harness is
actually executed against a real browser. The code fix (merge-mode UI
exposure) is real and independently useful regardless of when/whether
the harness runs — it closes a genuine UX gap, not just a test gap.
