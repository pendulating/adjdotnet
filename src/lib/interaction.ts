export class InteractionSystem {
    // Placeholder for interaction logic:
    // 1. Mouse Move -> Update Picking Texture Uniforms (optional) or Raycast on CPU (if small)
    // 2. Mouse Click -> Read pixel from Picking Texture -> Get Node ID
    // 3. Drag -> Update GraphState.nodePos[id] -> Write to GPU Buffer
    
    // Implementation would be tied to the Renderer class.
    // For now, providing the structure.
    
    constructor() {
        console.log("Interaction System ready.");
    }

    public handleMouseDown(x: number, y: number, renderer: any) {
        // Pseudo-code
        // const id = renderer.pick(x, y);
        // if (id) startDrag(id);
    }
}




