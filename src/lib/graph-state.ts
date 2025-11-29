export class GraphState {
    // Structure of Arrays (SoA) for Nodes
    public nodeCount: number = 0;
    public nodeCapacity: number;
    public nodeX: Float32Array;
    public nodeY: Float32Array;
    public nodeVX: Float32Array;
    public nodeVY: Float32Array;
    // We can add mass, radius, etc. if needed
  
    // Structure of Arrays (SoA) for Edges
    public edgeCount: number = 0;
    public edgeCapacity: number;
    public edgeSource: Uint32Array;
    public edgeTarget: Uint32Array;
  
    constructor(initialNodeCapacity: number = 100000, initialEdgeCapacity: number = 300000) {
      this.nodeCapacity = initialNodeCapacity;
      this.edgeCapacity = initialEdgeCapacity;
  
      // Allocate SharedArrayBuffers for zero-copy compatibility if supported, or standard Float32Array
      // Using standard TypedArrays for now, can upgrade to SAB for Worker sharing
      this.nodeX = new Float32Array(this.nodeCapacity);
      this.nodeY = new Float32Array(this.nodeCapacity);
      this.nodeVX = new Float32Array(this.nodeCapacity);
      this.nodeVY = new Float32Array(this.nodeCapacity);
  
      this.edgeSource = new Uint32Array(this.edgeCapacity);
      this.edgeTarget = new Uint32Array(this.edgeCapacity);
    }
  
    public addNode(x: number, y: number): number {
      if (this.nodeCount >= this.nodeCapacity) {
        this.resizeNodes(this.nodeCapacity * 2);
      }
      const idx = this.nodeCount++;
      this.nodeX[idx] = x;
      this.nodeY[idx] = y;
      this.nodeVX[idx] = 0;
      this.nodeVY[idx] = 0;
      return idx;
    }
  
    public addEdge(source: number, target: number): number {
        if (this.edgeCount >= this.edgeCapacity) {
            this.resizeEdges(this.edgeCapacity * 2);
        }
        const idx = this.edgeCount++;
        this.edgeSource[idx] = source;
        this.edgeTarget[idx] = target;
        return idx;
    }

    private resizeNodes(newCapacity: number) {
        console.log(`Resizing nodes from ${this.nodeCapacity} to ${newCapacity}`);
        const newX = new Float32Array(newCapacity);
        const newY = new Float32Array(newCapacity);
        const newVX = new Float32Array(newCapacity);
        const newVY = new Float32Array(newCapacity);

        newX.set(this.nodeX);
        newY.set(this.nodeY);
        newVX.set(this.nodeVX);
        newVY.set(this.nodeVY);

        this.nodeX = newX;
        this.nodeY = newY;
        this.nodeVX = newVX;
        this.nodeVY = newVY;
        this.nodeCapacity = newCapacity;
    }

    private resizeEdges(newCapacity: number) {
        console.log(`Resizing edges from ${this.edgeCapacity} to ${newCapacity}`);
        const newSource = new Uint32Array(newCapacity);
        const newTarget = new Uint32Array(newCapacity);

        newSource.set(this.edgeSource);
        newTarget.set(this.edgeTarget);

        this.edgeSource = newSource;
        this.edgeTarget = newTarget;
        this.edgeCapacity = newCapacity;
    }

    public loadFromArrow(nodes: any, edges: any) {
        // Assume 'nodes' and 'edges' are Arrow Tables or DuckDB query results converted to array-like objects
        // This is a simplified loader.
        
        // Reset counts
        this.nodeCount = 0;
        this.edgeCount = 0;

        // Load Nodes
        const xOffset = nodes.getChild("x_offset");
        const yOffset = nodes.getChild("y_offset");
        const numNodes = nodes.numRows;

        // Resize if necessary
        if (numNodes > this.nodeCapacity) {
             this.resizeNodes(Math.max(numNodes, this.nodeCapacity * 2));
        }

        // Direct copy if possible, otherwise loop
        // Arrow arrays can be complex (chunks), so looping is safest for MVP
        for (let i = 0; i < numNodes; i++) {
            // Arrow's get(i) might be slow, bulk access is better if possible
            this.addNode(xOffset.get(i), yOffset.get(i));
        }

        // Load Edges
        const source = edges.getChild("source_idx");
        const target = edges.getChild("target_idx");
        const numEdges = edges.numRows;

        if (numEdges > this.edgeCapacity) {
            this.resizeEdges(Math.max(numEdges, this.edgeCapacity * 2));
        }

         for (let i = 0; i < numEdges; i++) {
            this.addEdge(source.get(i), target.get(i));
        }
        
        console.log(`Loaded ${this.nodeCount} nodes and ${this.edgeCount} edges into GraphState.`);
    }

    public getBuffers() {
        return {
            nodeX: this.nodeX,
            nodeY: this.nodeY,
            edgeSource: this.edgeSource,
            edgeTarget: this.edgeTarget
        };
    }
}
