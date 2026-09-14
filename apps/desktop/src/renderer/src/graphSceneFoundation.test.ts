import { describe, expect, it } from "vitest";

import {
  DEFAULT_SCENE_CAMERA,
  applyGraphLayoutFrame,
  applyGraphSceneLayoutFrame,
  buildGraphPickIndex,
  cameraBasis,
  createDeterministicLayout,
  createGraphLayoutInput,
  createGraphScene,
  emptyGraphSelection,
  focusGraphCamera,
  frameGraphCamera,
  graphKeyboardIntent,
  graphNodeScreenRadius,
  orbitGraphCamera,
  panGraphCamera,
  pickGraphSceneNode,
  planGraphLabels,
  projectGraphScene,
  reconcileGraphLayout,
  reconcileGraphScene,
  retainGraphSelectionOnResize,
  reconcileGraphSelection,
  selectGraphPath,
  validateGraphTopology,
  zoomGraphCameraAt,
  zoomGraphCameraFromWheel,
  type GraphCamera,
  type GraphLabelBox,
  type GraphTopologyArrays,
  type GraphViewport,
} from "./graphSceneFoundation";

const viewport: GraphViewport = { width: 800, height: 600 };

type TopologyOverrides = Omit<Partial<GraphTopologyArrays>, "nodes" | "edges"> & {
  nodes?: Partial<GraphTopologyArrays["nodes"]>;
  edges?: Partial<GraphTopologyArrays["edges"]>;
};

function topology(overrides: TopologyOverrides = {}): GraphTopologyArrays {
  const base: GraphTopologyArrays = {
    topologyHash: "fixture",
    layoutEpochId: "layout-fixture",
    seed: 17,
    nodes: {
      identityKeys: new Uint32Array([101, 1, 202, 2, 303, 3, 404, 4]),
      seeds: new Uint32Array([11, 22, 33, 44]),
      groups: new Uint32Array([0, 0, 1, 1]),
      degrees: new Uint32Array([1, 2, 2, 1]),
      visualClasses: new Uint8Array([0, 0, 1, 1]),
    },
    edges: {
      endpoints: new Uint32Array([0, 1, 1, 2, 2, 3]),
      visualClasses: new Uint8Array([0, 0, 1]),
    },
  };
  return {
    ...base,
    ...overrides,
    nodes: { ...base.nodes, ...overrides.nodes },
    edges: { ...base.edges, ...overrides.edges },
  };
}

function targetPlanePoint(camera: GraphCamera, pointX: number, pointY: number, size: GraphViewport) {
  const units = (2 * camera.distance * Math.tan(camera.fov / 2)) / size.height;
  const { right, up } = cameraBasis(camera);
  const dx = pointX - size.width / 2;
  const dy = pointY - size.height / 2;
  return camera.target.map((coordinate, axis) => coordinate + right[axis] * dx * units - up[axis] * dy * units);
}

function overlaps(left: GraphLabelBox, right: GraphLabelBox): boolean {
  return left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
}

function projectionState(nodes: Float32Array, size: GraphViewport = viewport) {
  return { viewport: size, nodes, pickIndex: buildGraphPickIndex(nodes, size) };
}

describe("renderer-neutral graph scene contract", () => {
  it("rejects malformed parallel topology arrays and invalid endpoints", () => {
    expect(validateGraphTopology(topology())).toEqual([]);
    expect(validateGraphTopology(topology({
      nodes: { groups: new Uint32Array(0) },
      edges: { endpoints: new Uint32Array([99, 1, 1, 2, 2, 3]) },
    }))).toEqual([
      "groups length must equal seeds length",
      "edge 0 endpoint is outside node bounds",
    ]);
  });

  it("rejects duplicate 64-bit identities while deliberately allowing layout-seed collisions", () => {
    expect(validateGraphTopology(topology({
      nodes: {
        identityKeys: new Uint32Array([101, 1, 101, 1, 303, 3, 404, 4]),
        seeds: new Uint32Array([7, 7, 7, 7]),
      },
    }))).toContain("node 1 duplicates a 64-bit identity key");
    expect(validateGraphTopology(topology({ nodes: { seeds: new Uint32Array([7, 7, 7, 7]) } }))).toEqual([]);
  });

  it("creates byte-for-byte deterministic positions from stable node seeds", () => {
    const first = createDeterministicLayout(topology());
    const second = createDeterministicLayout(topology());
    expect([...first.positions]).toEqual([...second.positions]);
    expect(first).toMatchObject({ topologyHash: "fixture", layoutEpochId: "layout-fixture", sequence: 0, settled: false });
    expect(new Set(first.positions).size).toBeGreaterThan(4);
  });

  it("preserves unchanged positions when stable nodes reorder and seeds new nodes deterministically", () => {
    const previousTopology = topology();
    const previous = createDeterministicLayout(previousTopology);
    previous.positions.set([101, 102, 103], 3);
    const nextTopology = topology({
      topologyHash: "fixture-next",
      layoutEpochId: "layout-next",
      nodes: {
        identityKeys: new Uint32Array([202, 2, 505, 5, 101, 1]),
        seeds: new Uint32Array([22, 55, 11]),
        groups: new Uint32Array([0, 2, 0]),
        degrees: new Uint32Array([2, 0, 1]),
        visualClasses: new Uint8Array([0, 2, 0]),
      },
      edges: { endpoints: new Uint32Array([0, 2]), visualClasses: new Uint8Array([0]) },
    });
    const next = reconcileGraphLayout(previousTopology, previous, nextTopology);
    expect([...next.positions.slice(0, 3)]).toEqual([101, 102, 103]);
    expect([...next.positions.slice(6, 9)]).toEqual([...previous.positions.slice(0, 3)]);
    expect([...next.positions.slice(3, 6)]).toEqual([...createDeterministicLayout(nextTopology).positions.slice(3, 6)]);
    expect([...next.continuityMask]).toEqual([1, 0, 1]);
  });

  it("uses 64-bit identity rather than colliding 32-bit layout seeds for continuity", () => {
    const previousTopology = topology({
      nodes: {
        identityKeys: new Uint32Array([10, 100, 20, 200]),
        seeds: new Uint32Array([7, 7]),
        groups: new Uint32Array([0, 0]),
        degrees: new Uint32Array([0, 0]),
        visualClasses: new Uint8Array([0, 0]),
      },
      edges: { endpoints: new Uint32Array(0), visualClasses: new Uint8Array(0) },
    });
    const previous = createDeterministicLayout(previousTopology);
    previous.positions.set([1, 2, 3, 8, 9, 10]);
    const nextTopology = topology({
      topologyHash: "reordered",
      layoutEpochId: "layout-reordered",
      nodes: {
        identityKeys: new Uint32Array([20, 200, 10, 100]),
        seeds: new Uint32Array([7, 7]),
        groups: new Uint32Array([0, 0]),
        degrees: new Uint32Array([0, 0]),
        visualClasses: new Uint8Array([0, 0]),
      },
      edges: { endpoints: new Uint32Array(0), visualClasses: new Uint8Array(0) },
    });
    expect([...reconcileGraphLayout(previousTopology, previous, nextTopology).positions]).toEqual([8, 9, 10, 1, 2, 3]);
  });

  it("creates an epoch-qualified worker input with explicit continuity anchors", () => {
    const graph = topology();
    const layout = createDeterministicLayout(graph);
    layout.continuityMask[1] = 1;
    expect(createGraphLayoutInput(graph, layout)).toMatchObject({
      topologyHash: "fixture",
      layoutEpochId: "layout-fixture",
      sequence: 1,
      nodeSeeds: graph.nodes.seeds,
      nodeGroups: graph.nodes.groups,
      edgeEndpoints: graph.edges.endpoints,
      continuityMask: layout.continuityMask,
    });
    expect(() => createGraphLayoutInput(topology({ topologyHash: "other" }), layout)).toThrow("exact topology and layout epoch");
  });

  it("accepts only a newer frame for the exact topology and layout epoch and copies its buffer", () => {
    const initial = createDeterministicLayout(topology());
    const positions = new Float32Array(initial.positions).fill(7);
    const accepted = applyGraphLayoutFrame(initial, {
      topologyHash: "fixture",
      layoutEpochId: "layout-fixture",
      sequence: 3,
      positions,
      settled: true,
    });
    expect(accepted.accepted).toBe(true);
    if (!accepted.accepted) throw new Error("expected accepted frame");
    positions[0] = 99;
    expect(accepted.state.positions[0]).toBe(7);
    expect(accepted.state).toMatchObject({ sequence: 3, settled: true });

    const stale = applyGraphLayoutFrame(accepted.state, { ...accepted.state, positions: accepted.state.positions });
    expect(stale).toMatchObject({ accepted: false, reason: "stale-layout-sequence" });
    expect(applyGraphLayoutFrame(initial, {
      ...initial,
      topologyHash: "other",
      sequence: 1,
    })).toMatchObject({ accepted: false, reason: "topology-mismatch" });
    expect(applyGraphLayoutFrame(initial, {
      ...initial,
      layoutEpochId: "other-layout",
      sequence: 1,
    })).toMatchObject({ accepted: false, reason: "layout-epoch-mismatch" });
    expect(applyGraphLayoutFrame(initial, {
      ...initial,
      sequence: Number.NaN,
    })).toMatchObject({ accepted: false, reason: "invalid-layout-sequence" });
    expect(applyGraphLayoutFrame(initial, {
      ...initial,
      sequence: 1,
      positions: new Float32Array(3),
    })).toMatchObject({ accepted: false, reason: "invalid-position-count" });
    const notFinite = new Float32Array(initial.positions);
    notFinite[0] = Number.NaN;
    expect(applyGraphLayoutFrame(initial, {
      ...initial,
      sequence: 1,
      positions: notFinite,
    })).toMatchObject({ accepted: false, reason: "non-finite-position" });
  });

  it("keeps selection and shortest paths as stable numeric scene state", () => {
    const selected = selectGraphPath(topology(), 0, 3, 2);
    expect(selected.selected).toBe(0);
    expect(selected.pathTarget).toBe(3);
    expect(selected.hovered).toBe(2);
    expect([...selected.pathNodes]).toEqual([1, 1, 1, 1]);
    expect([...selected.pathEdges]).toEqual([1, 1, 1]);

    const disconnected = selectGraphPath(topology({ edges: { endpoints: new Uint32Array(0), visualClasses: new Uint8Array(0) } }), 0, 3);
    expect([...disconnected.pathNodes]).toEqual([0, 0, 0, 0]);
  });

  it("remaps interaction by stable 64-bit identity across topology versions", () => {
    const previousTopology = topology();
    const previous = selectGraphPath(previousTopology, 1, 3, 0);
    const nextTopology = topology({
      topologyHash: "next",
      layoutEpochId: "layout-next",
      nodes: {
        identityKeys: new Uint32Array([404, 4, 202, 2, 606, 6]),
        seeds: new Uint32Array([44, 22, 66]),
        groups: new Uint32Array([1, 0, 2]),
        degrees: new Uint32Array([1, 1, 0]),
        visualClasses: new Uint8Array([1, 0, 0]),
      },
      edges: { endpoints: new Uint32Array([0, 1]), visualClasses: new Uint8Array([0]) },
    });
    const next = reconcileGraphSelection(previousTopology, previous, nextTopology);
    expect(next).toMatchObject({ selected: 1, pathTarget: 0, hovered: -1 });
    expect([...next.pathNodes]).toEqual([1, 1, 0]);
  });

  it("creates a complete scene without renderer state", () => {
    const scene = createGraphScene(topology(), viewport);
    expect(scene.topology).toBeDefined();
    expect(scene.projection.nodes).toHaveLength(16);
    expect(scene.interaction).toEqual(emptyGraphSelection(4, 3));
    expect(scene.projection.nodes.some((value) => Number.isFinite(value))).toBe(true);
  });

  it("advances a whole scene without resetting camera, surviving selection, or accepting stale worker frames", () => {
    const previous = createGraphScene(topology(), viewport);
    previous.camera = panGraphCamera(previous.camera, 30, -20, viewport);
    previous.interaction = selectGraphPath(previous.topology, 1, 3);
    const nextTopology = topology({ topologyHash: "next", layoutEpochId: "layout-next" });
    const next = reconcileGraphScene(previous, nextTopology);
    expect(next.camera).toEqual(previous.camera);
    expect(next.interaction).toMatchObject({ selected: 1, pathTarget: 3 });
    const applied = applyGraphSceneLayoutFrame(next, {
      ...next.layout,
      sequence: 1,
    });
    expect(applied.rejection).toBeUndefined();
    expect(applyGraphSceneLayoutFrame(applied.scene, {
      ...applied.scene.layout,
      sequence: 1,
    })).toEqual({ scene: applied.scene, rejection: "stale-layout-sequence" });
  });
});

describe("camera and controller transforms", () => {
  it("frames and focuses finite layout bounds", () => {
    const positions = new Float32Array([-100, -50, 0, 100, 50, 0]);
    const framed = frameGraphCamera(positions, viewport);
    expect(framed.distance).toBeGreaterThan(200);
    expect(framed.pitch).toBeCloseTo(0.46);
    expect(framed.target).toEqual([0, 0, 0]);
    expect(focusGraphCamera(positions, 1, viewport, 220)).toMatchObject({ distance: 220, target: [100, 50, 0] });
    expect(focusGraphCamera(positions, 7, viewport)).toEqual(framed);
  });

  it("opens with the full graph comfortably inside the viewport", () => {
    const positions = new Float32Array([
      -320, -220, -80,
      330, -190, 40,
      -280, 240, 70,
      300, 230, -50,
      0, 0, 120,
    ]);
    const projection = projectGraphScene(positions, frameGraphCamera(positions, viewport), viewport);
    for (let index = 0; index < positions.length / 3; index += 1) {
      const offset = index * 4;
      expect(projection.nodes[offset]).toBeGreaterThan(20);
      expect(projection.nodes[offset]).toBeLessThan(viewport.width - 20);
      expect(projection.nodes[offset + 1]).toBeGreaterThan(20);
      expect(projection.nodes[offset + 1]).toBeLessThan(viewport.height - 20);
    }
  });

  it("orbits and pans without mutating the input camera", () => {
    const camera: GraphCamera = { ...DEFAULT_SCENE_CAMERA, target: [0, 0, 0] };
    const orbited = orbitGraphCamera(camera, 20, -10);
    const panned = panGraphCamera(camera, 20, -10, viewport);
    expect(orbited.yaw).not.toBe(camera.yaw);
    expect(orbited.pitch).not.toBe(camera.pitch);
    expect(panned.target).not.toEqual(camera.target);
    expect(camera).toEqual(DEFAULT_SCENE_CAMERA);
  });

  it("maps direct-manipulation pan deltas to matching content motion on both axes", () => {
    const camera: GraphCamera = { ...DEFAULT_SCENE_CAMERA, target: [0, 0, 0] };
    const position = new Float32Array([0, 0, 0]);
    const before = projectGraphScene(position, camera, viewport).nodes;
    const panned = panGraphCamera(camera, 24, 18, viewport);
    const after = projectGraphScene(position, panned, viewport).nodes;

    expect(after[0]).toBeGreaterThan(before[0] ?? 0);
    expect(after[1]).toBeGreaterThan(before[1] ?? 0);
  });

  it("anchors adaptive zoom to the world point under the pointer", () => {
    const camera: GraphCamera = { ...DEFAULT_SCENE_CAMERA, target: [14, -20, 7] };
    const pointer = { x: 680, y: 145 };
    const before = targetPlanePoint(camera, pointer.x, pointer.y, viewport);
    const zoomed = zoomGraphCameraAt(camera, viewport, pointer.x, pointer.y, 2.4);
    const after = targetPlanePoint(zoomed, pointer.x, pointer.y, viewport);
    expect(zoomed.distance).toBeCloseTo(camera.distance / 2.4, 7);
    expect(after[0]).toBeCloseTo(before[0] ?? 0, 5);
    expect(after[1]).toBeCloseTo(before[1] ?? 0, 5);
    expect(after[2]).toBeCloseTo(before[2] ?? 0, 5);
    expect(camera.target).toEqual([14, -20, 7]);
  });

  it("normalizes wheel units and exposes deterministic keyboard intentions", () => {
    const camera: GraphCamera = { ...DEFAULT_SCENE_CAMERA, target: [0, 0, 0] };
    expect(zoomGraphCameraFromWheel(camera, viewport, 400, 300, -10, 1).distance).toBeLessThan(camera.distance);
    expect(graphKeyboardIntent(camera, "o", viewport)).toEqual({ kind: "frame" });
    expect(graphKeyboardIntent(camera, "f", viewport)).toEqual({ kind: "focus" });
    expect(graphKeyboardIntent(camera, "Escape", viewport)).toEqual({ kind: "clear" });
    expect(graphKeyboardIntent(camera, "x", viewport)).toEqual({ kind: "none" });
    expect(graphKeyboardIntent(camera, "+", viewport)).toMatchObject({ kind: "camera", camera: { distance: expect.any(Number) } });
    const left = graphKeyboardIntent(camera, "ArrowLeft", viewport);
    expect(left.kind === "camera" && left.camera.yaw).toBeGreaterThan(camera.yaw);
  });
});

describe("picking and focal labels", () => {
  it("picks the frontmost visible radius hit instead of the nearest center", () => {
    const graph = topology({ nodes: { degrees: new Uint32Array([1, 120, 1, 1]) } });
    const projection = projectionState(new Float32Array([
      400, 300, 0.7, 1,
      408, 300, 0.2, 1,
      400, 300, 0.1, 0,
      700, 500, 0.1, 1,
    ]));
    expect(pickGraphSceneNode(graph, projection, DEFAULT_SCENE_CAMERA, 400, 300)).toBe(1);
    expect(pickGraphSceneNode(graph, projection, DEFAULT_SCENE_CAMERA, 430, 300, { pointer: "fine", finePadding: 0 })).toBe(-1);
    expect(pickGraphSceneNode(graph, projection, DEFAULT_SCENE_CAMERA, 430, 300, { pointer: "coarse" })).toBe(1);
    expect(graphNodeScreenRadius(120, 0, DEFAULT_SCENE_CAMERA)).toBeGreaterThan(graphNodeScreenRadius(1, 0, DEFAULT_SCENE_CAMERA));
  });

  it("projects hidden nodes without making them pickable", () => {
    const camera: GraphCamera = { ...DEFAULT_SCENE_CAMERA, target: [0, 0, 0] };
    const projection = projectGraphScene(new Float32Array([0, 0, 0, 0, 0, 100_000]), camera, viewport);
    expect(projection.nodes[3]).toBe(1);
    expect(projection.nodes[7]).toBe(0);
    const graph = topology({
      nodes: {
        identityKeys: new Uint32Array([1, 1, 2, 2]), seeds: new Uint32Array([1, 2]), groups: new Uint32Array(2), degrees: new Uint32Array(2), visualClasses: new Uint8Array(2),
      },
      edges: { endpoints: new Uint32Array(0), visualClasses: new Uint8Array(0) },
    });
    expect(pickGraphSceneNode(graph, projection, camera, projection.nodes[4] ?? 0, projection.nodes[5] ?? 0)).not.toBe(1);
  });

  it("plans a bounded deterministic collision-free label set with selected and path labels", () => {
    const graph = topology();
    const projection = projectionState(new Float32Array([
      100, 100, 0.3, 1,
      104, 102, 0.4, 1,
      108, 104, 0.5, 1,
      320, 170, 0.6, 1,
    ]), { width: 420, height: 260 });
    const interaction = selectGraphPath(graph, 0, 2);
    const candidates = [0, 1, 2, 3].map((index) => ({ index, text: `Node ${index}`, width: 58, height: 14 }));
    const first = planGraphLabels(graph, projection, interaction, candidates, { maxLabels: 2 });
    const second = planGraphLabels(graph, projection, interaction, candidates, { maxLabels: 2 });
    expect(first).toEqual(second);
    expect(first.omittedRequired).toEqual([]);
    expect(first.placements.map(({ index }) => index).sort()).toEqual([0, 1, 2]);
    for (let left = 0; left < first.placements.length; left += 1) {
      for (let right = left + 1; right < first.placements.length; right += 1) {
        expect(overlaps(first.placements[left]!.box, first.placements[right]!.box)).toBe(false);
      }
    }
  });

  it("can omit detached overflow while keeping labels beside nodes and reporting hidden selection labels", () => {
    const graph = topology();
    const projection = projectionState(new Float32Array([
      210, 160, 0.3, 1,
      0, 0, 0.3, 1,
      0, 0, 0.3, 1,
      0, 0, 0.3, 1,
    ]), { width: 420, height: 320 });
    const interaction = emptyGraphSelection(4, graph.edges.endpoints.length / 2);
    interaction.selected = 1;
    const candidates = [0, 1, 2, 3].map(index => ({ index, text: `Node ${index}`, width: 80, height: 14 }));
    const shown = planGraphLabels(graph, projection, interaction, candidates, { maxLabels: 4 });
    const hidden = planGraphLabels(graph, projection, interaction, candidates, { maxLabels: 4, showOverflowLabels: false });
    expect(shown.placements).toHaveLength(4);
    expect(hidden.placements).toEqual([shown.placements.find(placement => placement.index === 0)]);
    expect(hidden.omittedRequired).toEqual([1]);
    expect(interaction.selected).toBe(1);
  });

  it("reports a required label that physically cannot fit instead of overlapping", () => {
    const graph = topology({
      nodes: {
        identityKeys: new Uint32Array([1, 1]), seeds: new Uint32Array([1]), groups: new Uint32Array([0]), degrees: new Uint32Array([1]), visualClasses: new Uint8Array([0]),
      },
      edges: { endpoints: new Uint32Array(0), visualClasses: new Uint8Array(0) },
    });
    const interaction = emptyGraphSelection(1, 0);
    interaction.selected = 0;
    const plan = planGraphLabels(
      graph,
      projectionState(new Float32Array([20, 15, 0.2, 1]), { width: 40, height: 30 }),
      interaction,
      [{ index: 0, text: "Too wide", width: 100, height: 20 }],
      { maxLabels: 1 },
    );
    expect(plan.placements).toEqual([]);
    expect(plan.omittedRequired).toEqual([0]);
  });
});

describe("large numeric scene contract", () => {
  it("builds and projects 10k nodes without object-per-node scene state", () => {
    const count = 10_000;
    const graph = topology({
      topologyHash: "10k",
      nodes: {
        identityKeys: Uint32Array.from({ length: count * 2 }, (_, index) => index),
        seeds: Uint32Array.from({ length: count }, (_, index) => index + 1),
        groups: Uint32Array.from({ length: count }, (_, index) => index % 12),
        degrees: Uint32Array.from({ length: count }, (_, index) => index % 32),
        visualClasses: new Uint8Array(count),
      },
      edges: { endpoints: new Uint32Array(0), visualClasses: new Uint8Array(0) },
    });
    const started = performance.now();
    const layout = createDeterministicLayout(graph);
    const projected = projectGraphScene(layout.positions, frameGraphCamera(layout.positions, viewport), viewport);
    const elapsed = performance.now() - started;
    expect(projected.nodes).toHaveLength(count * 4);
    expect(elapsed).toBeLessThan(500);
  });
});


describe("narrow graph framing", () => {
  it.each([{ width: 230, height: 800 }, { width: 200, height: 1000 }])("fits horizontal extents in $width by $height", (viewport) => {
    const { right } = cameraBasis(DEFAULT_SCENE_CAMERA);
    const positions = new Float32Array([...right.map(value => -1000 * value), ...right.map(value => 1000 * value)]);
    const projected = projectGraphScene(positions, frameGraphCamera(positions, viewport), viewport);
    for (let index = 0; index < 2; index += 1) {
      expect(projected.nodes[index * 4]).toBeGreaterThan(12);
      expect(projected.nodes[index * 4]).toBeLessThan(viewport.width - 12);
      expect(projected.nodes[index * 4 + 3]).toBe(1);
    }
  });
});


it("retains a valid manual camera when selection containment would exceed the zoom limit", () => {
  const camera = { ...DEFAULT_SCENE_CAMERA, distance: 30_000 };
  const { right } = cameraBasis(camera);
  const positions = new Float32Array(right.map(value => value * 10_000));
  const before = { width: 800, height: 800 };
  const after = { width: 230, height: 800 };
  expect(projectGraphScene(positions, camera, before).nodes[3]).toBe(1);
  const resized = retainGraphSelectionOnResize(positions, camera, 0, before, after);
  expect(resized).toEqual(camera);
  expect(projectGraphScene(new Float32Array(camera.target), resized, after).nodes[3]).toBe(1);
});
