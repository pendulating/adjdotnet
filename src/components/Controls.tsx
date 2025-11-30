interface ControlsProps {
  canUndo: boolean;
  canRedo: boolean;
  canDelete: boolean;
  basemapEnabled: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onDelete: () => void;
  onResetView: () => void;
  onToggleBasemap: () => void;
}

export function Controls({
  canUndo,
  canRedo,
  canDelete,
  basemapEnabled,
  onUndo,
  onRedo,
  onDelete,
  onResetView,
  onToggleBasemap,
}: ControlsProps) {
  return (
    <div className="controls">
      <button onClick={onUndo} disabled={!canUndo} title="Undo (Ctrl+Z)">
        ↶ Undo
      </button>
      <button onClick={onRedo} disabled={!canRedo} title="Redo (Ctrl+Y)">
        ↷ Redo
      </button>
      <button
        onClick={onDelete}
        disabled={!canDelete}
        title="Delete Selection (Del)"
      >
        🗑 Delete
      </button>
      <span className="separator" />
      <button onClick={onResetView}>Reset View</button>
      <button
        onClick={onToggleBasemap}
        className={basemapEnabled ? 'active' : ''}
      >
        {basemapEnabled ? 'Hide Map' : 'Show Map'}
      </button>
    </div>
  );
}

