import type { EditorMode } from '../lib/editor-state';
import { EDITOR_MODES } from '../lib/editor-state';

interface ToolbarProps {
  mode: EditorMode;
  onModeChange: (mode: EditorMode) => void;
}

export function Toolbar({ mode, onModeChange }: ToolbarProps) {
  return (
    <div className="toolbar">
      {EDITOR_MODES.map(m => (
        <button
          key={m.id}
          onClick={() => onModeChange(m.id)}
          className={mode === m.id ? 'active' : ''}
          title={`${m.label} (${m.shortcut})`}
        >
          <span className="icon">{m.icon}</span>
          <span className="label">{m.label}</span>
        </button>
      ))}
    </div>
  );
}

