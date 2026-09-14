import type { GraphPresentationPlan } from "./graphPresentation";

const NODE_FLOATS = 16;
const EDGE_FLOATS = 16;
const FRAME_BYTES = 16;
const EDGE_SEGMENTS = 8;
const MAXIMUM_DPR = 3;

export interface GraphGpuCompilationMessage {
  type: string;
  message: string;
  lineNum?: number;
  linePos?: number;
}

export interface GraphGpuShaderModule {
  getCompilationInfo?(): Promise<{ messages: readonly GraphGpuCompilationMessage[] }>;
}

export interface GraphGpuBuffer {
  destroy(): void;
}

export interface GraphGpuQueue {
  writeBuffer(buffer: GraphGpuBuffer, offset: number, data: ArrayBufferLike, dataOffset?: number, size?: number): void;
  submit(commands: readonly unknown[]): void;
}

export interface GraphGpuRenderPass {
  setBindGroup(index: number, bindGroup: unknown): void;
  setPipeline(pipeline: unknown): void;
  draw(vertexCount: number, instanceCount?: number): void;
  end(): void;
}

export interface GraphGpuCommandEncoder {
  beginRenderPass(descriptor: Record<string, unknown>): GraphGpuRenderPass;
  finish(): unknown;
}

export interface GraphGpuUncapturedErrorEvent {
  error?: unknown;
  preventDefault?(): void;
}

export interface GraphGpuDevice {
  readonly queue: GraphGpuQueue;
  readonly limits: { maxStorageBufferBindingSize: number };
  readonly lost: Promise<{ reason?: string; message?: string }>;
  createBuffer(descriptor: Record<string, unknown>): GraphGpuBuffer;
  createBindGroupLayout(descriptor: Record<string, unknown>): unknown;
  createPipelineLayout(descriptor: Record<string, unknown>): unknown;
  createShaderModule(descriptor: Record<string, unknown>): GraphGpuShaderModule;
  createRenderPipelineAsync(descriptor: Record<string, unknown>): Promise<unknown>;
  createBindGroup(descriptor: Record<string, unknown>): unknown;
  createCommandEncoder(descriptor?: Record<string, unknown>): GraphGpuCommandEncoder;
  pushErrorScope(filter: "validation"): void;
  popErrorScope(): Promise<unknown | null>;
  addEventListener?(type: "uncapturederror", listener: (event: GraphGpuUncapturedErrorEvent) => void): void;
  removeEventListener?(type: "uncapturederror", listener: (event: GraphGpuUncapturedErrorEvent) => void): void;
  destroy(): void;
}

export interface GraphGpuAdapter {
  requestDevice(): Promise<GraphGpuDevice>;
}

export interface GraphGpu {
  requestAdapter(options?: Record<string, unknown>): Promise<GraphGpuAdapter | null>;
  getPreferredCanvasFormat(): string;
}

export interface GraphGpuCanvasContext {
  configure(descriptor: Record<string, unknown>): void;
  getCurrentTexture(): { createView(): unknown };
  unconfigure?(): void;
}

export interface GraphWebGpuSurface {
  width: number;
  height: number;
  style?: { width: string; height: string };
  getContext(contextId: "webgpu"): GraphGpuCanvasContext | null;
}

export interface GraphGpuRuntime {
  gpu: GraphGpu;
  bufferUsage: { copyDestination: number; uniform: number; storage: number };
  shaderStage: { vertex: number; fragment: number };
}

export interface GraphWebGpuRendererOptions {
  reportFailure?: (error: GraphWebGpuRendererError) => void;
  now?: () => number;
}

export interface GraphWebGpuRenderMeasurement {
  cpuMilliseconds: number;
  drawCalls: number;
  nodes: number;
  edges: number;
  width: number;
  height: number;
  dpr: number;
}

export interface PackedGraphPresentation {
  nodes: Float32Array;
  edges: Float32Array;
  nodeCount: number;
  edgeCount: number;
  clearColor: readonly [number, number, number, number];
}

export class GraphWebGpuRendererError extends Error {
  readonly renderer = "webgpu";

  constructor(
    readonly code:
      | "adapter-unavailable"
      | "device-unavailable"
      | "context-unavailable"
      | "shader-compilation"
      | "validation"
      | "resource-limit"
      | "invalid-plan"
      | "draw-failed"
      | "device-lost",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GraphWebGpuRendererError";
  }
}

/** Resolve actual browser capability without enabling unsafe feature flags. */
export function runtimeGraphGpu(source: unknown = globalThis): GraphGpuRuntime | null {
  const root = source as {
    navigator?: { gpu?: unknown };
    GPUBufferUsage?: { COPY_DST?: unknown; UNIFORM?: unknown; STORAGE?: unknown };
    GPUShaderStage?: { VERTEX?: unknown; FRAGMENT?: unknown };
  };
  const gpu = root.navigator?.gpu;
  const bufferUsage = root.GPUBufferUsage;
  const shaderStage = root.GPUShaderStage;
  if (!isGraphGpu(gpu)
    || typeof bufferUsage?.COPY_DST !== "number"
    || typeof bufferUsage.UNIFORM !== "number"
    || typeof bufferUsage.STORAGE !== "number"
    || typeof shaderStage?.VERTEX !== "number"
    || typeof shaderStage.FRAGMENT !== "number") return null;
  return {
    gpu,
    bufferUsage: {
      copyDestination: bufferUsage.COPY_DST,
      uniform: bufferUsage.UNIFORM,
      storage: bufferUsage.STORAGE,
    },
    shaderStage: { vertex: shaderStage.VERTEX, fragment: shaderStage.FRAGMENT },
  };
}

/** Pure encoding shared by tests and the GPU upload path. Labels remain outside WebGPU. */
export function packGraphPresentation(plan: GraphPresentationPlan): PackedGraphPresentation {
  validatePlan(plan);
  const nodes = new Float32Array(plan.nodes.indices.length * NODE_FLOATS);
  const edges = new Float32Array(plan.edges.indices.length * EDGE_FLOATS);
  writePackedPresentation(plan, nodes, edges);
  return {
    nodes,
    edges,
    nodeCount: plan.nodes.indices.length,
    edgeCount: plan.edges.indices.length,
    clearColor: plan.clearColor === null ? [0, 0, 0, 0] : colorChannels(plan.clearColor, 1),
  };
}

/** Disposable WebGPU pixel adapter for an already-resolved presentation plan. */
export class GraphWebGpuRenderer {
  readonly kind = "webgpu" as const;
  private frameBuffer: GraphGpuBuffer | null = null;
  private nodeBuffer: GraphGpuBuffer | null = null;
  private edgeBuffer: GraphGpuBuffer | null = null;
  private bindGroupLayout: unknown = null;
  private bindGroup: unknown = null;
  private nodePipeline: unknown = null;
  private edgePipeline: unknown = null;
  private nodeCapacity = 0;
  private edgeCapacity = 0;
  private nodeStaging = new Float32Array(0);
  private edgeStaging = new Float32Array(0);
  private readonly frameData = new Float32Array(4);
  private width = 0;
  private height = 0;
  private dpr = 1;
  private destroyed = false;
  private failureReported = false;
  private readonly now: () => number;
  private readonly uncapturedErrorListener: (event: GraphGpuUncapturedErrorEvent) => void;

  private constructor(
    private readonly canvas: GraphWebGpuSurface,
    private readonly runtime: GraphGpuRuntime,
    private readonly device: GraphGpuDevice,
    private readonly context: GraphGpuCanvasContext,
    private readonly format: string,
    private readonly options: GraphWebGpuRendererOptions,
  ) {
    this.now = options.now ?? (() => performance.now());
    this.uncapturedErrorListener = (event) => {
      event.preventDefault?.();
      this.reportFailure(asRendererError("validation", "WebGPU reported an uncaptured error.", event.error));
    };
  }

  static async create(
    canvas: GraphWebGpuSurface,
    runtime: GraphGpuRuntime,
    options: GraphWebGpuRendererOptions = {},
  ): Promise<GraphWebGpuRenderer> {
    const adapter = await runtime.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new GraphWebGpuRendererError("adapter-unavailable", "No WebGPU adapter is available.");
    let device: GraphGpuDevice;
    try {
      device = await adapter.requestDevice();
    } catch (cause) {
      throw new GraphWebGpuRendererError("device-unavailable", "WebGPU device creation failed.", { cause });
    }
    let context: GraphGpuCanvasContext | null = null;
    try {
      context = canvas.getContext("webgpu");
    } catch (cause) {
      device.destroy();
      throw new GraphWebGpuRendererError("context-unavailable", "WebGPU canvas initialization failed.", { cause });
    }
    if (!context) {
      device.destroy();
      throw new GraphWebGpuRendererError("context-unavailable", "WebGPU canvas context is unavailable.");
    }
    const renderer = new GraphWebGpuRenderer(canvas, runtime, device, context, runtime.gpu.getPreferredCanvasFormat(), options);
    try {
      await renderer.initialize();
      return renderer;
    } catch (cause) {
      renderer.destroy();
      throw cause;
    }
  }

  resize(viewport: { width: number; height: number; dpr: number }): void {
    this.assertActive();
    const width = finiteDimension(viewport.width);
    const height = finiteDimension(viewport.height);
    const dpr = clamp(Number.isFinite(viewport.dpr) ? viewport.dpr : 1, 1, MAXIMUM_DPR);
    const physicalWidth = Math.max(1, Math.round(width * dpr));
    const physicalHeight = Math.max(1, Math.round(height * dpr));
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    if (this.canvas.width !== physicalWidth) this.canvas.width = physicalWidth;
    if (this.canvas.height !== physicalHeight) this.canvas.height = physicalHeight;
    // The host owns CSS geometry; renderers only size the backing store.
    this.context.configure({ device: this.device, format: this.format, alphaMode: "premultiplied", colorSpace: "srgb" });
  }

  render(plan: GraphPresentationPlan): GraphWebGpuRenderMeasurement {
    const started = this.now();
    try {
      this.assertActive();
      validatePlan(plan);
      if (finiteDimension(plan.viewport.width) !== this.width || finiteDimension(plan.viewport.height) !== this.height) {
        this.resize({ ...plan.viewport, dpr: this.dpr });
      }
      this.ensureStorage(plan.nodes.indices.length, plan.edges.indices.length);
      writePackedPresentation(plan, this.nodeStaging, this.edgeStaging);
      const nodeBytes = plan.nodes.indices.length * NODE_FLOATS * Float32Array.BYTES_PER_ELEMENT;
      const edgeBytes = plan.edges.indices.length * EDGE_FLOATS * Float32Array.BYTES_PER_ELEMENT;
      if (nodeBytes > 0 && this.nodeBuffer) {
        this.device.queue.writeBuffer(this.nodeBuffer, 0, this.nodeStaging.buffer, 0, nodeBytes);
      }
      if (edgeBytes > 0 && this.edgeBuffer) {
        this.device.queue.writeBuffer(this.edgeBuffer, 0, this.edgeStaging.buffer, 0, edgeBytes);
      }
      this.frameData[0] = this.width;
      this.frameData[1] = this.height;
      this.frameData[2] = 1 / this.width;
      this.frameData[3] = 1 / this.height;
      this.device.queue.writeBuffer(this.frameBuffer!, 0, this.frameData.buffer, 0, this.frameData.byteLength);

      const encoder = this.device.createCommandEncoder({ label: "exograph graph frame" });
      const pass = encoder.beginRenderPass({
        label: "exograph graph pixels",
        colorAttachments: [{
          view: this.context.getCurrentTexture().createView(),
          clearValue: clearValue(plan.clearColor),
          loadOp: "clear",
          storeOp: "store",
        }],
      });
      pass.setBindGroup(0, this.bindGroup);
      let drawCalls = 0;
      if (plan.edges.indices.length > 0) {
        pass.setPipeline(this.edgePipeline);
        pass.draw(EDGE_SEGMENTS * 6, plan.edges.indices.length);
        drawCalls += 1;
      }
      if (plan.nodes.indices.length > 0) {
        pass.setPipeline(this.nodePipeline);
        pass.draw(6, plan.nodes.indices.length);
        drawCalls += 1;
      }
      pass.end();
      this.device.queue.submit([encoder.finish()]);
      return {
        cpuMilliseconds: Math.max(0, this.now() - started),
        drawCalls,
        nodes: plan.nodes.indices.length,
        edges: plan.edges.indices.length,
        width: this.width,
        height: this.height,
        dpr: this.dpr,
      };
    } catch (cause) {
      const error = cause instanceof GraphWebGpuRendererError
        ? cause
        : new GraphWebGpuRendererError("draw-failed", "WebGPU graph drawing failed.", { cause });
      this.reportFailure(error);
      throw error;
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.device.removeEventListener?.("uncapturederror", this.uncapturedErrorListener);
    this.nodeBuffer?.destroy();
    this.edgeBuffer?.destroy();
    this.frameBuffer?.destroy();
    this.nodeBuffer = null;
    this.edgeBuffer = null;
    this.frameBuffer = null;
    this.bindGroup = null;
    this.context.unconfigure?.();
    this.device.destroy();
    this.nodeStaging = new Float32Array(0);
    this.edgeStaging = new Float32Array(0);
  }

  private async initialize(): Promise<void> {
    const { device } = this;
    device.pushErrorScope("validation");
    let initializationError: unknown = null;
    try {
      this.bindGroupLayout = device.createBindGroupLayout({
        label: "exograph graph presentation layout",
        entries: [
          { binding: 0, visibility: this.runtime.shaderStage.vertex | this.runtime.shaderStage.fragment, buffer: { type: "uniform", minBindingSize: FRAME_BYTES } },
          { binding: 1, visibility: this.runtime.shaderStage.vertex | this.runtime.shaderStage.fragment, buffer: { type: "read-only-storage", minBindingSize: NODE_FLOATS * 4 } },
          { binding: 2, visibility: this.runtime.shaderStage.vertex | this.runtime.shaderStage.fragment, buffer: { type: "read-only-storage", minBindingSize: EDGE_FLOATS * 4 } },
        ],
      });
      const pipelineLayout = device.createPipelineLayout({ label: "exograph graph pipeline layout", bindGroupLayouts: [this.bindGroupLayout] });
      const nodeModule = device.createShaderModule({ label: "exograph graph nodes", code: NODE_SHADER });
      const edgeModule = device.createShaderModule({ label: "exograph graph edges", code: EDGE_SHADER });
      await Promise.all([
        assertShaderCompiles(nodeModule, "node"),
        assertShaderCompiles(edgeModule, "edge"),
      ]);
      const blend = {
        color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
        alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
      };
      [this.edgePipeline, this.nodePipeline] = await Promise.all([
        device.createRenderPipelineAsync({
          label: "exograph graph edge pipeline",
          layout: pipelineLayout,
          vertex: { module: edgeModule, entryPoint: "vertexMain" },
          fragment: { module: edgeModule, entryPoint: "fragmentMain", targets: [{ format: this.format, blend }] },
          primitive: { topology: "triangle-list", cullMode: "none" },
        }),
        device.createRenderPipelineAsync({
          label: "exograph graph node pipeline",
          layout: pipelineLayout,
          vertex: { module: nodeModule, entryPoint: "vertexMain" },
          fragment: { module: nodeModule, entryPoint: "fragmentMain", targets: [{ format: this.format, blend }] },
          primitive: { topology: "triangle-list", cullMode: "none" },
        }),
      ]);
      this.frameBuffer = device.createBuffer({
        label: "exograph graph viewport",
        size: FRAME_BYTES,
        usage: this.runtime.bufferUsage.uniform | this.runtime.bufferUsage.copyDestination,
      });
      this.device.addEventListener?.("uncapturederror", this.uncapturedErrorListener);
      void this.device.lost.then((information) => {
        if (this.destroyed || information.reason === "destroyed") return;
        this.reportFailure(new GraphWebGpuRendererError(
          "device-lost",
          `WebGPU device lost${information.message ? `: ${information.message}` : "."}`,
        ));
      });
      this.ensureStorage(0, 0);
    } catch (cause) {
      initializationError = cause;
    }
    const validationError = await device.popErrorScope().catch((cause) => cause);
    if (initializationError) throw initializationError;
    if (validationError) {
      throw new GraphWebGpuRendererError("validation", "WebGPU renderer initialization failed validation.", { cause: validationError });
    }
  }

  private ensureStorage(nodeCount: number, edgeCount: number): void {
    const requiredNodes = Math.max(1, nodeCount);
    const requiredEdges = Math.max(1, edgeCount);
    let changed = false;
    if (requiredNodes > this.nodeCapacity) {
      this.nodeCapacity = growCapacity(requiredNodes);
      const bytes = this.nodeCapacity * NODE_FLOATS * Float32Array.BYTES_PER_ELEMENT;
      this.checkStorageLimit(bytes, "node");
      this.nodeBuffer?.destroy();
      this.nodeBuffer = this.device.createBuffer({
        label: "exograph graph nodes",
        size: align(bytes, 16),
        usage: this.runtime.bufferUsage.storage | this.runtime.bufferUsage.copyDestination,
      });
      this.nodeStaging = new Float32Array(this.nodeCapacity * NODE_FLOATS);
      changed = true;
    }
    if (requiredEdges > this.edgeCapacity) {
      this.edgeCapacity = growCapacity(requiredEdges);
      const bytes = this.edgeCapacity * EDGE_FLOATS * Float32Array.BYTES_PER_ELEMENT;
      this.checkStorageLimit(bytes, "edge");
      this.edgeBuffer?.destroy();
      this.edgeBuffer = this.device.createBuffer({
        label: "exograph graph edges",
        size: align(bytes, 16),
        usage: this.runtime.bufferUsage.storage | this.runtime.bufferUsage.copyDestination,
      });
      this.edgeStaging = new Float32Array(this.edgeCapacity * EDGE_FLOATS);
      changed = true;
    }
    if (changed || !this.bindGroup) {
      this.bindGroup = this.device.createBindGroup({
        label: "exograph graph presentation",
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.frameBuffer } },
          { binding: 1, resource: { buffer: this.nodeBuffer } },
          { binding: 2, resource: { buffer: this.edgeBuffer } },
        ],
      });
    }
  }

  private checkStorageLimit(bytes: number, kind: "node" | "edge"): void {
    if (bytes <= this.device.limits.maxStorageBufferBindingSize) return;
    throw new GraphWebGpuRendererError(
      "resource-limit",
      `Graph ${kind} presentation requires ${bytes} bytes; this device permits ${this.device.limits.maxStorageBufferBindingSize}.`,
    );
  }

  private reportFailure(error: GraphWebGpuRendererError): void {
    if (this.destroyed || this.failureReported) return;
    this.failureReported = true;
    this.options.reportFailure?.(error);
  }

  private assertActive(): void {
    if (this.destroyed) throw new GraphWebGpuRendererError("draw-failed", "WebGPU renderer has been destroyed.");
  }
}

function writePackedPresentation(plan: GraphPresentationPlan, nodes: Float32Array, edges: Float32Array): void {
  for (let index = 0; index < plan.nodes.indices.length; index += 1) {
    const target = index * NODE_FLOATS;
    nodes[target] = plan.nodes.centers[index * 2] ?? 0;
    nodes[target + 1] = plan.nodes.centers[index * 2 + 1] ?? 0;
    nodes[target + 2] = plan.nodes.depths[index] ?? 0;
    nodes[target + 3] = plan.nodes.radii[index] ?? 0;
    writeColor(nodes, target + 4, plan.nodes.fillColors[index] ?? 0, plan.nodes.opacities[index] ?? 0);
    writeColor(nodes, target + 8, plan.nodes.strokeColors[index] ?? 0, plan.nodes.strokeOpacities[index] ?? 0);
    nodes[target + 12] = plan.nodes.strokeWidths[index] ?? 0;
    nodes[target + 13] = plan.nodes.emphasis[index] ?? 0;
    nodes[target + 14] = plan.nodes.visualClasses[index] ?? 0;
    nodes[target + 15] = plan.nodes.indices[index] ?? 0;
  }
  for (let index = 0; index < plan.edges.indices.length; index += 1) {
    const target = index * EDGE_FLOATS;
    const source = index * 6;
    edges[target] = plan.edges.curves[source] ?? 0;
    edges[target + 1] = plan.edges.curves[source + 1] ?? 0;
    edges[target + 2] = plan.edges.curves[source + 2] ?? 0;
    edges[target + 3] = plan.edges.curves[source + 3] ?? 0;
    edges[target + 4] = plan.edges.curves[source + 4] ?? 0;
    edges[target + 5] = plan.edges.curves[source + 5] ?? 0;
    edges[target + 6] = plan.edges.widths[index] ?? 0;
    edges[target + 7] = plan.edges.depths[index] ?? 0;
    writeColor(edges, target + 8, plan.edges.strokeColors[index] ?? 0, plan.edges.opacities[index] ?? 0);
    edges[target + 12] = plan.edges.emphasis[index] ?? 0;
    edges[target + 13] = plan.edges.visualClasses[index] ?? 0;
    edges[target + 14] = plan.edges.indices[index] ?? 0;
    edges[target + 15] = 0;
  }
}

function writeColor(target: Float32Array, offset: number, color: number, opacity: number): void {
  target[offset] = (color >>> 24) / 255;
  target[offset + 1] = ((color >>> 16) & 0xff) / 255;
  target[offset + 2] = ((color >>> 8) & 0xff) / 255;
  target[offset + 3] = ((color & 0xff) / 255) * clamp(opacity, 0, 1);
}

function colorChannels(color: number, opacity: number): readonly [number, number, number, number] {
  return [
    (color >>> 24) / 255,
    ((color >>> 16) & 0xff) / 255,
    ((color >>> 8) & 0xff) / 255,
    ((color & 0xff) / 255) * clamp(opacity, 0, 1),
  ];
}

function clearValue(color: number | null): { r: number; g: number; b: number; a: number } {
  const channels = color === null ? [0, 0, 0, 0] as const : colorChannels(color, 1);
  return { r: channels[0], g: channels[1], b: channels[2], a: channels[3] };
}

function validatePlan(plan: GraphPresentationPlan): void {
  const nodes = plan.nodes.indices.length;
  const edges = plan.edges.indices.length;
  if (plan.nodes.centers.length !== nodes * 2
    || plan.nodes.depths.length !== nodes
    || plan.nodes.visualClasses.length !== nodes
    || plan.nodes.radii.length !== nodes
    || plan.nodes.opacities.length !== nodes
    || plan.nodes.fillColors.length !== nodes
    || plan.nodes.strokeColors.length !== nodes
    || plan.nodes.strokeWidths.length !== nodes
    || plan.nodes.strokeOpacities.length !== nodes
    || plan.nodes.emphasis.length !== nodes
    || plan.edges.curves.length !== edges * 6
    || plan.edges.depths.length !== edges
    || plan.edges.visualClasses.length !== edges
    || plan.edges.widths.length !== edges
    || plan.edges.opacities.length !== edges
    || plan.edges.strokeColors.length !== edges
    || plan.edges.emphasis.length !== edges
    || !Number.isFinite(plan.viewport.width)
    || !Number.isFinite(plan.viewport.height)
    || plan.viewport.width <= 0
    || plan.viewport.height <= 0) {
    throw new GraphWebGpuRendererError("invalid-plan", "WebGPU received an invalid graph presentation plan.");
  }
}

async function assertShaderCompiles(module: GraphGpuShaderModule, label: "node" | "edge"): Promise<void> {
  if (!module.getCompilationInfo) return;
  const information = await module.getCompilationInfo();
  const errors = information.messages.filter((message) => message.type === "error");
  if (errors.length === 0) return;
  const details = errors.map((message) => {
    const location = message.lineNum ? `${message.lineNum}:${message.linePos ?? 1}` : "unknown";
    return `${location} ${message.message}`;
  }).join("\n");
  throw new GraphWebGpuRendererError("shader-compilation", `${label} shader failed to compile:\n${details}`);
}

function asRendererError(code: "validation" | "draw-failed", message: string, cause: unknown): GraphWebGpuRendererError {
  return cause instanceof GraphWebGpuRendererError ? cause : new GraphWebGpuRendererError(code, message, { cause });
}

function isGraphGpu(value: unknown): value is GraphGpu {
  return typeof value === "object" && value !== null
    && typeof (value as { requestAdapter?: unknown }).requestAdapter === "function"
    && typeof (value as { getPreferredCanvasFormat?: unknown }).getPreferredCanvasFormat === "function";
}

function growCapacity(required: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(1, required)));
}

function finiteDimension(value: number): number {
  return Math.max(1, Math.round(Number.isFinite(value) ? value : 1));
}

function align(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

const NODE_SHADER = /* wgsl */`
struct Frame { viewport: vec4<f32> };
struct Node {
  position: vec4<f32>,
  fill: vec4<f32>,
  stroke: vec4<f32>,
  style: vec4<f32>,
};
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage, read> nodes: array<Node>;
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) local: vec2<f32>,
  @location(1) metrics: vec2<f32>,
  @location(2) fill: vec4<f32>,
  @location(3) stroke: vec4<f32>,
  @location(4) strokeWidth: f32,
};
@vertex fn vertexMain(@builtin(vertex_index) vertexIndex: u32, @builtin(instance_index) instanceIndex: u32) -> VertexOutput {
  let corners = array<vec2<f32>, 6>(
    vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(1.0, 1.0),
    vec2(-1.0, -1.0), vec2(1.0, 1.0), vec2(-1.0, 1.0)
  );
  let node = nodes[instanceIndex];
  let radius = max(0.0, node.position.w);
  let strokeWidth = max(0.0, node.style.x);
  let outer = radius + strokeWidth * 0.5 + 1.0;
  let corner = corners[vertexIndex];
  let center = vec2(
    node.position.x * frame.viewport.z * 2.0 - 1.0,
    1.0 - node.position.y * frame.viewport.w * 2.0
  );
  let offset = corner * outer * vec2(frame.viewport.z * 2.0, -frame.viewport.w * 2.0);
  var output: VertexOutput;
  output.position = vec4(center + offset, 0.0, 1.0);
  output.local = corner;
  output.metrics = vec2(radius, outer);
  output.fill = node.fill;
  output.stroke = node.stroke;
  output.strokeWidth = strokeWidth;
  return output;
}
@fragment fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let distance = length(input.local) * input.metrics.y;
  let aa = max(fwidth(distance), 0.65);
  let fillCoverage = 1.0 - smoothstep(input.metrics.x - aa, input.metrics.x + aa, distance);
  let halfStroke = input.strokeWidth * 0.5;
  let strokeInner = max(0.0, input.metrics.x - halfStroke);
  let strokeOuter = input.metrics.x + halfStroke;
  let strokeCoverage = select(
    0.0,
    smoothstep(strokeInner - aa, strokeInner + aa, distance)
      * (1.0 - smoothstep(strokeOuter - aa, strokeOuter + aa, distance)),
    input.strokeWidth > 0.0
  );
  let strokeAlpha = strokeCoverage * input.stroke.a;
  let fillAlpha = fillCoverage * input.fill.a * (1.0 - strokeAlpha);
  let alpha = strokeAlpha + fillAlpha;
  if (alpha <= 0.0001) { discard; }
  let rgb = input.stroke.rgb * strokeAlpha + input.fill.rgb * fillAlpha;
  return vec4(rgb, alpha);
}`;

const EDGE_SHADER = /* wgsl */`
struct Frame { viewport: vec4<f32> };
struct Edge {
  sourceControl: vec4<f32>,
  targetStyle: vec4<f32>,
  color: vec4<f32>,
  metadata: vec4<f32>,
};
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(2) var<storage, read> edges: array<Edge>;
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) side: f32,
  @location(1) outer: f32,
  @location(2) halfWidth: f32,
  @location(3) color: vec4<f32>,
};
fn curve(edge: Edge, t: f32) -> vec2<f32> {
  let source = edge.sourceControl.xy;
  let control = edge.sourceControl.zw;
  let destination = edge.targetStyle.xy;
  let a = mix(source, control, t);
  let b = mix(control, destination, t);
  return mix(a, b, t);
}
@vertex fn vertexMain(@builtin(vertex_index) vertexIndex: u32, @builtin(instance_index) instanceIndex: u32) -> VertexOutput {
  let edge = edges[instanceIndex];
  let segment = vertexIndex / 6u;
  let localVertex = vertexIndex % 6u;
  let startT = f32(segment) / ${EDGE_SEGMENTS}.0;
  let endT = f32(segment + 1u) / ${EDGE_SEGMENTS}.0;
  let along = array<f32, 6>(0.0, 1.0, 1.0, 0.0, 1.0, 0.0)[localVertex];
  let side = array<f32, 6>(-1.0, -1.0, 1.0, -1.0, 1.0, 1.0)[localVertex];
  let start = curve(edge, startT);
  let end = curve(edge, endT);
  let point = mix(start, end, along);
  let tangent = (end - start) / max(length(end - start), 0.001);
  let normal = vec2(-tangent.y, tangent.x);
  let halfWidth = max(0.25, edge.targetStyle.z * 0.5);
  let outer = halfWidth + 1.0;
  let pixel = point + normal * side * outer;
  var output: VertexOutput;
  output.position = vec4(
    pixel.x * frame.viewport.z * 2.0 - 1.0,
    1.0 - pixel.y * frame.viewport.w * 2.0,
    0.0,
    1.0
  );
  output.side = side;
  output.outer = outer;
  output.halfWidth = halfWidth;
  output.color = edge.color;
  return output;
}
@fragment fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let distance = abs(input.side) * input.outer;
  let aa = max(fwidth(distance), 0.65);
  let coverage = 1.0 - smoothstep(input.halfWidth - aa, input.halfWidth + aa, distance);
  let alpha = input.color.a * coverage;
  if (alpha <= 0.0001) { discard; }
  return vec4(input.color.rgb * alpha, alpha);
}`;
