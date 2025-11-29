// Editor State: Selection, Modes, and Command History
import { GraphState } from './graph-state';

// ==================== EDITOR MODES ====================

export type EditorMode = 'pan' | 'select' | 'addNode' | 'addEdge' | 'delete';

export const EDITOR_MODES: { id: EditorMode; label: string; shortcut: string; icon: string }[] = [
  { id: 'pan', label: 'Pan', shortcut: 'V', icon: '✋' },
  { id: 'select', label: 'Select', shortcut: 'S', icon: '⬚' },
  { id: 'addNode', label: 'Add Node', shortcut: 'N', icon: '◉' },
  { id: 'addEdge', label: 'Add Edge', shortcut: 'E', icon: '╱' },
  { id: 'delete', label: 'Delete', shortcut: 'X', icon: '✕' },
];

// ==================== SELECTION STATE ====================

export interface Selection {
  nodes: Set<number>;
  edges: Set<number>;
}

export function createEmptySelection(): Selection {
  return { nodes: new Set(), edges: new Set() };
}

export function selectionCount(sel: Selection): number {
  return sel.nodes.size + sel.edges.size;
}

export function clearSelection(sel: Selection): Selection {
  return { nodes: new Set(), edges: new Set() };
}

export function toggleNodeSelection(sel: Selection, nodeIdx: number, multi: boolean): Selection {
  const newNodes = multi ? new Set(sel.nodes) : new Set<number>();
  const newEdges = multi ? new Set(sel.edges) : new Set<number>();

  if (newNodes.has(nodeIdx)) {
    newNodes.delete(nodeIdx);
  } else {
    newNodes.add(nodeIdx);
  }
  return { nodes: newNodes, edges: newEdges };
}

export function toggleEdgeSelection(sel: Selection, edgeIdx: number, multi: boolean): Selection {
  const newNodes = multi ? new Set(sel.nodes) : new Set<number>();
  const newEdges = multi ? new Set(sel.edges) : new Set<number>();

  if (newEdges.has(edgeIdx)) {
    newEdges.delete(edgeIdx);
  } else {
    newEdges.add(edgeIdx);
  }
  return { nodes: newNodes, edges: newEdges };
}

export function selectNodes(sel: Selection, nodeIndices: number[], multi: boolean): Selection {
  const newNodes = multi ? new Set(sel.nodes) : new Set<number>();
  const newEdges = multi ? new Set(sel.edges) : new Set<number>();
  for (const idx of nodeIndices) {
    newNodes.add(idx);
  }
  return { nodes: newNodes, edges: newEdges };
}

// ==================== COMMAND PATTERN (UNDO/REDO) ====================

export interface Command {
  execute(): void;
  undo(): void;
  description: string;
}

export class CommandHistory {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private maxHistory: number;

  constructor(maxHistory: number = 100) {
    this.maxHistory = maxHistory;
  }

  public execute(cmd: Command): void {
    cmd.execute();
    this.undoStack.push(cmd);
    this.redoStack = []; // Clear redo stack on new action

    // Trim history if too long
    if (this.undoStack.length > this.maxHistory) {
      this.undoStack.shift();
    }
  }

  public undo(): Command | null {
    const cmd = this.undoStack.pop();
    if (cmd) {
      cmd.undo();
      this.redoStack.push(cmd);
      return cmd;
    }
    return null;
  }

  public redo(): Command | null {
    const cmd = this.redoStack.pop();
    if (cmd) {
      cmd.execute();
      this.undoStack.push(cmd);
      return cmd;
    }
    return null;
  }

  public canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  public canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  public clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}

// ==================== GRAPH COMMANDS ====================

export class AddNodeCommand implements Command {
  private graph: GraphState;
  private x: number;
  private y: number;
  private nodeIdx: number = -1;
  public description: string;

  constructor(graph: GraphState, x: number, y: number) {
    this.graph = graph;
    this.x = x;
    this.y = y;
    this.description = `Add node at (${x.toFixed(1)}, ${y.toFixed(1)})`;
  }

  execute(): void {
    this.nodeIdx = this.graph.addNode(this.x, this.y);
  }

  undo(): void {
    if (this.nodeIdx >= 0) {
      this.graph.removeNode(this.nodeIdx);
      this.nodeIdx = -1;
    }
  }

  getNodeIdx(): number {
    return this.nodeIdx;
  }
}

export class RemoveNodeCommand implements Command {
  private graph: GraphState;
  private nodeIdx: number;
  private savedX: number = 0;
  private savedY: number = 0;
  private savedEdges: { source: number; target: number }[] = [];
  public description: string;

  constructor(graph: GraphState, nodeIdx: number) {
    this.graph = graph;
    this.nodeIdx = nodeIdx;
    this.description = `Remove node ${nodeIdx}`;
  }

  execute(): void {
    // Save node data
    this.savedX = this.graph.nodeX[this.nodeIdx];
    this.savedY = this.graph.nodeY[this.nodeIdx];

    // Save connected edges
    this.savedEdges = [];
    for (let i = 0; i < this.graph.edgeCount; i++) {
      if (this.graph.edgeSource[i] === this.nodeIdx || this.graph.edgeTarget[i] === this.nodeIdx) {
        this.savedEdges.push({
          source: this.graph.edgeSource[i],
          target: this.graph.edgeTarget[i],
        });
      }
    }

    this.graph.removeNode(this.nodeIdx);
  }

  undo(): void {
    // Re-add node at original position
    // Note: This may not restore the exact same index due to compaction
    const newIdx = this.graph.addNode(this.savedX, this.savedY);

    // Re-add edges (with remapped indices if necessary)
    for (const edge of this.savedEdges) {
      let src = edge.source === this.nodeIdx ? newIdx : edge.source;
      let tgt = edge.target === this.nodeIdx ? newIdx : edge.target;
      this.graph.addEdge(src, tgt);
    }
  }
}

export class MoveNodeCommand implements Command {
  private graph: GraphState;
  private nodeIdx: number;
  private oldX: number;
  private oldY: number;
  private newX: number;
  private newY: number;
  public description: string;

  constructor(graph: GraphState, nodeIdx: number, newX: number, newY: number) {
    this.graph = graph;
    this.nodeIdx = nodeIdx;
    this.oldX = graph.nodeX[nodeIdx];
    this.oldY = graph.nodeY[nodeIdx];
    this.newX = newX;
    this.newY = newY;
    this.description = `Move node ${nodeIdx}`;
  }

  execute(): void {
    this.graph.updateNode(this.nodeIdx, this.newX, this.newY);
  }

  undo(): void {
    this.graph.updateNode(this.nodeIdx, this.oldX, this.oldY);
  }

  // Allow updating the target position (for dragging)
  updateTarget(x: number, y: number): void {
    this.newX = x;
    this.newY = y;
  }
}

export class AddEdgeCommand implements Command {
  private graph: GraphState;
  private source: number;
  private target: number;
  private edgeIdx: number = -1;
  public description: string;

  constructor(graph: GraphState, source: number, target: number) {
    this.graph = graph;
    this.source = source;
    this.target = target;
    this.description = `Add edge ${source} → ${target}`;
  }

  execute(): void {
    this.edgeIdx = this.graph.addEdge(this.source, this.target);
  }

  undo(): void {
    if (this.edgeIdx >= 0) {
      this.graph.removeEdge(this.edgeIdx);
      this.edgeIdx = -1;
    }
  }

  getEdgeIdx(): number {
    return this.edgeIdx;
  }
}

export class RemoveEdgeCommand implements Command {
  private graph: GraphState;
  private edgeIdx: number;
  private savedSource: number = 0;
  private savedTarget: number = 0;
  public description: string;

  constructor(graph: GraphState, edgeIdx: number) {
    this.graph = graph;
    this.edgeIdx = edgeIdx;
    this.description = `Remove edge ${edgeIdx}`;
  }

  execute(): void {
    this.savedSource = this.graph.edgeSource[this.edgeIdx];
    this.savedTarget = this.graph.edgeTarget[this.edgeIdx];
    this.graph.removeEdge(this.edgeIdx);
  }

  undo(): void {
    this.graph.addEdge(this.savedSource, this.savedTarget);
  }
}

// Batch delete command for multi-selection
export class BatchDeleteCommand implements Command {
  private commands: Command[] = [];
  public description: string;

  constructor(graph: GraphState, nodeIndices: number[], edgeIndices: number[]) {
    // Delete edges first (before their nodes are removed)
    // Sort in descending order to avoid index shifting issues
    const sortedEdges = [...edgeIndices].sort((a, b) => b - a);
    for (const idx of sortedEdges) {
      this.commands.push(new RemoveEdgeCommand(graph, idx));
    }

    // Then delete nodes (sorted descending)
    const sortedNodes = [...nodeIndices].sort((a, b) => b - a);
    for (const idx of sortedNodes) {
      this.commands.push(new RemoveNodeCommand(graph, idx));
    }

    const nodeStr = nodeIndices.length > 0 ? `${nodeIndices.length} nodes` : '';
    const edgeStr = edgeIndices.length > 0 ? `${edgeIndices.length} edges` : '';
    this.description = `Delete ${[nodeStr, edgeStr].filter(Boolean).join(' and ')}`;
  }

  execute(): void {
    for (const cmd of this.commands) {
      cmd.execute();
    }
  }

  undo(): void {
    // Undo in reverse order
    for (let i = this.commands.length - 1; i >= 0; i--) {
      this.commands[i].undo();
    }
  }
}

// ==================== EDITOR STATE ====================

export interface EditorState {
  mode: EditorMode;
  selection: Selection;
  // For addEdge mode: the first node clicked
  pendingEdgeSource: number | null;
  // For drag operations
  isDragging: boolean;
  dragStartWorld: { x: number; y: number } | null;
  draggedNodes: Map<number, { startX: number; startY: number }>;
}

export function createEditorState(): EditorState {
  return {
    mode: 'select',
    selection: createEmptySelection(),
    pendingEdgeSource: null,
    isDragging: false,
    dragStartWorld: null,
    draggedNodes: new Map(),
  };
}

