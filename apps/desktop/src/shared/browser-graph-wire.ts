import type { GraphTopology } from "@exograph/core";

type GraphWire = Omit<GraphTopology, "nodes" | "edges"> & {
  nodes: { [K in keyof GraphTopology["nodes"]]: number[] };
  edges: { [K in keyof GraphTopology["edges"]]: number[] };
};
export function encodeBrowserGraph(graph: GraphTopology): GraphWire {
  return {
    ...graph,
    nodes: {
      identityKeys: Array.from(graph.nodes.identityKeys),
      seeds: Array.from(graph.nodes.seeds),
      groups: Array.from(graph.nodes.groups),
      degrees: Array.from(graph.nodes.degrees),
      visualClasses: Array.from(graph.nodes.visualClasses),
    },
    edges: {
      endpoints: Array.from(graph.edges.endpoints),
      visualClasses: Array.from(graph.edges.visualClasses),
    },
  };
}
export function decodeBrowserGraph(value: unknown): GraphTopology {
  if (!value || typeof value !== "object")
    throw new Error("Invalid browser graph.");
  const graph = value as GraphWire;
  if (
    !Number.isSafeInteger(graph.nodeCount) ||
    graph.nodeCount < 0 ||
    !Number.isSafeInteger(graph.edgeCount) ||
    graph.edgeCount < 0 ||
    !graph.nodes ||
    !graph.edges
  )
    throw new Error("Invalid browser graph counts.");
  const uint = (values: unknown, length: number, max: number): number[] => {
    if (
      !Array.isArray(values) ||
      values.length !== length ||
      values.some(
        (value) => !Number.isInteger(value) || value < 0 || value > max,
      )
    )
      throw new Error("Invalid browser graph buffer.");
    return values;
  };
  const u32 = (values: unknown, length: number) =>
    new Uint32Array(uint(values, length, 0xffffffff));
  const u8 = (values: unknown, length: number) =>
    new Uint8Array(uint(values, length, 255));
  return {
    ...graph,
    nodes: {
      identityKeys: u32(graph.nodes.identityKeys, graph.nodeCount * 2),
      seeds: u32(graph.nodes.seeds, graph.nodeCount),
      groups: u32(graph.nodes.groups, graph.nodeCount),
      degrees: u32(graph.nodes.degrees, graph.nodeCount),
      visualClasses: u8(graph.nodes.visualClasses, graph.nodeCount),
    },
    edges: {
      endpoints: u32(graph.edges.endpoints, graph.edgeCount * 2),
      visualClasses: u8(graph.edges.visualClasses, graph.edgeCount),
    },
  };
}
