// WebGPU Vertex and Fragment Shaders for Graph Rendering

export const GRAPH_RENDER_SHADER = `
struct Camera {
  projection: mat4x4f,
  view: mat4x4f,
  scale: f32, // To keep point size constant in screen space if needed
};

@group(0) @binding(0) var<uniform> camera: Camera;

// ------------------------------------------------------------------
// NODE RENDERING (Instanced)
// ------------------------------------------------------------------
struct Node {
  pos: vec2f,
  vel: vec2f,
};

@group(1) @binding(0) var<storage, read> nodes: array<Node>;

struct NodeVertexOutput {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
  @location(1) uv: vec2f,
};

@vertex
fn vs_node(
  @builtin(vertex_index) vIdx: u32,
  @builtin(instance_index) iIdx: u32
) -> NodeVertexOutput {
  let node = nodes[iIdx];
  
  // Standard quad vertices
  var pos = vec2f(0.0, 0.0);
  var uv = vec2f(0.5, 0.5);
  
  // 6 vertices for a quad (2 triangles)
  switch(vIdx) {
    case 0u: { pos = vec2f(-1.0, -1.0); uv = vec2f(0.0, 0.0); }
    case 1u: { pos = vec2f( 1.0, -1.0); uv = vec2f(1.0, 0.0); }
    case 2u: { pos = vec2f(-1.0,  1.0); uv = vec2f(0.0, 1.0); }
    case 3u: { pos = vec2f(-1.0,  1.0); uv = vec2f(0.0, 1.0); }
    case 4u: { pos = vec2f( 1.0, -1.0); uv = vec2f(1.0, 0.0); }
    case 5u: { pos = vec2f( 1.0,  1.0); uv = vec2f(1.0, 1.0); }
    default: { }
  }

  // Billboard size (in world units or screen pixels)
  // Let's assume world units for now, say 2 meters radius?
  let size = 5.0; // 5 meters width
  
  let worldPos = vec4f(node.pos + pos * size * 0.5, 0.0, 1.0);
  
  var out: NodeVertexOutput;
  out.position = camera.projection * camera.view * worldPos;
  out.color = vec4f(0.0, 0.5, 1.0, 1.0); // Blueish
  out.uv = uv;
  return out;
}

@fragment
fn fs_node(@location(0) color: vec4f, @location(1) uv: vec2f) -> @location(0) vec4f {
  // Simple circle
  let d = distance(uv, vec2f(0.5));
  if (d > 0.5) {
    discard;
  }
  return color;
}

// ------------------------------------------------------------------
// EDGE RENDERING
// ------------------------------------------------------------------
struct Edge {
  source: u32,
  target: u32,
  padding1: u32,
  padding2: u32,
};

@group(1) @binding(1) var<storage, read> edges: array<Edge>;

@vertex
fn vs_edge(
  @builtin(vertex_index) vIdx: u32, // We assume topology: LineList (2 verts per edge)
  // Or better: Instanced Line Quads?
  // Simplest: Topology "line-list", draw call uses vertex_index to fetch edge.
  // Requires: Draw(edgeCount * 2)
  // vertex_index / 2 = edge_index
  // vertex_index % 2 = 0 (source) or 1 (target)
) -> @builtin(position) vec4f {
  let edgeIdx = vIdx / 2;
  let pointIdx = vIdx % 2;
  
  let edge = edges[edgeIdx];
  let nodeIdx = select(edge.source, edge.target, pointIdx == 1u);
  
  let node = nodes[nodeIdx];
  let worldPos = vec4f(node.pos, 0.0, 1.0);
  
  return camera.projection * camera.view * worldPos;
}

@fragment
fn fs_edge() -> @location(0) vec4f {
  return vec4f(0.8, 0.8, 0.8, 0.5); // Gray, semi-transparent
}
`;




