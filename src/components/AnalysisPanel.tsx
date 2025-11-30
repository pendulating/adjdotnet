interface GraphStatistics {
  nodeCount: number;
  edgeCount: number;
  numComponents: number;
  giantComponentSize: number;
  giantComponentPercent: number;
  avgDegree: number;
  isolatedNodes: number;
}

interface AnalysisPanelProps {
  isOpen: boolean;
  onToggle: () => void;
  graphStats: GraphStatistics | null;
  isComputing: boolean;
  colorMode: 0 | 1 | 2;
  onComputeStatistics: () => void;
  onSetColorMode: (mode: 0 | 1 | 2) => void;
  onSelectGiantComponent: () => void;
  onRemoveIsolatedNodes: () => void;
  onKeepOnlyGiantComponent: () => void;
}

export function AnalysisPanel({
  isOpen,
  onToggle,
  graphStats,
  isComputing,
  colorMode,
  onComputeStatistics,
  onSetColorMode,
  onSelectGiantComponent,
  onRemoveIsolatedNodes,
  onKeepOnlyGiantComponent,
}: AnalysisPanelProps) {
  const handleToggle = () => {
    onToggle();
    if (!isOpen && !graphStats) {
      onComputeStatistics();
    }
  };

  return (
    <div className={`analysis-panel ${isOpen ? 'open' : ''}`}>
      <button className="analysis-toggle" onClick={handleToggle}>
        {isOpen ? '▶' : '◀'} Analysis
      </button>

      {isOpen && (
        <div className="analysis-content">
          <h3>Graph Analysis</h3>

          {isComputing ? (
            <div className="computing">Computing...</div>
          ) : graphStats ? (
            <>
              <div className="stat-group">
                <div className="stat-row">
                  <span className="stat-label">Nodes</span>
                  <span className="stat-value">{graphStats.nodeCount.toLocaleString()}</span>
                </div>
                <div className="stat-row">
                  <span className="stat-label">Edges</span>
                  <span className="stat-value">{graphStats.edgeCount.toLocaleString()}</span>
                </div>
                <div className="stat-row">
                  <span className="stat-label">Avg Degree</span>
                  <span className="stat-value">{graphStats.avgDegree.toFixed(2)}</span>
                </div>
              </div>

              <div className="stat-group">
                <h4>Connectivity</h4>
                <div className="stat-row">
                  <span className="stat-label">Components</span>
                  <span className="stat-value">{graphStats.numComponents.toLocaleString()}</span>
                </div>
                <div className="stat-row highlight">
                  <span className="stat-label">Giant Component</span>
                  <span className="stat-value">
                    {graphStats.giantComponentSize.toLocaleString()}
                    <small> ({graphStats.giantComponentPercent.toFixed(1)}%)</small>
                  </span>
                </div>
                <div className="stat-row">
                  <span className="stat-label">Isolated Nodes</span>
                  <span className="stat-value">{graphStats.isolatedNodes.toLocaleString()}</span>
                </div>
              </div>

              <div className="action-group">
                <h4>Visualization</h4>
                <button
                  onClick={() => onSetColorMode(colorMode === 1 ? 0 : 1)}
                  className={colorMode === 1 ? 'active' : ''}
                >
                  {colorMode === 1 ? '● ' : '○ '}
                  Color All Components
                </button>
                <button
                  onClick={() => onSetColorMode(colorMode === 2 ? 0 : 2)}
                  className={colorMode === 2 ? 'active highlight-giant' : ''}
                >
                  {colorMode === 2 ? '● ' : '○ '}
                  Highlight Giant Only
                </button>
                <button onClick={onSelectGiantComponent}>
                  Select Giant Component
                </button>
              </div>

              <div className="action-group">
                <h4>Clean Up</h4>
                <button onClick={onRemoveIsolatedNodes}>
                  Remove Isolated Nodes
                </button>
                <button onClick={onKeepOnlyGiantComponent} className="destructive">
                  Keep Only Giant Component
                </button>
              </div>

              <button className="refresh-btn" onClick={onComputeStatistics}>
                ↻ Refresh Statistics
              </button>
            </>
          ) : (
            <button onClick={onComputeStatistics}>Compute Statistics</button>
          )}
        </div>
      )}
    </div>
  );
}

export type { GraphStatistics };

