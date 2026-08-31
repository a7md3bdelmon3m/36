// import.js — KIMA EIS workbook import pipeline (05_IMPORT/IMPORT_PIPELINE.md)
// Stage order is fixed and must not be reordered or collapsed:
//   fingerprint -> parse -> structural validation -> header/schema recognition
//   -> normalization -> candidate identity resolution -> relationship extraction
//   -> evidence attachment -> conflict report -> preview -> commit
//
// File formats: CSV (manual RFC-4180 parser, built R2-001) and .xlsx/.xls
// (via a locally-vendored SheetJS build, added R2-002 — see
// 30_WEB_APP/lib/xlsx.full.min.js, loaded as a global `XLSX` by index.html's
// local <script> tag, never a CDN). Both formats normalize to the exact same
// row-array shape before entering validateStructure, so every stage after
// `parse` is completely format-agnostic and untouched by which format was
// used.

import { KimaDB } from './db.js';

/**
 * Stage 1: fingerprint. SHA-256 over the raw file bytes, computed BEFORE
 * any parsing/decoding, so two byte-identical files always fingerprint
 * identically regardless of parse outcome (per stage-order constraint).
 * Format-agnostic: works identically for CSV text bytes and .xlsx binary
 * bytes.
 */
async function fingerprintFile(file) {
  const buffer = await file.arrayBuffer();
  const checksum = await KimaDB.sha256HexBytes(buffer);
  return { checksum, buffer, byteLength: buffer.byteLength };
}

/**
 * Stage 2: parse. Manual CSV parser — handles quoted fields, embedded
 * commas/newlines/escaped quotes (RFC 4180-style), without any external
 * dependency. Returns an array of raw row arrays (strings), header row
 * included as rows[0].
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  function endField() {
    row.push(field);
    field = '';
  }
  function endRow() {
    endField();
    rows.push(row);
    row = [];
  }

  while (i < len) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += c; i += 1; continue;
    }
    if (c === '"') { inQuotes = true; i += 1; continue; }
    if (c === ',') { endField(); i += 1; continue; }
    if (c === '\r') { i += 1; continue; } // normalize CRLF -> LF
    if (c === '\n') { endRow(); i += 1; continue; }
    field += c; i += 1;
  }
  // Final field/row if the file doesn't end with a newline.
  if (field.length > 0 || row.length > 0) endRow();

  // Drop fully-empty trailing rows (common with trailing blank lines).
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/**
 * Stage 2 (alternate branch): parse .xlsx/.xls via the locally-vendored
 * SheetJS build (30_WEB_APP/lib/xlsx.full.min.js, loaded as the global
 * `XLSX` by index.html — never fetched from a CDN; checked explicitly
 * here rather than assumed present, so a missing/blocked script tag
 * fails loud with a clear message instead of a confusing crash deep in
 * this function).
 *
 * Defaults to the first sheet (R2-002 scope decision, recorded in
 * R2-002-TASK_RESULT.md). `sheetName` (optional, added in this review to
 * address the case where the first sheet is a README/index sheet and the
 * actual tabular data lives on a later sheet — common in real DEXPI/CFIHOS
 * workbooks with 20-30+ sheets) lets the caller pick a different sheet
 * explicitly. This is additive, not a reversal of R2-002: silent
 * first-sheet-only behavior is preserved by default; the caller must
 * opt in to a different sheet.
 *
 * Returns the exact same row-array shape parseCsv returns (rows[0] =
 * header, rows[1..] = data, all cell values coerced to strings) so
 * every pipeline stage after `parse` is unaffected by which format was
 * used.
 */
function parseXlsx(buffer, sheetName = null) {
  if (typeof XLSX === 'undefined') {
    throw new Error('مكتبة قراءة Excel (xlsx.full.min.js) غير محمَّلة — تحقق من وجود الملف في 30_WEB_APP/lib/');
  }
  const workbook = XLSX.read(buffer, { type: 'array' });
  const sheetNames = workbook.SheetNames || [];
  if (sheetNames.length === 0) {
    return { rows: [], ignoredSheets: [], allSheets: [] };
  }
  const targetSheetName = (sheetName && sheetNames.includes(sheetName)) ? sheetName : sheetNames[0];
  const sheet = workbook.Sheets[targetSheetName];
  // header:1 -> array-of-arrays (not object-per-row), matching parseCsv's
  // shape exactly; defval:'' -> missing cells become '' rather than being
  // omitted, so every row keeps the header's column count (ragged rows
  // still get caught by validateStructure exactly as with CSV).
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false });
  const rows = aoa.map((r) => r.map((cell) => (cell === null || cell === undefined ? '' : String(cell))));
  return { rows, ignoredSheets: sheetNames.filter((n) => n !== targetSheetName), usedSheet: targetSheetName, allSheets: sheetNames };
}

/**
 * Detects which parse branch to use from the file's name/type, per the
 * task contract's format decision. Defaults to CSV for anything not
 * recognized as Excel, since CSV is the more forgiving/inspectable
 * format for an unrecognized extension.
 */
function detectFormat(file) {
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) return 'xlsx';
  if (file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'xlsx';
  if (file.type === 'application/vnd.ms-excel') return 'xlsx';
  return 'csv';
}

/**
 * Stage 3: structural validation. A well-formed workbook has a header
 * row and at least one data row, and every data row has the same column
 * count as the header (ragged rows are a structural conflict, not a
 * silent best-effort fill).
 */
function validateStructure(rows) {
  const issues = [];
  if (rows.length === 0) {
    issues.push({ severity: 'BLOCKER', stage: 'structural_validation', message: 'الملف فارغ تمامًا' });
    return { ok: false, issues };
  }
  if (rows.length === 1) {
    issues.push({ severity: 'BLOCKER', stage: 'structural_validation', message: 'يحتوي الملف على صف الرأس فقط، بلا بيانات' });
    return { ok: false, issues };
  }
  const headerLen = rows[0].length;
  rows.forEach((r, idx) => {
    if (idx === 0) return;
    if (r.length !== headerLen) {
      issues.push({
        severity: 'MAJOR', stage: 'structural_validation', row: idx,
        message: `الصف ${idx + 1} يحتوي على ${r.length} عمودًا بدل ${headerLen} (لن يُلتزَم به)`,
      });
    }
  });
  return { ok: true, issues };
}

/**
 * Stage 4: header/schema recognition. Maps recognized header names
 * (case-insensitive, trimmed) to the canonical fields this pipeline
 * knows how to import. Unrecognized columns are kept as-is and reported
 * as INFO (unmapped optional metadata), never silently dropped from the
 * source-value record.
 */
const KNOWN_HEADERS = {
  entity_type: [
    'entity_type', 'type', 'النوع',
    'asset_type', 'asset type', 'component_type', 'component type',
    'equipment_type', 'equipment type', 'item_type', 'item type',
    'category', 'class', 'object_type', 'object type', 'kind',
    'نوع العنصر', 'نوع الأصل', 'الفئة',
    // KIMA real-file synonyms (ADR-013): K103 DEXPI/CFIHOS master workbook
    // uses "Functional Type" / "Source/Functional Type" as its type column,
    // and carries the DEXPI/CFIHOS class as a separate *_Mapping column
    // (kept distinct from entity_type — see identifier/context notes below;
    // class-mapping columns are informational, not mapped to entity_type,
    // to avoid conflating "what kind of thing" with "which external
    // ontology class it aligns to").
    'functional_type', 'functional type', 'source/functional type',
    'source / functional type',
  ],
  canonical_name: [
    'canonical_name', 'tag', 'المعرف القانوني', 'الاسم القانوني',
    'tag_number', 'tag number', 'tag no', 'tag no.', 'tagno',
    'equipment_tag', 'equipment tag', 'asset_tag', 'asset tag',
    'component_id', 'component id', 'functional_location', 'functional location',
    'رقم العلامة', 'رقم التاج', 'المعرف',
    // KIMA real-file synonyms (ADR-013): K103 DEXPI/CFIHOS master workbook's
    // tag column is literally "Tag_ID" across 02_Asset_Register,
    // 06_Instruments, 07_Valves, 08_Equipment.
    'tag_id', 'tag id',
  ],
  display_name: [
    'display_name', 'name', 'الاسم', 'الاسم المعروض',
    'description', 'short_description', 'short description',
    'equipment_name', 'equipment name', 'title',
    'الوصف', 'الوصف المختصر',
  ],
  context: [
    'context', 'السياق',
    'location', 'area', 'unit', 'system', 'plant_area', 'plant area',
    'الموقع', 'المنطقة', 'الوحدة', 'النظام',
  ],
  namespace: ['namespace', 'identifier_namespace', 'نطاق المعرف'],
  identifier: [
    'identifier', 'id', 'المعرف',
    'asset_id', 'asset id', 'equipment_id', 'equipment id',
  ],
};

function recognizeHeaders(headerRow) {
  const map = {}; // canonical field -> column index
  const unmapped = [];
  headerRow.forEach((raw, colIdx) => {
    const h = raw.trim().toLowerCase();
    let matched = null;
    for (const [canonicalField, aliases] of Object.entries(KNOWN_HEADERS)) {
      if (aliases.some((a) => a.toLowerCase() === h)) { matched = canonicalField; break; }
    }
    if (matched) map[matched] = colIdx;
    else unmapped.push({ column: raw, index: colIdx });
  });
  return { map, unmapped };
}

/**
 * Stage 5: normalization. Trims whitespace for comparison purposes ONLY
 * — the original raw value is preserved separately and unmodified
 * (Import invariant: original source values are preserved). Normalized
 * values are used solely for header/identity matching, never persisted
 * in place of the original.
 */
function normalize(value) {
  return (value ?? '').trim();
}

/**
 * Stages 6-9: candidate identity resolution, relationship extraction,
 * evidence attachment, conflict report — combined into one pass over
 * data rows, producing a per-row plan. Relationship extraction is a
 * no-op in R2-001 (this CSV schema only expresses entities+identifiers,
 * not relationships between them yet) but the stage is still named and
 * present in the returned plan for pipeline-completeness and to avoid
 * silently skipping a documented stage without saying so.
 */
async function buildImportPlan(rows, headerMap, sourceRef) {
  const dataRows = rows.slice(1);
  const plan = { rows: [], conflicts: [], relationshipExtraction: { extracted: 0, note: 'لا توجد أعمدة علاقات معروفة في هذا المخطط بعد — لا استخراج علاقات في R2-001' } };

  // First pass: count occurrences of each [namespace, identifier] key within
  // this file. A key appearing more than once has no objective way to pick
  // which occurrence is "the real one" without a reviewed decision — so
  // ALL rows sharing a duplicated key are flagged BLOCKER equally, not just
  // the second-and-later occurrences. Silently accepting the first one and
  // only rejecting the rest would be an unreviewed identity decision, which
  // MASTER_PROJECT_CONTRACT.md's matching rule does not permit.
  const keyOccurrenceCount = new Map();
  const rowKeys = [];
  for (let i = 0; i < dataRows.length; i += 1) {
    const raw = dataRows[i];
    if (raw.length !== rows[0].length) { rowKeys.push(null); continue; }
    const get = (field) => (headerMap[field] !== undefined ? raw[headerMap[field]] : undefined);
    const namespace = normalize(get('namespace'));
    const identifier = normalize(get('identifier'));
    const key = (namespace && identifier) ? `${namespace}|${identifier}` : null;
    rowKeys.push(key);
    if (key) keyOccurrenceCount.set(key, (keyOccurrenceCount.get(key) || 0) + 1);
  }

  for (let i = 0; i < dataRows.length; i += 1) {
    const raw = dataRows[i];
    if (raw.length !== rows[0].length) continue; // already reported as MAJOR structural conflict, skip from plan

    const get = (field) => (headerMap[field] !== undefined ? raw[headerMap[field]] : undefined);
    const entity_type = normalize(get('entity_type'));
    const canonical_name = normalize(get('canonical_name'));
    const display_name = normalize(get('display_name')) || canonical_name;
    const context = get('context') !== undefined ? normalize(get('context')) || null : null;
    const namespace = normalize(get('namespace'));
    const identifier = normalize(get('identifier'));

    const rowConflicts = [];
    if (!entity_type || !canonical_name) {
      rowConflicts.push({ severity: 'BLOCKER', stage: 'candidate_identity_resolution', row: i + 2, message: 'entity_type و canonical_name إلزاميان (CANONICAL_ENTITY_CONTRACT.md)' });
    }

    const identityKey = rowKeys[i];
    if (identityKey && keyOccurrenceCount.get(identityKey) > 1) {
      // Import invariant: duplicate canonical identifier -> BLOCKER (IMPORT_CONFLICT_POLICY.md example 1).
      // Every row sharing this key is flagged, not just the later occurrence(s).
      rowConflicts.push({ severity: 'BLOCKER', stage: 'conflict_report', row: i + 2, message: `معرّف مكرر داخل نفس الملف (${keyOccurrenceCount.get(identityKey)} تكرارات): [${namespace}, ${identifier}]` });
    }

    // Exact-match identity resolution only (CANONICAL_ENTITY_CONTRACT.md: never fuzzy).
    let matchedEntityId = null;
    if (namespace && identifier && rowConflicts.every((c) => c.severity !== 'BLOCKER')) {
      const existing = await KimaDB.findEntityIdentifier(namespace, identifier);
      if (existing) matchedEntityId = existing.entity_id;
    }

    plan.rows.push({
      sourceRowNumber: i + 2, // 1-based, +1 for header row
      raw: { entity_type: get('entity_type'), canonical_name: get('canonical_name'), display_name: get('display_name'), context: get('context'), namespace: get('namespace'), identifier: get('identifier') },
      normalized: { entity_type, canonical_name, display_name, context, namespace, identifier },
      action: matchedEntityId ? 'update' : 'insert',
      matchedEntityId,
      conflicts: rowConflicts,
      sourceReference: `${sourceRef} — row ${i + 2}`,
    });
    plan.conflicts.push(...rowConflicts.map((c) => ({ ...c })));
  }

  return plan;
}

/**
 * Stage 10: preview. Returns the plan plus a header-recognition report,
 * performing zero IndexedDB writes — callers must not call commit()
 * without the caller's own explicit action (no auto-commit).
 *
 * `overrideMap` (optional): { canonicalField: columnIndex, ... } — lets the
 * caller manually bind a source column to a KIMA field when automatic
 * KNOWN_HEADERS recognition misses it (M-03: heterogeneous workbooks won't
 * all use header names this pipeline already knows). Manual entries always
 * win over automatic ones for the same canonical field; a manual entry set
 * to null/undefined clears that field's mapping entirely (lets the user
 * say "don't import this field" even if auto-detection had guessed one).
 */
export async function previewImport(file, overrideMap = null, sheetName = null) {
  const { checksum, buffer } = await fingerprintFile(file);
  const format = detectFormat(file);

  let rows;
  let ignoredSheets = [];
  let usedSheet = null;
  let allSheets = [];
  if (format === 'xlsx') {
    const parsed = parseXlsx(buffer, sheetName);
    rows = parsed.rows;
    ignoredSheets = parsed.ignoredSheets || [];
    usedSheet = parsed.usedSheet || null;
    allSheets = parsed.allSheets || [];
  } else {
    const text = new TextDecoder('utf-8').decode(buffer);
    rows = parseCsv(text);
  }

  const structural = validateStructure(rows);
  if (!structural.ok) {
    return { checksum, fileName: file.name, format, buffer, structural, headerReport: null, plan: { rows: [], conflicts: structural.issues, relationshipExtraction: null }, ignoredSheets, usedSheet, allSheets };
  }

  const auto = recognizeHeaders(rows[0]);
  let map = { ...auto.map };
  let unmapped = auto.unmapped;
  if (overrideMap && typeof overrideMap === 'object') {
    for (const [field, colIdx] of Object.entries(overrideMap)) {
      if (colIdx === null || colIdx === undefined || colIdx === '') { delete map[field]; continue; }
      map[field] = Number(colIdx);
    }
    // Recompute unmapped: a column index now claimed by any field is no longer "unmapped".
    const claimedIdx = new Set(Object.values(map));
    unmapped = rows[0].map((raw, index) => ({ column: raw, index })).filter((u) => !claimedIdx.has(u.index));
  }
  const headerReport = { map, unmapped, auto: auto.map, manualOverride: !!overrideMap };
  const plan = await buildImportPlan(rows, map, `${file.name} (${checksum.slice(0, 12)})`);

  return { checksum, fileName: file.name, format, buffer, structural, headerReport, plan, ignoredSheets, usedSheet, allSheets, sourceHeaderRow: rows[0] };
}

/**
 * Stage 11: commit. Persists only rows with zero BLOCKER-severity
 * conflicts. Records one `source` row per commit attempt (provenance of
 * "when was this file imported"), and per non-BLOCKER row either
 * updates the matched existing entity (idempotent re-import path) or
 * inserts a new one + its identifier (first-import path). Each row's
 * commit runs as its own logical unit so one row's failure does not
 * abort unrelated rows — but each row's own entity+identifier write
 * still shares a single transaction (per R1-002's established pattern).
 */
export async function commitImport(previewResult) {
  const { checksum, fileName, plan } = previewResult;

  const sourceType = previewResult.format === 'xlsx' ? 'workbook_xlsx' : (previewResult.format === 'csv' ? 'workbook_csv' : `workbook_${previewResult.format || 'unknown'}`);
  const registered = await KimaDB.registerSourceWithArtifact({ source_type: sourceType, source_name: fileName, source_version: checksum.slice(0, 16), buffer: previewResult.buffer, file_name: fileName, mime_type: previewResult.format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv' });
  const source = registered.source;

  const committed = [];
  const skipped = [];

  for (const row of plan.rows) {
    const hasBlocker = row.conflicts.some((c) => c.severity === 'BLOCKER');
    if (hasBlocker) { skipped.push({ sourceRowNumber: row.sourceRowNumber, reason: 'BLOCKER conflict present' }); continue; }
    try { const r = await KimaDB.commitImportRow({ row, source_id: source.source_id }); committed.push({ sourceRowNumber: row.sourceRowNumber, entity_id: r.entity.entity_id, action: r.action, observation_id: r.observation.observation_id }); }
    catch (err) { skipped.push({ sourceRowNumber: row.sourceRowNumber, reason: err.message || String(err) }); }
  }

  return { source, committed, skipped };
}

export const ImportPipeline = { previewImport, commitImport, parseCsv, parseXlsx, detectFormat, validateStructure, recognizeHeaders };

// ============================================================================
// R2-003 — Relationship import (parallel stage, per ADR-013's recommendation:
// a new pipeline stage, NOT an extension of KNOWN_HEADERS/buildImportPlan
// above, which are entity-import-shaped and untouched by anything below).
// ============================================================================

/**
 * Header aliases for relationship-shaped sheets, modeled directly on
 * ADR-013's documented real column names for K103's 09_Piping_Connections
 * (144 rows) and 10_Relationships (35 rows) sheets: From_Tag/To_Tag or
 * From_ID/To_ID, plus Relationship_Type. A separate map from
 * KNOWN_HEADERS (entity import) — these are relationship-endpoint roles,
 * not entity fields, and must not be conflated with them.
 */
const RELATIONSHIP_KNOWN_HEADERS = {
  from: ['from_tag', 'from tag', 'from_id', 'from id', 'source_tag', 'source tag', 'from', 'source', 'المصدر'],
  to: ['to_tag', 'to tag', 'to_id', 'to id', 'target_tag', 'target tag', 'to', 'target', 'الهدف'],
  relationship_type: ['relationship_type', 'relationship type', 'type', 'نوع العلاقة'],
  direction: ['direction', 'الاتجاه'],
};

function recognizeRelationshipHeaders(headerRow) {
  const map = {};
  const unmapped = [];
  headerRow.forEach((raw, colIdx) => {
    const h = raw.trim().toLowerCase();
    let matched = null;
    for (const [canonicalField, aliases] of Object.entries(RELATIONSHIP_KNOWN_HEADERS)) {
      if (aliases.some((a) => a.toLowerCase() === h)) { matched = canonicalField; break; }
    }
    if (matched) map[matched] = colIdx;
    else unmapped.push({ column: raw, index: colIdx });
  });
  return { map, unmapped };
}

/**
 * Builds a relationship-import plan. Unlike buildImportPlan (entities),
 * this stage needs live KimaDB lookups per row (resolving From/To tag
 * values to entity_ids) — the same async-per-row shape buildImportPlan
 * already uses for findEntityIdentifier, extended here for
 * findEntitiesByCanonicalName's ambiguous-array-result case, per this
 * task's contract findings #1-#3.
 *
 * relationship_type/direction validity is pre-checked here against the
 * exact same RELATIONSHIP_TYPES/RELATIONSHIP_RULES createRelationship
 * itself enforces (imported from db.js, not re-declared), so a BLOCKER
 * a user sees at preview time is guaranteed to match what commit would
 * have rejected — never a narrower or looser check than the real one.
 */
async function buildRelationshipImportPlan(rows, headerMap, sourceRef, { RELATIONSHIP_TYPES, RELATIONSHIP_RULES }) {
  const dataRows = rows.slice(1);
  const plan = { rows: [], conflicts: [] };

  // Duplicate-within-file detection for exact (from, to, type, direction)
  // tuples — mirrors buildImportPlan's identifier-duplicate handling
  // (every row sharing a key flagged, not just later occurrences), applied
  // here as an INFO-level note rather than a BLOCKER: per this task's
  // acceptance criterion 5, an exact repeated row within one file is far
  // more likely to be a genuinely repeated real-world relationship
  // statement (e.g. the same physical connection listed on two related
  // sheets) than a data-entry error, so it is surfaced for awareness
  // without silently blocking an otherwise-valid row.
  const tupleCount = new Map();
  const rowTuples = [];
  for (let i = 0; i < dataRows.length; i += 1) {
    const raw = dataRows[i];
    if (raw.length !== rows[0].length) { rowTuples.push(null); continue; }
    const get = (field) => (headerMap[field] !== undefined ? raw[headerMap[field]] : undefined);
    const tuple = [normalize(get('from')), normalize(get('to')), normalize(get('relationship_type')), normalize(get('direction')) || 'forward'].join('|');
    rowTuples.push(tuple);
    tupleCount.set(tuple, (tupleCount.get(tuple) || 0) + 1);
  }

  for (let i = 0; i < dataRows.length; i += 1) {
    const raw = dataRows[i];
    if (raw.length !== rows[0].length) continue; // reported as structural conflict already, skip from plan

    const get = (field) => (headerMap[field] !== undefined ? raw[headerMap[field]] : undefined);
    const fromTag = normalize(get('from'));
    const toTag = normalize(get('to'));
    const relationship_type = normalize(get('relationship_type'));
    const rawDirection = normalize(get('direction'));
    // Per this task's contract finding #5: never guess at new direction
    // vocabulary aliases (M-19's own lesson). Default to 'forward' — the
    // same default assertRelationshipSemantics itself applies when
    // direction is omitted — and surface the raw source value regardless,
    // so a mismatch is visible rather than silently coerced.
    const direction = rawDirection || 'forward';

    const rowConflicts = [];
    if (!fromTag || !toTag || !relationship_type) {
      rowConflicts.push({ severity: 'BLOCKER', stage: 'candidate_identity_resolution', row: i + 2, message: 'From/To/Relationship_Type إلزامية لكل صف علاقة' });
    }
    if (relationship_type && !RELATIONSHIP_TYPES.includes(relationship_type)) {
      rowConflicts.push({ severity: 'BLOCKER', stage: 'relationship_semantics', row: i + 2, message: `نوع علاقة غير معروف: ${relationship_type}` });
    } else if (relationship_type) {
      const allowed = RELATIONSHIP_RULES[relationship_type]?.allowedDirections || ['forward'];
      if (!allowed.includes(direction)) {
        rowConflicts.push({ severity: 'BLOCKER', stage: 'relationship_semantics', row: i + 2, message: `اتجاه غير صالح (${rawDirection || '(افتراضي: forward)'}) لنوع العلاقة ${relationship_type} — المسموح: ${allowed.join(', ')}` });
      }
    }

    // Endpoint resolution — only attempted if we have both tags and no
    // BLOCKER yet, matching buildImportPlan's existing pattern of skipping
    // live DB lookups once a row is already known-invalid.
    let sourceMatches = [];
    let targetMatches = [];
    if (fromTag && toTag && rowConflicts.every((c) => c.severity !== 'BLOCKER')) {
      [sourceMatches, targetMatches] = await Promise.all([
        KimaDB.findEntitiesByCanonicalName(null, fromTag),
        KimaDB.findEntitiesByCanonicalName(null, toTag),
      ]);
      if (sourceMatches.length === 0) rowConflicts.push({ severity: 'BLOCKER', stage: 'candidate_identity_resolution', row: i + 2, message: `لم يُعثر على عنصر بالاسم القانوني: ${fromTag} (يجب استيراد الكيانات أولًا)` });
      else if (sourceMatches.length > 1) rowConflicts.push({ severity: 'BLOCKER', stage: 'candidate_identity_resolution', row: i + 2, message: `تطابق غامض: ${sourceMatches.length} عناصر تحمل الاسم القانوني ${fromTag} — يلزم تدقيق يدوي` });
      if (targetMatches.length === 0) rowConflicts.push({ severity: 'BLOCKER', stage: 'candidate_identity_resolution', row: i + 2, message: `لم يُعثر على عنصر بالاسم القانوني: ${toTag} (يجب استيراد الكيانات أولًا)` });
      else if (targetMatches.length > 1) rowConflicts.push({ severity: 'BLOCKER', stage: 'candidate_identity_resolution', row: i + 2, message: `تطابق غامض: ${targetMatches.length} عناصر تحمل الاسم القانوني ${toTag} — يلزم تدقيق يدوي` });
    }

    const tuple = rowTuples[i];
    if (tuple && tupleCount.get(tuple) > 1) {
      rowConflicts.push({ severity: 'INFO', stage: 'conflict_report', row: i + 2, message: `صف علاقة مكرر حرفيًا داخل نفس الملف (${tupleCount.get(tuple)} مرات): ${fromTag} -> ${toTag} (${relationship_type})` });
    }

    plan.rows.push({
      sourceRowNumber: i + 2,
      raw: { from: get('from'), to: get('to'), relationship_type: get('relationship_type'), direction: get('direction') },
      normalized: {
        sourceEntityId: sourceMatches.length === 1 ? sourceMatches[0].entity_id : null,
        targetEntityId: targetMatches.length === 1 ? targetMatches[0].entity_id : null,
        relationship_type, direction,
      },
      conflicts: rowConflicts,
      sourceReference: `${sourceRef} — row ${i + 2}`,
    });
    plan.conflicts.push(...rowConflicts.map((c) => ({ ...c })));
  }

  return plan;
}

/**
 * Preview for the relationship pipeline. Same fingerprint/parse/
 * structural-validation stages as previewImport (format-agnostic, so
 * reused directly, not duplicated) — only header recognition and plan
 * building differ, since the target data shape is relationships, not
 * entities.
 */
export async function previewRelationshipImport(file, overrideMap = null, sheetName = null) {
  const { checksum, buffer } = await fingerprintFile(file);
  const format = detectFormat(file);

  let rows;
  let ignoredSheets = [];
  let usedSheet = null;
  let allSheets = [];
  if (format === 'xlsx') {
    const parsed = parseXlsx(buffer, sheetName);
    rows = parsed.rows;
    ignoredSheets = parsed.ignoredSheets || [];
    usedSheet = parsed.usedSheet || null;
    allSheets = parsed.allSheets || [];
  } else {
    const text = new TextDecoder('utf-8').decode(buffer);
    rows = parseCsv(text);
  }

  const structural = validateStructure(rows);
  if (!structural.ok) {
    return { checksum, fileName: file.name, format, buffer, structural, headerReport: null, plan: { rows: [], conflicts: structural.issues }, ignoredSheets, usedSheet, allSheets };
  }

  const auto = recognizeRelationshipHeaders(rows[0]);
  let map = { ...auto.map };
  let unmapped = auto.unmapped;
  if (overrideMap && typeof overrideMap === 'object') {
    for (const [field, colIdx] of Object.entries(overrideMap)) {
      if (colIdx === null || colIdx === undefined || colIdx === '') { delete map[field]; continue; }
      map[field] = Number(colIdx);
    }
    const claimedIdx = new Set(Object.values(map));
    unmapped = rows[0].map((raw, index) => ({ column: raw, index })).filter((u) => !claimedIdx.has(u.index));
  }
  const headerReport = { map, unmapped, auto: auto.map, manualOverride: !!overrideMap };
  const plan = await buildRelationshipImportPlan(rows, map, `${file.name} (${checksum.slice(0, 12)})`, { RELATIONSHIP_TYPES: KimaDB.RELATIONSHIP_TYPES, RELATIONSHIP_RULES: KimaDB.RELATIONSHIP_RULES });

  return { checksum, fileName: file.name, format, buffer, structural, headerReport, plan, ignoredSheets, usedSheet, allSheets, sourceHeaderRow: rows[0] };
}

/**
 * Commit for the relationship pipeline. Same per-row-independent-
 * transaction shape as commitImport (entities) — one source record per
 * commit attempt, each row's write isolated so one failure doesn't
 * abort siblings — but calls KimaDB.commitImportRelationshipRow (new,
 * R2-003) instead of commitImportRow, and never writes to the
 * relationship store directly.
 */
export async function commitRelationshipImport(previewResult) {
  const { checksum, fileName, plan } = previewResult;

  const sourceType = previewResult.format === 'xlsx' ? 'workbook_xlsx' : (previewResult.format === 'csv' ? 'workbook_csv' : `workbook_${previewResult.format || 'unknown'}`);
  const registered = await KimaDB.registerSourceWithArtifact({ source_type: sourceType, source_name: fileName, source_version: checksum.slice(0, 16), buffer: previewResult.buffer, file_name: fileName, mime_type: previewResult.format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv' });
  const source = registered.source;

  const committed = [];
  const skipped = [];

  for (const row of plan.rows) {
    const hasBlocker = row.conflicts.some((c) => c.severity === 'BLOCKER');
    if (hasBlocker) { skipped.push({ sourceRowNumber: row.sourceRowNumber, reason: 'BLOCKER conflict present' }); continue; }
    try {
      const r = await KimaDB.commitImportRelationshipRow({ row, source_id: source.source_id });
      committed.push({ sourceRowNumber: row.sourceRowNumber, relationship_id: r.relationship.relationship_id, evidence_id: r.evidence.evidence_id });
    } catch (err) {
      skipped.push({ sourceRowNumber: row.sourceRowNumber, reason: err.message || String(err) });
    }
  }

  return { source, committed, skipped };
}

export const RelationshipImportPipeline = { previewRelationshipImport, commitRelationshipImport, recognizeRelationshipHeaders };
