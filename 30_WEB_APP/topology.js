/**
 * KIMA EIS — topology graph renderer (R9).
 *
 * Renders KimaDB relationship data as an interactive Canvas graph
 * (zoom, pan, touch), starting from a chosen entity and traversing
 * outward via KimaDB's own graph.js#traverse — this module never
 * re-implements traversal, matching R3-001/R3-002's established
 * constraint of not duplicating logic that already exists in db.js/
 * graph.js.
 *
 * Per 06_GRAPH/TOPOLOGY_RULES.md: "A graph edge must never imply a
 * physical connection unless its relationship type explicitly says
 * so." RELATIONSHIP_TYPE_CATEGORY below is the explicit mapping that
 * rule requires — edges are colored/styled by category, and only
 * `piping`/`connection` (the two RELATIONSHIP_TYPES that represent an
 * actual physical link) render as a solid "physical" edge. Every other
 * type renders visibly differently (dashed/dotted), so the drawing
 * itself cannot be misread as claiming a physical connection that
 * isn't there.
 */

// Explicit category mapping — one entry per KimaDB.RELATIONSHIP_TYPES
// value (db.js). Kept here, not inferred from the type name, so a
// future new relationship_type must be deliberately categorized rather
// than silently defaulting to something that could misrepresent it as
// physical.
export const RELATIONSHIP_TYPE_CATEGORY = Object.freeze({
  containment: 'containment',
  connection: 'physical',
  dependency: 'logical',
  reference: 'reference',
  process_flow: 'process_flow',
  piping: 'physical',
  instrumentation: 'instrumentation',
  function: 'logical',
  equipment_association: 'logical',
  document_reference: 'reference',
  drawing_reference: 'reference',
  standard_mapping: 'reference',
});

const CATEGORY_STYLE = Object.freeze({
  physical: { color: '#4FAE8A', dash: [] }, // solid — the only category TOPOLOGY_RULES.md allows to look like a real physical link
  process_flow: { color: '#D9A441', dash: [] }, // solid but distinct color — flow, not a static connection
  containment: { color: '#9AA3B2', dash: [6, 3] },
  instrumentation: { color: '#6E9FD9', dash: [2, 3] },
  logical: { color: '#9AA3B2', dash: [4, 4] },
  reference: { color: '#7A8194', dash: [1, 4] },
});

function categoryFor(relationshipType) {
  return RELATIONSHIP_TYPE_CATEGORY[relationshipType] || 'reference';
}

/**
 * Deterministic radial layout: startId at the center, each subsequent
 * traversal depth placed on its own ring, nodes spread evenly around
 * their ring. Deterministic (no physics simulation, no randomness) so
 * the same graph always renders identically — matches this project's
 * "UI never invents/varies data" posture and keeps output testable.
 */
function layoutRadial(nodes, edges, startId, width, height) {
  const cx = width / 2, cy = height / 2;
  const byDepth = new Map();
  for (const n of nodes) {
    if (!byDepth.has(n.depth)) byDepth.set(n.depth, []);
    byDepth.get(n.depth).push(n);
  }
  const maxDepth = Math.max(0, ...byDepth.keys());
  const ringGap = Math.max(60, Math.min(width, height) / (2 * Math.max(1, maxDepth + 1)));
  const positions = new Map();
  for (const [depth, group] of byDepth) {
    if (depth === 0) { positions.set(group[0].entity_id, { x: cx, y: cy }); continue; }
    const radius = ringGap * depth;
    group.forEach((n, i) => {
      const angle = (2 * Math.PI * i) / group.length - Math.PI / 2;
      positions.set(n.entity_id, { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) });
    });
  }
  return positions;
}

/**
 * Creates a topology renderer bound to a <canvas> element.
 * @param {HTMLCanvasElement} canvas
 * @param {(entityId: string) => void} [onNodeClick] — called when a node is tapped/clicked
 */
export function createTopologyRenderer(canvas, onNodeClick) {
  const ctx = canvas.getContext('2d');
  let currentGraph = null; // { nodes, edges, startId, entitiesById }
  let positions = new Map();
  let view = { scale: 1, offsetX: 0, offsetY: 0 };
  let dragging = null; // { pointerId, startX, startY, startOffsetX, startOffsetY } | { pinch: {...} }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function toScreen(x, y) {
    return { x: x * view.scale + view.offsetX, y: y * view.scale + view.offsetY };
  }

  function draw() {
    const rect = canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    if (!currentGraph) return;

    ctx.save();
    // Edges first, under nodes
    for (const edge of currentGraph.edges) {
      const a = positions.get(edge.source_entity_id);
      const b = positions.get(edge.target_entity_id);
      if (!a || !b) continue; // endpoint outside this traversal's node set — not drawn, not guessed
      const style = CATEGORY_STYLE[categoryFor(edge.relationship_type)];
      const pa = toScreen(a.x, a.y), pb = toScreen(b.x, b.y);
      ctx.beginPath();
      ctx.setLineDash(style.dash.map((d) => d * view.scale));
      ctx.strokeStyle = style.color;
      ctx.lineWidth = Math.max(1, 1.5 * view.scale);
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Nodes
    const nodeRadius = 16 * view.scale;
    for (const node of currentGraph.nodes) {
      const p = positions.get(node.entity_id);
      if (!p) continue;
      const screen = toScreen(p.x, p.y);
      const entity = currentGraph.entitiesById.get(node.entity_id);
      const isStart = node.entity_id === currentGraph.startId;
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, nodeRadius, 0, Math.PI * 2);
      ctx.fillStyle = isStart ? '#4FAE8A' : '#232833';
      ctx.strokeStyle = isStart ? '#4FAE8A' : '#323847';
      ctx.lineWidth = Math.max(1, 2 * view.scale);
      ctx.fill();
      ctx.stroke();

      const label = entity ? entity.canonical_name : node.entity_id;
      ctx.fillStyle = isStart ? '#08110D' : '#E7E9EE';
      ctx.font = `${Math.max(9, 11 * view.scale)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (view.scale > 0.5) {
        // Label under the node once zoomed in enough to be legible;
        // never drawn on top of/inside a small node at low zoom, where
        // it would be unreadable clutter rather than useful data.
        ctx.fillStyle = '#E7E9EE';
        ctx.fillText(truncateLabel(label), screen.x, screen.y + nodeRadius + 12 * view.scale);
      }
    }
    ctx.restore();
  }

  function truncateLabel(s, max = 18) {
    const str = String(s ?? '');
    return str.length > max ? `${str.slice(0, max - 1)}…` : str;
  }

  /**
   * Loads and renders the traversal graph rooted at startId.
   * @param {object[]} relationships — full relationship list (as returned by KimaDB.listRelationshipsForEntity or similar); traversal itself is delegated to graph.js#traverse
   * @param {object[]} entities — entity records used only for display labels (canonical_name); never used to alter traversal/edges
   * @param {string} startId
   * @param {(rels: object[], startId: string, options: object) => {startId,nodes,edges}} traverseFn — KimaDB's graph.js#traverse, injected rather than imported directly so this module has no hidden coupling and stays testable in isolation
   * @param {object} [options] — passed through to traverseFn (maxDepth, direction, relationshipTypes)
   */
  function render(relationships, entities, startId, traverseFn, options = {}) {
    const result = traverseFn(relationships, startId, options);
    const entitiesById = new Map(entities.map((e) => [e.entity_id, e]));
    currentGraph = { ...result, entitiesById };
    view = { scale: 1, offsetX: 0, offsetY: 0 };
    const rect = canvas.getBoundingClientRect();
    positions = layoutRadial(result.nodes, result.edges, startId, rect.width || 400, rect.height || 400);
    // Center the layout's origin (radial layout is already centered on
    // the canvas midpoint in local coordinates) — offset stays 0,0.
    resize();
  }

  function clear() {
    currentGraph = null;
    positions = new Map();
    draw();
  }

  function hitTestNode(screenX, screenY) {
    if (!currentGraph) return null;
    const nodeRadius = 16 * view.scale;
    for (const node of currentGraph.nodes) {
      const p = positions.get(node.entity_id);
      if (!p) continue;
      const s = toScreen(p.x, p.y);
      const dx = screenX - s.x, dy = screenY - s.y;
      if (dx * dx + dy * dy <= nodeRadius * nodeRadius) return node.entity_id;
    }
    return null;
  }

  // --- Interaction: pan (drag), zoom (wheel + pinch), tap-to-select ---

  function pointerPos(ev) {
    const rect = canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  const activePointers = new Map(); // pointerId -> {x,y}
  let pinchStartDist = null;
  let pinchStartScale = 1;
  let pointerDownPos = null;
  let pointerMoved = false;

  canvas.addEventListener('pointerdown', (ev) => {
    canvas.setPointerCapture(ev.pointerId);
    const p = pointerPos(ev);
    activePointers.set(ev.pointerId, p);
    pointerMoved = false;
    if (activePointers.size === 1) {
      pointerDownPos = p;
      dragging = { pointerId: ev.pointerId, startX: p.x, startY: p.y, startOffsetX: view.offsetX, startOffsetY: view.offsetY };
    } else if (activePointers.size === 2) {
      const pts = [...activePointers.values()];
      pinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      pinchStartScale = view.scale;
      dragging = null;
    }
  });

  canvas.addEventListener('pointermove', (ev) => {
    if (!activePointers.has(ev.pointerId)) return;
    const p = pointerPos(ev);
    activePointers.set(ev.pointerId, p);
    if (activePointers.size === 2 && pinchStartDist) {
      const pts = [...activePointers.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      view.scale = clampScale(pinchStartScale * (dist / pinchStartDist));
      draw();
      return;
    }
    if (dragging && dragging.pointerId === ev.pointerId) {
      const dx = p.x - dragging.startX, dy = p.y - dragging.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) pointerMoved = true;
      view.offsetX = dragging.startOffsetX + dx;
      view.offsetY = dragging.startOffsetY + dy;
      draw();
    }
  });

  function endPointer(ev) {
    const wasSingleTap = activePointers.size === 1 && !pointerMoved && pointerDownPos;
    activePointers.delete(ev.pointerId);
    if (activePointers.size < 2) pinchStartDist = null;
    if (dragging && dragging.pointerId === ev.pointerId) dragging = null;
    if (wasSingleTap && onNodeClick) {
      const hit = hitTestNode(pointerDownPos.x, pointerDownPos.y);
      if (hit) onNodeClick(hit);
    }
    pointerDownPos = null;
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  function clampScale(s) { return Math.max(0.2, Math.min(3, s)); }

  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const factor = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
    view.scale = clampScale(view.scale * factor);
    draw();
  }, { passive: false });

  window.addEventListener('resize', resize);

  /**
   * R9-MERGE-001 fix: the original code called
   * `window.addEventListener('resize', resize)` here unconditionally,
   * with no corresponding removal. Since `createTopologyRenderer` is
   * invoked fresh on every entity selection that has relationships
   * (selectEntity rebuilds `panel.innerHTML`, destroying the previous
   * <canvas> and creating a new one each time), every selection left
   * one more permanent listener on `window` pointing at a `resize`
   * closure over an abandoned canvas/ctx — a real, unbounded memory
   * leak confirmed by direct simulation (5 entity selections ->
   * 5 accumulated listeners, 0 ever removed; see
   * R9-MERGE-001-TASK_RESULT.md). `window` never goes away, so nothing
   * ever released these on its own.
   *
   * Fix: use a `ResizeObserver` scoped to the canvas element itself
   * instead of a global `window` listener. When the old canvas is
   * removed from the DOM (the next `selectEntity` call replaces
   * `panel.innerHTML`), the observer holds no reference that keeps it
   * or the canvas alive — both become garbage-collectable normally,
   * with no manual cleanup required at every call site. `destroy()` is
   * also exposed for any caller that wants to stop observing
   * explicitly and deterministically rather than relying on GC timing.
   */
  const resizeObserver = new ResizeObserver(() => resize());
  resizeObserver.observe(canvas);
  function destroy() {
    resizeObserver.disconnect();
  }

  return { render, clear, resize, destroy };
}
