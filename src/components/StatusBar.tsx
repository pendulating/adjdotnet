import type { EditorMode, Selection } from '../lib/editor-state';
import { selectionCount } from '../lib/editor-state';

interface StatusBarProps {
  nodeCount: number;
  edgeCount: number;
  fps: number;
  selection: Selection;
  mode: EditorMode;
  pendingEdgeSource: number | null;
  polygonPointCount: number;
}

export function StatusBar({
  nodeCount,
  edgeCount,
  fps,
  selection,
  mode,
  pendingEdgeSource,
  polygonPointCount,
}: StatusBarProps) {
  return (
    <div className="stats">
      <span>{nodeCount.toLocaleString()} nodes</span>
      <span>{edgeCount.toLocaleString()} edges</span>
      <span>{fps} fps</span>
      
      {selectionCount(selection) > 0 && (
        <span className="selection-info">
          {selection.nodes.size > 0 && `${selection.nodes.size} nodes`}
          {selection.nodes.size > 0 && selection.edges.size > 0 && ', '}
          {selection.edges.size > 0 && `${selection.edges.size} edges`}
          {' selected'}
        </span>
      )}
      
      {pendingEdgeSource !== null && (
        <span className="mode-hint">Click target node to create edge</span>
      )}
      
      {mode === 'polygonSelect' && polygonPointCount > 0 && (
        <span className="mode-hint">
          {polygonPointCount} points • Double-click or Enter to select
        </span>
      )}
      
      {mode === 'lassoSelect' && polygonPointCount === 0 && (
        <span className="mode-hint">Click and drag to draw selection</span>
      )}
    </div>
  );
}

