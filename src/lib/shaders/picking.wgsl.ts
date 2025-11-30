// WebGPU Picking Shader
// Renders nodes as IDs to an offscreen texture

export const PICKING_SHADER = `
struct Camera {
  projection: mat4x4f,
  view: mat4x4f,
  scale: f32,
};

@group(0) @binding(0) var<uniform> camera: Camera;

struct Node {
  pos: vec2f,
  vel: vec2f,
};

@group(1) @binding(0) var<storage, read> nodes: array<Node>;

struct NodeVertexOutput {
  @builtin(position) position: vec4f,
  @location(0) id: u32,
};

@vertex
fn vs_pick(
  @builtin(vertex_index) vIdx: u32,
  @builtin(instance_index) iIdx: u32
) -> NodeVertexOutput {
  let node = nodes[iIdx];
  
  // Reuse quad logic from Render Shader
  var pos = vec2f(0.0, 0.0);
  switch(vIdx) {
    case 0u: { pos = vec2f(-1.0, -1.0); }
    case 1u: { pos = vec2f( 1.0, -1.0); }
    case 2u: { pos = vec2f(-1.0,  1.0); }
    case 3u: { pos = vec2f(-1.0,  1.0); }
    case 4u: { pos = vec2f( 1.0, -1.0); }
    case 5u: { pos = vec2f( 1.0,  1.0); }
    default: { }
  }

  // Ensure size matches render shader
  let size = 5.0; 
  let worldPos = vec4f(node.pos + pos * size * 0.5, 0.0, 1.0);
  
  var out: NodeVertexOutput;
  out.position = camera.projection * camera.view * worldPos;
  out.id = iIdx; // Pass the instance ID (node index)
  return out;
}

@fragment
fn fs_pick(@location(0) id: u32) -> @location(0) vec4u {
  // Output ID encoded as color or direct integer if texture format supports it (r32uint)
  return vec4u(id, 0u, 0u, 1u);
}
`;





