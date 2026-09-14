import os from "node:os";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import type { GraphPresentationPlan } from "./graphPresentation";
import {
  GraphWebGpuRenderer,
  GraphWebGpuRendererError,
  packGraphPresentation,
  runtimeGraphGpu,
  type GraphGpuAdapter,
  type GraphGpuBuffer,
  type GraphGpuCanvasContext,
  type GraphGpuCommandEncoder,
  type GraphGpuCompilationMessage,
  type GraphGpuDevice,
  type GraphGpuQueue,
  type GraphGpuRenderPass,
  type GraphGpuRuntime,
  type GraphGpuUncapturedErrorEvent,
  type GraphWebGpuSurface,
} from "./graphWebGpuRenderer";

describe("WebGPU graph pixel adapter", () => {
  it("keeps WGSL locals clear of Chromium-reserved target syntax", () => {
    const source = readFileSync(new URL("./graphWebGpuRenderer.ts", import.meta.url), "utf8");
    expect(source).not.toContain("let target = edge.targetStyle.xy");
    expect(source).toContain("let destination = edge.targetStyle.xy");
  });

  it("detects only a complete actual-runtime WebGPU contract without flags", () => {
    const mock = gpuHarness();
    expect(runtimeGraphGpu({
      navigator: { gpu: mock.gpu },
      GPUBufferUsage: { COPY_DST: 8, UNIFORM: 64, STORAGE: 128 },
      GPUShaderStage: { VERTEX: 1, FRAGMENT: 2 },
    })).toMatchObject({ bufferUsage: { copyDestination: 8, uniform: 64, storage: 128 } });
    expect(runtimeGraphGpu({ navigator: { gpu: mock.gpu } })).toBeNull();
    expect(runtimeGraphGpu({ navigator: {} })).toBeNull();
  });

  it("packs the Canvas presentation contract without deriving new semantics", () => {
    const packed = packGraphPresentation(plan());
    const rounded = (values: Float32Array) => [...values].map((value) => Number(value.toFixed(4)));

    expect({
      nodeCount: packed.nodeCount,
      edgeCount: packed.edgeCount,
      clearColor: packed.clearColor,
      nodes: rounded(packed.nodes),
      edges: rounded(packed.edges),
    }).toMatchInlineSnapshot(`
      {
        "clearColor": [
          0,
          0,
          0,
          0,
        ],
        "edgeCount": 1,
        "edges": [
          80,
          70,
          160,
          55,
          260,
          100,
          1.5,
          0.45,
          0.2471,
          0.4902,
          0.4471,
          0.5647,
          2,
          3,
          9,
          0,
        ],
        "nodeCount": 2,
        "nodes": [
          80,
          70,
          0.8,
          4,
          0.2471,
          0.4902,
          0.4471,
          0.72,
          0.749,
          0.4078,
          0.251,
          0,
          0,
          0,
          1,
          7,
          260,
          100,
          0.2,
          7,
          0.749,
          0.4078,
          0.251,
          1,
          0.2471,
          0.4902,
          0.4471,
          0.94,
          1.5,
          3,
          2,
          11,
        ],
      }
    `);
    expect(plan().labels.placements).toHaveLength(1);
  });

  it("validates shaders, uploads plan pixels, and issues two instanced draws", async () => {
    const mock = gpuHarness();
    const renderer = await GraphWebGpuRenderer.create(mock.surface, mock.runtime, { now: sequenceClock([4, 7]) });
    renderer.resize({ width: 320, height: 180, dpr: 9 });
    const measurement = renderer.render(plan());

    expect(mock.surface).toMatchObject({ width: 960, height: 540, style: { width: "", height: "" } });
    expect(mock.context.configurations.at(-1)).toMatchObject({ alphaMode: "premultiplied", colorSpace: "srgb" });
    expect(mock.device.shaderLabels).toEqual(["exograph graph nodes", "exograph graph edges"]);
    expect(mock.device.queue.writes.map((write) => write.size)).toEqual([128, 64, 16]);
    expect(mock.device.pass.draws).toEqual([[48, 1], [6, 2]]);
    expect(mock.device.pass.descriptor.colorAttachments).toEqual([
      expect.objectContaining({ clearValue: { r: 0, g: 0, b: 0, a: 0 } }),
    ]);
    expect(measurement).toMatchObject({ cpuMilliseconds: 3, drawCalls: 2, nodes: 2, edges: 1, dpr: 3 });

    renderer.destroy();
    renderer.destroy();
    expect(mock.device.destroyCalls).toBe(1);
    expect(mock.context.unconfigureCalls).toBe(1);
    expect(mock.device.buffers.every((buffer) => buffer.destroyCalls === 1)).toBe(true);
  });

  it("reports device loss and uncaptured validation once", async () => {
    const mock = gpuHarness();
    const reportFailure = vi.fn();
    const renderer = await GraphWebGpuRenderer.create(mock.surface, mock.runtime, { reportFailure });

    mock.device.emitUncaptured(new Error("validation"));
    mock.device.resolveLost({ reason: "unknown", message: "gone" });
    await Promise.resolve();

    expect(reportFailure).toHaveBeenCalledTimes(1);
    expect(reportFailure).toHaveBeenCalledWith(expect.objectContaining({ code: "validation" }));
    renderer.destroy();
  });

  it("fails explicitly on shader compilation and destroys partial state", async () => {
    const messages: GraphGpuCompilationMessage[] = [{ type: "error", message: "bad wgsl", lineNum: 4, linePos: 2 }];
    const mock = gpuHarness({ compilationMessages: messages });

    await expect(GraphWebGpuRenderer.create(mock.surface, mock.runtime)).rejects.toMatchObject({
      code: "shader-compilation",
      message: expect.stringContaining("4:2 bad wgsl"),
    });
    expect(mock.device.destroyCalls).toBe(1);
    expect(mock.context.unconfigureCalls).toBe(1);
  });

  it("makes context and storage-limit failures visible", async () => {
    const unavailable = gpuHarness({ contextAvailable: false });
    await expect(GraphWebGpuRenderer.create(unavailable.surface, unavailable.runtime)).rejects.toMatchObject({ code: "context-unavailable" });
    expect(unavailable.device.destroyCalls).toBe(1);

    const limited = gpuHarness({ storageLimit: 127 });
    const reportFailure = vi.fn();
    const renderer = await GraphWebGpuRenderer.create(limited.surface, limited.runtime, { reportFailure });
    expect(() => renderer.render(plan())).toThrow(GraphWebGpuRendererError);
    expect(reportFailure).toHaveBeenCalledWith(expect.objectContaining({ code: "resource-limit" }));
    renderer.destroy();
  });

  it("records hardware-stamped live-adapter pack and queue-submit CPU cost separately from presentation compile", async () => {
    const hardware = os.cpus()[0]?.model ?? "unknown CPU";
    const scales = [
      { nodes: 10_000, edges: 50_000, samples: 16 },
      { nodes: 50_000, edges: 250_000, samples: 8 },
    ];
    for (const scale of scales) {
      const mock = gpuHarness({ storageLimit: 64 * 1024 * 1024 });
      const renderer = await GraphWebGpuRenderer.create(mock.surface, mock.runtime);
      renderer.resize({ width: 1_440, height: 900, dpr: 2 });
      const graphPlan = scalePlan(scale.nodes, scale.edges);
      renderer.render(graphPlan);
      const bufferCount = mock.device.buffers.length;
      const samples = Array.from({ length: scale.samples }, () => renderer.render(graphPlan).cpuMilliseconds);
      const ordered = [...samples].sort((left, right) => left - right);
      const measurement = {
        hardware,
        runtime: `${process.platform}/${process.arch} Node ${process.version}`,
        workload: "GraphWebGpuRenderer pack + mocked queue.writeBuffer/submit CPU",
        nodes: scale.nodes,
        edges: scale.edges,
        p50: percentile(ordered, 0.5),
        p95: percentile(ordered, 0.95),
        max: ordered.at(-1) ?? 0,
        samples: samples.length,
      };
      console.info("graph-webgpu-pack-submit-measurement", measurement);
      expect(mock.device.buffers).toHaveLength(bufferCount);
      expect(mock.device.queue.submissions).toHaveLength(scale.samples + 1);
      expect(measurement.p95).toBeGreaterThanOrEqual(0);
      renderer.destroy();
    }
  }, 20_000);
});

class MockBuffer implements GraphGpuBuffer {
  destroyCalls = 0;
  constructor(readonly descriptor: Record<string, unknown>) {}
  destroy() { this.destroyCalls += 1; }
}

class MockQueue implements GraphGpuQueue {
  writes: Array<{ buffer: GraphGpuBuffer; size: number }> = [];
  submissions: readonly (readonly unknown[])[] = [];
  writeBuffer(buffer: GraphGpuBuffer, _offset: number, _data: ArrayBufferLike, _dataOffset = 0, size = 0) {
    this.writes.push({ buffer, size });
  }
  submit(commands: readonly unknown[]) { this.submissions = [...this.submissions, commands]; }
}

class MockPass implements GraphGpuRenderPass {
  draws: Array<[number, number]> = [];
  descriptor: { colorAttachments: unknown[] } = { colorAttachments: [] };
  setBindGroup() {}
  setPipeline() {}
  draw(vertices: number, instances = 1) { this.draws.push([vertices, instances]); }
  end() {}
}

class MockEncoder implements GraphGpuCommandEncoder {
  constructor(private readonly pass: MockPass) {}
  beginRenderPass(descriptor: Record<string, unknown>) {
    this.pass.descriptor = descriptor as { colorAttachments: unknown[] };
    return this.pass;
  }
  finish() { return { command: true }; }
}

class MockDevice implements GraphGpuDevice {
  readonly queue = new MockQueue();
  readonly buffers: MockBuffer[] = [];
  readonly pass = new MockPass();
  readonly shaderLabels: string[] = [];
  readonly limits: { maxStorageBufferBindingSize: number };
  readonly lost: Promise<{ reason?: string; message?: string }>;
  destroyCalls = 0;
  private resolveDeviceLost!: (value: { reason?: string; message?: string }) => void;
  private uncapturedListener: ((event: GraphGpuUncapturedErrorEvent) => void) | null = null;

  constructor(
    storageLimit: number,
    private readonly compilationMessages: readonly GraphGpuCompilationMessage[],
  ) {
    this.limits = { maxStorageBufferBindingSize: storageLimit };
    this.lost = new Promise((resolve) => { this.resolveDeviceLost = resolve; });
  }

  createBuffer(descriptor: Record<string, unknown>) {
    const buffer = new MockBuffer(descriptor);
    this.buffers.push(buffer);
    return buffer;
  }
  createBindGroupLayout() { return { layout: true }; }
  createPipelineLayout() { return { pipelineLayout: true }; }
  createShaderModule(descriptor: Record<string, unknown>) {
    this.shaderLabels.push(String(descriptor.label));
    return { getCompilationInfo: async () => ({ messages: this.compilationMessages }) };
  }
  async createRenderPipelineAsync(descriptor: Record<string, unknown>) { return { descriptor }; }
  createBindGroup(descriptor: Record<string, unknown>) { return { descriptor }; }
  createCommandEncoder() { return new MockEncoder(this.pass); }
  pushErrorScope() {}
  async popErrorScope() { return null; }
  addEventListener(_type: "uncapturederror", listener: (event: GraphGpuUncapturedErrorEvent) => void) {
    this.uncapturedListener = listener;
  }
  removeEventListener(_type: "uncapturederror", listener: (event: GraphGpuUncapturedErrorEvent) => void) {
    if (this.uncapturedListener === listener) this.uncapturedListener = null;
  }
  destroy() { this.destroyCalls += 1; }
  emitUncaptured(error: unknown) { this.uncapturedListener?.({ error, preventDefault() {} }); }
  resolveLost(value: { reason?: string; message?: string }) { this.resolveDeviceLost(value); }
}

class MockContext implements GraphGpuCanvasContext {
  configurations: Record<string, unknown>[] = [];
  unconfigureCalls = 0;
  configure(descriptor: Record<string, unknown>) { this.configurations.push(descriptor); }
  getCurrentTexture() { return { createView: () => ({ view: true }) }; }
  unconfigure() { this.unconfigureCalls += 1; }
}

function gpuHarness(options: {
  compilationMessages?: readonly GraphGpuCompilationMessage[];
  contextAvailable?: boolean;
  storageLimit?: number;
} = {}) {
  const device = new MockDevice(options.storageLimit ?? 1_000_000, options.compilationMessages ?? []);
  const adapter: GraphGpuAdapter = { requestDevice: async () => device };
  const gpu = { requestAdapter: async () => adapter, getPreferredCanvasFormat: () => "bgra8unorm" };
  const context = new MockContext();
  const surface: GraphWebGpuSurface = {
    width: 1,
    height: 1,
    style: { width: "", height: "" },
    getContext: () => options.contextAvailable === false ? null : context,
  };
  const runtime: GraphGpuRuntime = {
    gpu,
    bufferUsage: { copyDestination: 8, uniform: 64, storage: 128 },
    shaderStage: { vertex: 1, fragment: 2 },
  };
  return { gpu, device, context, surface, runtime };
}

function sequenceClock(values: number[]) {
  let index = 0;
  return () => values[index++] ?? values.at(-1) ?? 0;
}

function plan(): GraphPresentationPlan {
  return {
    version: "0.1",
    topologyHash: "topology:parity",
    layoutEpochId: "layout:parity",
    viewport: { width: 320, height: 180 },
    profile: "exploration",
    clearColor: null,
    nodes: {
      indices: new Uint32Array([7, 11]),
      centers: new Float32Array([80, 70, 260, 100]),
      depths: new Float32Array([0.8, 0.2]),
      visualClasses: new Uint8Array([1, 2]),
      radii: new Float32Array([4, 7]),
      opacities: new Float32Array([0.72, 1]),
      fillColors: new Uint32Array([0x3f7d72ff, 0xbf6840ff]),
      strokeColors: new Uint32Array([0xbf6840ff, 0x3f7d72ff]),
      strokeWidths: new Float32Array([0, 1.5]),
      strokeOpacities: new Float32Array([0, 0.94]),
      emphasis: new Uint8Array([0, 3]),
    },
    edges: {
      indices: new Uint32Array([9]),
      curves: new Float32Array([80, 70, 160, 55, 260, 100]),
      depths: new Float32Array([0.45]),
      visualClasses: new Uint8Array([3]),
      widths: new Float32Array([1.5]),
      opacities: new Float32Array([0.72]),
      strokeColors: new Uint32Array([0x3f7d72c8]),
      emphasis: new Uint8Array([2]),
    },
    labels: {
      placements: [{ index: 11, text: "Selected", x: 270, y: 100, depth: 0.2, required: true, box: { left: 268, top: 86, right: 320, bottom: 104 } }],
      omittedRequired: [],
    },
    labelStyle: { font: "11px monospace", requiredFont: "600 11px monospace", color: 0x202522ff, requiredColor: 0x3f7d72ff, opacity: 0.9 },
  };
}

function scalePlan(nodeCount: number, edgeCount: number): GraphPresentationPlan {
  return {
    ...plan(),
    topologyHash: `topology:${nodeCount}:${edgeCount}`,
    nodes: {
      indices: Uint32Array.from({ length: nodeCount }, (_, index) => index),
      centers: new Float32Array(nodeCount * 2),
      depths: new Float32Array(nodeCount),
      visualClasses: new Uint8Array(nodeCount),
      radii: new Float32Array(nodeCount).fill(3),
      opacities: new Float32Array(nodeCount).fill(0.8),
      fillColors: new Uint32Array(nodeCount).fill(0x3f7d72ff),
      strokeColors: new Uint32Array(nodeCount).fill(0x3f7d72ff),
      strokeWidths: new Float32Array(nodeCount),
      strokeOpacities: new Float32Array(nodeCount),
      emphasis: new Uint8Array(nodeCount),
    },
    edges: {
      indices: Uint32Array.from({ length: edgeCount }, (_, index) => index),
      curves: new Float32Array(edgeCount * 6),
      depths: new Float32Array(edgeCount),
      visualClasses: new Uint8Array(edgeCount),
      widths: new Float32Array(edgeCount).fill(0.75),
      opacities: new Float32Array(edgeCount).fill(0.14),
      strokeColors: new Uint32Array(edgeCount).fill(0x3f7d72ff),
      emphasis: new Uint8Array(edgeCount),
    },
    labels: { placements: [], omittedRequired: [] },
  };
}

function percentile(ordered: readonly number[], quantile: number): number {
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * quantile))] ?? 0;
}
