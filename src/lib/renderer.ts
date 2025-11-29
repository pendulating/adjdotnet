import { GraphState } from './graph-state';
import { mat4 } from 'wgpu-matrix';
import { TileCache, tileBounds, getVisibleTiles, TILE_PROVIDERS } from './tile-layer';
import type { TileCoord, TileProvider } from './tile-layer';

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

struct TileInstance {
  minX: f32,
  minY: f32,
  maxX: f32,
  maxY: f32,
};

@group(0) @binding(3) var<uniform> tile: TileInstance;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) vIdx: u32) -> VertexOutput {
  // Quad vertices (2 triangles)
  var positions: array<vec2f, 6> = array<vec2f, 6>(
    vec2f(0.0, 0.0),
    vec2f(1.0, 0.0),
    vec2f(0.0, 1.0),
    vec2f(0.0, 1.0),
    vec2f(1.0, 0.0),
    vec2f(1.0, 1.0),
  );
  
  let p = positions[vIdx];
  let worldX = mix(tile.minX, tile.maxX, p.x);
  let worldY = mix(tile.minY, tile.maxY, p.y);
  
  var out: VertexOutput;
  out.position = camera.projection * camera.view * vec4f(worldX, worldY, 0.0, 1.0);
  out.uv = vec2f(p.x, 1.0 - p.y); // Flip Y for texture
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

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(
  @builtin(vertex_index) vIdx: u32,
  @builtin(instance_index) iIdx: u32
) -> VertexOutput {
  let node = nodes[iIdx];
  
  // Quad vertices (2 triangles)
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
  let nodeSize = 8.0 / camera.scale; // 8 pixels in screen space
  
  let worldPos = vec4f(node.pos + localPos * nodeSize, 0.0, 1.0);
  
  var out: VertexOutput;
  out.position = camera.projection * camera.view * worldPos;
  out.uv = quadUV[vIdx];
  return out;
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let d = distance(uv, vec2f(0.5));
  if (d > 0.5) {
    discard;
  }
  // Soft edge
  let alpha = smoothstep(0.5, 0.35, d);
  return vec4f(0.24, 0.63, 0.95, alpha); // Blue nodes
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

@vertex
fn vs_main(@builtin(vertex_index) vIdx: u32) -> @builtin(position) vec4f {
  let edgeIdx = vIdx / 2u;
  let isDest = (vIdx % 2u) == 1u;
  
  let edge = edges[edgeIdx];
  let nodeIdx = select(edge.source, edge.dest, isDest);
  let node = nodes[nodeIdx];
  
  let worldPos = vec4f(node.pos, 0.0, 1.0);
  return camera.projection * camera.view * worldPos;
}

@fragment
fn fs_main() -> @location(0) vec4f {
  return vec4f(0.4, 0.4, 0.45, 0.6); // Gray edges
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

  // Pipelines
  private nodePipeline: GPURenderPipeline | null = null;
  private edgePipeline: GPURenderPipeline | null = null;
  private tilePipeline: GPURenderPipeline | null = null;

  // Buffers
  private nodeBuffer: GPUBuffer | null = null;
  private edgeBuffer: GPUBuffer | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private tileUniformBuffer: GPUBuffer | null = null;

  // Bind Groups
  private nodeBindGroup: GPUBindGroup | null = null;
  private edgeBindGroup: GPUBindGroup | null = null;

  // Tile Layer
  private tileCache: TileCache;
  private tileTextures = new Map<string, GPUTexture>();
  private tileSampler: GPUSampler | null = null;
  private basemapEnabled = true;
  private worldCenterX = 0; // Absolute Web Mercator center
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
    // Clear existing textures
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

    // Tile Pipeline
    const tileModule = this.device.createShaderModule({ code: TILE_SHADER });
    this.tilePipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: tileModule,
        entryPoint: 'vs_main',
      },
      fragment: {
        module: tileModule,
        entryPoint: 'fs_main',
        targets: [{ format: this.format }],
      },
      primitive: { topology: 'triangle-list' },
    });

    // Tile sampler
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
  }

  private async initBuffers() {
    if (!this.device) return;

    const { nodeX, nodeY, edgeSource, edgeTarget } = this.graphState.getBuffers();
    const nodeCount = this.graphState.nodeCount;
    const edgeCount = this.graphState.edgeCount;

    // Node buffer: vec2f pos + vec2f vel = 16 bytes per node
    const nodeData = new Float32Array(nodeCount * 4);
    for (let i = 0; i < nodeCount; i++) {
      nodeData[i * 4 + 0] = nodeX[i];
      nodeData[i * 4 + 1] = nodeY[i];
      nodeData[i * 4 + 2] = 0;
      nodeData[i * 4 + 3] = 0;
    }

    this.nodeBuffer = this.device.createBuffer({
      size: Math.max(nodeData.byteLength, 16),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Float32Array(this.nodeBuffer.getMappedRange()).set(nodeData);
    this.nodeBuffer.unmap();

    // Edge buffer: u32 source + u32 target = 8 bytes per edge
    const edgeData = new Uint32Array(edgeCount * 2);
    for (let i = 0; i < edgeCount; i++) {
      edgeData[i * 2 + 0] = edgeSource[i];
      edgeData[i * 2 + 1] = edgeTarget[i];
    }

    this.edgeBuffer = this.device.createBuffer({
      size: Math.max(edgeData.byteLength, 8),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Uint32Array(this.edgeBuffer.getMappedRange()).set(edgeData);
    this.edgeBuffer.unmap();

    // Uniform buffer: mat4x4 projection (64) + mat4x4 view (64) + vec2 viewport (8) + float scale (4) + pad (4) = 144 bytes
    this.uniformBuffer = this.device.createBuffer({
      size: 144,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Tile uniform buffer: 4 floats (minX, minY, maxX, maxY) = 16 bytes
    this.tileUniformBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Create bind groups
    if (this.nodePipeline && this.edgePipeline) {
      this.nodeBindGroup = this.device.createBindGroup({
        layout: this.nodePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer } },
          { binding: 1, resource: { buffer: this.nodeBuffer } },
        ],
      });

      this.edgeBindGroup = this.device.createBindGroup({
        layout: this.edgePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer } },
          { binding: 1, resource: { buffer: this.nodeBuffer } },
          { binding: 2, resource: { buffer: this.edgeBuffer } },
        ],
      });
    }
  }

  private updateUniforms() {
    if (!this.device || !this.uniformBuffer) return;

    const width = this.canvas.width;
    const height = this.canvas.height;
    const aspect = width / height;

    // Orthographic projection centered on camera position
    const halfWidth = (width / 2) / this.camera.zoom;
    const halfHeight = (height / 2) / this.camera.zoom;

    const projection = mat4.ortho(
      -halfWidth, halfWidth,
      -halfHeight, halfHeight,
      -1, 1
    );

    // View matrix (translate to camera center)
    const view = mat4.translation([-this.camera.centerX, -this.camera.centerY, 0]);

    // Write to buffer
    const data = new Float32Array(36); // 16 + 16 + 2 + 1 + 1 = 36
    data.set(projection, 0);
    data.set(view, 16);
    data[32] = width;
    data[33] = height;
    data[34] = this.camera.zoom;
    data[35] = 0; // padding

    this.device.queue.writeBuffer(this.uniformBuffer, 0, data);
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
      // Start loading in background
      this.tileCache.getTile(tile);
      return null;
    }

    // Create texture from image
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
    if (this.basemapEnabled && this.tilePipeline && this.tileSampler && this.tileUniformBuffer) {
      this.renderTiles(renderPass);
    }

    // Draw edges (behind nodes)
    if (this.edgeBindGroup && this.graphState.edgeCount > 0) {
      renderPass.setPipeline(this.edgePipeline);
      renderPass.setBindGroup(0, this.edgeBindGroup);
      renderPass.draw(this.graphState.edgeCount * 2);
    }

    // Draw nodes
    if (this.nodeBindGroup && this.graphState.nodeCount > 0) {
      renderPass.setPipeline(this.nodePipeline);
      renderPass.setBindGroup(0, this.nodeBindGroup);
      renderPass.draw(6, this.graphState.nodeCount); // 6 verts per quad, instanced
    }

    renderPass.end();
    this.device.queue.submit([commandEncoder.finish()]);

    this.frameId = requestAnimationFrame(this.render);
  };

  private renderTiles(renderPass: GPURenderPassEncoder) {
    if (!this.device || !this.tilePipeline || !this.tileSampler || !this.uniformBuffer || !this.tileUniformBuffer) return;

    // Calculate absolute camera position
    const absCenterX = this.worldCenterX + this.camera.centerX;
    const absCenterY = this.worldCenterY + this.camera.centerY;

    // Get visible tiles
    const tiles = getVisibleTiles(
      absCenterX,
      absCenterY,
      this.canvas.width,
      this.canvas.height,
      this.camera.zoom
    );

    renderPass.setPipeline(this.tilePipeline);

    for (const tile of tiles) {
      const texture = this.getOrCreateTileTexture(tile);
      if (!texture) continue; // Skip tiles that aren't loaded yet

      // Get tile bounds in absolute Web Mercator
      const bounds = tileBounds(tile);

      // Convert to local coordinates (relative to world center)
      const localBounds = {
        minX: bounds.minX - this.worldCenterX,
        minY: bounds.minY - this.worldCenterY,
        maxX: bounds.maxX - this.worldCenterX,
        maxY: bounds.maxY - this.worldCenterY,
      };

      // Update tile uniform buffer
      const tileData = new Float32Array([localBounds.minX, localBounds.minY, localBounds.maxX, localBounds.maxY]);
      this.device.queue.writeBuffer(this.tileUniformBuffer, 0, tileData);

      // Create bind group for this tile
      const tileBindGroup = this.device.createBindGroup({
        layout: this.tilePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer } },
          { binding: 1, resource: this.tileSampler },
          { binding: 2, resource: texture.createView() },
          { binding: 3, resource: { buffer: this.tileUniformBuffer } },
        ],
      });

      renderPass.setBindGroup(0, tileBindGroup);
      renderPass.draw(6);
    }
  }

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
    // Convert screen coords to world coords before zoom
    const worldX = this.camera.centerX + (x - this.canvas.width / 2) / this.camera.zoom;
    const worldY = this.camera.centerY - (y - this.canvas.height / 2) / this.camera.zoom;

    const newZoom = Math.max(0.001, Math.min(100, this.camera.zoom * factor));
    
    // Adjust center to zoom toward mouse position
    this.camera.centerX = worldX - (x - this.canvas.width / 2) / newZoom;
    this.camera.centerY = worldY + (y - this.canvas.height / 2) / newZoom;
    this.camera.zoom = newZoom;
  }

  public destroy() {
    cancelAnimationFrame(this.frameId);
  }
}
