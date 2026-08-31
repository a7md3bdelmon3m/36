# H-07 / H-08 / H-10 / H-11 implementation

Task ID: ADR-032 (see `00_CONTROL/DECISION_LOG.md`)

## What this task implements

Four of the five HIGH gaps ADR-030 re-confirmed as genuinely OPEN with
zero implementation. H-09 pattern (headless-Chromium harness) could not
be repeated here — see "Real limits" below — so this task follows the
H-04/ADR-031 pattern instead: real code, Node-logic-verified only.

### H-07 — P&ID navigation/locator model
Per `11_PNID/PNID_NAVIGATION_SPEC.md` exactly: drawing identity, drawing
version, entity-to-region link, page/region locator, evidence, navigation
state; "No P&ID link is considered authoritative without a
source/evidence reference."

- New stores: `drawing` (drawing_id, drawing_number, drawing_title,
  drawing_version, supersedes_drawing_id, evidence_id, timestamps),
  `drawing_locator` (locator_id, entity_id, drawing_id, region, page,
  evidence_id **required**, navigation_state, timestamps).
- `KimaDB.createDrawing`, `listDrawings`, `createDrawingLocator`,
  `listDrawingLocatorsForEntity`, `navigateEntityToDrawings` (the
  spec's stated Entity → Drawing → Region → Related Entity → Graph
  workflow's first three hops — the "→ Graph" hop reuses the existing
  `listRelationshipsForEntity`/topology code rather than duplicating
  traversal logic here).
- `createDrawingLocator` throws synchronously if `evidence_id` is
  omitted — a literal, load-bearing implementation of the spec
  sentence above, not a general design preference.
- UI: `#drawing-form` (register a drawing) and `#drawing-locator-form`
  (link the selected entity to a drawing region, evidence-gated) added
  to `selectEntity`'s panel, same pattern as the existing
  `#standard-mapping-form`.

### H-08 — Field observation layer
Per `12_FIELD/FIELD_LAYER_SPECIFICATION.md` exactly: observation_id,
entity_id, timestamp, value, unit, note, attachment, location
(optional), actor, validation_state, source=FIELD. "Field data is
separate from master/source data. A field observation does not
overwrite engineering master data automatically."

- New store: `field_observation`, deliberately separate from the
  existing `observation` store (per the spec sentence above — mirrors
  this schema's existing precedent of `standard_mapping` and
  `decision` being separate stores despite conceptual overlap with
  `observation`).
- `KimaDB.createFieldObservation`, `listFieldObservationsForEntity`.
- UI: `#field-observation-form` added to `selectEntity`'s panel.

### H-10 — Source artifact retention / evidence resolvability
Real gap per ADR-030: source metadata can outlive its accessible
artifact with nothing checking or flagging that.

- **Deliberately NOT** an autonomous deletion/archival scheduler — this
  schema never silently deletes provenance records (existing precedent:
  `commitImportRelationshipRow`'s own doc comment on orphaned evidence).
- `RETENTION_STATUSES` = `ACTIVE | ARCHIVED | UNAVAILABLE`.
- `KimaDB.setArtifactRetentionStatus(artifactId, status, reason)` —
  explicit, audited (via `change_event`) status change.
- `KimaDB.getEvidenceResolvability(evidenceId)` — resolves whether an
  evidence record's underlying artifact(s) are still `ACTIVE`; existing
  rows with no `retention_status` field default to `ACTIVE` (named,
  not backfilled — see gap-register note).
- No UI wired for this one yet — it is a query/audit primitive for a
  future admin view, not an end-user form; named as a remaining step.

### H-11 — Migration framework
Real gap per ADR-030: zero matches for migration/migrate beyond the
base `onupgradeneeded` handler; no versioned registry or N-1/N testing.

- `MIGRATION_REGISTRY` — one entry per `DB_VERSION`, naming
  `stores_added`/`stores_removed`/`breaking` per version. Two entries
  exist: v7 (base schema, backfilled description of what ADR-017/the
  original schema already did) and v8 (this task's own three new
  stores).
- `migrationsBetween(from, to)` — returns the registry slice for an
  N-1/N (or wider) upgrade span; throws `Migration registry gap` if any
  version in the requested range has no registry entry — this is
  intentionally strict: an unregistered version bump is exactly the
  failure mode H-11 exists to prevent, so silently returning a partial
  list would defeat the gap's own purpose.
- `onupgradeneeded` itself still performs the actual store/index
  creation (IndexedDB requires this); the registry is the newly-added
  single source of truth for "what changed at each version" that this
  task's own test suite (and any future N-1/N test) reads from, rather
  than only the handler's own uncommented code.
- **Not implemented**: an actual N-1/N upgrade **test** that opens a
  real v7 IndexedDB and confirms it upgrades cleanly to v8 without data
  loss. This requires a real IndexedDB (see "Real limits" below) and is
  named as the concrete next step for H-11, not assumed covered by the
  registry's existence alone.

## Schema/version change

`DB_VERSION`: 7 → 8. `STORE_NAMES`: 10 → 13 (adds `drawing`,
`drawing_locator`, `field_observation`). Backup format:
`KIMA_EIS_BACKUP_V7` → `KIMA_EIS_BACKUP_V8` for `exportBackup`;
`importBackup` accepts both V7 and V8 for backward compatibility with
existing backup files, exactly like the V3–V7 range it already accepted
before this task. `V3_CURRENT_STATE.txt` / release-verification ground
truth updated accordingly (see `DECISION_LOG.md` ADR-032).

## Real limits — what was attempted and what is honestly not covered

**Attempted first, per this project's own established practice for
every implementation task since ADR-023**: a real-browser or
real-IndexedDB harness (the H-05/H-06/H-09/H-12 pattern). `bash_tool`'s
network is disabled in this session (no Chromium reachable — same
constraint as ADR-031). `npm install fake-indexeddb --no-save` was
attempted **fresh in this task**, not assumed from ADR-031's prior
result, and failed identically: `403 Forbidden` from the npm registry.

**What was actually run**: `node_logic_test.mjs` in this directory,
18/18 checks — verifying only the parts of the four gaps' new code that
do not require a real IndexedDB: synchronous pre-DB-touch validation
guards on all four new `create*` functions, the exported
`RETENTION_STATUSES`/`MIGRATION_REGISTRY` constants and
`migrationsBetween`'s own internal consistency, and source-level
confirmation (via direct string matching against the actual `db.js`
file, not memory) that `STORE_NAMES`, the backup format bump, and the
`drawing_locator` evidence-required import-validation message are all
genuinely present.

**Explicitly NOT verified** (named, not glossed over):

- Any actual IndexedDB write/read for `drawing`, `drawing_locator`,
  `field_observation`, or a `source_artifact` record's
  `retention_status` field.
- `onupgradeneeded` actually creating the three new stores + their
  indexes on a real browser's IndexedDB when an existing v7 database
  upgrades to v8 (the exact N-1/N scenario H-11 itself is about).
- The four new forms (`#drawing-form`, `#drawing-locator-form`,
  `#field-observation-form`) actually submitting in a real DOM, their
  handlers firing, or `selectEntity`'s re-render showing the new rows.
- `navigateEntityToDrawings`' join logic against real stored
  locator/drawing rows.
- `getEvidenceResolvability`'s actual multi-artifact resolution logic
  (the `ACTIVE`-preference-among-multiple-artifacts branch) against
  real data — only its synchronous invalid-status guard
  (`setArtifactRetentionStatus`) was reachable without a DB.
- `exportBackup`/`importBackup` round-tripping the three new stores —
  H-09's own T012 harness (ADR-026) did not include them (they did not
  exist yet); this task adds them to `STORE_NAMES` so the existing
  generic per-store export/import loop covers them structurally, but
  that has not been exercised against a real IndexedDB here.
- A real N-1/N migration test (open a v7-shaped IndexedDB, confirm a
  clean upgrade to v8 with the pre-existing 10 stores' data intact and
  the 3 new stores present and empty).

## Gap-register status

All four rows set to **PARTIALLY CLOSED**, not CLOSED — matching this
project's own established discipline (H-04/ADR-031; H-05/H-06 sat at
Node-only-verified for two days before ADR-021/022's real-device
confirmation closed them). The closure criterion for each
(H-07: "Tag-to-drawing navigation is traceable and tested"; H-08:
"Field observation lifecycle is executable offline"; H-10: "Evidence
locator remains resolvable or explicitly marked unavailable" — this one
arguably closer, since `getEvidenceResolvability` exists, but its core
multi-artifact logic is DB-dependent and untested; H-11: "N-1/N
migrations execute without data loss") requires real-browser or
real-IndexedDB evidence this task's tier cannot supply.
