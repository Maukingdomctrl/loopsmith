// === ownership.ts ===

/**
 * Loop Sprite Engine — the ownership engine.
 *
 * Seam evidence answers "are the cuts on gutters". It cannot answer the two
 * questions that actually decide whether a parse is CORRECT:
 *
 *      Is one sprite split across several cells?     (P3, integrity)
 *      Are several sprites crammed into one cell?    (P4, singularity)
 *
 * Both are statements about connected ink, not about marginal projections, and
 * both are invisible to any 1-D statistic: a 2× over-refinement of a correct
 * grid can have impeccable seams on every cut while bisecting every sprite,
 * and a 2× under-refinement can have impeccable seams while pairing them up.
 *
 * THE UNIT ABSTRACTION
 * --------------------
 * The naive approach — count connected components per cell and demand exactly
 * one — fails immediately on real art. A character with a floating crown, a
 * dotted "i", a detached sword glint or an antialiased spark is several
 * components and one sprite. So components are first partitioned into UNITS by
 * an attachment relation:
 *
 *      attach(a, b)  ⟺  d∞(bbox_a, bbox_b) ≤ R
 *                        ∧ min(m_a,m_b) / max(m_a,m_b) ≤ γ
 *
 * The distance clause captures proximity; the MASS RATIO clause is what stops
 * the relation from collapsing the whole sheet. Without it, two adjacent
 * full-size sprites in neighbouring cells would attach to each other and the
 * engine would conclude the sheet contains one enormous sprite. With γ = 1/2
 * the relation only ever glues a SMALL thing to a LARGE thing — a decoration to
 * its owner — and never two peers. Attachment is closed transitively by
 * union-find, so a chain crown → head → body is one unit.
 *
 * R is a fraction of min(width, height) of the IMAGE, never of the cell. If R
 * scaled with the cell, a finer candidate would automatically get a smaller
 * attachment radius, its decorations would detach, and the very geometry under
 * test would change the evidence used to judge it. Grid-independence of the
 * unit partition is what makes candidates comparable at all: the units are
 * computed ONCE per image and reused for every candidate.
 *
 * LEAKAGE
 * -------
 * For a unit with total ink m and per-cell ink m_c,
 *
 *      λ = 1 − max_c m_c / m.
 *
 * λ = 0 means the unit lies wholly in one cell. λ ≈ 1/2 means it is bisected.
 * The bound λ ≤ 1/8 comes from the decoration-mass argument: a legitimate
 * accessory that straddles a cut carries a small fraction of its sprite's ink,
 * whereas a bisected body carries a large one, and 1/8 separates the two
 * populations with room to spare on antialiased art.
 *
 * DUST
 * ----
 * Units below `dustPermille` of the MEDIAN unit mass are not sprites — they are
 * JPEG speckle, stray antialiasing, a signature in the corner. They are counted
 * in the report but excluded from P3 and P4, because a 3-pixel speck sitting on
 * a cut line has λ ≈ 1/2 and would veto every otherwise-perfect grid. The median
 * is used rather than the mean so a single large sprite cannot raise the bar
 * high enough to discard its own smaller siblings.
 */

import {
  DEFAULT_SPRITE_CONFIG,
  type ComponentLabelling,
  type ConnectedComponent,
  type OccupancyField,
  type OwnershipReport,
  type SpriteGrid,
  type SpriteEngineConfig,
  type SpriteUnit,
  type UnitGrouping,
} from "./types";

// ---------------------------------------------------------------------------
// Connected components
// ---------------------------------------------------------------------------

const BACKGROUND_LABEL = -1;

/**
 * 8-connected labelling of the ink set { I ≥ minInkLevel }.
 *
 * Iterative flood fill over an explicit Int32Array stack: recursion would blow
 * the JS stack on a single large sprite, and a 64e6-pixel field admits a
 * component long enough to need ~10⁷ frames.
 *
 * 8-connectivity rather than 4: sprite art is full of diagonal single-pixel
 * staircases, and under 4-connectivity a diagonal outline fragments into
 * hundreds of components. That would not change the unit partition (attachment
 * would glue them back) but it would exhaust `maxComponents` on real input.
 *
 * When the component cap is reached, labelling continues but the smallest
 * regions are dropped to background and `truncated` is set. Dropping the
 * SMALLEST is the safe direction: the cap is only ever hit by speckle, and
 * discarding speckle is what the dust threshold would have done anyway.
 */
export function labelComponents(
  field: OccupancyField,
  config: SpriteEngineConfig = DEFAULT_SPRITE_CONFIG
): ComponentLabelling {
  const { width, height, data } = field;
  const pixels = width * height;
  const labels = new Int32Array(pixels).fill(BACKGROUND_LABEL);

  if (pixels === 0) {
    return { width, height, labels, components: [], truncated: false };
  }

  const ink = config.minInkLevel < 1 ? 1 : config.minInkLevel;
  const stack = new Int32Array(pixels);
  const raw: ConnectedComponent[] = [];

  for (let seed = 0; seed < pixels; seed++) {
    if (labels[seed] !== BACKGROUND_LABEL) continue;
    if (data[seed] < ink) continue;

    const id = raw.length;
    let top = 0;
    stack[top++] = seed;
    labels[seed] = id;

    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let mass = 0;
    let pixelCount = 0;

    while (top > 0) {
      const p = stack[--top];
      const y = (p / width) | 0;
      const x = p - y * width;

      mass += data[p];
      pixelCount++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      const y0 = y > 0 ? y - 1 : 0;
      const y1 = y + 1 < height ? y + 1 : height - 1;
      const x0 = x > 0 ? x - 1 : 0;
      const x1 = x + 1 < width ? x + 1 : width - 1;

      for (let ny = y0; ny <= y1; ny++) {
        const base = ny * width;
        for (let nx = x0; nx <= x1; nx++) {
          const q = base + nx;
          if (labels[q] !== BACKGROUND_LABEL) continue;
          if (data[q] < ink) continue;
          labels[q] = id;
          stack[top++] = q;
        }
      }
    }

    raw.push({ id, minX, minY, maxX, maxY, mass, pixelCount });
  }

  if (raw.length <= config.maxComponents) {
    return { width, height, labels, components: raw, truncated: false };
  }

  // Keep the `maxComponents` heaviest, ordered by (mass desc, id asc) so the
  // selection is deterministic even when masses tie.
  const order = raw.slice().sort((a, b) => b.mass - a.mass || a.id - b.id);
  const keep = new Int32Array(raw.length).fill(BACKGROUND_LABEL);
  const components: ConnectedComponent[] = [];
  for (let i = 0; i < config.maxComponents; i++) {
    keep[order[i].id] = i;
  }
  // Renumber in original scan order so ids stay ascending in image order.
  const remap = new Int32Array(raw.length).fill(BACKGROUND_LABEL);
  for (let id = 0; id < raw.length; id++) {
    if (keep[id] === BACKGROUND_LABEL) continue;
    const newId = components.length;
    remap[id] = newId;
    const c = raw[id];
    components.push({
      id: newId,
      minX: c.minX,
      minY: c.minY,
      maxX: c.maxX,
      maxY: c.maxY,
      mass: c.mass,
      pixelCount: c.pixelCount,
    });
  }
  for (let p = 0; p < pixels; p++) {
    const l = labels[p];
    labels[p] = l === BACKGROUND_LABEL ? BACKGROUND_LABEL : remap[l];
  }

  return { width, height, labels, components, truncated: true };
}

// ---------------------------------------------------------------------------
// Detached accessories: the attachment relation
// ---------------------------------------------------------------------------

/** Chebyshev distance between two axis-aligned boxes; 0 when they overlap. */
function boxDistance(a: ConnectedComponent, b: ConnectedComponent): number {
  const dx =
    a.minX > b.maxX ? a.minX - b.maxX : b.minX > a.maxX ? b.minX - a.maxX : 0;
  const dy =
    a.minY > b.maxY ? a.minY - b.maxY : b.minY > a.maxY ? b.minY - a.maxY : 0;
  return dx > dy ? dx : dy;
}

class UnionFind {
  private readonly parent: Int32Array;

  constructor(n: number) {
    this.parent = new Int32Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }

  find(i: number): number {
    let root = i;
    while (this.parent[root] !== root) root = this.parent[root];
    // Path compression, iterative.
    let walk = i;
    while (this.parent[walk] !== root) {
      const next = this.parent[walk];
      this.parent[walk] = root;
      walk = next;
    }
    return root;
  }

  /** Union by SMALLEST index, not by rank: the representative must be stable. */
  union(a: number, b: number): boolean {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return false;
    if (ra < rb) this.parent[rb] = ra;
    else this.parent[ra] = rb;
    return true;
  }
}

/**
 * Partition components into sprite units.
 *
 * Grid-independent by construction: neither the radius nor the mass ratio nor
 * the iteration order mentions a cell. Computed once per image.
 *
 * Complexity is O(k²) in the component count, bounded by `maxComponents`. The
 * pair loop runs in ascending (i, j) order so the union sequence — and hence
 * every representative — is a deterministic function of the labelling.
 */
export function groupUnits(
  labelling: ComponentLabelling,
  config: SpriteEngineConfig = DEFAULT_SPRITE_CONFIG
): UnitGrouping {
  const components = labelling.components;
  const k = components.length;
  const unitOfComponent = new Int32Array(k).fill(-1);

  if (k === 0) {
    return {
      unitOfComponent,
      groups: [],
      unitMass: new Float64Array(0),
      attachmentEdges: 0,
    };
  }

  const shortSide = Math.min(labelling.width, labelling.height);
  const radius = Math.max(
    1,
    Math.floor((shortSide * config.attachDistancePermille) / 1000)
  );

  const uf = new UnionFind(k);
  let attachmentEdges = 0;

  for (let i = 0; i < k; i++) {
    const a = components[i];
    for (let j = i + 1; j < k; j++) {
      const b = components[j];
      if (boxDistance(a, b) > radius) continue;

      const small = a.mass < b.mass ? a.mass : b.mass;
      const large = a.mass < b.mass ? b.mass : a.mass;
      if (large <= 0) continue;
      // small/large ≤ γ, cross-multiplied to stay in integers.
      if (
        small * config.massRatioDenominator >
        large * config.massRatioNumerator
      ) {
        continue;
      }

      if (uf.union(i, j)) attachmentEdges++;
    }
  }

  // Assign unit indices in ascending representative order, so unit 0 is the
  // unit containing the first component in scan order.
  const indexOfRoot = new Map<number, number>();
  const groups: number[][] = [];
  for (let i = 0; i < k; i++) {
    const root = uf.find(i);
    let unit = indexOfRoot.get(root);
    if (unit === undefined) {
      unit = groups.length;
      indexOfRoot.set(root, unit);
      groups.push([]);
    }
    groups[unit].push(i);
    unitOfComponent[i] = unit;
  }

  const unitMass = new Float64Array(groups.length);
  for (let u = 0; u < groups.length; u++) {
    let m = 0;
    for (let g = 0; g < groups[u].length; g++) m += components[groups[u][g]].mass;
    unitMass[u] = m;
  }

  return { unitOfComponent, groups, unitMass, attachmentEdges };
}

// ---------------------------------------------------------------------------
// Ink leakage and mass ownership
// ---------------------------------------------------------------------------

/** Cell index per column / per row, −1 outside the grid extent. */
function axisIndexMap(
  cuts: readonly number[],
  divisions: number,
  extent: number
): Int32Array {
  const map = new Int32Array(extent).fill(-1);
  for (let d = 0; d < divisions; d++) {
    const lo = cuts[d];
    const hi = cuts[d + 1];
    for (let i = lo; i < hi && i < extent; i++) map[i] = d;
  }
  return map;
}

/** Lower median of a Float64Array's used prefix. Integer-free but exact order. */
function lowerMedianF64(values: Float64Array, length: number): number {
  if (length === 0) return 0;
  const copy = Array.prototype.slice.call(values, 0, length) as number[];
  copy.sort((a, b) => a - b);
  return copy[(length - 1) >> 1];
}

/**
 * Build the full ownership report for one candidate grid.
 *
 * Single O(WH) pass over the label image accumulates, for every (unit, cell)
 * pair that actually occurs, the ink mass in that intersection. The sparse
 * accumulation is a Map keyed by `unit * cells + cell`, so the memory cost is
 * proportional to the number of straddles rather than to units × cells.
 *
 * Predicates evaluated here:
 *
 *   P3 integrity   max λ over principal units ≤ maxLeakageNumerator/Denominator
 *   P4 singularity no cell owns two or more principal units
 *   P5 coverage    occupied-cell fraction ≥ minOccupiedPermille, and (when
 *                  `requireEmptySuffix`) the empty cells form a suffix of scan
 *                  order — a real sheet has its ragged remainder at the END,
 *                  not as holes scattered through the middle, and scattered
 *                  holes are the signature of an over-refined grid.
 */
export function buildOwnershipReport(
  field: OccupancyField,
  grid: SpriteGrid,
  labelling: ComponentLabelling,
  grouping: UnitGrouping,
  config: SpriteEngineConfig = DEFAULT_SPRITE_CONFIG
): OwnershipReport {
  const { width, height, data } = field;
  const cells = grid.cols * grid.rows;
  const occupiedCells = new Uint8Array(cells);
  const principalCounts = new Uint8Array(cells);

  const components = labelling.components;
  const unitCount = grouping.groups.length;

  if (cells === 0) {
    return {
      units: [],
      componentCount: components.length,
      occupiedCells,
      occupiedCellCount: 0,
      principalCounts,
      principalUnitCount: 0,
      maxLeakage: 0,
      integrityOk: false,
      singularityOk: false,
      coverageOk: false,
      violationAt: 0,
    };
  }

  const colOf = axisIndexMap(grid.cutsX, grid.cols, width);
  const rowOf = axisIndexMap(grid.cutsY, grid.rows, height);

  const cellMass = new Float64Array(cells);
  const pairMass = new Map<number, number>();
  const labels = labelling.labels;
  const unitOf = grouping.unitOfComponent;

  for (let y = 0; y < height; y++) {
    const row = rowOf[y];
    if (row < 0) continue;
    const rowBase = row * grid.cols;
    const base = y * width;
    for (let x = 0; x < width; x++) {
      const p = base + x;
      const label = labels[p];
      if (label < 0) continue;
      const col = colOf[x];
      if (col < 0) continue;

      const cell = rowBase + col;
      const m = data[p];
      cellMass[cell] += m;

      const unit = unitOf[label];
      if (unit < 0) continue;
      const key = unit * cells + cell;
      pairMass.set(key, (pairMass.get(key) ?? 0) + m);
    }
  }

  // Occupancy per cell: ink relative to a fully saturated cell of that size.
  let occupiedCellCount = 0;
  for (let row = 0; row < grid.rows; row++) {
    const cellHeight = grid.cutsY[row + 1] - grid.cutsY[row];
    for (let col = 0; col < grid.cols; col++) {
      const cellWidth = grid.cutsX[col + 1] - grid.cutsX[col];
      const cell = row * grid.cols + col;
      const capacity = cellWidth * cellHeight * 255;
      const needed = (capacity * config.cellOccupancyPermille) / 1000;
      if (cellMass[cell] >= needed && cellMass[cell] > 0) {
        occupiedCells[cell] = 1;
        occupiedCellCount++;
      }
    }
  }

  // Dust threshold from the median unit mass.
  const median = lowerMedianF64(grouping.unitMass, unitCount);
  const dustThreshold = (median * config.dustPermille) / 1000;

  // Per-unit aggregation. Sparse pairs collected per unit in ascending cell order.
  const claimsByUnit: Map<number, number>[] = [];
  for (let u = 0; u < unitCount; u++) claimsByUnit.push(new Map<number, number>());
  pairMass.forEach((mass, key) => {
    const unit = Math.floor(key / cells);
    const cell = key - unit * cells;
    claimsByUnit[unit].set(cell, mass);
  });

  const units: SpriteUnit[] = [];
  let maxLeakage = 0;
  let principalUnitCount = 0;
  let integrityOk = true;
  let violationAt = -1;

  const leakageLimit =
    config.maxLeakageNumerator / config.maxLeakageDenominator;

  for (let u = 0; u < unitCount; u++) {
    const componentIds = grouping.groups[u];

    let minX = labelling.width;
    let minY = labelling.height;
    let maxX = -1;
    let maxY = -1;
    let pixelCount = 0;
    for (let i = 0; i < componentIds.length; i++) {
      const c = components[componentIds[i]];
      if (c.minX < minX) minX = c.minX;
      if (c.minY < minY) minY = c.minY;
      if (c.maxX > maxX) maxX = c.maxX;
      if (c.maxY > maxY) maxY = c.maxY;
      pixelCount += c.pixelCount;
    }

    const mass = grouping.unitMass[u];
    const claims = claimsByUnit[u];
    const claimCells: number[] = [];
    let ownerCell = -1;
    let ownerMass = -1;
    claims.forEach((m, cell) => {
      claimCells.push(cell);
      // Ties resolve to the LOWEST cell index, making ownership total.
      if (m > ownerMass || (m === ownerMass && cell < ownerCell)) {
        ownerMass = m;
        ownerCell = cell;
      }
    });
    claimCells.sort((a, b) => a - b);

    const leakage = mass > 0 && ownerMass > 0 ? 1 - ownerMass / mass : 0;
    const principal = mass >= dustThreshold && mass > 0;

    if (principal) {
      principalUnitCount++;
      if (leakage > maxLeakage) maxLeakage = leakage;
      if (leakage > leakageLimit) {
        if (integrityOk) violationAt = u;
        integrityOk = false;
      }
      if (ownerCell >= 0 && principalCounts[ownerCell] < 255) {
        principalCounts[ownerCell]++;
      }
    }

    units.push({
      id: u,
      componentIds: componentIds.slice(),
      minX,
      minY,
      maxX: maxX < 0 ? 0 : maxX,
      maxY: maxY < 0 ? 0 : maxY,
      mass,
      pixelCount,
      ownerCell,
      claimCells,
      leakage,
      principal,
    });
  }

  // P4: at most one principal unit per cell.
  let singularityOk = true;
  for (let cell = 0; cell < cells; cell++) {
    if (principalCounts[cell] > 1) {
      singularityOk = false;
      if (violationAt < 0) violationAt = cell;
      break;
    }
  }

  // P5: density, plus the empty-suffix shape requirement.
  let coverageOk =
    occupiedCellCount * 1000 >= cells * config.minOccupiedPermille;
  if (coverageOk && config.requireEmptySuffix) {
    let firstEmpty = -1;
    for (let cell = 0; cell < cells; cell++) {
      if (occupiedCells[cell] === 0) {
        if (firstEmpty < 0) firstEmpty = cell;
      } else if (firstEmpty >= 0) {
        coverageOk = false;
        if (violationAt < 0) violationAt = cell;
        break;
      }
    }
  }

  return {
    units,
    componentCount: components.length,
    occupiedCells,
    occupiedCellCount,
    principalCounts,
    principalUnitCount,
    maxLeakage,
    integrityOk,
    singularityOk,
    coverageOk,
    violationAt: violationAt < 0 ? -1 : violationAt,
  };
}

/** P3 ∧ P4 ∧ P5, mapped to the reason the candidate filter reports. */
export function ownershipRejection(
  report: OwnershipReport
): "split-sprite" | "grouped-sprite" | "coverage" | null {
  if (!report.integrityOk) return "split-sprite";
  if (!report.singularityOk) return "grouped-sprite";
  if (!report.coverageOk) return "coverage";
  return null;
}