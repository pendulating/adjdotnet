// Structure of Arrays (SoA) GraphState with full mutation support

export interface NodeData {
  x: number;
  y: number;
}

export interface EdgeData {
  source: number;
  target: number;
}

export class GraphState {
  // Structure of Arrays (SoA) for Nodes
  public nodeCount: number = 0;
  public nodeCapacity: number;
  public nodeX: Float32Array;
  public nodeY: Float32Array;
  public nodeVX: Float32Array;
  public nodeVY: Float32Array;

  // Structure of Arrays (SoA) for Edges
  public edgeCount: number = 0;
  public edgeCapacity: number;
  public edgeSource: Uint32Array;
  public edgeTarget: Uint32Array;

  // Version tracking for change detection
  private _version: number = 0;

  constructor(initialNodeCapacity: number = 100000, initialEdgeCapacity: number = 300000) {
    this.nodeCapacity = initialNodeCapacity;
    this.edgeCapacity = initialEdgeCapacity;

    this.nodeX = new Float32Array(this.nodeCapacity);
    this.nodeY = new Float32Array(this.nodeCapacity);
    this.nodeVX = new Float32Array(this.nodeCapacity);
    this.nodeVY = new Float32Array(this.nodeCapacity);

    this.edgeSource = new Uint32Array(this.edgeCapacity);
    this.edgeTarget = new Uint32Array(this.edgeCapacity);
  }

  public get version(): number {
    return this._version;
  }

  private incrementVersion() {
    this._version++;
  }

  // ==================== NODE OPERATIONS ====================

  public addNode(x: number, y: number): number {
    if (this.nodeCount >= this.nodeCapacity) {
      this.resizeNodes(this.nodeCapacity * 2);
    }
    const idx = this.nodeCount++;
    this.nodeX[idx] = x;
    this.nodeY[idx] = y;
    this.nodeVX[idx] = 0;
    this.nodeVY[idx] = 0;
    this.incrementVersion();
    return idx;
  }

  public removeNode(nodeIdx: number): boolean {
    if (nodeIdx < 0 || nodeIdx >= this.nodeCount) return false;

    // First, remove all edges connected to this node
    this.removeEdgesForNode(nodeIdx);

    // Compact: move the last node to fill the gap
    const lastIdx = this.nodeCount - 1;
    if (nodeIdx !== lastIdx) {
      this.nodeX[nodeIdx] = this.nodeX[lastIdx];
      this.nodeY[nodeIdx] = this.nodeY[lastIdx];
      this.nodeVX[nodeIdx] = this.nodeVX[lastIdx];
      this.nodeVY[nodeIdx] = this.nodeVY[lastIdx];

      // Update all edge references from lastIdx to nodeIdx
      this.remapNodeIndex(lastIdx, nodeIdx);
    }

    this.nodeCount--;
    this.incrementVersion();
    return true;
  }

  public updateNode(nodeIdx: number, x: number, y: number): boolean {
    if (nodeIdx < 0 || nodeIdx >= this.nodeCount) return false;
    this.nodeX[nodeIdx] = x;
    this.nodeY[nodeIdx] = y;
    this.incrementVersion();
    return true;
  }

  public getNode(nodeIdx: number): NodeData | null {
    if (nodeIdx < 0 || nodeIdx >= this.nodeCount) return null;
    return {
      x: this.nodeX[nodeIdx],
      y: this.nodeY[nodeIdx],
    };
  }

  // ==================== EDGE OPERATIONS ====================

  public addEdge(source: number, target: number): number {
    if (source < 0 || source >= this.nodeCount) return -1;
    if (target < 0 || target >= this.nodeCount) return -1;
    if (source === target) return -1; // No self-loops

    // Check for duplicate edge
    if (this.hasEdge(source, target)) return -1;

    if (this.edgeCount >= this.edgeCapacity) {
      this.resizeEdges(this.edgeCapacity * 2);
    }
    const idx = this.edgeCount++;
    this.edgeSource[idx] = source;
    this.edgeTarget[idx] = target;
    this.incrementVersion();
    return idx;
  }

  public removeEdge(edgeIdx: number): boolean {
    if (edgeIdx < 0 || edgeIdx >= this.edgeCount) return false;

    // Compact: move the last edge to fill the gap
    const lastIdx = this.edgeCount - 1;
    if (edgeIdx !== lastIdx) {
      this.edgeSource[edgeIdx] = this.edgeSource[lastIdx];
      this.edgeTarget[edgeIdx] = this.edgeTarget[lastIdx];
    }

    this.edgeCount--;
    this.incrementVersion();
    return true;
  }

  public getEdge(edgeIdx: number): EdgeData | null {
    if (edgeIdx < 0 || edgeIdx >= this.edgeCount) return null;
    return {
      source: this.edgeSource[edgeIdx],
      target: this.edgeTarget[edgeIdx],
    };
  }

  public hasEdge(source: number, target: number): boolean {
    for (let i = 0; i < this.edgeCount; i++) {
      if (
        (this.edgeSource[i] === source && this.edgeTarget[i] === target) ||
        (this.edgeSource[i] === target && this.edgeTarget[i] === source)
      ) {
        return true;
      }
    }
    return false;
  }

  public findEdge(source: number, target: number): number {
    for (let i = 0; i < this.edgeCount; i++) {
      if (
        (this.edgeSource[i] === source && this.edgeTarget[i] === target) ||
        (this.edgeSource[i] === target && this.edgeTarget[i] === source)
      ) {
        return i;
      }
    }
    return -1;
  }

  // ==================== ADJACENCY HELPERS ====================

  public getEdgesForNode(nodeIdx: number): number[] {
    const edges: number[] = [];
    for (let i = 0; i < this.edgeCount; i++) {
      if (this.edgeSource[i] === nodeIdx || this.edgeTarget[i] === nodeIdx) {
        edges.push(i);
      }
    }
    return edges;
  }

  public getNeighbors(nodeIdx: number): number[] {
    const neighbors: number[] = [];
    for (let i = 0; i < this.edgeCount; i++) {
      if (this.edgeSource[i] === nodeIdx) {
        neighbors.push(this.edgeTarget[i]);
      } else if (this.edgeTarget[i] === nodeIdx) {
        neighbors.push(this.edgeSource[i]);
      }
    }
    return neighbors;
  }

  private removeEdgesForNode(nodeIdx: number): void {
    // Remove from end to avoid index shifting issues
    for (let i = this.edgeCount - 1; i >= 0; i--) {
      if (this.edgeSource[i] === nodeIdx || this.edgeTarget[i] === nodeIdx) {
        this.removeEdge(i);
      }
    }
  }

  private remapNodeIndex(oldIdx: number, newIdx: number): void {
    for (let i = 0; i < this.edgeCount; i++) {
      if (this.edgeSource[i] === oldIdx) {
        this.edgeSource[i] = newIdx;
      }
      if (this.edgeTarget[i] === oldIdx) {
        this.edgeTarget[i] = newIdx;
      }
    }
  }

  // ==================== SPATIAL QUERIES ====================

  /**
   * Find the nearest node to a point within a maximum distance
   */
  public findNearestNode(x: number, y: number, maxDist: number = Infinity): number {
    let nearestIdx = -1;
    let nearestDistSq = maxDist * maxDist;

    for (let i = 0; i < this.nodeCount; i++) {
      const dx = this.nodeX[i] - x;
      const dy = this.nodeY[i] - y;
      const distSq = dx * dx + dy * dy;
      if (distSq < nearestDistSq) {
        nearestDistSq = distSq;
        nearestIdx = i;
      }
    }
    return nearestIdx;
  }

  /**
   * Find all nodes within a radius
   */
  public findNodesInRadius(x: number, y: number, radius: number): number[] {
    const nodes: number[] = [];
    const radiusSq = radius * radius;

    for (let i = 0; i < this.nodeCount; i++) {
      const dx = this.nodeX[i] - x;
      const dy = this.nodeY[i] - y;
      const distSq = dx * dx + dy * dy;
      if (distSq <= radiusSq) {
        nodes.push(i);
      }
    }
    return nodes;
  }

  /**
   * Find all nodes within a bounding box
   */
  public findNodesInBox(minX: number, minY: number, maxX: number, maxY: number): number[] {
    const nodes: number[] = [];
    for (let i = 0; i < this.nodeCount; i++) {
      const x = this.nodeX[i];
      const y = this.nodeY[i];
      if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
        nodes.push(i);
      }
    }
    return nodes;
  }

  /**
   * Find the nearest edge to a point
   */
  public findNearestEdge(x: number, y: number, maxDist: number = Infinity): number {
    let nearestIdx = -1;
    let nearestDistSq = maxDist * maxDist;

    for (let i = 0; i < this.edgeCount; i++) {
      const srcIdx = this.edgeSource[i];
      const tgtIdx = this.edgeTarget[i];
      const x1 = this.nodeX[srcIdx];
      const y1 = this.nodeY[srcIdx];
      const x2 = this.nodeX[tgtIdx];
      const y2 = this.nodeY[tgtIdx];

      const distSq = this.pointToSegmentDistSq(x, y, x1, y1, x2, y2);
      if (distSq < nearestDistSq) {
        nearestDistSq = distSq;
        nearestIdx = i;
      }
    }
    return nearestIdx;
  }

  private pointToSegmentDistSq(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lengthSq = dx * dx + dy * dy;

    if (lengthSq === 0) {
      // Segment is a point
      const ddx = px - x1;
      const ddy = py - y1;
      return ddx * ddx + ddy * ddy;
    }

    // Project point onto line segment
    let t = ((px - x1) * dx + (py - y1) * dy) / lengthSq;
    t = Math.max(0, Math.min(1, t));

    const closestX = x1 + t * dx;
    const closestY = y1 + t * dy;

    const ddx = px - closestX;
    const ddy = py - closestY;
    return ddx * ddx + ddy * ddy;
  }

  // ==================== RESIZE OPERATIONS ====================

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

  // ==================== BULK LOADING ====================

  public loadFromArrow(nodes: any, edges: any) {
    this.nodeCount = 0;
    this.edgeCount = 0;

    const xOffset = nodes.getChild("x_offset");
    const yOffset = nodes.getChild("y_offset");
    const numNodes = nodes.numRows;

    if (numNodes > this.nodeCapacity) {
      this.resizeNodes(Math.max(numNodes, this.nodeCapacity * 2));
    }

    for (let i = 0; i < numNodes; i++) {
      this.nodeX[i] = xOffset.get(i);
      this.nodeY[i] = yOffset.get(i);
      this.nodeVX[i] = 0;
      this.nodeVY[i] = 0;
    }
    this.nodeCount = numNodes;

    const source = edges.getChild("source_idx");
    const target = edges.getChild("target_idx");
    const numEdges = edges.numRows;

    if (numEdges > this.edgeCapacity) {
      this.resizeEdges(Math.max(numEdges, this.edgeCapacity * 2));
    }

    for (let i = 0; i < numEdges; i++) {
      this.edgeSource[i] = source.get(i);
      this.edgeTarget[i] = target.get(i);
    }
    this.edgeCount = numEdges;

    this.incrementVersion();
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

  // ==================== SERIALIZATION ====================

  public toJSON(): { nodes: NodeData[], edges: EdgeData[] } {
    const nodes: NodeData[] = [];
    const edges: EdgeData[] = [];

    for (let i = 0; i < this.nodeCount; i++) {
      nodes.push({ x: this.nodeX[i], y: this.nodeY[i] });
    }

    for (let i = 0; i < this.edgeCount; i++) {
      edges.push({ source: this.edgeSource[i], target: this.edgeTarget[i] });
    }

    return { nodes, edges };
  }
}
