import { GRAPH_RENDER_SHADER } from './shaders/render.wgsl';
import { LAYOUT_SHADER } from './shaders/layout.wgsl';
import { PICKING_SHADER } from './shaders/picking.wgsl';
import { GraphState } from './graph-state';
import { mat4 } from 'wgpu-matrix';

export class WebGPURenderer {
  private canvas: HTMLCanvasElement;
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private format: GPUTextureFormat = 'bgra8unorm';

  private graphState: GraphState;

  // Pipelines
  private renderPipeline: GPURenderPipeline | null = null;
  private computePipeline: GPUComputePipeline | null = null;
  private pickingPipeline: GPURenderPipeline | null = null;

  // Buffers
  private nodeBuffer: GPUBuffer | null = null;
  private edgeBuffer: GPUBuffer | null = null;
  private uniformBuffer: GPUBuffer | null = null;

  // Bind Groups
  private renderBindGroup: GPUBindGroup | null = null;
  private computeBindGroup: GPUBindGroup | null = null;

  // Simulation State
  private isRunning: boolean = false;
  private frameId: number = 0;

  constructor(canvas: HTMLCanvasElement, graphState: GraphState) {
    this.canvas = canvas;
    this.graphState = graphState;
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
    
    // Start Loop
    this.render();
  }

  private async initPipelines() {
    if (!this.device) return;

    // 1. Render Pipeline
    const renderModule = this.device.createShaderModule({ code: GRAPH_RENDER_SHADER });
    
    this.renderPipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: renderModule,
        entryPoint: 'vs_node', // We need separate pipelines for nodes/edges or one uber shader
        // For simplicity, let's assume we draw NODES first using this pipeline
      },
      fragment: {
        module: renderModule,
        entryPoint: 'fs_node',
        targets: [{ format: this.format }],
      },
      primitive: {
        topology: 'triangle-list',
      },
    });
    // Note: Edge pipeline would be separate or defined in same shader with different entry point.
    // For MVP, we focus on Nodes.

    // 2. Compute Pipeline
    const computeModule = this.device.createShaderModule({ code: LAYOUT_SHADER });
    this.computePipeline = this.device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: computeModule,
        entryPoint: 'main',
      },
    });
  }

  private async initBuffers() {
    if (!this.device) return;

    const { nodeX, nodeY, edgeSource, edgeTarget } = this.graphState.getBuffers();

    // Create GPU Buffers mapped from CPU state
    // In a real app, we'd interleave X/Y into vec2f or keep separate. 
    // The shader expects `struct Node { pos: vec2f, vel: vec2f }`.
    // We need to repack the SoA into AoS for the shader, OR change shader to SoA.
    // Repacking to AoS for the shader is easier for standard struct usage.
    
    const nodeCount = this.graphState.nodeCount;
    const nodeData = new Float32Array(nodeCount * 4); // pos(2) + vel(2)
    for(let i=0; i<nodeCount; i++) {
        nodeData[i*4 + 0] = nodeX[i];
        nodeData[i*4 + 1] = nodeY[i];
        nodeData[i*4 + 2] = 0;
        nodeData[i*4 + 3] = 0;
    }

    this.nodeBuffer = this.device.createBuffer({
        size: nodeData.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true
    });
    new Float32Array(this.nodeBuffer.getMappedRange()).set(nodeData);
    this.nodeBuffer.unmap();

    // Uniforms
    this.uniformBuffer = this.device.createBuffer({
        size: 64 + 64 + 16, // Proj(64) + View(64) + Scale(4) + Padding
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    // Create BindGroups (once buffers are ready)
    if (this.renderPipeline) {
        this.renderBindGroup = this.device.createBindGroup({
            layout: this.renderPipeline.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }]
            // Note: Our shader has @group(0) for camera, @group(1) for nodes.
            // We need a second bindgroup for storage buffers.
        });
        // This is a simplified setup.
    }
  }

  public render = () => {
    if (!this.device || !this.context || !this.renderPipeline) return;

    // 1. Update Uniforms (Camera)
    // ...

    const commandEncoder = this.device.createCommandEncoder();

    // 2. Compute Pass (if running)
    if (this.isRunning && this.computePipeline) {
        const pass = commandEncoder.beginComputePass();
        pass.setPipeline(this.computePipeline);
        // pass.setBindGroup(...)
        pass.dispatchWorkgroups(Math.ceil(this.graphState.nodeCount / 64));
        pass.end();
    }

    // 3. Render Pass
    const textureView = this.context.getCurrentTexture().createView();
    const renderPass = commandEncoder.beginRenderPass({
        colorAttachments: [{
            view: textureView,
            clearValue: { r: 0.1, g: 0.1, b: 0.1, a: 1.0 },
            loadOp: 'clear',
            storeOp: 'store',
        }]
    });

    renderPass.setPipeline(this.renderPipeline);
    // renderPass.setBindGroup(...)
    // renderPass.draw(...)
    renderPass.end();

    this.device.queue.submit([commandEncoder.finish()]);

    this.frameId = requestAnimationFrame(this.render);
  }

  public destroy() {
    cancelAnimationFrame(this.frameId);
  }
}




