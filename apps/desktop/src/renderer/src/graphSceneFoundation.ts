/**
 * Renderer-neutral graph scene state. Renderers consume these resolved numeric
 * arrays; they do not choose graph meaning, interaction, labels, or layout.
 */

import type { GraphTopology } from "@exograph/core";

export type Vec3 = readonly [number, number, number];

/** The scene consumes the exact hot-array contract compiled by core. */
export type GraphTopologyArrays = Pick<
  GraphTopology,
  "topologyHash" | "layoutEpochId" | "seed" | "nodes" | "edges"
>;

export interface GraphLayoutState {
  topologyHash: string;
  layoutEpochId: string;
  sequence: number;
  positions: Float32Array;
  /** Nodes copied from the previous topology by 64-bit identity. */
  continuityMask: Uint8Array;
  settled: boolean;
}

export interface GraphLayoutInput {
  topologyHash: string;
  layoutEpochId: string;
  sequence: number;
  seed: number;
  nodeSeeds: Uint32Array;
  nodeGroups: Uint32Array;
  edgeEndpoints: Uint32Array;
  initialPositions: Float32Array;
  continuityMask: Uint8Array;
}

export interface GraphLayoutFrame {
  topologyHash: string;
  layoutEpochId: string;
  sequence: number;
  positions: Float32Array;
  settled: boolean;
}

export type LayoutFrameRejection =
  | "topology-mismatch"
  | "layout-epoch-mismatch"
  | "invalid-layout-sequence"
  | "stale-layout-sequence"
  | "invalid-position-count"
  | "non-finite-position";

export type LayoutFrameResult =
  | { accepted: true; state: GraphLayoutState }
  | { accepted: false; reason: LayoutFrameRejection; state: GraphLayoutState };

export interface GraphSelectionState {
  selected: number;
  pathTarget: number;
  hovered: number;
  pathNodes: Uint8Array;
  pathEdges: Uint8Array;
}

export interface GraphCamera {
  yaw: number;
  pitch: number;
  distance: number;
  target: [number, number, number];
  fov: number;
  near: number;
  far: number;
}

export interface GraphViewport {
  width: number;
  height: number;
}

/** x, y, normalized depth, visible flag for every node. */
export interface GraphProjectionState {
  nodes: Float32Array;
  viewport: GraphViewport;
  pickIndex: GraphPickIndex;
}

export interface GraphPickIndex {
  cellSize: number;
  columns: number;
  rows: number;
  offsets: Uint32Array;
  nodeIndices: Uint32Array;
}

export interface GraphSceneContract {
  topology: GraphTopologyArrays;
  layout: GraphLayoutState;
  interaction: GraphSelectionState;
  camera: GraphCamera;
  projection: GraphProjectionState;
}

export interface GraphLabelCandidate {
  index: number;
  text: string;
  width: number;
  height: number;
}

export interface GraphLabelBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface GraphLabelPlacement {
  index: number;
  text: string;
  x: number;
  y: number;
  depth: number;
  required: boolean;
  box: GraphLabelBox;
}

export interface GraphLabelPlan {
  placements: GraphLabelPlacement[];
  omittedRequired: number[];
}

export interface GraphLabelPlanOptions {
  maxLabels: number;
  showOverflowLabels?: boolean;
  edgeInset?: number;
  collisionGap?: number;
}

export interface GraphPickOptions {
  pointer?: "fine" | "coarse";
  finePadding?: number;
  coarsePadding?: number;
}

export interface GraphPointerTransformOptions {
  orbitRadiansPerPixel?: number;
  minimumPitch?: number;
  maximumPitch?: number;
  minimumDistance?: number;
  maximumDistance?: number;
}

export type GraphKeyboardIntent =
  | { kind: "camera"; camera: GraphCamera }
  | { kind: "frame" }
  | { kind: "focus" }
  | { kind: "clear" }
  | { kind: "none" };

export const DEFAULT_SCENE_CAMERA: GraphCamera = {
  yaw: -0.42,
  pitch: 0.46,
  distance: 760,
  target: [0, 0, 0],
  fov: Math.PI / 4.2,
  near: 0.1,
  far: 50_000,
};

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const DEFAULT_MINIMUM_DISTANCE = 24;
const DEFAULT_MAXIMUM_DISTANCE = 30_000;
const EPSILON = 1e-6;

export function validateGraphTopology(topology: GraphTopologyArrays): string[] {
  const issues: string[] = [];
  const nodeCount = topology.nodes.seeds.length;
  const edgeCount = topology.edges.visualClasses.length;
  if (!topology.topologyHash) issues.push("topologyHash must not be empty");
  if (!topology.layoutEpochId) issues.push("layoutEpochId must not be empty");
  if (topology.nodes.identityKeys.length !== nodeCount * 2) issues.push("identityKeys must contain one low/high word pair per node");
  if (topology.nodes.groups.length !== nodeCount) issues.push("groups length must equal seeds length");
  if (topology.nodes.degrees.length !== nodeCount) issues.push("degrees length must equal seeds length");
  if (topology.nodes.visualClasses.length !== nodeCount) issues.push("node visualClasses length must equal seeds length");
  if (topology.edges.endpoints.length !== edgeCount * 2) issues.push("endpoints must contain one source/target pair per edge");
  const identities = new Set<string>();
  for (let node = 0; node < Math.min(nodeCount, topology.nodes.identityKeys.length / 2); node += 1) {
    const identity = identityKeyAt(topology.nodes.identityKeys, node);
    if (identities.has(identity)) {
      issues.push(`node ${node} duplicates a 64-bit identity key`);
      break;
    }
    identities.add(identity);
  }
  for (let edge = 0; edge < Math.min(edgeCount, topology.edges.endpoints.length / 2); edge += 1) {
    const source = topology.edges.endpoints[edge * 2] ?? nodeCount;
    const target = topology.edges.endpoints[edge * 2 + 1] ?? nodeCount;
    if (source >= nodeCount || target >= nodeCount) {
      issues.push(`edge ${edge} endpoint is outside node bounds`);
      break;
    }
  }
  return issues;
}

export function createDeterministicLayout(topology: GraphTopologyArrays): GraphLayoutState {
  const issues = validateGraphTopology(topology);
  if (issues.length) throw new Error(`Invalid graph topology: ${issues.join("; ")}`);
  const groupIds = [...new Set(topology.nodes.groups)].sort((left, right) => left - right);
  const groupIndex = new Map(groupIds.map((group, index) => [group, index]));
  const anchorRadius = Math.max(80, Math.sqrt(topology.nodes.seeds.length) * 18);
  const anchors = new Float32Array(groupIds.length * 3);
  for (let index = 0; index < groupIds.length; index += 1) {
    const y = groupIds.length === 1 ? 0 : 1 - (index / Math.max(1, groupIds.length - 1)) * 2;
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    const angle = index * GOLDEN_ANGLE;
    anchors[index * 3] = Math.cos(angle) * ring * anchorRadius;
    anchors[index * 3 + 1] = y * anchorRadius * 0.72;
    anchors[index * 3 + 2] = Math.sin(angle) * ring * anchorRadius;
  }
  const positions = new Float32Array(topology.nodes.seeds.length * 3);
  for (let index = 0; index < topology.nodes.seeds.length; index += 1) {
    const nodeSeed = topology.nodes.seeds[index] ?? 0;
    const seed = mix32(nodeSeed ^ topology.seed);
    const theta = ((seed & 0xffff) / 0xffff) * Math.PI * 2;
    const z = (((seed >>> 16) & 0xffff) / 0xffff) * 2 - 1;
    const radial = Math.sqrt(Math.max(0, 1 - z * z));
    const radius = 20 + (mix32(seed ^ 0x9e3779b9) / 0xffffffff) * 58;
    const anchorIndex = groupIndex.get(topology.nodes.groups[index] ?? 0) ?? 0;
    positions[index * 3] = (anchors[anchorIndex * 3] ?? 0) + Math.cos(theta) * radial * radius;
    positions[index * 3 + 1] = (anchors[anchorIndex * 3 + 1] ?? 0) + z * radius;
    positions[index * 3 + 2] = (anchors[anchorIndex * 3 + 2] ?? 0) + Math.sin(theta) * radial * radius;
  }
  return {
    topologyHash: topology.topologyHash,
    layoutEpochId: topology.layoutEpochId,
    sequence: 0,
    positions,
    continuityMask: new Uint8Array(topology.nodes.seeds.length),
    settled: topology.nodes.seeds.length === 0,
  };
}

/** Preserve unchanged nodes by 64-bit identity and deterministically seed new nodes. */
export function reconcileGraphLayout(
  previousTopology: GraphTopologyArrays,
  previousLayout: GraphLayoutState,
  nextTopology: GraphTopologyArrays,
): GraphLayoutState {
  const seeded = createDeterministicLayout(nextTopology);
  if (previousLayout.positions.length !== previousTopology.nodes.seeds.length * 3) return seeded;
  const previousByIdentity = identityIndexQueues(previousTopology.nodes.identityKeys);
  for (let nextIndex = 0; nextIndex < nextTopology.nodes.seeds.length; nextIndex += 1) {
    const queue = previousByIdentity.get(identityKeyAt(nextTopology.nodes.identityKeys, nextIndex));
    const previousIndex = queue?.shift();
    if (previousIndex === undefined) continue;
    seeded.positions.set(previousLayout.positions.subarray(previousIndex * 3, previousIndex * 3 + 3), nextIndex * 3);
    seeded.continuityMask[nextIndex] = 1;
  }
  return seeded;
}

export function createGraphLayoutInput(
  topology: GraphTopologyArrays,
  layout: GraphLayoutState,
  sequence = layout.sequence + 1,
): GraphLayoutInput {
  if (topology.topologyHash !== layout.topologyHash || topology.layoutEpochId !== layout.layoutEpochId) {
    throw new Error("Graph layout input must use the exact topology and layout epoch.");
  }
  return {
    topologyHash: topology.topologyHash,
    layoutEpochId: topology.layoutEpochId,
    sequence,
    seed: topology.seed,
    nodeSeeds: topology.nodes.seeds,
    nodeGroups: topology.nodes.groups,
    edgeEndpoints: topology.edges.endpoints,
    initialPositions: layout.positions,
    continuityMask: layout.continuityMask,
  };
}

export function applyGraphLayoutFrame(state: GraphLayoutState, frame: GraphLayoutFrame): LayoutFrameResult {
  let reason: LayoutFrameRejection | null = null;
  if (frame.topologyHash !== state.topologyHash) reason = "topology-mismatch";
  else if (frame.layoutEpochId !== state.layoutEpochId) reason = "layout-epoch-mismatch";
  else if (!Number.isSafeInteger(frame.sequence) || frame.sequence < 1) reason = "invalid-layout-sequence";
  else if (frame.sequence <= state.sequence) reason = "stale-layout-sequence";
  else if (frame.positions.length !== state.positions.length) reason = "invalid-position-count";
  else if (!allFinite(frame.positions)) reason = "non-finite-position";
  if (reason) return { accepted: false, reason, state };
  return {
    accepted: true,
    state: {
      topologyHash: state.topologyHash,
      layoutEpochId: state.layoutEpochId,
      sequence: frame.sequence,
      positions: new Float32Array(frame.positions),
      continuityMask: new Uint8Array(state.continuityMask),
      settled: frame.settled,
    },
  };
}

export function emptyGraphSelection(nodeCount: number, edgeCount: number): GraphSelectionState {
  return {
    selected: -1,
    pathTarget: -1,
    hovered: -1,
    pathNodes: new Uint8Array(nodeCount),
    pathEdges: new Uint8Array(edgeCount),
  };
}

export function reconcileGraphSelection(
  previousTopology: GraphTopologyArrays,
  previous: GraphSelectionState,
  nextTopology: GraphTopologyArrays,
): GraphSelectionState {
  const next = emptyGraphSelection(nextTopology.nodes.seeds.length, nextTopology.edges.visualClasses.length);
  next.selected = remapStableIndex(previous.selected, previousTopology.nodes.identityKeys, nextTopology.nodes.identityKeys);
  next.pathTarget = remapStableIndex(previous.pathTarget, previousTopology.nodes.identityKeys, nextTopology.nodes.identityKeys);
  next.hovered = remapStableIndex(previous.hovered, previousTopology.nodes.identityKeys, nextTopology.nodes.identityKeys);
  if (next.selected >= 0 && next.pathTarget >= 0) return selectGraphPath(nextTopology, next.selected, next.pathTarget, next.hovered);
  return next;
}

export function selectGraphPath(
  topology: GraphTopologyArrays,
  selected: number,
  pathTarget = -1,
  hovered = -1,
): GraphSelectionState {
  const state = emptyGraphSelection(topology.nodes.seeds.length, topology.edges.visualClasses.length);
  state.selected = validIndex(selected, topology.nodes.seeds.length) ? selected : -1;
  state.pathTarget = validIndex(pathTarget, topology.nodes.seeds.length) ? pathTarget : -1;
  state.hovered = validIndex(hovered, topology.nodes.seeds.length) ? hovered : -1;
  if (state.selected < 0 || state.pathTarget < 0) return state;
  if (state.selected === state.pathTarget) {
    state.pathNodes[state.selected] = 1;
    return state;
  }
  const adjacency = buildAdjacency(topology);
  const previousNode = new Int32Array(topology.nodes.seeds.length).fill(-2);
  const previousEdge = new Int32Array(topology.nodes.seeds.length).fill(-1);
  const queue = new Uint32Array(topology.nodes.seeds.length);
  let head = 0;
  let tail = 0;
  queue[tail++] = state.selected;
  previousNode[state.selected] = -1;
  while (head < tail && previousNode[state.pathTarget] === -2) {
    const current = queue[head++] ?? 0;
    for (const entry of adjacency[current] ?? []) {
      if (previousNode[entry.node] !== -2) continue;
      previousNode[entry.node] = current;
      previousEdge[entry.node] = entry.edge;
      queue[tail++] = entry.node;
    }
  }
  if (previousNode[state.pathTarget] === -2) return state;
  for (let current = state.pathTarget; current !== -1; current = previousNode[current] ?? -1) {
    state.pathNodes[current] = 1;
    const edge = previousEdge[current] ?? -1;
    if (edge >= 0) state.pathEdges[edge] = 1;
  }
  return state;
}

export function createGraphScene(topology: GraphTopologyArrays, viewport: GraphViewport): GraphSceneContract {
  const layout = createDeterministicLayout(topology);
  const camera = frameGraphCamera(layout.positions, viewport);
  return {
    topology,
    layout,
    interaction: emptyGraphSelection(topology.nodes.seeds.length, topology.edges.visualClasses.length),
    camera,
    projection: projectGraphScene(layout.positions, camera, viewport),
  };
}

/** Advance topology without resetting the user's camera or surviving identities. */
export function reconcileGraphScene(previous: GraphSceneContract, topology: GraphTopologyArrays): GraphSceneContract {
  const layout = reconcileGraphLayout(previous.topology, previous.layout, topology);
  const interaction = reconcileGraphSelection(previous.topology, previous.interaction, topology);
  const camera = { ...previous.camera, target: [...previous.camera.target] as [number, number, number] };
  return {
    topology,
    layout,
    interaction,
    camera,
    projection: projectGraphScene(layout.positions, camera, previous.projection.viewport),
  };
}

export function applyGraphSceneLayoutFrame(scene: GraphSceneContract, frame: GraphLayoutFrame): {
  scene: GraphSceneContract;
  rejection?: LayoutFrameRejection;
} {
  const result = applyGraphLayoutFrame(scene.layout, frame);
  if (!result.accepted) return { scene, rejection: result.reason };
  return {
    scene: {
      ...scene,
      layout: result.state,
      projection: projectGraphScene(result.state.positions, scene.camera, scene.projection.viewport),
    },
  };
}

export function projectGraphScene(
  positions: Float32Array,
  camera: GraphCamera,
  viewport: GraphViewport,
): GraphProjectionState {
  const nodes = new Float32Array((positions.length / 3) * 4);
  const matrix = viewProjectionMatrix(camera, viewport);
  for (let index = 0; index < positions.length / 3; index += 1) {
    const source = index * 3;
    const x = positions[source] ?? 0;
    const y = positions[source + 1] ?? 0;
    const z = positions[source + 2] ?? 0;
    const clipX = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
    const clipY = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
    const clipZ = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
    const clipW = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
    const target = index * 4;
    if (clipW <= EPSILON) continue;
    const inverseW = 1 / clipW;
    const ndcX = clipX * inverseW;
    const ndcY = clipY * inverseW;
    const depth = clipZ * inverseW;
    nodes[target] = (ndcX * 0.5 + 0.5) * viewport.width;
    nodes[target + 1] = (-ndcY * 0.5 + 0.5) * viewport.height;
    nodes[target + 2] = depth;
    nodes[target + 3] = depth >= 0 && depth <= 1 && ndcX >= -1.15 && ndcX <= 1.15 && ndcY >= -1.15 && ndcY <= 1.15 ? 1 : 0;
  }
  return { nodes, viewport: { ...viewport }, pickIndex: buildGraphPickIndex(nodes, viewport) };
}

export function buildGraphPickIndex(nodes: Float32Array, viewport: GraphViewport, cellSize = 48): GraphPickIndex {
  const columns = Math.max(1, Math.ceil(viewport.width / cellSize));
  const rows = Math.max(1, Math.ceil(viewport.height / cellSize));
  const counts = new Uint32Array(columns * rows);
  let visibleCount = 0;
  for (let index = 0; index < nodes.length / 4; index += 1) {
    if (nodes[index * 4 + 3] !== 1) continue;
    counts[pickCell(nodes[index * 4] ?? 0, nodes[index * 4 + 1] ?? 0, cellSize, columns, rows)] += 1;
    visibleCount += 1;
  }
  const offsets = new Uint32Array(counts.length + 1);
  for (let cell = 0; cell < counts.length; cell += 1) offsets[cell + 1] = (offsets[cell] ?? 0) + (counts[cell] ?? 0);
  const cursors = new Uint32Array(offsets);
  const nodeIndices = new Uint32Array(visibleCount);
  for (let index = 0; index < nodes.length / 4; index += 1) {
    if (nodes[index * 4 + 3] !== 1) continue;
    const cell = pickCell(nodes[index * 4] ?? 0, nodes[index * 4 + 1] ?? 0, cellSize, columns, rows);
    nodeIndices[cursors[cell] ?? 0] = index;
    cursors[cell] += 1;
  }
  return { cellSize, columns, rows, offsets, nodeIndices };
}

export function graphNodeScreenRadius(degree: number, style: number, camera: GraphCamera): number {
  const styleScale = 1 + Math.min(7, Math.max(0, style)) * 0.035;
  const semanticRadius = (3.4 + 0.75 * Math.log2(1 + Math.max(0, degree))) * styleScale;
  const zoom = clamp(Math.pow(760 / Math.max(1, camera.distance), 0.38), 0.95, 4);
  return clamp(semanticRadius * zoom, 3, 30);
}

/** Pick the frontmost visible node whose rendered radius contains the pointer. */
export function pickGraphSceneNode(
  topology: GraphTopologyArrays,
  projection: GraphProjectionState,
  camera: GraphCamera,
  x: number,
  y: number,
  options: GraphPickOptions = {},
): number {
  const padding = options.pointer === "coarse" ? (options.coarsePadding ?? 16) : (options.finePadding ?? 8);
  let winner = -1;
  let winnerDepth = Number.POSITIVE_INFINITY;
  let winnerDistance = Number.POSITIVE_INFINITY;
  const { pickIndex } = projection;
  const centerColumn = clamp(Math.floor(x / pickIndex.cellSize), 0, pickIndex.columns - 1);
  const centerRow = clamp(Math.floor(y / pickIndex.cellSize), 0, pickIndex.rows - 1);
  const searchRadius = Math.max(1, Math.ceil((30 + padding) / pickIndex.cellSize));
  for (let row = Math.max(0, centerRow - searchRadius); row <= Math.min(pickIndex.rows - 1, centerRow + searchRadius); row += 1) {
    for (let column = Math.max(0, centerColumn - searchRadius); column <= Math.min(pickIndex.columns - 1, centerColumn + searchRadius); column += 1) {
      const cell = row * pickIndex.columns + column;
      const start = pickIndex.offsets[cell] ?? 0;
      const end = pickIndex.offsets[cell + 1] ?? start;
      for (let cursor = start; cursor < end; cursor += 1) {
        const index = pickIndex.nodeIndices[cursor] ?? -1;
        if (index < 0) continue;
        const offset = index * 4;
        const distance = Math.hypot((projection.nodes[offset] ?? 0) - x, (projection.nodes[offset + 1] ?? 0) - y);
        const radius = graphNodeScreenRadius(topology.nodes.degrees[index] ?? 0, topology.nodes.visualClasses[index] ?? 0, camera) + padding;
        if (distance > radius) continue;
        const depth = projection.nodes[offset + 2] ?? 1;
        if (depth < winnerDepth - EPSILON || (Math.abs(depth - winnerDepth) <= EPSILON && distance < winnerDistance)) {
          winner = index;
          winnerDepth = depth;
          winnerDistance = distance;
        }
      }
    }
  }
  return winner;
}

/**
 * Plan labels without renderer measurement or drawing. Selected and path labels
 * are attempted first and may exceed maxLabels; impossible required placements
 * are reported rather than silently overlapping.
 */
export function planGraphLabels(
  topology: GraphTopologyArrays,
  projection: GraphProjectionState,
  interaction: GraphSelectionState,
  candidates: readonly GraphLabelCandidate[],
  options: GraphLabelPlanOptions,
): GraphLabelPlan {
  const inset = options.edgeInset ?? 8;
  const gap = options.collisionGap ?? 6;
  const candidateByIndex = new Map(candidates.map((candidate) => [candidate.index, candidate]));
  const centerX = projection.viewport.width / 2;
  const centerY = projection.viewport.height / 2;
  const ranked = candidates
    .filter((candidate) => candidate.index >= 0 && candidate.index < topology.nodes.seeds.length && projection.nodes[candidate.index * 4 + 3] === 1)
    .map((candidate) => {
      const required = candidate.index === interaction.selected
        || candidate.index === interaction.pathTarget
        || interaction.pathNodes[candidate.index] === 1;
      const hovered = candidate.index === interaction.hovered;
      const offset = candidate.index * 4;
      const distance = Math.hypot((projection.nodes[offset] ?? 0) - centerX, (projection.nodes[offset + 1] ?? 0) - centerY);
      const score = (required ? 1e9 : 0)
        + (hovered ? 5e8 : 0)
        + (topology.nodes.degrees[candidate.index] ?? 0) * 38
        + 1_200 / (1 + distance / 160)
        - (projection.nodes[offset + 2] ?? 1) * 140;
      return { candidate, required, score };
    })
    .sort((left, right) => right.score - left.score || left.candidate.index - right.candidate.index);
  const requiredCount = ranked.filter((entry) => entry.required).length;
  const limit = Math.max(0, options.maxLabels, requiredCount);
  const occupied: GraphLabelBox[] = [];
  const placements: GraphLabelPlacement[] = [];
  const omittedRequired: number[] = [];
  for (const entry of ranked) {
    if (placements.length >= limit && !entry.required) continue;
    const candidate = candidateByIndex.get(entry.candidate.index);
    if (!candidate) continue;
    const offset = candidate.index * 4;
    const nodeX = projection.nodes[offset] ?? 0;
    const nodeY = projection.nodes[offset + 1] ?? 0;
    const radius = 8;
    const anchors = graphLabelAnchors(nodeX, nodeY, radius, candidate.width, candidate.height);
    const anchored = anchors.find((placement) => labelFits(placement.box, projection.viewport, inset)
      && occupied.every((box) => !boxesOverlap(placement.box, box, gap)));
    const fallback = anchored ?? (options.showOverflowLabels === false
      ? null
      : findFreeLabelCell(candidate, projection.viewport, occupied, inset, gap));
    if (!fallback) {
      if (entry.required) omittedRequired.push(candidate.index);
      continue;
    }
    occupied.push(fallback.box);
    placements.push({
      ...fallback,
      index: candidate.index,
      text: candidate.text,
      required: entry.required,
      depth: projection.nodes[offset + 2] ?? 1,
    });
  }
  return { placements, omittedRequired };
}

export function frameGraphCamera(positions: Float32Array, viewport: GraphViewport): GraphCamera {
  const bounds = graphSphereBounds(positions);
  const aspect = Math.max(1, viewport.width) / Math.max(1, viewport.height);
  const halfAngle = Math.atan(Math.tan(DEFAULT_SCENE_CAMERA.fov / 2) * Math.min(1, aspect));
  const distance = clamp(
    (bounds.radius / Math.sin(halfAngle)) * 1.18,
    90,
    DEFAULT_MAXIMUM_DISTANCE,
  );
  return { ...DEFAULT_SCENE_CAMERA, distance, target: [...bounds.center] };
}

/** Preserve manual framing, only dollying out if a visible selection would be lost. */
export function retainGraphSelectionOnResize(
  positions: Float32Array,
  camera: GraphCamera,
  selected: number,
  previous: GraphViewport,
  viewport: GraphViewport,
): GraphCamera {
  if (!validIndex(selected, positions.length / 3)) return camera;
  const point = positions.slice(selected * 3, selected * 3 + 3);
  const before = projectGraphScene(point, camera, previous).nodes;
  if (before[3] !== 1 || before[0] < 0 || before[0] > previous.width || before[1] < 0 || before[1] > previous.height) return camera;
  const after = projectGraphScene(point, camera, viewport).nodes;
  const inset = Math.min(12, viewport.width / 4, viewport.height / 4);
  if (after[3] === 1 && after[0] >= inset && after[0] <= viewport.width - inset && after[1] >= inset && after[1] <= viewport.height - inset) return camera;
  const offset = subtract3([point[0], point[1], point[2]], camera.target);
  const { right, up, forward } = cameraBasis(camera);
  const tangent = Math.tan(camera.fov / 2);
  const horizontal = tangent * viewport.width / Math.max(1, viewport.height) * (1 - 2 * inset / viewport.width);
  const vertical = tangent * (1 - 2 * inset / viewport.height);
  const requiredDepth = Math.max(Math.abs(dot3(offset, right)) / horizontal, Math.abs(dot3(offset, up)) / vertical);
  return { ...camera, target: [...camera.target], distance: Math.max(camera.distance, Math.min(DEFAULT_MAXIMUM_DISTANCE, requiredDepth - dot3(offset, forward))) };
}

export function focusGraphCamera(
  positions: Float32Array,
  index: number,
  viewport: GraphViewport,
  distance?: number,
): GraphCamera {
  if (!validIndex(index, positions.length / 3)) return frameGraphCamera(positions, viewport);
  const offset = index * 3;
  return {
    ...DEFAULT_SCENE_CAMERA,
    distance: distance ?? (viewport.width < 600 ? 470 : 350),
    target: [positions[offset] ?? 0, positions[offset + 1] ?? 0, positions[offset + 2] ?? 0],
  };
}

export function orbitGraphCamera(
  camera: GraphCamera,
  deltaX: number,
  deltaY: number,
  options: GraphPointerTransformOptions = {},
): GraphCamera {
  const sensitivity = options.orbitRadiansPerPixel ?? 0.0048;
  return {
    ...camera,
    yaw: camera.yaw - deltaX * sensitivity,
    pitch: clamp(camera.pitch - deltaY * sensitivity, options.minimumPitch ?? -1.43, options.maximumPitch ?? 1.43),
    target: [...camera.target],
  };
}

export function panGraphCamera(camera: GraphCamera, deltaX: number, deltaY: number, viewport: GraphViewport): GraphCamera {
  const { right, up } = cameraBasis(camera);
  const unitsPerPixel = (2 * camera.distance * Math.tan(camera.fov / 2)) / Math.max(1, viewport.height);
  return {
    ...camera,
    target: add3(
      subtract3(camera.target, scale3(right, deltaX * unitsPerPixel)),
      scale3(up, deltaY * unitsPerPixel),
    ),
  };
}

/** Relative zoom that preserves the target-plane world point below the pointer. */
export function zoomGraphCameraAt(
  camera: GraphCamera,
  viewport: GraphViewport,
  pointerX: number,
  pointerY: number,
  scale: number,
  options: GraphPointerTransformOptions = {},
): GraphCamera {
  const nextDistance = clamp(
    camera.distance / Math.max(0.05, scale),
    options.minimumDistance ?? DEFAULT_MINIMUM_DISTANCE,
    options.maximumDistance ?? DEFAULT_MAXIMUM_DISTANCE,
  );
  const oldUnits = (2 * camera.distance * Math.tan(camera.fov / 2)) / Math.max(1, viewport.height);
  const nextUnits = (2 * nextDistance * Math.tan(camera.fov / 2)) / Math.max(1, viewport.height);
  const deltaUnits = oldUnits - nextUnits;
  const { right, up } = cameraBasis(camera);
  const dx = pointerX - viewport.width / 2;
  const dy = pointerY - viewport.height / 2;
  return {
    ...camera,
    distance: nextDistance,
    target: add3(
      add3(camera.target, scale3(right, dx * deltaUnits)),
      scale3(up, -dy * deltaUnits),
    ),
  };
}

export function zoomGraphCameraFromWheel(
  camera: GraphCamera,
  viewport: GraphViewport,
  pointerX: number,
  pointerY: number,
  deltaY: number,
  deltaMode = 0,
  options: GraphPointerTransformOptions = {},
): GraphCamera {
  const pixels = deltaMode === 1 ? deltaY * 14 : deltaMode === 2 ? deltaY * viewport.height : deltaY;
  const bounded = clamp(pixels, -700, 700);
  return zoomGraphCameraAt(camera, viewport, pointerX, pointerY, Math.exp(-bounded * 0.0016), options);
}

export function graphKeyboardIntent(
  camera: GraphCamera,
  key: string,
  viewport: GraphViewport,
  shiftKey = false,
): GraphKeyboardIntent {
  if (key === "Escape") return { kind: "clear" };
  if (key.toLowerCase() === "o") return { kind: "frame" };
  if (key.toLowerCase() === "f") return { kind: "focus" };
  if (key === "+" || key === "=") {
    return { kind: "camera", camera: zoomGraphCameraAt(camera, viewport, viewport.width / 2, viewport.height / 2, 1.22) };
  }
  if (key === "-" || key === "_") {
    return { kind: "camera", camera: zoomGraphCameraAt(camera, viewport, viewport.width / 2, viewport.height / 2, 1 / 1.22) };
  }
  const step = shiftKey ? 0.16 : 0.055;
  const delta = key === "ArrowLeft" ? [-step, 0]
    : key === "ArrowRight" ? [step, 0]
      : key === "ArrowUp" ? [0, -step]
        : key === "ArrowDown" ? [0, step]
          : null;
  if (!delta) return { kind: "none" };
  return { kind: "camera", camera: orbitGraphCamera(camera, delta[0] / 0.0048, delta[1] / 0.0048) };
}

export function graphSphereBounds(positions: Float32Array): { center: [number, number, number]; radius: number } {
  if (!positions.length) return { center: [0, 0, 0], radius: 1 };
  const center: [number, number, number] = [0, 0, 0];
  const count = positions.length / 3;
  for (let index = 0; index < positions.length; index += 3) {
    center[0] += positions[index] ?? 0;
    center[1] += positions[index + 1] ?? 0;
    center[2] += positions[index + 2] ?? 0;
  }
  center[0] /= count;
  center[1] /= count;
  center[2] /= count;
  let radius = 1;
  for (let index = 0; index < positions.length; index += 3) {
    radius = Math.max(radius, Math.hypot(
      (positions[index] ?? 0) - center[0],
      (positions[index + 1] ?? 0) - center[1],
      (positions[index + 2] ?? 0) - center[2],
    ));
  }
  return { center, radius };
}

export function viewProjectionMatrix(camera: GraphCamera, viewport: GraphViewport): Float32Array {
  const eye = cameraEye(camera);
  const { up } = cameraBasis(camera);
  return multiply4(
    perspective(camera.fov, Math.max(1, viewport.width) / Math.max(1, viewport.height), camera.near, camera.far),
    lookAt(eye, camera.target, up),
  );
}

export function cameraBasis(camera: GraphCamera): {
  forward: [number, number, number];
  right: [number, number, number];
  up: [number, number, number];
} {
  const cosinePitch = Math.cos(camera.pitch);
  const forward = normalize3([
    -Math.sin(camera.yaw) * cosinePitch,
    -Math.sin(camera.pitch),
    -Math.cos(camera.yaw) * cosinePitch,
  ]);
  const right = normalize3(cross3(forward, [0, 1, 0]));
  const up = normalize3(cross3(right, forward));
  return { forward, right, up };
}

function cameraEye(camera: GraphCamera): [number, number, number] {
  return subtract3(camera.target, scale3(cameraBasis(camera).forward, camera.distance));
}

function perspective(fov: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fov / 2);
  const range = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, far * range, -1,
    0, 0, near * far * range, 0,
  ]);
}

function lookAt(eye: Vec3, target: Vec3, upHint: Vec3): Float32Array {
  const forward = normalize3(subtract3(target, eye));
  let right = normalize3(cross3(forward, upHint));
  if (length3(right) < EPSILON) right = [1, 0, 0];
  const up = cross3(right, forward);
  return new Float32Array([
    right[0], up[0], -forward[0], 0,
    right[1], up[1], -forward[1], 0,
    right[2], up[2], -forward[2], 0,
    -dot3(right, eye), -dot3(up, eye), dot3(forward, eye), 1,
  ]);
}

function multiply4(left: Float32Array, right: Float32Array): Float32Array {
  const output = new Float32Array(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      output[column * 4 + row] =
        (left[row] ?? 0) * (right[column * 4] ?? 0)
        + (left[4 + row] ?? 0) * (right[column * 4 + 1] ?? 0)
        + (left[8 + row] ?? 0) * (right[column * 4 + 2] ?? 0)
        + (left[12 + row] ?? 0) * (right[column * 4 + 3] ?? 0);
    }
  }
  return output;
}

function graphLabelAnchors(x: number, y: number, radius: number, width: number, height: number) {
  const gap = radius + 5;
  return [
    labelPlacement(x + gap, y + height * 0.36, width, height),
    labelPlacement(x - gap - width, y + height * 0.36, width, height),
    labelPlacement(x - width / 2, y - gap, width, height),
    labelPlacement(x - width / 2, y + gap + height, width, height),
  ];
}

function pickCell(x: number, y: number, cellSize: number, columns: number, rows: number): number {
  const column = clamp(Math.floor(x / cellSize), 0, columns - 1);
  const row = clamp(Math.floor(y / cellSize), 0, rows - 1);
  return row * columns + column;
}

function labelPlacement(x: number, y: number, width: number, height: number) {
  return { x, y, box: { left: x - 2, top: y - height, right: x + width + 3, bottom: y + 4 } };
}

function findFreeLabelCell(
  candidate: GraphLabelCandidate,
  viewport: GraphViewport,
  occupied: readonly GraphLabelBox[],
  inset: number,
  gap: number,
) {
  const strideX = Math.max(12, candidate.width + gap * 2);
  const strideY = Math.max(12, candidate.height + gap * 2);
  for (let top = inset; top + candidate.height + 4 <= viewport.height - inset; top += strideY) {
    for (let left = inset + 2; left + candidate.width + 3 <= viewport.width - inset; left += strideX) {
      const placement = labelPlacement(left, top + candidate.height, candidate.width, candidate.height);
      if (labelFits(placement.box, viewport, inset)
        && occupied.every((box) => !boxesOverlap(placement.box, box, gap))) return placement;
    }
  }
  return null;
}

function labelFits(box: GraphLabelBox, viewport: GraphViewport, inset: number): boolean {
  return box.left >= inset && box.right <= viewport.width - inset && box.top >= inset && box.bottom <= viewport.height - inset;
}

function boxesOverlap(left: GraphLabelBox, right: GraphLabelBox, gap: number): boolean {
  return left.left < right.right + gap
    && left.right + gap > right.left
    && left.top < right.bottom + gap
    && left.bottom + gap > right.top;
}

function buildAdjacency(topology: GraphTopologyArrays): Array<Array<{ node: number; edge: number }>> {
  const adjacency = Array.from({ length: topology.nodes.seeds.length }, () => [] as Array<{ node: number; edge: number }>);
  for (let edge = 0; edge < topology.edges.visualClasses.length; edge += 1) {
    const source = topology.edges.endpoints[edge * 2] ?? -1;
    const target = topology.edges.endpoints[edge * 2 + 1] ?? -1;
    if (!validIndex(source, adjacency.length) || !validIndex(target, adjacency.length) || source === target) continue;
    adjacency[source]?.push({ node: target, edge });
    adjacency[target]?.push({ node: source, edge });
  }
  return adjacency;
}

function remapStableIndex(index: number, previousKeys: Uint32Array, nextKeys: Uint32Array): number {
  if (!validIndex(index, previousKeys.length / 2)) return -1;
  const key = identityKeyAt(previousKeys, index);
  for (let nextIndex = 0; nextIndex < nextKeys.length / 2; nextIndex += 1) {
    if (identityKeyAt(nextKeys, nextIndex) === key) return nextIndex;
  }
  return -1;
}

function identityIndexQueues(values: Uint32Array): Map<string, number[]> {
  const queues = new Map<string, number[]>();
  for (let index = 0; index < values.length / 2; index += 1) {
    const value = identityKeyAt(values, index);
    const queue = queues.get(value);
    if (queue) queue.push(index);
    else queues.set(value, [index]);
  }
  return queues;
}

function identityKeyAt(values: Uint32Array, index: number): string {
  return `${values[index * 2] ?? 0}:${values[index * 2 + 1] ?? 0}`;
}

function allFinite(values: Float32Array): boolean {
  for (const value of values) if (!Number.isFinite(value)) return false;
  return true;
}

function validIndex(index: number, length: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < length;
}

function mix32(value: number): number {
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad);
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97);
  return (value ^ (value >>> 15)) >>> 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function add3(left: Vec3, right: Vec3): [number, number, number] {
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2]];
}

function subtract3(left: Vec3, right: Vec3): [number, number, number] {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function scale3(vector: Vec3, scalar: number): [number, number, number] {
  return [vector[0] * scalar, vector[1] * scalar, vector[2] * scalar];
}

function dot3(left: Vec3, right: Vec3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function cross3(left: Vec3, right: Vec3): [number, number, number] {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function length3(vector: Vec3): number {
  return Math.hypot(vector[0], vector[1], vector[2]);
}

function normalize3(vector: Vec3): [number, number, number] {
  const length = length3(vector);
  return length < EPSILON ? [0, 0, 0] : scale3(vector, 1 / length);
}
