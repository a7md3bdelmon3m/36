import { buildGraph, traverse } from './graph.js';
import { calculateImpact } from './impact.js';
import { evaluateObservations, summarizeDecisions } from './decision.js';
import { createTopologyRenderer } from './topology.js';
// app.js — KIMA EIS UI logic, wired to db.js (IndexedDB layer)
import { KimaDB } from './db.js';
import { ImportPipeline, RelationshipImportPipeline } from './import.js';

const el = (sel) => document.querySelector(sel);
const elAll = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  entities: [],
  selectedEntityId: null,
  activeTopologyRenderer: null,
  explorer: {
    query: '',
    entity_type: '',
    status: '',
    sort_by: 'updated_at',
    sort_order: 'desc',
    page: 1,
    pageSize: 20,
    contextLevels: [],
  },
};

function toast(message, kind = 'info') {
  const host = el('#toast-host');
  const node = document.createElement('div');
  node.className = `toast toast--${kind}`;
  node.textContent = message;
  host.appendChild(node);
  requestAnimationFrame(() => node.classList.add('toast--visible'));
  setTimeout(() => {
    node.classList.remove('toast--visible');
    setTimeout(() => node.remove(), 250);
  }, 4200);
}

function formatDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' });
  } catch (_) {
    return iso;
  }
}

function statusBadgeClass(status) {
  if (status === 'ACTIVE') return 'badge badge--active';
  if (status === 'RETIRED' || status === 'DEPRECATED') return 'badge badge--retired';
  return 'badge badge--pending';
}

/**
 * Loads all entities from IndexedDB into state.entities (the in-memory
 * cache other code — selectEntity, relationship/evidence forms — reads
 * from), then delegates to renderExplorer for the actual search/
 * filter/sort/paginate-aware display. Called after every write
 * (create, import commit, etc.) exactly as it always was; the explorer
 * behavior is additive, not a replacement of when this refresh happens.
 */
async function refreshEntityList() {
  state.entities = await KimaDB.listEntities();
  populateExplorerFilterOptions();
  renderExplorer();
}

/**
 * Populates the type/status filter <select> options from the actual
 * distinct values present in state.entities — never a hardcoded list,
 * so the UI never offers a filter option that couldn't possibly match
 * anything (or omits one that could).
 */
function populateExplorerFilterOptions() {
  const typeSelect = el('#explorer-filter-type');
  const statusSelect = el('#explorer-filter-status');
  const currentType = state.explorer.entity_type;
  const currentStatus = state.explorer.status;

  const types = Array.from(new Set(state.entities.map((e) => e.entity_type).filter(Boolean))).sort();
  const statuses = Array.from(new Set(state.entities.map((e) => e.status).filter(Boolean))).sort();

  typeSelect.innerHTML = '<option value="">كل الأنواع</option>' +
    types.map((t) => `<option value="${escapeHtml(t)}"${t === currentType ? ' selected' : ''}>${escapeHtml(t)}</option>`).join('');
  statusSelect.innerHTML = '<option value="">كل الحالات</option>' +
    statuses.map((s) => `<option value="${escapeHtml(s)}"${s === currentStatus ? ' selected' : ''}>${escapeHtml(s)}</option>`).join('');
}

/**
 * The actual explorer render: applies state.explorer's current search/
 * filter/sort/page settings via KimaDB.searchEntities (never
 * re-implements the filtering predicate here — see
 * R3-001-TASK_CONTRACT.md constraint 2), then renders the resulting
 * page of rows, pagination controls, and empty/no-results states.
 */
function renderExplorer() {
  renderContextFilterIndicator();
  const listHost = el('#entity-list');
  const emptyState = el('#entity-empty');
  const noResultsState = el('#explorer-no-results');
  const countBadge = el('#entity-count');
  const paginationNav = el('#explorer-pagination');

  countBadge.textContent = String(state.entities.length);

  if (state.entities.length === 0) {
    listHost.innerHTML = '';
    emptyState.hidden = false;
    noResultsState.hidden = true;
    paginationNav.hidden = true;
    return;
  }
  emptyState.hidden = true;

  const result = KimaDB.searchEntities(state.entities, state.explorer);

  if (result.total === 0) {
    listHost.innerHTML = '';
    noResultsState.hidden = false;
    paginationNav.hidden = true;
    return;
  }
  noResultsState.hidden = true;

  listHost.innerHTML = result.items.map((e) => {
    const ctx = KimaDB.parseContextHierarchy(e.context);
    const breadcrumb = ctx.levels.length > 0
      ? `<span class="entity-row__context">${ctx.levels.map(escapeHtml).join(' / ')}</span>`
      : '';
    return `
    <li class="entity-row" data-entity-id="${e.entity_id}" tabindex="0" role="button" aria-pressed="${state.selectedEntityId === e.entity_id}">
      <div class="entity-row__main">
        <span class="entity-row__name">${escapeHtml(e.display_name)}</span>
        <span class="entity-row__canonical">${escapeHtml(e.canonical_name)}</span>
        ${breadcrumb}
      </div>
      <div class="entity-row__meta">
        <span class="chip">${escapeHtml(e.entity_type)}</span>
        <span class="${statusBadgeClass(e.status)}">${escapeHtml(e.status)}</span>
      </div>
    </li>
  `;
  }).join('');

  elAll('.entity-row').forEach((row) => {
    row.addEventListener('click', () => selectEntity(row.dataset.entityId));
    row.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); selectEntity(row.dataset.entityId); }
    });
  });

  if (result.totalPages > 1) {
    paginationNav.hidden = false;
    el('#explorer-page-info').textContent = `صفحة ${result.page} من ${result.totalPages} (${result.total} نتيجة)`;
    el('#explorer-page-prev').disabled = result.page <= 1;
    el('#explorer-page-next').disabled = result.page >= result.totalPages;
  } else {
    paginationNav.hidden = true;
  }
}

function setupExplorerControls() {
  const searchInput = el('#explorer-search-input');
  const typeSelect = el('#explorer-filter-type');
  const statusSelect = el('#explorer-filter-status');
  const sortBySelect = el('#explorer-sort-by');
  const sortDirBtn = el('#explorer-sort-direction');
  const pagePrevBtn = el('#explorer-page-prev');
  const pageNextBtn = el('#explorer-page-next');

  let searchDebounceTimer = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      state.explorer.query = searchInput.value;
      state.explorer.page = 1;
      renderExplorer();
    }, 150);
  });

  typeSelect.addEventListener('change', () => {
    state.explorer.entity_type = typeSelect.value;
    state.explorer.page = 1;
    renderExplorer();
  });

  statusSelect.addEventListener('change', () => {
    state.explorer.status = statusSelect.value;
    state.explorer.page = 1;
    renderExplorer();
  });

  sortBySelect.addEventListener('change', () => {
    state.explorer.sort_by = sortBySelect.value;
    renderExplorer();
  });

  sortDirBtn.addEventListener('click', () => {
    state.explorer.sort_order = state.explorer.sort_order === 'asc' ? 'desc' : 'asc';
    sortDirBtn.textContent = state.explorer.sort_order === 'asc' ? '↑' : '↓';
    renderExplorer();
  });

  pagePrevBtn.addEventListener('click', () => {
    if (state.explorer.page > 1) { state.explorer.page -= 1; renderExplorer(); }
  });
  pageNextBtn.addEventListener('click', () => {
    state.explorer.page += 1;
    renderExplorer();
  });
}

/**
 * Updates the persistent context bar (01_PRODUCT/MOBILE_UX_REQUIREMENTS.md:
 * "Persistent context: Plant / Area / Unit / System") to show the
 * currently selected entity's parsed context hierarchy, if any. Shown
 * only when there is something real to show — never a placeholder/
 * guessed value, per "the UI never invents missing data".
 *
 * R3-002: each breadcrumb segment is now a clickable drill-down filter
 * (see R3-001-TASK_RESULT.md Warnings — "no app-wide current Plant/
 * Area/Unit/System filter that narrows the explorer itself"). Clicking
 * a segment sets state.explorer.contextLevels to that segment's full
 * prefix (e.g. clicking "Area" in "Plant/Area/Unit" filters to
 * ["Plant","Area"]) and re-renders the explorer via the existing
 * KimaDB.searchEntities path — no new filtering logic here, this only
 * sets the option searchEntities already knows how to apply.
 */
function updateContextBar(entity) {
  const bar = el('#context-bar');
  if (!entity) { bar.hidden = true; bar.innerHTML = ''; return; }
  const ctx = KimaDB.parseContextHierarchy(entity.context);
  if (ctx.levels.length === 0) { bar.hidden = true; bar.innerHTML = ''; return; }
  bar.hidden = false;
  bar.innerHTML = ctx.levels.map((level, i) => {
    const prefix = ctx.levels.slice(0, i + 1);
    return `<button type="button" class="context-bar__segment" data-context-prefix='${escapeHtml(JSON.stringify(prefix))}'>${escapeHtml(level)}</button>`;
  }).join('<span class="context-bar__sep" aria-hidden="true"> ‹ </span>');

  elAll('.context-bar__segment').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.explorer.contextLevels = JSON.parse(btn.dataset.contextPrefix);
      state.explorer.page = 1;
      renderExplorer();
    });
  });
}

/**
 * R3-002: shows which context-level filter is currently narrowing the
 * explorer (if any), with a control to clear it back to the full list.
 * Separate from updateContextBar (the header breadcrumb for the
 * *selected* entity) — this reflects the *explorer's* active filter,
 * which persists across selection changes until explicitly cleared.
 */
function renderContextFilterIndicator() {
  const host = el('#explorer-context-filter');
  if (!host) return;
  const levels = state.explorer.contextLevels;
  if (!levels || levels.length === 0) { host.hidden = true; host.innerHTML = ''; return; }
  host.hidden = false;
  host.innerHTML = `
    <span class="muted">مُصفّى حسب السياق: ${escapeHtml(levels.join(' ‹ '))}</span>
    <button type="button" id="explorer-context-filter-clear" class="btn btn--secondary">إزالة التصفية</button>
  `;
  el('#explorer-context-filter-clear').addEventListener('click', () => {
    state.explorer.contextLevels = [];
    state.explorer.page = 1;
    renderExplorer();
  });
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function validationBadgeClass(state) {
  if (state === 'VALIDATED' || state === 'CONFIRMED') return 'badge badge--active';
  if (state === 'REJECTED' || state === 'INVALID') return 'badge badge--retired';
  return 'badge badge--pending'; // UNREVIEWED and anything else
}

/**
 * Renders the R12 impact report (calculateImpact's output, impact.js)
 * as HTML. Purely a display layer — every value shown is read directly
 * from the report object (already computed from stored data, no
 * invention here either), consistent with "impact is not a guess
 * engine" governing impact.js itself.
 */
const IMPACT_CATEGORY_LABEL = Object.freeze({
  identity: 'الهوية (identity)',
  functional: 'وظيفي (functional)',
  topology: 'طوبولوجيا (topology)',
  document: 'مستندات (document)',
  standard: 'معيار (standard)',
  QA: 'ضمان الجودة (QA)',
  uncategorized: 'غير مصنّف',
});

function impactReportHtml(report, entities) {
  const entitiesById = new Map(entities.map((e) => [e.entity_id, e]));
  if (report.impacted.length === 0) {
    return '<p class="muted">لا يوجد أثر متوقع ضمن العمق المحدد.</p>';
  }
  const summaryChips = Object.entries(report.categorySummary)
    .filter(([, count]) => count > 0)
    .map(([cat, count]) => `<span class="chip chip--outline">${escapeHtml(IMPACT_CATEGORY_LABEL[cat] || cat)}: ${count}</span>`)
    .join(' ');
  const rows = report.impacted.map((row) => {
    const entity = entitiesById.get(row.entity_id);
    const label = entity ? escapeHtml(entity.canonical_name) : `<span class="mono">${escapeHtml(row.entity_id)}</span>`;
    const evidenceNote = row.evidence_id
      ? `<span class="muted">دليل: ${escapeHtml(row.evidence_id)}</span>`
      : '<span class="muted">بدون دليل مرتبط</span>';
    return `
      <li class="identifier-row">
        <span class="chip chip--outline">عمق ${row.depth}</span>
        <span>${label}</span>
        <span class="muted">${escapeHtml(row.relationship_type || '—')}</span>
        <span class="chip chip--outline">${escapeHtml(IMPACT_CATEGORY_LABEL[row.category] || row.category)}</span>
        <span class="${validationBadgeClass(row.validation_state)}">${escapeHtml(row.validation_state || 'UNREVIEWED')}</span>
        ${evidenceNote}
      </li>
    `;
  }).join('');
  return `
    <p class="muted">تم الحساب: ${escapeHtml(new Date(report.generated_at).toLocaleString('ar-EG'))} — إجمالي العناصر المتأثرة: ${report.impacted.length}</p>
    <p class="topology-legend">${summaryChips}</p>
    <ul class="identifier-list">${rows}</ul>
  `;
}

async function renderRelationshipTypeOptions() {
  return KimaDB.RELATIONSHIP_TYPES.map((t) => `<option value="${t}">${escapeHtml(t)}</option>`).join('');
}

async function renderEntityOptions(excludeEntityId) {
  return state.entities
    .filter((e) => e.entity_id !== excludeEntityId)
    .map((e) => `<option value="${e.entity_id}">${escapeHtml(e.display_name)} (${escapeHtml(e.canonical_name)})</option>`)
    .join('');
}

async function renderEvidenceOptions() {
  const evidenceList = await KimaDB.listEvidence();
  const opts = evidenceList
    .map((ev) => `<option value="${ev.evidence_id}">${escapeHtml(ev.evidence_type)} — ${escapeHtml(ev.locator)}</option>`)
    .join('');
  return `<option value="">— بلا دليل —</option>${opts}`;
}

// H-07: drawing_locator's evidence_id is mandatory (PNID_NAVIGATION_SPEC.md —
// no P&ID link is authoritative without evidence), so this variant omits the
// "no evidence" blank default that renderEvidenceOptions offers.
async function renderRequiredEvidenceOptions() {
  const evidenceList = await KimaDB.listEvidence();
  if (evidenceList.length === 0) return '<option value="">لا يوجد دليل مسجّل بعد — سجّل دليلاً أولاً</option>';
  return evidenceList
    .map((ev) => `<option value="${ev.evidence_id}">${escapeHtml(ev.evidence_type)} — ${escapeHtml(ev.locator)}</option>`)
    .join('');
}

async function renderDrawingOptions() {
  const drawings = await KimaDB.listDrawings();
  if (drawings.length === 0) return '<option value="">لا توجد رسومات مسجّلة بعد — سجّل رسمًا أولاً</option>';
  return drawings
    .map((d) => `<option value="${d.drawing_id}">${escapeHtml(d.drawing_number)}${d.drawing_version ? ' — ' + escapeHtml(d.drawing_version) : ''}</option>`)
    .join('');
}

function relationshipRowHtml(rel, currentEntityId) {
  const isOutgoing = rel.source_entity_id === currentEntityId;
  const otherId = isOutgoing ? rel.target_entity_id : rel.source_entity_id;
  const other = state.entities.find((e) => e.entity_id === otherId);
  const otherLabel = other ? escapeHtml(other.display_name) : `<span class="mono">${escapeHtml(otherId)}</span>`;
  const arrow = isOutgoing ? '→' : '←';
  return `
    <li class="identifier-row">
      <span class="chip chip--outline">${escapeHtml(rel.relationship_type)}</span>
      <span>${arrow} ${otherLabel}</span>
      <span class="${validationBadgeClass(rel.validation_state)}">${escapeHtml(rel.validation_state)}</span>
      ${rel.evidence_id ? '<span class="chip">مرتبط بدليل</span>' : ''}
    </li>
  `;
}

function evidenceRowHtml(ev, sourcesById) {
  const src = sourcesById.get(ev.source_id);
  const srcLabel = src ? escapeHtml(src.source_name) : `<span class="mono">${escapeHtml(ev.source_id)}</span>`;
  return `
    <li class="identifier-row">
      <span class="chip chip--outline">${escapeHtml(ev.evidence_type)}</span>
      <span>${escapeHtml(ev.locator)}</span>
      <span class="muted">من: ${srcLabel}</span>
      <span class="${validationBadgeClass(ev.validation_state)}">${escapeHtml(ev.validation_state)}</span>
    </li>
  `;
}

function standardMappingRowHtml(m) {
  return `
    <li class="identifier-row">
      <span class="chip chip--outline">${escapeHtml(m.standard_name)}</span>
      <span class="mono">${escapeHtml(m.standard_identifier)}</span>
      <span class="muted">${escapeHtml(m.mapping_type)}</span>
      ${m.notes ? `<span class="muted">${escapeHtml(m.notes)}</span>` : ''}
      <span class="${validationBadgeClass(m.validation_state)}">${escapeHtml(m.validation_state)}</span>
    </li>
  `;
}

// H-07: one entity→drawing→region locator row, per navigateEntityToDrawings' {locator, drawing} pairing.
function drawingLocatorRowHtml(pair) {
  const { locator, drawing } = pair;
  const drawingLabel = drawing ? escapeHtml(drawing.drawing_number) + (drawing.drawing_version ? ' — ' + escapeHtml(drawing.drawing_version) : '') : `<span class="mono">${escapeHtml(locator.drawing_id)}</span>`;
  return `
    <li class="identifier-row">
      <span class="chip chip--outline">${drawingLabel}</span>
      ${locator.region ? `<span class="muted">منطقة: ${escapeHtml(locator.region)}</span>` : ''}
      ${locator.page !== null && locator.page !== undefined ? `<span class="muted">صفحة: ${escapeHtml(String(locator.page))}</span>` : ''}
      <span class="chip">${escapeHtml(locator.navigation_state)}</span>
    </li>
  `;
}

// H-08: one field_observation row. Deliberately labeled "FIELD" and kept visually
// distinct from observation/decision rows — the spec states field data is separate
// from master/source data and never auto-overwrites it.
function fieldObservationRowHtml(fo) {
  return `
    <li class="identifier-row">
      <span class="chip chip--outline">FIELD</span>
      <span class="mono">${escapeHtml(String(fo.value))}${fo.unit ? ' ' + escapeHtml(fo.unit) : ''}</span>
      <span class="muted">${escapeHtml(new Date(fo.timestamp).toLocaleString('ar-EG'))}</span>
      ${fo.actor ? `<span class="muted">بواسطة: ${escapeHtml(fo.actor)}</span>` : ''}
      ${fo.note ? `<span class="muted">${escapeHtml(fo.note)}</span>` : ''}
      <span class="${validationBadgeClass(fo.validation_state)}">${escapeHtml(fo.validation_state)}</span>
    </li>
  `;
}


function decisionBadge(status){
  const labels={CRITICAL:'حرج',WATCH:'مراقبة',INVESTIGATE:'تحقيق',DATA_INSUFFICIENT:'بيانات غير كافية',NORMAL:'طبيعي'};
  return `<span class="${status==='CRITICAL'?'badge badge--retired':status==='WATCH'?'badge badge--pending':'chip chip--outline'}">${labels[status]||status}</span>`;
}
function roleNextStep(decision, role){
  if(decision.status==='CRITICAL'){
    if(role==='control_room') return 'تحقق من القراءة ومصدرها ثم اتبع إجراء التشغيل/الطوارئ المعتمد. لا تستخدم التطبيق كواجهة إصدار أمر تحكم.';
    if(role==='field') return 'تحقق ميدانيًا من القراءة والآلة وفق إجراءات السلامة المعتمدة، ثم سجّل النتيجة. لا تغيّر حالة المعدة من التطبيق.';
    return 'راجع الأدلة والحدود والاتجاه والعلاقات المتأثرة، ثم اتخذ القرار الهندسي وفق الإجراء المعتمد.';
  }
  if(decision.status==='WATCH'){
    if(role==='field') return 'أعد التحقق من القياس ومصدره ميدانيًا، وسجّل ملاحظة جديدة إذا لزم.';
    if(role==='control_room') return 'راقب الاتجاه وقارن بالحدود المعتمدة وسجّل أي تغير مهم وفق الإجراء.';
    return 'راجع جودة البيانات والاتجاه والأدلة وحدد إن كان يلزم فحص أو تحليل إضافي.';
  }
  if(decision.status==='DATA_INSUFFICIENT') return 'أكمل البيانات أو الحدود المعتمدة قبل تحويل القراءة إلى قرار.';
  return role==='field'?'استمر في المراقبة وفق خطة الموقع المعتمدة.':role==='control_room'?'استمر في المراقبة وفق خطة التشغيل المعتمدة.':'استمر في المراجعة وفق الخطة المعتمدة.';
}
function renderDecisionCards(cards, role){
  if(!cards.length) return '<p class="muted">لا توجد قراءات قابلة للتحليل لهذا العنصر.</p>';
  return cards.map(d=>`<article class="decision-card decision-card--${d.status.toLowerCase()}">
    <div class="decision-card__top"><strong>${escapeHtml(d.property_name||'قراءة')}</strong>${decisionBadge(d.status)}<span class="chip">أولوية: ${escapeHtml(d.priority)}</span><span class="chip">ثقة: ${Math.round((d.confidence||0)*100)}%</span></div>
    <dl><div><dt>القراءة</dt><dd>${escapeHtml(String(d.value??'—'))}${d.unit?' '+escapeHtml(d.unit):''}</dd></div><div><dt>التفسير</dt><dd>${escapeHtml(d.interpretation)}</dd></div><div><dt>الخطوة التالية</dt><dd>${escapeHtml(roleNextStep(d,role))}</dd></div></dl>
    <p class="muted decision-disclaimer">قرار دعم ومراجعة فقط — لا توجد أوامر تحكم أو تغيير تلقائي في حالة الأصل.</p>
  </article>`).join('');
}
async function refreshDecisionCenter(entityId){
  const host=el('#decision-summary'); if(!host) return;
  if(!entityId){host.textContent='اختر عنصرًا هندسيًا من القائمة لعرض قراراته وقراءة بياناته.';return;}
  const obs=await KimaDB.listObservationsForEntity(entityId);
  const cards=evaluateObservations(obs);
  const sum=summarizeDecisions(cards);
  const role=el('#decision-role')?.value||'engineer';
  host.innerHTML=`<div class="decision-kpis"><div class="decision-kpi"><span>الأعلى</span><strong>${escapeHtml(sum.highest)}</strong></div><div class="decision-kpi"><span>حرج</span><strong>${sum.critical}</strong></div><div class="decision-kpi"><span>مراقبة</span><strong>${sum.watch}</strong></div><div class="decision-kpi"><span>بيانات ناقصة</span><strong>${sum.insufficient}</strong></div><div class="decision-kpi"><span>قراءات</span><strong>${sum.count}</strong></div></div><div>${renderDecisionCards(cards,role)}</div>`;
}

async function selectEntity(entityId) {
  state.selectedEntityId = entityId;
  elAll('.entity-row').forEach((row) => {
    row.setAttribute('aria-pressed', String(row.dataset.entityId === entityId));
  });

  const entity = state.entities.find((e) => e.entity_id === entityId);
  updateContextBar(entity || null);
  await refreshDecisionCenter(entityId);
  const panel = el('#ledger-panel');
  if (!entity) {
    panel.innerHTML = '<p class="muted">اختر عنصرًا هندسيًا من القائمة لعرض سجل تتبعه.</p>';
    return;
  }

  const [identifiers, relationships, evidenceList, sources, entityOptions, relTypeOptions, evidenceOptions, standardMappings, requiredEvidenceOptions, drawingOptions, drawingLocatorPairs, fieldObservations] = await Promise.all([
    KimaDB.listIdentifiersForEntity(entityId),
    KimaDB.listRelationshipsForEntity(entityId),
    KimaDB.listEvidence(),
    KimaDB.listSources(),
    renderEntityOptions(entityId),
    renderRelationshipTypeOptions(),
    renderEvidenceOptions(),
    KimaDB.listStandardMappingsForEntity(entityId),
    renderRequiredEvidenceOptions(),
    renderDrawingOptions(),
    KimaDB.navigateEntityToDrawings(entityId),
    KimaDB.listFieldObservationsForEntity(entityId),
  ]);

  const sourcesById = new Map(sources.map((s) => [s.source_id, s]));
  // Evidence directly relevant here is what's already linked to this entity's
  // relationships; the full evidence list stays available via the picker
  // in the relationship form (evidence is not yet entity-scoped by itself —
  // it becomes entity-relevant once linked to a relationship, per
  // RELATIONSHIP_CONTRACT.md's evidence_id field).
  const linkedEvidenceIds = new Set(relationships.map((r) => r.evidence_id).filter(Boolean));
  const linkedEvidence = evidenceList.filter((ev) => linkedEvidenceIds.has(ev.evidence_id));

  panel.innerHTML = `
    <header class="ledger-panel__header">
      <h2>${escapeHtml(entity.display_name)}</h2>
      <span class="${statusBadgeClass(entity.status)}">${escapeHtml(entity.status)}</span>
    </header>
    <dl class="ledger-panel__facts">
      <div><dt>الاسم القانوني</dt><dd>${escapeHtml(entity.canonical_name)}</dd></div>
      <div><dt>النوع</dt><dd>${escapeHtml(entity.entity_type)}</dd></div>
      <div><dt>السياق</dt><dd>${entity.context ? escapeHtml(entity.context) : '<span class="muted">غير محدد</span>'}</dd></div>
      <div><dt>أُنشئ</dt><dd>${formatDate(entity.created_at)}</dd></div>
      <div><dt>آخر تحديث</dt><dd>${formatDate(entity.updated_at)}</dd></div>
      <div><dt>المعرّف</dt><dd class="mono">${escapeHtml(entity.entity_id)}</dd></div>
    </dl>

    <h3 class="ledger-panel__subheading">معرّفات المصدر (${identifiers.length})</h3>
    ${identifiers.length === 0
      ? '<p class="muted">لا توجد معرّفات مصدر بعد.</p>'
      : `<ul class="identifier-list">${identifiers.map((i) => `
          <li class="identifier-row">
            <span class="chip chip--outline">${escapeHtml(i.namespace)}</span>
            <span class="mono">${escapeHtml(i.identifier)}</span>
            ${i.is_primary ? '<span class="badge badge--active">أساسي</span>' : ''}
          </li>
        `).join('')}</ul>`
    }

    <form id="identifier-form" class="inline-form">
      <div class="field-row">
        <label>
          <span>نطاق المصدر (namespace)</span>
          <input type="text" name="namespace" placeholder="مثال: P&amp;ID-TAG" required />
        </label>
        <label>
          <span>المعرّف</span>
          <input type="text" name="identifier" placeholder="مثال: PV-1042" required />
        </label>
      </div>
      <label class="checkbox-row">
        <input type="checkbox" name="is_primary" />
        <span>تعيينه كمعرّف أساسي</span>
      </label>
      <button type="submit" class="btn btn--secondary">إضافة معرّف</button>
    </form>


    <h3 class="ledger-panel__subheading">القياسات والملاحظات التشغيلية (${(await KimaDB.listObservationsForEntity(entityId)).length})</h3>
    <form id="measurement-form" class="inline-form measurement-form">
      <div class="field-row">
        <label><span>الخاصية / القياس</span><input name="property_name" placeholder="مثال: pressure / temperature / flow / vibration" required /></label>
        <label><span>القيمة</span><input name="value" type="number" step="any" placeholder="مثال: 72.5" required /></label>
        <label><span>الوحدة</span><input name="unit" placeholder="bar / °C / m³/h" /></label>
      </div>
      <div class="field-row">
        <label><span>الحد الأدنى المعتمد</span><input name="min" type="number" step="any" placeholder="اختياري" /></label>
        <label><span>الحد الأقصى المعتمد</span><input name="max" type="number" step="any" placeholder="اختياري" /></label>
        <label><span>الحد الحرج الأدنى</span><input name="critical_min" type="number" step="any" placeholder="اختياري" /></label>
        <label><span>الحد الحرج الأقصى</span><input name="critical_max" type="number" step="any" placeholder="اختياري" /></label>
      </div>
      <p class="muted">أدخل الحدود فقط من مصدر/إجراء/مواصفة معتمدة. النظام لا يخترع حدودًا تشغيلية.</p>
      <button type="submit" class="btn btn--secondary">تسجيل القراءة وتحليلها</button>
    </form>

    <h3 class="ledger-panel__subheading">العلاقات (${relationships.length})</h3>
    ${relationships.length === 0
      ? '<p class="muted">لا توجد علاقات مسجّلة بعد لهذا العنصر.</p>'
      : `<ul class="identifier-list">${relationships.map((r) => relationshipRowHtml(r, entityId)).join('')}</ul>`
    }

    ${state.entities.length < 2
      ? '<p class="muted">أضِف عنصرًا هندسيًا آخر لتتمكن من إنشاء علاقة.</p>'
      : `<form id="relationship-form" class="inline-form">
          <div class="field-row">
            <label>
              <span>نوع العلاقة (relationship_type)</span>
              <select name="relationship_type" required>${relTypeOptions}</select>
            </label>
            <label>
              <span>العنصر الآخر (target)</span>
              <select name="target_entity_id" required>${entityOptions}</select>
            </label>
          </div>
          <div class="field-row">
            <label>
              <span>الاتجاه (direction)</span>
              <select name="direction">
                <option value="forward" selected>forward (من هذا العنصر إلى الآخر)</option>
                <option value="reverse">reverse (من الآخر إلى هذا العنصر)</option>
                <option value="bidirectional">bidirectional</option>
              </select>
            </label>
            <label>
              <span>الدليل الداعم (evidence)</span>
              <select name="evidence_id">${evidenceOptions}</select>
            </label>
          </div>
          <label>
            <span>مرجع المصدر <em>(source_reference، اختياري)</em></span>
            <input type="text" name="source_reference" placeholder="مثال: P&amp;ID-204 rev C" />
          </label>
          <button type="submit" class="btn btn--secondary">إنشاء علاقة</button>
        </form>`
    }

    <h3 class="ledger-panel__subheading">الرسم البياني للعلاقات (Graph)</h3>
    ${relationships.length === 0
      ? '<p class="muted">لا توجد علاقات مسجّلة بعد لعرضها كرسم بياني.</p>'
      : `<div class="topology-controls">
          <label>
            <span>العمق الأقصى</span>
            <select id="topology-depth">
              <option value="1">1</option>
              <option value="2" selected>2</option>
              <option value="3">3</option>
              <option value="5">5</option>
            </select>
          </label>
          <label>
            <span>الاتجاه</span>
            <select id="topology-direction">
              <option value="both" selected>both</option>
              <option value="out">out</option>
              <option value="in">in</option>
            </select>
          </label>
        </div>
        <canvas id="topology-canvas" class="topology-canvas" aria-label="رسم بياني للعلاقات، قابل للتكبير والسحب"></canvas>
        <p class="muted topology-legend">
          <span class="topology-legend__item"><span class="topology-legend__swatch" style="background:#4FAE8A"></span> physical (piping/connection)</span>
          <span class="topology-legend__item"><span class="topology-legend__swatch" style="background:#D9A441"></span> process_flow</span>
          <span class="topology-legend__item"><span class="topology-legend__swatch" style="background:#6E9FD9"></span> instrumentation</span>
          <span class="topology-legend__item"><span class="topology-legend__swatch" style="background:#9AA3B2"></span> containment / logical</span>
          <span class="topology-legend__item"><span class="topology-legend__swatch" style="background:#7A8194"></span> reference</span>
        </p>`
    }

    <h3 class="ledger-panel__subheading">تحليل الأثر (Impact)</h3>
    ${relationships.length === 0
      ? '<p class="muted">لا توجد علاقات مسجّلة بعد لتحليل الأثر.</p>'
      : `<div class="topology-controls">
          <label>
            <span>العمق الأقصى</span>
            <select id="impact-depth">
              <option value="1">1</option>
              <option value="2" selected>2</option>
              <option value="3">3</option>
              <option value="5">5</option>
            </select>
          </label>
          <button type="button" id="impact-run" class="btn btn--secondary">حساب الأثر</button>
        </div>
        <div id="impact-report"></div>`
    }

    <h3 class="ledger-panel__subheading">مطابقات المعايير القياسية (Standard Mappings) (${standardMappings.length})</h3>
    ${standardMappings.length === 0
      ? '<p class="muted">لا توجد مطابقات معايير مسجّلة بعد لهذا العنصر.</p>'
      : `<ul class="identifier-list">${standardMappings.map((m) => standardMappingRowHtml(m)).join('')}</ul>`
    }

    <form id="standard-mapping-form" class="inline-form">
      <div class="field-row">
        <label>
          <span>المعيار (standard_name)</span>
          <input type="text" name="standard_name" placeholder="مثال: ISO 14224 / DEXPI / CFIHOS" required />
        </label>
        <label>
          <span>معرّف المعيار (standard_identifier)</span>
          <input type="text" name="standard_identifier" placeholder="مثال: Class code / tag" required />
        </label>
      </div>
      <div class="field-row">
        <label>
          <span>نوع المطابقة (mapping_type)</span>
          <select name="mapping_type">
            <option value="equivalence" selected>equivalence</option>
            <option value="partial">partial</option>
            <option value="candidate">candidate</option>
          </select>
        </label>
        <label>
          <span>حالة التحقق (validation_state)</span>
          <select name="validation_state">
            <option value="UNREVIEWED" selected>UNREVIEWED</option>
            <option value="OBSERVED">OBSERVED</option>
            <option value="VALIDATED">VALIDATED</option>
            <option value="REJECTED">REJECTED</option>
          </select>
        </label>
      </div>
      <label>
        <span>ملاحظات <em>(اختياري)</em></span>
        <input type="text" name="notes" placeholder="أي ملاحظة توضيحية" />
      </label>
      <button type="submit" class="btn btn--secondary">إضافة مطابقة معيار</button>
    </form>

    <h3 class="ledger-panel__subheading">مواقع الرسومات (P&amp;ID Locators) (${drawingLocatorPairs.length})</h3>
    ${drawingLocatorPairs.length === 0
      ? '<p class="muted">لا توجد روابط رسومات مسجّلة بعد لهذا العنصر.</p>'
      : `<ul class="identifier-list">${drawingLocatorPairs.map((pair) => drawingLocatorRowHtml(pair)).join('')}</ul>`
    }

    <form id="drawing-form" class="inline-form">
      <div class="field-row">
        <label>
          <span>رقم الرسم (drawing_number)</span>
          <input type="text" name="drawing_number" placeholder="مثال: P&amp;ID-K103-01" required />
        </label>
        <label>
          <span>إصدار الرسم <em>(اختياري)</em></span>
          <input type="text" name="drawing_version" placeholder="مثال: rev C" />
        </label>
      </div>
      <button type="submit" class="btn btn--secondary">تسجيل رسم جديد</button>
    </form>

    <form id="drawing-locator-form" class="inline-form">
      <div class="field-row">
        <label>
          <span>الرسم (drawing)</span>
          <select name="drawing_id" required>${drawingOptions}</select>
        </label>
        <label>
          <span>الدليل (evidence) <em>مطلوب</em></span>
          <select name="evidence_id" required>${requiredEvidenceOptions}</select>
        </label>
      </div>
      <div class="field-row">
        <label>
          <span>المنطقة (region) <em>(اختياري)</em></span>
          <input type="text" name="region" placeholder="مثال: Zone C-3" />
        </label>
        <label>
          <span>الصفحة (page) <em>(اختياري)</em></span>
          <input type="text" name="page" placeholder="مثال: 1" />
        </label>
      </div>
      <p class="muted">لا يُعتبر رابط الرسم موثوقًا بدون دليل مصدر، وفق مواصفة تنقل P&amp;ID.</p>
      <button type="submit" class="btn btn--secondary">ربط العنصر بموقع في الرسم</button>
    </form>

    <h3 class="ledger-panel__subheading">المشاهدات الميدانية (Field Observations) (${fieldObservations.length})</h3>
    ${fieldObservations.length === 0
      ? '<p class="muted">لا توجد مشاهدات ميدانية مسجّلة بعد لهذا العنصر.</p>'
      : `<ul class="identifier-list">${fieldObservations.map((fo) => fieldObservationRowHtml(fo)).join('')}</ul>`
    }

    <form id="field-observation-form" class="inline-form">
      <div class="field-row">
        <label>
          <span>القيمة (value)</span>
          <input type="text" name="value" placeholder="مثال: 82" required />
        </label>
        <label>
          <span>الوحدة (unit) <em>(اختياري)</em></span>
          <input type="text" name="unit" placeholder="مثال: °C" />
        </label>
      </div>
      <div class="field-row">
        <label>
          <span>الملاحظ (actor) <em>(اختياري)</em></span>
          <input type="text" name="actor" placeholder="اسم فني الميدان" />
        </label>
        <label>
          <span>حالة التحقق (validation_state)</span>
          <select name="validation_state">
            <option value="UNREVIEWED" selected>UNREVIEWED</option>
            <option value="OBSERVED">OBSERVED</option>
            <option value="VALIDATED">VALIDATED</option>
            <option value="REJECTED">REJECTED</option>
          </select>
        </label>
      </div>
      <label>
        <span>ملاحظة <em>(اختياري)</em></span>
        <input type="text" name="note" placeholder="أي ملاحظة ميدانية" />
      </label>
      <p class="muted">البيانات الميدانية منفصلة عن بيانات المصدر الهندسي ولا تُستبدل البيانات الرئيسية تلقائيًا.</p>
      <button type="submit" class="btn btn--secondary">تسجيل مشاهدة ميدانية</button>
    </form>

    <h3 class="ledger-panel__subheading">الأدلة المرتبطة بعلاقات هذا العنصر (${linkedEvidence.length})</h3>
    ${linkedEvidence.length === 0
      ? '<p class="muted">لا توجد أدلة مرتبطة بعد. سجّل مصدرًا ثم أدخل دليلاً من القسم أدناه، واربطه عند إنشاء علاقة.</p>'
      : `<ul class="identifier-list">${linkedEvidence.map((ev) => evidenceRowHtml(ev, sourcesById)).join('')}</ul>`
    }

    <details class="evidence-registration">
      <summary>تسجيل مصدر جديد وإضافة دليل</summary>
      <form id="source-form" class="inline-form">
        <div class="field-row">
          <label>
            <span>نوع المصدر (source_type)</span>
            <input type="text" name="source_type" placeholder="مثال: P&amp;ID / Workbook / Photo" required />
          </label>
          <label>
            <span>اسم المصدر (source_name)</span>
            <input type="text" name="source_name" placeholder="مثال: P&amp;ID-204 rev C" required />
          </label>
        </div>
        <label>
          <span>إصدار المصدر <em>(اختياري)</em></span>
          <input type="text" name="source_version" placeholder="مثال: rev C" />
        </label>
        <button type="submit" class="btn btn--secondary">تسجيل المصدر</button>
      </form>

      <form id="evidence-form" class="inline-form">
        <div class="field-row">
          <label>
            <span>المصدر (source)</span>
            <select name="source_id" required>${sources.length === 0
              ? '<option value="">لا توجد مصادر مسجَّلة بعد</option>'
              : sources.map((s) => `<option value="${s.source_id}">${escapeHtml(s.source_name)}</option>`).join('')
            }</select>
          </label>
          <label>
            <span>نوع الدليل (evidence_type)</span>
            <input type="text" name="evidence_type" placeholder="مثال: drawing_excerpt / field_note" required />
          </label>
        </div>
        <label>
          <span>الموضع/الموقع (locator)</span>
          <input type="text" name="locator" placeholder="مثال: Sheet 2, Zone C4" required />
        </label>
        <button type="submit" class="btn btn--secondary">إضافة دليل</button>
      </form>
    </details>
  `;


  el('#measurement-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const form=ev.target;
    const num=(name)=>form[name].value.trim()===''?null:Number(form[name].value);
    const thresholds={min:num('min'),max:num('max'),critical_min:num('critical_min'),critical_max:num('critical_max')};
    const clean=Object.fromEntries(Object.entries(thresholds).filter(([,v])=>v!==null&&Number.isFinite(v)));
    try{
      const o=await KimaDB.createObservation({entity_id:entityId,property_name:form.property_name.value.trim(),value:Number(form.value.value),value_type:'number',unit:form.unit.value.trim()||null,validation_state:'OBSERVED',observation_context:{thresholds:clean,role:el('#decision-role')?.value||'engineer'}});
      const cards=evaluateObservations([o]);
      if(cards[0]) await KimaDB.createDecision(cards[0]);
      toast('تم تسجيل القراءة وإنشاء بطاقة قرار قابلة للتتبع','success');
      form.reset();
      await selectEntity(entityId);
      await refreshStatusBar();
    }catch(err){toast(err.message||'تعذّر تسجيل القراءة','error');}
  });

  el('#identifier-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const form = ev.target;
    const namespace = form.namespace.value.trim();
    const identifier = form.identifier.value.trim();
    const is_primary = form.is_primary.checked;
    try {
      await KimaDB.addEntityIdentifier({ entity_id: entityId, namespace, identifier, is_primary });
      toast('تمت إضافة المعرّف بنجاح', 'success');
      await selectEntity(entityId);
    } catch (err) {
      toast(err.message || 'تعذّرت إضافة المعرّف', 'error');
    }
  });

  const relForm = el('#relationship-form');
  if (relForm) {
    relForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const form = ev.target;
      const relationship_type = form.relationship_type.value;
      const target_entity_id = form.target_entity_id.value;
      const direction = form.direction.value;
      const evidence_id = form.evidence_id.value || null;
      const source_reference = form.source_reference.value.trim() || null;
      try {
        await KimaDB.createRelationship({
          source_entity_id: entityId, target_entity_id, relationship_type,
          direction, evidence_id, source_reference,
        });
        toast('تم إنشاء العلاقة بنجاح', 'success');
        await selectEntity(entityId);
        await refreshStatusBar();
      } catch (err) {
        toast(err.message || 'تعذّر إنشاء العلاقة', 'error');
      }
    });
  }

  const standardMappingForm = el('#standard-mapping-form');
  if (standardMappingForm) {
    standardMappingForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const form = ev.target;
      const standard_name = form.standard_name.value.trim();
      const standard_identifier = form.standard_identifier.value.trim();
      const mapping_type = form.mapping_type.value;
      const validation_state = form.validation_state.value;
      const notes = form.notes.value.trim() || null;
      try {
        await KimaDB.createStandardMapping({
          entity_id: entityId, standard_name, standard_identifier,
          mapping_type, validation_state, notes,
        });
        toast('تمت إضافة مطابقة المعيار بنجاح', 'success');
        await selectEntity(entityId);
      } catch (err) {
        toast(err.message || 'تعذّرت إضافة مطابقة المعيار', 'error');
      }
    });
  }

  const drawingForm = el('#drawing-form');
  if (drawingForm) {
    drawingForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const form = ev.target;
      const drawing_number = form.drawing_number.value.trim();
      const drawing_version = form.drawing_version.value.trim() || null;
      try {
        await KimaDB.createDrawing({ drawing_number, drawing_version });
        toast('تم تسجيل الرسم بنجاح', 'success');
        await selectEntity(entityId);
      } catch (err) {
        toast(err.message || 'تعذّر تسجيل الرسم', 'error');
      }
    });
  }

  const drawingLocatorForm = el('#drawing-locator-form');
  if (drawingLocatorForm) {
    drawingLocatorForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const form = ev.target;
      const drawing_id = form.drawing_id.value;
      const evidence_id = form.evidence_id.value;
      const region = form.region.value.trim() || null;
      const pageRaw = form.page.value.trim();
      const page = pageRaw === '' ? null : pageRaw;
      try {
        await KimaDB.createDrawingLocator({
          entity_id: entityId, drawing_id, evidence_id, region, page,
        });
        toast('تم ربط العنصر بموقع الرسم بنجاح', 'success');
        await selectEntity(entityId);
      } catch (err) {
        toast(err.message || 'تعذّر ربط العنصر بموقع الرسم', 'error');
      }
    });
  }

  const fieldObservationForm = el('#field-observation-form');
  if (fieldObservationForm) {
    fieldObservationForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const form = ev.target;
      const value = form.value.value.trim();
      const unit = form.unit.value.trim() || null;
      const actor = form.actor.value.trim() || null;
      const validation_state = form.validation_state.value;
      const note = form.note.value.trim() || null;
      try {
        await KimaDB.createFieldObservation({
          entity_id: entityId, value, unit, actor, validation_state, note,
        });
        toast('تم تسجيل المشاهدة الميدانية بنجاح', 'success');
        await selectEntity(entityId);
      } catch (err) {
        toast(err.message || 'تعذّر تسجيل المشاهدة الميدانية', 'error');
      }
    });
  }

  // Fetch the full relationship set once, shared by both the Graph
  // section below and the R12 Impact section — traverse()/
  // calculateImpact() both need the whole graph, not just this
  // entity's direct edges, to walk beyond depth 1. Lazily fetched and
  // cached per selectEntity call so neither section pays for a
  // KimaDB.listAllRelationships() call the user never triggers (e.g.
  // Impact is opt-in via its own button).
  let allRelationships = null;
  const ensureAllRelationships = async () => {
    if (!allRelationships) allRelationships = await KimaDB.listAllRelationships();
    return allRelationships;
  };

  const topologyCanvas = el('#topology-canvas');
  if (topologyCanvas && relationships.length > 0) {
    await ensureAllRelationships();
    const renderer = createTopologyRenderer(topologyCanvas, (clickedEntityId) => {
      if (clickedEntityId !== entityId) selectEntity(clickedEntityId);
    });
    // R9-MERGE-001: explicit disposal on top of the ResizeObserver fix
    // (see topology.js). The observer alone is enough to prevent the
    // leak (nothing keeps the old canvas/observer alive once its
    // <canvas> element is removed from the DOM), but storing and
    // calling destroy() explicitly is a cheap, deterministic second
    // layer rather than relying purely on GC timing across selections.
    if (state.activeTopologyRenderer) state.activeTopologyRenderer.destroy();
    state.activeTopologyRenderer = renderer;
    const depthSelect = el('#topology-depth');
    const directionSelect = el('#topology-direction');
    const redraw = () => {
      renderer.render(
        allRelationships,
        state.entities,
        entityId,
        traverse,
        { maxDepth: Number(depthSelect.value), direction: directionSelect.value },
      );
    };
    redraw();
    depthSelect.addEventListener('change', redraw);
    directionSelect.addEventListener('change', redraw);
  } else if (state.activeTopologyRenderer) {
    // Selected an entity with no relationships (topology section isn't
    // rendered at all in that case) — dispose of whatever the previous
    // selection created, same reasoning as above.
    state.activeTopologyRenderer.destroy();
    state.activeTopologyRenderer = null;
  }

  const impactRunBtn = el('#impact-run');
  if (impactRunBtn) {
    impactRunBtn.addEventListener('click', async () => {
      const rels = await ensureAllRelationships();
      const depth = Number(el('#impact-depth').value);
      const report = calculateImpact(rels, [entityId], { maxDepth: depth });
      el('#impact-report').innerHTML = impactReportHtml(report, state.entities);
    });
  }

  el('#source-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const form = ev.target;
    const source_type = form.source_type.value.trim();
    const source_name = form.source_name.value.trim();
    const source_version = form.source_version.value.trim() || null;
    try {
      await KimaDB.registerSource({ source_type, source_name, source_version });
      toast('تم تسجيل المصدر بنجاح', 'success');
      await selectEntity(entityId);
    } catch (err) {
      toast(err.message || 'تعذّر تسجيل المصدر', 'error');
    }
  });

  el('#evidence-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const form = ev.target;
    const source_id = form.source_id.value;
    const evidence_type = form.evidence_type.value.trim();
    const locator = form.locator.value.trim();
    try {
      await KimaDB.createEvidence({ source_id, evidence_type, locator });
      toast('تمت إضافة الدليل بنجاح', 'success');
      await selectEntity(entityId);
      await refreshStatusBar();
    } catch (err) {
      toast(err.message || 'تعذّرت إضافة الدليل', 'error');
    }
  });
}

async function handleCreateEntity(ev) {
  ev.preventDefault();
  const form = ev.target;
  const entity_type = form.entity_type.value.trim();
  const canonical_name = form.canonical_name.value.trim();
  const display_name = form.display_name.value.trim();
  const context = form.context.value.trim() || null;

  try {
    const entity = await KimaDB.createEntity({ entity_type, canonical_name, display_name, context });
    toast('تم إنشاء العنصر الهندسي', 'success');
    form.reset();
    await refreshEntityList();
    await selectEntity(entity.entity_id);
  } catch (err) {
    toast(err.message || 'تعذّر إنشاء العنصر', 'error');
  }
}

async function refreshStatusBar() {
  const [entityCount, relCount, evCount, obsCount, decCount] = await Promise.all([
    KimaDB.countStore('entity'),
    KimaDB.countStore('relationship'),
    KimaDB.countStore('evidence'),
    KimaDB.countStore('observation'),
    KimaDB.countStore('decision'),
  ]);
  el('#status-bar').textContent =
    `العناصر: ${entityCount} · العلاقات: ${relCount} · الأدلة: ${evCount} · القراءات: ${obsCount} · القرارات: ${decCount} · التخزين: IndexedDB (محلي بالكامل)`;
}

/**
 * Service Worker install/update-cycle handling (M-26 fix, ADR-034).
 * Previously: registerServiceWorkerIfHosted registered the SW and did
 * nothing else — no updatefound/controllerchange listener anywhere in
 * app.js. Combined with service-worker.js's self.skipWaiting() +
 * clients.claim() (which make a newly-installed SW version take control
 * of already-open pages immediately, without a reload), a page open
 * during a deploy would silently keep running its already-loaded JS
 * modules while the SW underneath it started serving a different
 * CACHE_NAME's assets on any future fetch — a version mismatch the user
 * was never told about and had no way to resolve short of guessing to
 * reload.
 *
 * Fix: a persistent (non-auto-dismissing) banner offering an explicit
 * reload, shown only when an update is genuinely available to an
 * ALREADY-CONTROLLED page — never on first install, where there is no
 * prior version to conflict with and no user-visible staleness exists.
 */
function registerServiceWorkerIfHosted() {
  // Only meaningful when served over http(s); inert and harmless under file://.
  if (!('serviceWorker' in navigator) || (location.protocol !== 'http:' && location.protocol !== 'https:')) return;

  navigator.serviceWorker.register('./service-worker.js').then((registration) => {
    // A worker already waiting when we register (e.g. the tab was open
    // during a deploy that finished installing before this run) is the
    // same "update available on a controlled page" case as updatefound
    // below — handle it here too, not just the live-transition path.
    if (registration.waiting && navigator.serviceWorker.controller) {
      showServiceWorkerUpdateBanner(registration.waiting);
    }

    registration.addEventListener('updatefound', () => {
      const installing = registration.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        if (installing.state !== 'installed') return;
        // navigator.serviceWorker.controller is null on the very first
        // install for this origin (no prior SW ever controlled this
        // page) — that is expected, normal, and must NOT show the
        // "update available" banner, since nothing is stale yet.
        if (navigator.serviceWorker.controller) {
          showServiceWorkerUpdateBanner(installing);
        }
      });
    });
  }).catch(() => {
    // Non-fatal: app remains fully usable without the service worker.
  });

  // Reload once the new worker actually takes control (fires after the
  // banner's reload button sends SKIP_WAITING below, or after any other
  // tab's own update triggers the same transition — either way, a
  // reload here is always correct and idempotent: postMessage-based
  // guards against a double-reload were considered unnecessary since
  // 'controllerchange' fires at most once per real controller swap).
  let reloadedOnce = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadedOnce) return;
    reloadedOnce = true;
    location.reload();
  });
}

function showServiceWorkerUpdateBanner(waitingWorker) {
  const banner = el('#sw-update-banner');
  if (!banner || banner.dataset.shown === '1') return; // avoid re-binding/re-showing if already surfaced
  banner.dataset.shown = '1';
  banner.hidden = false;
  el('#sw-update-reload-btn').addEventListener('click', () => {
    // The waiting worker's own install handler no longer calls
    // self.skipWaiting() automatically (see service-worker.js,
    // M-26/ADR-034) — this message is now the SOLE trigger for it to
    // activate and take control. Without this click, the new worker
    // stays waiting indefinitely and the page keeps running its
    // already-loaded version, matching the cache it already has.
    waitingWorker.postMessage({ type: 'SKIP_WAITING' });
  }, { once: true });
}


function conflictSeverityClass(sev) {
  if (sev === 'BLOCKER') return 'badge badge--retired';
  if (sev === 'MAJOR') return 'badge badge--pending';
  return 'chip chip--outline'; // MINOR / INFO
}

let currentPreview = null;
let currentFile = null;
let currentOverrideMap = null;
let currentSheetName = null;

function renderImportPreview(preview) {
  const host = el('#import-result');
  if (!preview.structural.ok) {
    host.innerHTML = `
      <p class="muted">تعذّر قبول الملف:</p>
      <ul class="identifier-list">
        ${preview.structural.issues.map((i) => `<li class="identifier-row"><span class="${conflictSeverityClass(i.severity)}">${escapeHtml(i.severity)}</span><span>${escapeHtml(i.message)}</span></li>`).join('')}
      </ul>
    `;
    el('#import-commit-btn').hidden = true;
    return;
  }

  const { plan, headerReport } = preview;
  const blockerRows = plan.rows.filter((r) => r.conflicts.some((c) => c.severity === 'BLOCKER'));
  const okRows = plan.rows.filter((r) => !r.conflicts.some((c) => c.severity === 'BLOCKER'));
  const insertCount = okRows.filter((r) => r.action === 'insert').length;
  const updateCount = okRows.filter((r) => r.action === 'update').length;

  const sheetSelectorBlock = (preview.allSheets && preview.allSheets.length > 1) ? `
    <div class="ledger-panel" style="margin-bottom:12px;">
      <h3 class="ledger-panel__subheading">اختيار الشيت (الملف يحتوي ${preview.allSheets.length} شيتات)</h3>
      <p class="muted">الشيت المستخدَم حاليًا: <strong>${escapeHtml(preview.usedSheet || '—')}</strong>. إن كانت بياناتك الهندسية في شيت آخر (مثل 02_Asset_Register أو 06_Instruments)، اخترها هنا.</p>
      <select id="sheet-select">
        ${preview.allSheets.map((s) => `<option value="${escapeHtml(s)}" ${s === preview.usedSheet ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('')}
      </select>
      <button type="button" id="sheet-select-apply-btn" class="btn">تحميل هذا الشيت</button>
    </div>
  ` : '';

  const KIMA_FIELDS = [
    { key: 'entity_type', label: 'entity_type (إلزامي)' },
    { key: 'canonical_name', label: 'canonical_name (إلزامي)' },
    { key: 'display_name', label: 'display_name' },
    { key: 'context', label: 'context' },
    { key: 'namespace', label: 'namespace (لمنع التكرار — اختياري)' },
    { key: 'identifier', label: 'identifier (لمنع التكرار — اختياري)' },
  ];
  const sourceColumns = preview.sourceHeaderRow || [];
  const mappingRows = KIMA_FIELDS.map((f) => {
    const selectedIdx = headerReport.map[f.key];
    const options = ['<option value="">— بلا ربط —</option>']
      .concat(sourceColumns.map((colName, idx) => `<option value="${idx}" ${idx === selectedIdx ? 'selected' : ''}>${escapeHtml(colName || `(عمود ${idx + 1})`)}</option>`));
    return `
      <div class="mapping-row" style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
        <label style="min-width:220px;">${escapeHtml(f.label)}</label>
        <select data-kima-field="${f.key}" class="mapping-select">${options.join('')}</select>
      </div>`;
  }).join('');

  const headerMappingBlock = sourceColumns.length > 0 ? `
    <div class="ledger-panel" style="margin-bottom:12px;">
      <h3 class="ledger-panel__subheading">ربط الأعمدة يدويًا (عند عدم التعرّف التلقائي — M-03)</h3>
      <p class="muted">إن كان عمودا entity_type/canonical_name إلزاميَّين يظهران بلا ربط، اختر العمود المطابق من ملفك أدناه ثم اضغط "إعادة تطبيق الربط".</p>
      <div id="header-mapping-fields">${mappingRows}</div>
      <button type="button" id="header-mapping-apply-btn" class="btn">إعادة تطبيق الربط</button>
    </div>
  ` : '';

  host.innerHTML = `
    ${sheetSelectorBlock}
    ${headerMappingBlock}
    <dl class="ledger-panel__facts">
      <div><dt>صيغة الملف</dt><dd>${preview.format === 'xlsx' ? 'Excel (.xlsx/.xls)' : 'CSV'}</dd></div>
      ${preview.usedSheet ? `<div><dt>الشيت المُستخدَم</dt><dd>${escapeHtml(preview.usedSheet)}</dd></div>` : ''}
      ${preview.ignoredSheets && preview.ignoredSheets.length > 0
        ? `<div><dt>شيتات تم تجاهلها</dt><dd><span class="badge badge--pending">لم تُعالَج</span> ${preview.ignoredSheets.map(escapeHtml).join('، ')}</dd></div>`
        : ''
      }
      <div><dt>بصمة الملف (fingerprint)</dt><dd class="mono">${escapeHtml(preview.checksum.slice(0, 24))}…</dd></div>
      <div><dt>الأعمدة غير المعروفة</dt><dd>${headerReport.unmapped.length === 0 ? '<span class="muted">لا يوجد</span>' : headerReport.unmapped.map((u) => escapeHtml(u.column)).join('، ')}</dd></div>
      <div><dt>صفوف ستُضاف (insert)</dt><dd>${insertCount}</dd></div>
      <div><dt>صفوف ستُحدَّث (update — معرّف مطابق فعليًا)</dt><dd>${updateCount}</dd></div>
      <div><dt>صفوف محظورة (BLOCKER — لن تُلتزَم)</dt><dd>${blockerRows.length}</dd></div>
    </dl>

    ${plan.conflicts.length === 0
      ? '<p class="muted">لا توجد تعارضات.</p>'
      : `<h3 class="ledger-panel__subheading">تقرير التعارضات (${plan.conflicts.length})</h3>
         <ul class="identifier-list">${plan.conflicts.map((c) => `
           <li class="identifier-row">
             <span class="${conflictSeverityClass(c.severity)}">${escapeHtml(c.severity)}</span>
             <span class="chip chip--outline">صف ${c.row ?? '؟'}</span>
             <span>${escapeHtml(c.message)}</span>
           </li>
         `).join('')}</ul>`
    }

    <h3 class="ledger-panel__subheading">معاينة الصفوف (${plan.rows.length})</h3>
    <ul class="identifier-list">
      ${plan.rows.map((r) => `
        <li class="identifier-row">
          <span class="chip chip--outline">صف ${r.sourceRowNumber}</span>
          <span>${escapeHtml(r.normalized.canonical_name || '—')}</span>
          <span class="chip">${r.action === 'update' ? 'تحديث' : 'إضافة'}</span>
          ${r.conflicts.length > 0 ? `<span class="${conflictSeverityClass(r.conflicts[0].severity)}">${escapeHtml(r.conflicts[0].severity)}</span>` : ''}
        </li>
      `).join('')}
    </ul>
  `;

  el('#import-commit-btn').hidden = okRows.length === 0;

  const applyBtn = document.getElementById('header-mapping-apply-btn');
  if (applyBtn) applyBtn.addEventListener('click', handleHeaderMappingApply);
  const sheetBtn = document.getElementById('sheet-select-apply-btn');
  if (sheetBtn) sheetBtn.addEventListener('click', handleSheetSelectApply);
}

async function handleImportFileChosen(ev) {
  const file = ev.target.files[0];
  if (!file) return;
  currentFile = file;
  currentOverrideMap = null;
  currentSheetName = null;
  el('#import-result').innerHTML = '<p class="muted">جارٍ التحليل والمعاينة…</p>';
  el('#import-commit-btn').hidden = true;
  try {
    currentPreview = await ImportPipeline.previewImport(file);
    renderImportPreview(currentPreview);
  } catch (err) {
    el('#import-result').innerHTML = `<p class="muted">تعذّر تحليل الملف: ${escapeHtml(err.message || String(err))}</p>`;
    toast(err.message || 'تعذّر تحليل الملف', 'error');
  }
}

async function handleHeaderMappingApply() {
  if (!currentFile) return;
  const selects = document.querySelectorAll('#header-mapping-fields .mapping-select');
  const overrideMap = {};
  selects.forEach((sel) => {
    const field = sel.getAttribute('data-kima-field');
    overrideMap[field] = sel.value === '' ? null : Number(sel.value);
  });
  currentOverrideMap = overrideMap;
  el('#import-result').innerHTML = '<p class="muted">جارٍ إعادة التحليل بالربط الجديد…</p>';
  el('#import-commit-btn').hidden = true;
  try {
    currentPreview = await ImportPipeline.previewImport(currentFile, overrideMap, currentSheetName);
    renderImportPreview(currentPreview);
    toast('تم تطبيق الربط اليدوي', 'success');
  } catch (err) {
    el('#import-result').innerHTML = `<p class="muted">تعذّر إعادة التحليل: ${escapeHtml(err.message || String(err))}</p>`;
    toast(err.message || 'تعذّر إعادة التحليل', 'error');
  }
}

async function handleSheetSelectApply() {
  if (!currentFile) return;
  const sheetSelect = document.getElementById('sheet-select');
  if (!sheetSelect) return;
  currentSheetName = sheetSelect.value;
  currentOverrideMap = null; // أعمدة الشيت الجديد مختلفة — الربط اليدوي السابق لا معنى له هنا
  el('#import-result').innerHTML = `<p class="muted">جارٍ تحميل الشيت "${escapeHtml(currentSheetName)}"…</p>`;
  el('#import-commit-btn').hidden = true;
  try {
    currentPreview = await ImportPipeline.previewImport(currentFile, null, currentSheetName);
    renderImportPreview(currentPreview);
    toast(`تم تحميل الشيت: ${currentSheetName}`, 'success');
  } catch (err) {
    el('#import-result').innerHTML = `<p class="muted">تعذّر تحميل الشيت: ${escapeHtml(err.message || String(err))}</p>`;
    toast(err.message || 'تعذّر تحميل الشيت', 'error');
  }
}

async function handleImportCommit() {
  if (!currentPreview) return;
  try {
    const result = await ImportPipeline.commitImport(currentPreview);
    toast(`تم الالتزام: ${result.committed.length} صفًا، تم تخطي ${result.skipped.length}`, 'success');
    el('#import-commit-btn').hidden = true;
    currentPreview = null;
    currentFile = null;
    currentOverrideMap = null;
    currentSheetName = null;
    el('#import-file-input').value = '';
    await refreshEntityList();
    await refreshStatusBar();
  } catch (err) {
    toast(err.message || 'تعذّر الالتزام بالاستيراد', 'error');
  }
}

// ============================================================================
// R2-003 — Relationship import UI. Deliberately separate state/functions
// from the entity-import ones above (currentRelPreview/currentRelFile vs
// currentPreview/currentFile) rather than sharing variables, so switching
// import modes can never accidentally carry over or clobber the other
// mode's in-progress preview.
// ============================================================================
let currentRelPreview = null;
let currentRelFile = null;

function renderRelationshipImportPreview(preview) {
  const host = el('#import-relationships-result');
  if (!preview.structural.ok) {
    host.innerHTML = `
      <p class="muted">تعذّر قبول الملف:</p>
      <ul class="identifier-list">
        ${preview.structural.issues.map((i) => `<li class="identifier-row"><span class="${conflictSeverityClass(i.severity)}">${escapeHtml(i.severity)}</span><span>${escapeHtml(i.message)}</span></li>`).join('')}
      </ul>
    `;
    el('#import-relationships-commit-btn').hidden = true;
    return;
  }

  const { plan, headerReport } = preview;
  const blockerRows = plan.rows.filter((r) => r.conflicts.some((c) => c.severity === 'BLOCKER'));
  const okRows = plan.rows.filter((r) => !r.conflicts.some((c) => c.severity === 'BLOCKER'));

  host.innerHTML = `
    <dl class="ledger-panel__facts">
      <div><dt>صيغة الملف</dt><dd>${preview.format === 'xlsx' ? 'Excel (.xlsx/.xls)' : 'CSV'}</dd></div>
      ${preview.usedSheet ? `<div><dt>الشيت المُستخدَم</dt><dd>${escapeHtml(preview.usedSheet)}</dd></div>` : ''}
      <div><dt>بصمة الملف (fingerprint)</dt><dd class="mono">${escapeHtml(preview.checksum.slice(0, 24))}…</dd></div>
      <div><dt>الأعمدة غير المعروفة</dt><dd>${headerReport.unmapped.length === 0 ? '<span class="muted">لا يوجد</span>' : headerReport.unmapped.map((u) => escapeHtml(u.column)).join('، ')}</dd></div>
      <div><dt>صفوف صالحة للالتزام</dt><dd>${okRows.length}</dd></div>
      <div><dt>صفوف محظورة (BLOCKER — لن تُلتزَم)</dt><dd>${blockerRows.length}</dd></div>
    </dl>

    ${plan.conflicts.length === 0
      ? '<p class="muted">لا توجد تعارضات.</p>'
      : `<h3 class="ledger-panel__subheading">تقرير التعارضات (${plan.conflicts.length})</h3>
         <ul class="identifier-list">${plan.conflicts.map((c) => `
           <li class="identifier-row">
             <span class="${conflictSeverityClass(c.severity)}">${escapeHtml(c.severity)}</span>
             <span class="chip chip--outline">صف ${c.row ?? '؟'}</span>
             <span>${escapeHtml(c.message)}</span>
           </li>
         `).join('')}</ul>`
    }

    <h3 class="ledger-panel__subheading">معاينة الصفوف (${plan.rows.length})</h3>
    <ul class="identifier-list">
      ${plan.rows.map((r) => `
        <li class="identifier-row">
          <span class="chip chip--outline">صف ${r.sourceRowNumber}</span>
          <span>${escapeHtml(r.raw.from || '—')} → ${escapeHtml(r.raw.to || '—')}</span>
          <span class="chip">${escapeHtml(r.normalized.relationship_type || '—')}</span>
          ${r.conflicts.length > 0 ? `<span class="${conflictSeverityClass(r.conflicts[0].severity)}">${escapeHtml(r.conflicts[0].severity)}</span>` : ''}
        </li>
      `).join('')}
    </ul>
  `;

  el('#import-relationships-commit-btn').hidden = okRows.length === 0;
}

async function handleRelationshipImportFileChosen(ev) {
  const file = ev.target.files[0];
  if (!file) return;
  currentRelFile = file;
  el('#import-relationships-result').innerHTML = '<p class="muted">جارٍ التحليل والمعاينة…</p>';
  el('#import-relationships-commit-btn').hidden = true;
  try {
    currentRelPreview = await RelationshipImportPipeline.previewRelationshipImport(file);
    renderRelationshipImportPreview(currentRelPreview);
  } catch (err) {
    el('#import-relationships-result').innerHTML = `<p class="muted">تعذّر تحليل الملف: ${escapeHtml(err.message || String(err))}</p>`;
    toast(err.message || 'تعذّر تحليل الملف', 'error');
  }
}

async function handleRelationshipImportCommit() {
  if (!currentRelPreview) return;
  try {
    const result = await RelationshipImportPipeline.commitRelationshipImport(currentRelPreview);
    toast(`تم الالتزام: ${result.committed.length} علاقة، تم تخطي ${result.skipped.length}`, 'success');
    el('#import-relationships-commit-btn').hidden = true;
    currentRelPreview = null;
    currentRelFile = null;
    el('#import-relationships-file-input').value = '';
    await refreshStatusBar();
  } catch (err) {
    toast(err.message || 'تعذّر الالتزام باستيراد العلاقات', 'error');
  }
}

function handleImportModeChange() {
  const isRelationships = el('#import-mode-relationships').checked;
  el('#import-mode-entities-panel').hidden = isRelationships;
  el('#import-mode-relationships-panel').hidden = !isRelationships;
}

async function handleBackupExport(){try{const blob=await KimaDB.exportBackup(),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`kima-eis-backup-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);el('#backup-status').textContent='تم إنشاء النسخة الاحتياطية.';toast('تم تصدير النسخة الاحتياطية','success');}catch(e){toast(e.message||'تعذر التصدير','error');}}
async function handleBackupImport(ev){const f=ev.target.files[0];if(!f)return;const modeEl=el('#backup-import-mode');const mode=modeEl?modeEl.value:'replace';const isReplace=mode!=='merge';const confirmMsg=isReplace?'سيتم استبدال كل البيانات المحلية الحالية بمحتوى النسخة الاحتياطية. لا يمكن التراجع عن هذا الإجراء. هل تريد المتابعة؟':'سيتم إضافة بيانات النسخة الاحتياطية إلى البيانات المحلية الحالية دون حذفها. هل تريد المتابعة؟';if(!confirm(confirmMsg)){ev.target.value='';return;}try{await KimaDB.importBackup(f,{replace:isReplace});await refreshEntityList();await refreshStatusBar();el('#backup-status').textContent=isReplace?'تمت الاستعادة (استبدال كامل).':'تمت الاستعادة (دمج إضافي).';toast('تمت استعادة النسخة','success');}catch(e){el('#backup-status').textContent=e.message||String(e);toast('تعذرت الاستعادة','error');}finally{ev.target.value='';}}

async function init() {
  el('#entity-form').addEventListener('submit', handleCreateEntity);
  el('#import-file-input').addEventListener('change', handleImportFileChosen);
  el('#import-commit-btn').addEventListener('click', handleImportCommit);
  el('#import-mode-entities').addEventListener('change', handleImportModeChange);
  el('#import-mode-relationships').addEventListener('change', handleImportModeChange);
  el('#import-relationships-file-input').addEventListener('change', handleRelationshipImportFileChosen);
  el('#import-relationships-commit-btn').addEventListener('click', handleRelationshipImportCommit);
  el('#backup-export-btn').addEventListener('click', handleBackupExport);
  el('#backup-import-input').addEventListener('change', handleBackupImport);
  setupExplorerControls();
  el('#decision-role')?.addEventListener('change', () => refreshDecisionCenter(state.selectedEntityId));
  await refreshEntityList();
  await refreshStatusBar();
  registerServiceWorkerIfHosted();
}

document.addEventListener('DOMContentLoaded', init);
