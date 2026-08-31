/**
 * Deterministic impact analysis over the relationship source of truth.
 *
 * Implements `10_CHANGE_IMPACT/IMPACT_ANALYSIS.md`'s 5-step contract:
 *   1. Identify direct affected nodes.
 *   2. Traverse according to approved relationship types.
 *   3. Classify impact (identity / functional / topology / document /
 *      standard / QA).
 *   4. Attach evidence.
 *   5. Produce a deterministic impact report.
 * "Impact is not a guess engine" — every field in the report is
 * either read directly from stored data (relationship_type, evidence_id
 * already on the connecting relationship, traversal depth) or a fixed,
 * documented mapping from relationship_type to category (below); no
 * severity, likelihood, or narrative is invented.
 *
 * Traversal itself is entirely delegated to graph.js#traverse (same
 * discipline this project held in R9/topology.js: one traversal
 * implementation, reused, never duplicated).
 */
import { traverse } from './graph.js';

/**
 * Explicit relationship_type -> impact-category mapping, one entry per
 * db.js's 12 RELATIONSHIP_TYPES values. This is a *different*
 * classification from topology.js's RELATIONSHIP_TYPE_CATEGORY (which
 * answers "is this edge physical?" for TOPOLOGY_RULES.md) — the two
 * modules classify the same 12 relationship types for two different
 * purposes, per 03_DOMAIN/RELATIONSHIP_CONTRACT.md's "Topology and
 * impact analysis must consume these same relationships." Kept
 * explicit here too, not derived from topology's mapping, so each
 * classification is independently reviewable against its own contract
 * and a new relationship_type must be deliberately placed in both,
 * not inherited from one into the other by assumption.
 *
 * Rationale per category, grounded in what each relationship_type
 * means in RELATIONSHIP_CONTRACT.md / CANONICAL_ENTITY_CONTRACT.md:
 * - identity:  containment, equipment_association — changing the
 *   containing/associated entity can affect what the contained entity
 *   IS understood to be (its place in the plant's identity hierarchy),
 *   per CANONICAL_ENTITY_CONTRACT.md's context/hierarchy concerns.
 * - functional: dependency, function, process_flow, piping,
 *   instrumentation, connection — these describe how the plant
 *   actually operates; a change here can affect real function/
 *   operation, the clearest read of "functional" impact.
 * - topology:  (reserved — no relationship_type maps here by default;
 *   topology-specific impact is a graph-shape question already
 *   answered by traversal depth/path itself, not a per-edge category.
 *   Kept as a defined category per the contract's literal list, not
 *   populated by inference.)
 * - document:  document_reference, drawing_reference — explicitly
 *   about documents per their names.
 * - standard:  standard_mapping — explicitly the DEXPI/CFIHOS mapping
 *   relationship per 08_STANDARDS/DEXPI_CFIHOS_POLICY.md.
 * - QA:        reference — a bare reference relationship carries the
 *   least semantic weight of the 12 types; flagged for QA review
 *   rather than asserted into a stronger category, consistent with
 *   "impact is not a guess engine" — better to under-claim than
 *   invent a functional/identity link a mere reference doesn't
 *   actually assert.
 */
export const IMPACT_CATEGORY = Object.freeze({
  containment: 'identity',
  equipment_association: 'identity',
  dependency: 'functional',
  function: 'functional',
  process_flow: 'functional',
  piping: 'functional',
  instrumentation: 'functional',
  connection: 'functional',
  document_reference: 'document',
  drawing_reference: 'document',
  standard_mapping: 'standard',
  reference: 'QA',
});

const IMPACT_CATEGORIES = Object.freeze(['identity', 'functional', 'topology', 'document', 'standard', 'QA']);

function categoryFor(relationshipType) {
  // No silent default: an uncategorized type is itself a finding, not
  // swallowed into a guessed bucket — surfaced in the report as
  // 'uncategorized' rather than mapped to any of the six real
  // categories the contract defines.
  return IMPACT_CATEGORY[relationshipType] || 'uncategorized';
}

/**
 * @param {object[]} relationships — full relationship list (KimaDB.listAllRelationships())
 * @param {string[]} changedEntityIds — entities whose change is the impact source
 * @param {object} [options] — maxDepth, direction, relationshipTypes — passed through to traverse (step 2's "approved relationship types" filter)
 * @returns {{changed: string[], generated_at: string, impacted: object[], categorySummary: Record<string, number>}}
 *   Each impacted entry: { entity_id, depth, caused_by, relationship_type,
 *   category, evidence_id, validation_state } — relationship_type/
 *   evidence_id/validation_state are read directly off the connecting
 *   edge closest to the changed entity (the edge that produced this
 *   entity's minimum depth), not invented or aggregated across paths.
 */
export function calculateImpact(relationships, changedEntityIds = [], options = {}) {
  const impacted = new Map(); // entity_id -> { entity_id, depth, caused_by, edge }
  for (const id of changedEntityIds) {
    const result = traverse(relationships, id, {
      maxDepth: options.maxDepth ?? 5,
      direction: options.direction ?? 'both',
      relationshipTypes: options.relationshipTypes ?? null,
    });
    // Index edges by relationship_id once per traversal for O(1) lookup
    // below, rather than re-scanning result.edges per node.
    const edgeById = new Map(result.edges.map((e) => [e.relationship_id, e]));
    for (const node of result.nodes) {
      if (node.entity_id === id) continue;
      const prev = impacted.get(node.entity_id);
      if (prev && prev.depth <= node.depth) continue;
      // Find the edge that connects this node to something one depth
      // shallower — the edge actually responsible for this node's
      // shortest-path membership in the impact set. With multiple
      // qualifying edges (parallel relationships at the same depth
      // boundary), the first found in traversal order is used —
      // deterministic given traverse's own deterministic edge order,
      // not randomly chosen.
      const shallowerIds = new Set(
        result.nodes.filter((n) => n.depth === node.depth - 1).map((n) => n.entity_id),
      );
      const edge = result.edges.find((e) => {
        const a = e.source_entity_id, b = e.target_entity_id;
        return (a === node.entity_id && shallowerIds.has(b)) || (b === node.entity_id && shallowerIds.has(a));
      });
      impacted.set(node.entity_id, { entity_id: node.entity_id, depth: node.depth, caused_by: id, edge: edge || null });
    }
  }

  const impactedList = [...impacted.values()]
    .sort((a, b) => a.depth - b.depth || a.entity_id.localeCompare(b.entity_id))
    .map((row) => ({
      entity_id: row.entity_id,
      depth: row.depth,
      caused_by: row.caused_by,
      relationship_type: row.edge ? row.edge.relationship_type : null,
      category: row.edge ? categoryFor(row.edge.relationship_type) : 'uncategorized',
      // Step 4, "attach evidence": surfaces the evidence_id already
      // recorded on the connecting relationship (per
      // RELATIONSHIP_CONTRACT.md's evidence_id field) — never
      // generates new evidence, per "impact is not a guess engine".
      evidence_id: row.edge ? row.edge.evidence_id : null,
      validation_state: row.edge ? row.edge.validation_state : null,
    }));

  const categorySummary = Object.fromEntries(IMPACT_CATEGORIES.map((c) => [c, 0]));
  categorySummary.uncategorized = 0;
  for (const row of impactedList) categorySummary[row.category] = (categorySummary[row.category] || 0) + 1;

  return {
    changed: [...changedEntityIds],
    generated_at: new Date().toISOString(),
    impacted: impactedList,
    categorySummary,
  };
}
