import { describe, it, expect } from 'vitest';
import { GraphState } from './graph-state';

describe('GraphState', () => {
  it('should initialize with correct capacities', () => {
    const graph = new GraphState(10, 20);
    expect(graph.nodeCapacity).toBe(10);
    expect(graph.edgeCapacity).toBe(20);
    expect(graph.nodeX.length).toBe(10);
    expect(graph.edgeSource.length).toBe(20);
  });

  it('should add nodes and update count', () => {
    const graph = new GraphState(10, 10);
    const id1 = graph.addNode(1.0, 2.0);
    const id2 = graph.addNode(3.0, 4.0);

    expect(id1).toBe(0);
    expect(id2).toBe(1);
    expect(graph.nodeCount).toBe(2);
    expect(graph.nodeX[0]).toBe(1.0);
    expect(graph.nodeY[0]).toBe(2.0);
    expect(graph.nodeX[1]).toBe(3.0);
    expect(graph.nodeY[1]).toBe(4.0);
  });

  it('should resize nodes when capacity exceeded', () => {
    const graph = new GraphState(2, 2);
    graph.addNode(1, 1);
    graph.addNode(2, 2);
    
    // This should trigger resize
    graph.addNode(3, 3);

    expect(graph.nodeCapacity).toBe(4); // 2 * 2
    expect(graph.nodeCount).toBe(3);
    expect(graph.nodeX[2]).toBe(3);
  });

  it('should add edges and update count', () => {
    const graph = new GraphState(10, 10);
    const id = graph.addEdge(0, 1);
    
    expect(id).toBe(0);
    expect(graph.edgeCount).toBe(1);
    expect(graph.edgeSource[0]).toBe(0);
    expect(graph.edgeTarget[0]).toBe(1);
  });

  it('should resize edges when capacity exceeded', () => {
    const graph = new GraphState(10, 2);
    graph.addEdge(0, 1);
    graph.addEdge(1, 2);
    
    // This should trigger resize
    graph.addEdge(2, 3);

    expect(graph.edgeCapacity).toBe(4); // 2 * 2
    expect(graph.edgeCount).toBe(3);
    expect(graph.edgeSource[2]).toBe(2);
  });
});





