/** KIMA EIS graph projection/traversal service. Relationship store remains source of truth.
 * Direction semantics: forward = source→target, reverse = target→source,
 * bidirectional = both.
 */
export function buildGraph(relationships = []) {
  const out = new Map(), inMap = new Map();
  const add=(m,k,r)=>{if(!m.has(k))m.set(k,[]);m.get(k).push(r);};
  for (const r of relationships) {
    const d = r.direction || 'forward';
    if (d === 'forward') { add(out,r.source_entity_id,r); add(inMap,r.target_entity_id,r); }
    else if (d === 'reverse') { add(out,r.target_entity_id,r); add(inMap,r.source_entity_id,r); }
    else if (d === 'bidirectional') { add(out,r.source_entity_id,r); add(out,r.target_entity_id,r); add(inMap,r.source_entity_id,r); add(inMap,r.target_entity_id,r); }
  }
  return { out, inMap };
}
/**
 * R9-MERGE-001 fix: `relationshipTypes` is a REPORTING filter, not a
 * connectivity restriction. BFS continues through every edge
 * regardless of type (so a matching edge deeper in the graph, reached
 * via a non-matching edge closer to the start, is still found) — only
 * which edges/nodes are *added to the returned result* is restricted
 * to matching types.
 *
 * Defect found during pre-merge review of the uploaded R9 pack (this
 * function was carried over unmodified from before R9): applying the
 * filter before continuing the walk meant the whole traversal silently
 * died at the first non-matching edge. Example: A-connection->B-piping
 * ->D-containment->E with relationshipTypes:['containment'] returned
 * only the start node, even though a real containment edge (D->E)
 * exists and is reachable. Confirmed live in this exact file via
 * `traverse(rels,'A',{relationshipTypes:['containment']})` before this
 * fix — see R9-MERGE-001-TASK_RESULT.md for the full reproduction and
 * regression proof. This option was not exercised by any pre-R9
 * caller (impact.js only ever passes it through as `null`), so it had
 * zero live impact until R9's own type-filter control became its first
 * real consumer.
 *
 * `walked` guards every node the BFS *walks through* (matching or not)
 * so it never revisits a node twice; a node is only pushed into the
 * *returned* `nodes` list (`reported`) when it was reached via a
 * matching edge, or no filter is active.
 */
export function traverse(relationships, startId, options = {}) {
  const { maxDepth = 5, direction = 'both', relationshipTypes = null } = options;
  const graph = buildGraph(relationships), queue=[{id:startId,depth:0}], walked=new Set([startId]), reported=new Set([startId]), nodes=[{entity_id:startId,depth:0}], edges=[];
  while(queue.length){const {id,depth}=queue.shift();if(depth>=maxDepth)continue;const candidates=[];
    if(direction==='out'||direction==='both') for(const r of graph.out.get(id)||[]) candidates.push({r,next:r.source_entity_id===id&&r.direction==='reverse'?r.target_entity_id:(r.target_entity_id===id&&r.direction==='reverse'?r.source_entity_id:(r.source_entity_id===id?r.target_entity_id:r.source_entity_id))});
    if(direction==='in'||direction==='both') for(const r of graph.inMap.get(id)||[]) candidates.push({r,next:r.source_entity_id===id&&r.direction==='forward'?r.target_entity_id:(r.target_entity_id===id&&r.direction==='forward'?r.source_entity_id:(r.source_entity_id===id?r.target_entity_id:r.source_entity_id))});
    for(const {r,next} of candidates){
      const matches=!relationshipTypes||relationshipTypes.includes(r.relationship_type);
      if(!walked.has(next)){walked.add(next);if(depth+1<maxDepth||matches)queue.push({id:next,depth:depth+1});}
      if(!matches)continue;
      edges.push(r);
      if(!reported.has(next)){reported.add(next);nodes.push({entity_id:next,depth:depth+1});}
    }
  }
  return {startId,nodes,edges:[...new Map(edges.map(e=>[e.relationship_id,e])).values()]};
}
