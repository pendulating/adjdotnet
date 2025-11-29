import { GraphState } from './graph-state';
import { mat4 } from 'wgpu-matrix';
import { TileCache, tileBounds, getVisibleTiles, TILE_PROVIDERS } from './tile-layer';
import type { TileCoord, TileProvider } from './tile-layer';
import type { Selection } from './editor-state';

const TILE_SHADER = `
struct Camera {
  projection: mat4x4f,
  view: mat4x4f,
  viewport: vec2f,
  scale: f32,
  _pad: f32,
};

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var tileSampler: sampler;
@group(0) @binding(2) var tileTexture: texture_2d<f32>;

struct VertexInput {
  @location(0) corner: vec2f,
  @location(1) tileBoundsMin: vec2f,
  @location(2) tileBoundsMax: vec2f,
};

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  let worldX = mix(input.tileBoundsMin.x, input.tileBoundsMax.x, input.corner.x);
  let worldY = mix(input.tileBoundsMin.y, input.tileBoundsMax.y, input.corner.y);
  
  var out: VertexOutput;
  out.position = camera.projection * camera.view * vec4f(worldX, worldY, 0.0, 1.0);
  out.uv = vec2f(input.corner.x, 1.0 - input.corner.y);
  return out;
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSample(tileTexture, tileSampler, uv);
}
`;

const NODE_SHADER = `
struct Camera {
  projection: mat4x4f,
  view: mat4x4f,
  viewport: vec2f,
  scale: f32,
  _pad: f32,
};

@group(0) @binding(0) var<uniform> camera: Camera;

struct Node {
  pos: vec2f,
  vel: vec2f,
};

@group(0) @binding(1) var<storage, read> nodes: array<Node>;
@group(0) @binding(2) var<storage, read> selectionMask: array<u32>;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) selected: u32,
};

@vertex
fn vs_main(
  @builtin(vertex_index) vIdx: u32,
  @builtin(instance_index) iIdx: u32
) -> VertexOutput {
  let node = nodes[iIdx];
  
  // Check if this node is selected (bit-packed, 32 nodes per u32)
  let wordIdx = iIdx / 32u;
  let bitIdx = iIdx % 32u;
  let isSelected = (selectionMask[wordIdx] >> bitIdx) & 1u;
  
  var quadPos: array<vec2f, 6> = array<vec2f, 6>(
    vec2f(-1.0, -1.0),
    vec2f( 1.0, -1.0),
    vec2f(-1.0,  1.0),
    vec2f(-1.0,  1.0),
    vec2f( 1.0, -1.0),
    vec2f( 1.0,  1.0),
  );
  
  var quadUV: array<vec2f, 6> = array<vec2f, 6>(
    vec2f(0.0, 0.0),
    vec2f(1.0, 0.0),
    vec2f(0.0, 1.0),
    vec2f(0.0, 1.0),
    vec2f(1.0, 0.0),
    vec2f(1.0, 1.0),
  );
  
  let localPos = quadPos[vIdx];
  var nodeSize = 8.0 / camera.scale;
  // Make selected nodes slightly larger
  if (isSelected == 1u) {
    nodeSize = 12.0 / camera.scale;
  }
  
  let worldPos = vec4f(node.pos + localPos * nodeSize, 0.0, 1.0);
  
  var out: VertexOutput;
  out.position = camera.projection * camera.view * worldPos;
  out.uv = quadUV[vIdx];
  out.selected = isSelected;
  return out;
}

@fragment
fn fs_main(@location(0) uv: vec2f, @location(1) @interpolate(flat) selected: u32) -> @location(0) vec4f {
  let d = distance(uv, vec2f(0.5));
  if (d > 0.5) {
    discard;
  }
  let alpha = smoothstep(0.5, 0.35, d);
  
  // Selected nodes are orange, normal nodes are blue
  if (selected == 1u) {
    return vec4f(1.0, 0.6, 0.2, alpha); // Orange
  }
  return vec4f(0.24, 0.63, 0.95, alpha); // Blue
}
`;

const EDGE_SHADER = `
struct Camera {
  projection: mat4x4f,
  view: mat4x4f,
  viewport: vec2f,
  scale: f32,
  _pad: f32,
};

@group(0) @binding(0) var<uniform> camera: Camera;

struct Node {
  pos: vec2f,
  vel: vec2f,
};

@group(0) @binding(1) var<storage, read> nodes: array<Node>;

struct Edge {
  source: u32,
  dest: u32,
};

@group(0) @binding(2) var<storage, read> edges: array<Edge>;
@group(0) @binding(3) var<storage, read> edgeSelectionMask: array<u32>;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) selected: u32,
};

@vertex
fn vs_main(@builtin(vertex_index) vIdx: u32) -> VertexOutput {
  let edgeIdx = vIdx / 2u;
  let isDest = (vIdx % 2u) == 1u;
  
  // Check if this edge is selected
  let wordIdx = edgeIdx / 32u;
  let bitIdx = edgeIdx % 32u;
  let isSelected = (edgeSelectionMask[wordIdx] >> bitIdx) & 1u;
  
  let edge = edges[edgeIdx];
  let nodeIdx = select(edge.source, edge.dest, isDest);
  let node = nodes[nodeIdx];
  
  let worldPos = vec4f(node.pos, 0.0, 1.0);
  
  var out: VertexOutput;
  out.position = camera.projection * camera.view * worldPos;
  out.selected = isSelected;
  return out;
}

@fragment
fn fs_main(@location(0) @interpolate(flat) selected: u32) -> @location(0) vec4f {
  if (selected == 1u) {
    return vec4f(1.0, 0.6, 0.2, 0.9); // Orange selected
  }
  return vec4f(0.4, 0.4, 0.45, 0.6); // Gray normal
}
`;

// Preview edge shader (for edge creation mode)
const PREVIEW_EDGE_SHADER = `
struct Camera {
  projection: mat4x4f,
  view: mat4x4f,
  viewport: vec2f,
  scale: f32,
  _pad: f32,
};

@group(0) @binding(0) var<uniform> camera: Camera;

struct PreviewEdge {
  start: vec2f,
  end: vec2f,
};

@group(0) @binding(1) var<uniform> previewEdge: PreviewEdge;

@vertex
fn vs_main(@builtin(vertex_index) vIdx: u32) -> @builtin(position) vec4f {
  let pos = select(previewEdge.start, previewEdge.end, vIdx == 1u);
  return camera.projection * camera.view * vec4f(pos, 0.0, 1.0);
}

@fragment
fn fs_main() -> @location(0) vec4f {
  return vec4f(0.2, 0.9, 0.4, 0.8); // Green preview
}
`;

export interface CameraState {
  centerX: number;
  centerY: number;
  zoom: number;
}

export class WebGPURenderer {
  private canvas: HTMLCanvasElement;
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private format: GPUTextureFormat = 'bgra8unorm';

  private graphState: GraphState;
  private lastGraphVersion: number = -1;

  // Pipelines
  private nodePipeline: GPURenderPipeline | null = null;
  private edgePipeline: GPURenderPipeline | null = null;
  private tilePipeline: GPURenderPipeline | null = null;
  private previewEdgePipeline: GPURenderPipeline | null = null;

  // Buffers
  private nodeBuffer: GPUBuffer | null = null;
  private edgeBuffer: GPUBuffer | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private nodeSelectionBuffer: GPUBuffer | null = null;
  private edgeSelectionBuffer: GPUBuffer | null = null;
  private previewEdgeBuffer: GPUBuffer | null = null;
  private tileBindGroupLayout: GPUBindGroupLayout | null = null;

  // Bind Groups
  private nodeBindGroup: GPUBindGroup | null = null;
  private edgeBindGroup: GPUBindGroup | null = null;
  private previewEdgeBindGroup: GPUBindGroup | null = null;

  // Selection state (bit-packed)
  private nodeSelectionMask: Uint32Array = new Uint32Array(0);
  private edgeSelectionMask: Uint32Array = new Uint32Array(0);

  // Preview edge (for addEdge mode)
  private previewEdgeVisible = false;
  private previewEdgeStart = { x: 0, y: 0 };
  private previewEdgeEnd = { x: 0, y: 0 };

  // Tile Layer
  private tileCache: TileCache;
  private tileTextures = new Map<string, GPUTexture>();
  private tileSampler: GPUSampler | null = null;
  private basemapEnabled = true;
  private worldCenterX = 0;
  private worldCenterY = 0;

  // Camera
  public camera: CameraState = { centerX: 0, centerY: 0, zoom: 1 };

  // Animation
  private frameId: number = 0;
  private onStatsUpdate: ((stats: { fps: number }) => void) | null = null;
  private lastFrameTime = 0;
  private frameCount = 0;
  private fps = 0;

  constructor(canvas: HTMLCanvasElement, graphState: GraphState) {
    this.canvas = canvas;
    this.graphState = graphState;
    this.tileCache = new TileCache(TILE_PROVIDERS.cartoDark);
  }

  public setWorldCenter(x: number, y: number) {
    this.worldCenterX = x;
    this.worldCenterY = y;
  }

  public setBasemapEnabled(enabled: boolean) {
    this.basemapEnabled = enabled;
  }

  public setTileProvider(provider: TileProvider) {
    this.tileCache.setProvider(provider);
    this.tileTextures.forEach(tex => tex.destroy());
    this.tileTextures.clear();
  }

  public setStatsCallback(cb: (stats: { fps: number }) => void) {
    this.onStatsUpdate = cb;
  }

  public async init() {
    if (!navigator.gpu) {
      throw new Error("WebGPU not supported on this browser.");
    }

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error("No WebGPU adapter found.");
    }

    this.device = await adapter.requestDevice();
    this.context = this.canvas.getContext('webgpu') as GPUCanvasContext;

    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: 'premultiplied',
    });

    await this.initPipelines();
    await this.initBuffers();
    
    this.render();
  }

  private async initPipelines() {
    if (!this.device) return;

    // Tile bind group layout
    this.tileBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });

    // Tile Pipeline
    const tileModule = this.device.createShaderModule({ code: TILE_SHADER });
    this.tilePipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [this.tileBindGroupLayout],
      }),
      vertex: {
        module: tileModule,
        entryPoint: 'vs_main',
        buffers: [{
          arrayStride: 24,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' },
            { shaderLocation: 1, offset: 8, format: 'float32x2' },
            { shaderLocation: 2, offset: 16, format: 'float32x2' },
          ],
        }],
      },
      fragment: {
        module: tileModule,
        entryPoint: 'fs_main',
        targets: [{ format: this.format }],
      },
      primitive: { topology: 'triangle-list' },
    });

    this.tileSampler = this.device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    // Node Pipeline
    const nodeModule = this.device.createShaderModule({ code: NODE_SHADER });
    this.nodePipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: nodeModule,
        entryPoint: 'vs_main',
      },
      fragment: {
        module: nodeModule,
        entryPoint: 'fs_main',
        targets: [{
          format: this.format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
    });

    // Edge Pipeline
    const edgeModule = this.device.createShaderModule({ code: EDGE_SHADER });
    this.edgePipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: edgeModule,
        entryPoint: 'vs_main',
      },
      fragment: {
        module: edgeModule,
        entryPoint: 'fs_main',
        targets: [{
          format: this.format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'line-list' },
    });

    // Preview Edge Pipeline
    const previewModule = this.device.createShaderModule({ code: PREVIEW_EDGE_SHADER });
    this.previewEdgePipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: previewModule,
        entryPoint: 'vs_main',
      },
      fragment: {
        module: previewModule,
        entryPoint: 'fs_main',
        targets: [{
          format: this.format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'line-list' },
    });
  }

  private async initBuffers() {
    if (!this.device) return;
    this.syncBuffers();
  }

  /**
   * Re-upload graph data to GPU buffers after mutations
   */
  public syncBuffers() {
    if (!this.device || !this.nodePipeline || !this.edgePipeline || !this.previewEdgePipeline) return;

    const { nodeX, nodeY, edgeSource, edgeTarget } = this.graphState.getBuffers();
    const nodeCount = this.graphState.nodeCount;
    const edgeCount = this.graphState.edgeCount;

    // Node buffer: vec2f pos + vec2f vel = 16 bytes per node
    const nodeData = new Float32Array(Math.max(nodeCount, 1) * 4);
    for (let i = 0; i < nodeCount; i++) {
      nodeData[i * 4 + 0] = nodeX[i];
      nodeData[i * 4 + 1] = nodeY[i];
      nodeData[i * 4 + 2] = 0;
      nodeData[i * 4 + 3] = 0;
    }

    // Recreate node buffer
    this.nodeBuffer?.destroy();
    this.nodeBuffer = this.device.createBuffer({
      size: Math.max(nodeData.byteLength, 16),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Float32Array(this.nodeBuffer.getMappedRange()).set(nodeData);
    this.nodeBuffer.unmap();

    // Edge buffer: u32 source + u32 target = 8 bytes per edge
    const edgeData = new Uint32Array(Math.max(edgeCount, 1) * 2);
    for (let i = 0; i < edgeCount; i++) {
      edgeData[i * 2 + 0] = edgeSource[i];
      edgeData[i * 2 + 1] = edgeTarget[i];
    }

    this.edgeBuffer?.destroy();
    this.edgeBuffer = this.device.createBuffer({
      size: Math.max(edgeData.byteLength, 8),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Uint32Array(this.edgeBuffer.getMappedRange()).set(edgeData);
    this.edgeBuffer.unmap();

    // Selection buffers (bit-packed, 32 elements per u32)
    const nodeSelectionWords = Math.ceil(Math.max(nodeCount, 1) / 32);
    const edgeSelectionWords = Math.ceil(Math.max(edgeCount, 1) / 32);

    this.nodeSelectionMask = new Uint32Array(nodeSelectionWords);
    this.edgeSelectionMask = new Uint32Array(edgeSelectionWords);

    this.nodeSelectionBuffer?.destroy();
    this.nodeSelectionBuffer = this.device.createBuffer({
      size: Math.max(nodeSelectionWords * 4, 4),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.edgeSelectionBuffer?.destroy();
    this.edgeSelectionBuffer = this.device.createBuffer({
      size: Math.max(edgeSelectionWords * 4, 4),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Uniform buffer
    if (!this.uniformBuffer) {
      this.uniformBuffer = this.device.createBuffer({
        size: 144,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }

    // Preview edge buffer (2 vec2f = 16 bytes)
    if (!this.previewEdgeBuffer) {
      this.previewEdgeBuffer = this.device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }

    // Recreate bind groups
    this.nodeBindGroup = this.device.createBindGroup({
      layout: this.nodePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.nodeBuffer } },
        { binding: 2, resource: { buffer: this.nodeSelectionBuffer } },
      ],
    });

    this.edgeBindGroup = this.device.createBindGroup({
      layout: this.edgePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.nodeBuffer } },
        { binding: 2, resource: { buffer: this.edgeBuffer } },
        { binding: 3, resource: { buffer: this.edgeSelectionBuffer } },
      ],
    });

    this.previewEdgeBindGroup = this.device.createBindGroup({
      layout: this.previewEdgePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.previewEdgeBuffer } },
      ],
    });

    this.lastGraphVersion = this.graphState.version;
  }

  /**
   * Update selection highlighting
   */
  public setSelection(selection: Selection) {
    if (!this.device || !this.nodeSelectionBuffer || !this.edgeSelectionBuffer) return;

    // Clear and rebuild node selection mask
    this.nodeSelectionMask.fill(0);
    for (const nodeIdx of selection.nodes) {
      const wordIdx = Math.floor(nodeIdx / 32);
      const bitIdx = nodeIdx % 32;
      if (wordIdx < this.nodeSelectionMask.length) {
        this.nodeSelectionMask[wordIdx] |= (1 << bitIdx);
      }
    }
    this.device.queue.writeBuffer(this.nodeSelectionBuffer, 0, this.nodeSelectionMask);

    // Clear and rebuild edge selection mask
    this.edgeSelectionMask.fill(0);
    for (const edgeIdx of selection.edges) {
      const wordIdx = Math.floor(edgeIdx / 32);
      const bitIdx = edgeIdx % 32;
      if (wordIdx < this.edgeSelectionMask.length) {
        this.edgeSelectionMask[wordIdx] |= (1 << bitIdx);
      }
    }
    this.device.queue.writeBuffer(this.edgeSelectionBuffer, 0, this.edgeSelectionMask);
  }

  /**
   * Set preview edge (for addEdge mode)
   */
  public setPreviewEdge(visible: boolean, startX?: number, startY?: number, endX?: number, endY?: number) {
    this.previewEdgeVisible = visible;
    if (visible && startX !== undefined && startY !== undefined && endX !== undefined && endY !== undefined) {
      this.previewEdgeStart = { x: startX, y: startY };
      this.previewEdgeEnd = { x: endX, y: endY };
    }
  }

  private updateUniforms() {
    if (!this.device || !this.uniformBuffer) return;

    const width = this.canvas.width;
    const height = this.canvas.height;

    const halfWidth = (width / 2) / this.camera.zoom;
    const halfHeight = (height / 2) / this.camera.zoom;

    const projection = mat4.ortho(
      -halfWidth, halfWidth,
      -halfHeight, halfHeight,
      -1, 1
    );

    const view = mat4.translation([-this.camera.centerX, -this.camera.centerY, 0]);

    const data = new Float32Array(36);
    data.set(projection, 0);
    data.set(view, 16);
    data[32] = width;
    data[33] = height;
    data[34] = this.camera.zoom;
    data[35] = 0;

    this.device.queue.writeBuffer(this.uniformBuffer, 0, data);

    // Update preview edge buffer if visible
    if (this.previewEdgeVisible && this.previewEdgeBuffer) {
      const previewData = new Float32Array([
        this.previewEdgeStart.x, this.previewEdgeStart.y,
        this.previewEdgeEnd.x, this.previewEdgeEnd.y,
      ]);
      this.device.queue.writeBuffer(this.previewEdgeBuffer, 0, previewData);
    }
  }

  private tileKey(tile: TileCoord): string {
    return `${tile.z}/${tile.x}/${tile.y}`;
  }

  private getOrCreateTileTexture(tile: TileCoord): GPUTexture | null {
    if (!this.device) return null;

    const key = this.tileKey(tile);
    if (this.tileTextures.has(key)) {
      return this.tileTextures.get(key)!;
    }

    const img = this.tileCache.getImmediate(tile);
    if (!img) {
      this.tileCache.getTile(tile);
      return null;
    }

    const texture = this.device.createTexture({
      size: [img.width, img.height, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });

    this.device.queue.copyExternalImageToTexture(
      { source: img },
      { texture },
      [img.width, img.height]
    );

    this.tileTextures.set(key, texture);
    return texture;
  }

  public render = () => {
    if (!this.device || !this.context || !this.nodePipeline || !this.edgePipeline) {
      this.frameId = requestAnimationFrame(this.render);
      return;
    }

    // Auto-sync if graph changed
    if (this.graphState.version !== this.lastGraphVersion) {
      this.syncBuffers();
    }

    // FPS tracking
    this.frameCount++;
    const now = performance.now();
    if (now - this.lastFrameTime >= 1000) {
      this.fps = this.frameCount;
      this.frameCount = 0;
      this.lastFrameTime = now;
      this.onStatsUpdate?.({ fps: this.fps });
    }

    this.updateUniforms();

    const commandEncoder = this.device.createCommandEncoder();
    const textureView = this.context.getCurrentTexture().createView();

    const renderPass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: textureView,
        clearValue: { r: 0.04, g: 0.04, b: 0.06, a: 1.0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });

    // Draw tiles (basemap) first
    if (this.basemapEnabled && this.tilePipeline && this.tileSampler && this.tileBindGroupLayout) {
      this.renderTiles(renderPass);
    }

    // Draw edges (behind nodes)
    if (this.edgeBindGroup && this.graphState.edgeCount > 0) {
      renderPass.setPipeline(this.edgePipeline);
      renderPass.setBindGroup(0, this.edgeBindGroup);
      renderPass.draw(this.graphState.edgeCount * 2);
    }

    // Draw preview edge (if in addEdge mode)
    if (this.previewEdgeVisible && this.previewEdgeBindGroup && this.previewEdgePipeline) {
      renderPass.setPipeline(this.previewEdgePipeline);
      renderPass.setBindGroup(0, this.previewEdgeBindGroup);
      renderPass.draw(2);
    }

    // Draw nodes
    if (this.nodeBindGroup && this.graphState.nodeCount > 0) {
      renderPass.setPipeline(this.nodePipeline);
      renderPass.setBindGroup(0, this.nodeBindGroup);
      renderPass.draw(6, this.graphState.nodeCount);
    }

    renderPass.end();
    this.device.queue.submit([commandEncoder.finish()]);

    this.frameId = requestAnimationFrame(this.render);
  };

  private renderTiles(renderPass: GPURenderPassEncoder) {
    if (!this.device || !this.tilePipeline || !this.tileSampler || !this.uniformBuffer || !this.tileBindGroupLayout) return;

    const absCenterX = this.worldCenterX + this.camera.centerX;
    const absCenterY = this.worldCenterY + this.camera.centerY;

    const tiles = getVisibleTiles(
      absCenterX,
      absCenterY,
      this.canvas.width,
      this.canvas.height,
      this.camera.zoom
    );

    renderPass.setPipeline(this.tilePipeline);

    const corners = [
      [0, 0], [1, 0], [0, 1],
      [0, 1], [1, 0], [1, 1],
    ];

    for (const tile of tiles) {
      const texture = this.getOrCreateTileTexture(tile);
      if (!texture) continue;

      const bounds = tileBounds(tile);

      const minX = bounds.minX - this.worldCenterX;
      const minY = bounds.minY - this.worldCenterY;
      const maxX = bounds.maxX - this.worldCenterX;
      const maxY = bounds.maxY - this.worldCenterY;

      const vertexData = new Float32Array(36);
      for (let i = 0; i < 6; i++) {
        const offset = i * 6;
        vertexData[offset + 0] = corners[i][0];
        vertexData[offset + 1] = corners[i][1];
        vertexData[offset + 2] = minX;
        vertexData[offset + 3] = minY;
        vertexData[offset + 4] = maxX;
        vertexData[offset + 5] = maxY;
      }

      const vertexBuffer = this.device.createBuffer({
        size: vertexData.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true,
      });
      new Float32Array(vertexBuffer.getMappedRange()).set(vertexData);
      vertexBuffer.unmap();

      const tileBindGroup = this.device.createBindGroup({
        layout: this.tileBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer } },
          { binding: 1, resource: this.tileSampler },
          { binding: 2, resource: texture.createView() },
        ],
      });

      renderPass.setBindGroup(0, tileBindGroup);
      renderPass.setVertexBuffer(0, vertexBuffer);
      renderPass.draw(6);
    }
  }

  // ==================== COORDINATE CONVERSION ====================

  /**
   * Convert screen coordinates to world coordinates
   */
  public screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
    const x = this.camera.centerX + (screenX - this.canvas.width / 2) / this.camera.zoom;
    const y = this.camera.centerY - (screenY - this.canvas.height / 2) / this.camera.zoom;
    return { x, y };
  }

  /**
   * Convert world coordinates to screen coordinates
   */
  public worldToScreen(worldX: number, worldY: number): { x: number; y: number } {
    const x = (worldX - this.camera.centerX) * this.camera.zoom + this.canvas.width / 2;
    const y = (this.camera.centerY - worldY) * this.camera.zoom + this.canvas.height / 2;
    return { x, y };
  }

  // ==================== CAMERA CONTROLS ====================

  public setCamera(centerX: number, centerY: number, zoom: number) {
    this.camera.centerX = centerX;
    this.camera.centerY = centerY;
    this.camera.zoom = zoom;
  }

  public pan(dx: number, dy: number) {
    this.camera.centerX -= dx / this.camera.zoom;
    this.camera.centerY += dy / this.camera.zoom;
  }

  public zoomAt(x: number, y: number, factor: number) {
    const worldX = this.camera.centerX + (x - this.canvas.width / 2) / this.camera.zoom;
    const worldY = this.camera.centerY - (y - this.canvas.height / 2) / this.camera.zoom;

    const newZoom = Math.max(0.001, Math.min(100, this.camera.zoom * factor));
    
    this.camera.centerX = worldX - (x - this.canvas.width / 2) / newZoom;
    this.camera.centerY = worldY + (y - this.canvas.height / 2) / newZoom;
    this.camera.zoom = newZoom;
  }

  public destroy() {
    cancelAnimationFrame(this.frameId);
    this.nodeBuffer?.destroy();
    this.edgeBuffer?.destroy();
    this.uniformBuffer?.destroy();
    this.nodeSelectionBuffer?.destroy();
    this.edgeSelectionBuffer?.destroy();
    this.previewEdgeBuffer?.destroy();
    this.tileTextures.forEach(tex => tex.destroy());
  }
}
