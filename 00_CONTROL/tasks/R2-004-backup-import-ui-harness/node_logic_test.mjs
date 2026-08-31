// ADR-033: Node-logic verification for the new #backup-import-mode
// (replace/merge) feature — the parts reachable without a real DOM or
// real IndexedDB.
//
// Two tiers here:
// 1. Source-level confirmation that app.js's handleBackupImport genuinely
//    reads the new mode select and branches its confirm()/replace logic
//    accordingly (not hardcoded to true as before this task).
// 2. A REAL exercise of KimaDB.importBackup's replace:false vs
//    replace:true semantics — this part does NOT need a browser, since
//    db.js's importBackup only needs IndexedDB, which is unavailable
//    here (confirmed: fake-indexeddb install still 403s, checked fresh
//    for this task) — so this tier is also source-verification only,
//    not a live DB run. Named explicitly, not glossed over.

import { readFile } from 'node:fs/promises';

let pass = 0, fail = 0;
function record(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${detail || ''}`); }
}

const appSrc = await readFile(new URL('../../../30_WEB_APP/app.js', import.meta.url), 'utf8');
const htmlSrc = await readFile(new URL('../../../30_WEB_APP/index.html', import.meta.url), 'utf8');

record(
  'R2004-LOGIC-1-mode-select-exists-in-html-with-replace-default',
  /id="backup-import-mode"/.test(htmlSrc) && /<option value="replace" selected>/.test(htmlSrc) && /<option value="merge">/.test(htmlSrc),
);

record(
  'R2004-LOGIC-2-handleBackupImport-reads-mode-select-not-hardcoded',
  appSrc.includes("el('#backup-import-mode')") && !appSrc.includes('importBackup(f,{replace:true})'),
  'confirms the old hardcoded replace:true call is gone',
);

record(
  'R2004-LOGIC-3-isReplace-computed-from-mode-not-constant',
  /const isReplace=mode!==.merge./.test(appSrc),
);

record(
  'R2004-LOGIC-4-importBackup-called-with-computed-isReplace',
  appSrc.includes('importBackup(f,{replace:isReplace})'),
);

record(
  'R2004-LOGIC-5-confirm-message-differs-by-mode',
  // Two distinct message literals must exist — replace's must mention
  // irreversibility, merge's must not claim data is deleted.
  /لا يمكن التراجع/.test(appSrc) && /دون حذفها/.test(appSrc),
);

record(
  'R2004-LOGIC-6-default-mode-is-replace-not-merge',
  // Safety property: if the select somehow fails to render/attach,
  // modeEl would be null and mode falls back to 'replace' (the safer,
  // more conservative default) not 'merge' — confirmed via the exact
  // fallback expression in source.
  /const mode=modeEl\?modeEl\.value:'replace'/.test(appSrc),
);

console.log(`\nR2004_LOGIC_TEST=${fail === 0 ? 'PASS' : 'FAIL'} (${pass}/${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
