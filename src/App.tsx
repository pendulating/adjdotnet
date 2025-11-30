import { useEffect, useRef, useState, useCallback } from 'react';
import './App.css';
import { WebGPURenderer } from './lib/renderer';
import { GraphState } from './lib/graph-state';
import { DuckDBLayer } from './lib/duckdb';
import { TILE_PROVIDERS, CUSTOM_TILE_PROVIDERS } from './lib/tile-layer';
import type { EditorMode, Selection, Point } from './lib/editor-state';
import {
  createEmptySelection,
  toggleNodeSelection,
  toggleEdgeSelection,
  selectionCount,
  selectNodes,
  CommandHistory,
  AddNodeCommand,
  AddEdgeCommand,
  MoveNodeCommand,
  BatchDeleteCommand,
  findNodesInPolygon,
  simplifyPath,
} from './lib/editor-state';

// Components
import {
  Toolbar,
  Controls,
  BasemapSelector,
  StatusBar,
  AnalysisPanel,
  DataLayersPanel,
} from './components';
import type { GraphStatistics } from './components';

// Hooks
import { useDataLayers, useCamera } from './hooks';

interface NetworkMetadata {
  center_x: number;
  center_y: number;
  crs: string;
}

// Hit detection threshold in pixels
const HIT_THRESHOLD_PX = 12;

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<WebGPURenderer | null>(null);
  const graphRef = useRef<GraphState | null>(null);
  const commandHistoryRef = useRef<CommandHistory>(new CommandHistory());

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState({ nodes: 0, edges: 0, fps: 0 });
  const [basemapEnabled, setBasemapEnabled] = useState(true);
  const [basemapStyle, setBasemapStyle] = useState<string>('cartoDark');

  // Editor state
  const [mode, setMode] = useState<EditorMode>('pan');
  const [selection, setSelection] = useState<Selection>(createEmptySelection());
  const [pendingEdgeSource, setPendingEdgeSource] = useState<number | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  // Analysis state
  const [showAnalysisPanel, setShowAnalysisPanel] = useState(false);
  const [graphStats, setGraphStats] = useState<GraphStatistics | null>(null);
  const [colorMode, setColorModeState] = useState<0 | 1 | 2>(0);
  const [isComputing, setIsComputing] = useState(false);

  // Data layers panel state
  const [showRecipesPanel, setShowRecipesPanel] = useState(false);

  // Drag state
  const isDragging = useRef(false);
  const dragStartScreen = useRef({ x: 0, y: 0 });
  const dragStartWorld = useRef({ x: 0, y: 0 });
  const draggedNodes = useRef<Map<number, { startX: number; startY: number }>>(new Map());

  // Polygon/Lasso selection state
  const [polygonPoints, setPolygonPoints] = useState<Point[]>([]);
  const isDrawingLassoRef = useRef(false);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);

  // Camera hook
  const { cameraVersion, pan, zoomAt, resetView } = useCamera({
    renderer: rendererRef.current,
  });

  // Data layers hook
  const {
    activeDatasets,
    datasetLoading,
    datasetError,
    showZoomWarning,
    addRecipeDatasets,
    toggleDataset,
    removeDataset,
    addCustomDataset,
    clearError,
  } = useDataLayers({
    renderer: rendererRef.current,
    loading,
    cameraVersion,
  });

  // Initialize
  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const metaRes = await fetch('/data/network_metadata.json');
        const metadata: NetworkMetadata = await metaRes.json();

        if (cancelled) return;

        const db = DuckDBLayer.getInstance();
        await db.init();

        if (cancelled) return;

        await db.loadParquet('/data/nodes.parquet', 'nodes');
        await db.loadParquet('/data/edges.parquet', 'edges');

        if (cancelled) return;

        const graph = new GraphState();
        const nodesResult = await db.query('SELECT * FROM nodes');
        const edgesResult = await db.query('SELECT * FROM edges');

        graph.loadFromArrow(nodesResult, edgesResult);
        graphRef.current = graph;

        if (cancelled) return;

        setStats(s => ({ ...s, nodes: graph.nodeCount, edges: graph.edgeCount }));

        const canvas = canvasRef.current;
        if (!canvas) {
          console.error('Canvas not ready');
          return;
        }

        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;

        const renderer = new WebGPURenderer(canvas, graph);
        renderer.setWorldCenter(metadata.center_x, metadata.center_y);

        await renderer.init();

        if (cancelled) {
          renderer.destroy();
          return;
        }

        renderer.setCamera(0, 0, 0.1);

        renderer.setStatsCallback(({ fps }) => {
          setStats(s => ({ ...s, fps }));
        });

        rendererRef.current = renderer;
        setLoading(false);

      } catch (e) {
        if (!cancelled) {
          console.error(e);
          setError(e instanceof Error ? e.message : 'Failed to initialize');
        }
      }
    }

    init();

    return () => {
      cancelled = true;
      rendererRef.current?.destroy();
      rendererRef.current = null;
    };
  }, []);

  // Update stats when graph changes
  const updateStats = useCallback(() => {
    if (graphRef.current) {
      setStats(s => ({
        ...s,
        nodes: graphRef.current!.nodeCount,
        edges: graphRef.current!.edgeCount,
      }));
    }
    setCanUndo(commandHistoryRef.current.canUndo());
    setCanRedo(commandHistoryRef.current.canRedo());
  }, []);

  // Sync selection to renderer
  useEffect(() => {
    rendererRef.current?.setSelection(selection);
  }, [selection]);

  // Draw polygon/lasso overlay
  useEffect(() => {
    const overlayCanvas = overlayCanvasRef.current;
    const mainCanvas = canvasRef.current;
    const renderer = rendererRef.current;
    if (!overlayCanvas || !mainCanvas || !renderer) return;

    const rect = mainCanvas.getBoundingClientRect();
    overlayCanvas.width = rect.width;
    overlayCanvas.height = rect.height;

    const ctx = overlayCanvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

    if (polygonPoints.length < 2) return;

    const dpr = window.devicePixelRatio || 1;
    const screenPoints = polygonPoints.map(p => {
      const screen = renderer.worldToScreen(p.x, p.y);
      return { x: screen.x / dpr, y: screen.y / dpr };
    });

    ctx.beginPath();
    ctx.moveTo(screenPoints[0].x, screenPoints[0].y);
    for (let i = 1; i < screenPoints.length; i++) {
      ctx.lineTo(screenPoints[i].x, screenPoints[i].y);
    }

    if (polygonPoints.length >= 3) {
      ctx.closePath();
    }

    ctx.fillStyle = mode === 'lassoSelect'
      ? 'rgba(34, 197, 94, 0.2)'
      : 'rgba(59, 130, 246, 0.15)';
    ctx.fill();

    ctx.strokeStyle = mode === 'lassoSelect' ? '#22c55e' : '#3b82f6';
    ctx.lineWidth = 2;
    ctx.setLineDash(mode === 'polygonSelect' ? [5, 5] : []);
    ctx.stroke();

    if (mode === 'polygonSelect') {
      ctx.fillStyle = '#3b82f6';
      for (const p of screenPoints) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }, [polygonPoints, mode]);

  // Handle resize
  useEffect(() => {
    const handleResize = () => {
      if (!canvasRef.current) return;
      const dpr = window.devicePixelRatio || 1;
      const rect = canvasRef.current.getBoundingClientRect();
      canvasRef.current.width = rect.width * dpr;
      canvasRef.current.height = rect.height * dpr;
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (!e.ctrlKey && !e.metaKey) {
        switch (e.key.toLowerCase()) {
          case 'v': setMode('pan'); setPolygonPoints([]); return;
          case 's': setMode('select'); setPolygonPoints([]); return;
          case 'p': setMode('polygonSelect'); setPolygonPoints([]); return;
          case 'l': setMode('lassoSelect'); setPolygonPoints([]); return;
          case 'n': setMode('addNode'); setPolygonPoints([]); return;
          case 'e': setMode('addEdge'); setPendingEdgeSource(null); setPolygonPoints([]); return;
          case 'x': setMode('delete'); setPolygonPoints([]); return;
          case 'escape':
            setSelection(createEmptySelection());
            setPendingEdgeSource(null);
            setPolygonPoints([]);
            rendererRef.current?.setPreviewEdge(false);
            return;
          case 'enter':
            if (mode === 'polygonSelect' && polygonPoints.length >= 3) {
              completePolygonSelection(e.shiftKey);
            }
            return;
          case 'delete':
          case 'backspace':
            deleteSelection();
            return;
        }
      }

      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          redo();
        } else {
          undo();
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
        e.preventDefault();
        redo();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selection, mode, polygonPoints]);

  // Hit testing
  const hitTest = useCallback((screenX: number, screenY: number): { type: 'node' | 'edge' | 'none'; idx: number } => {
    const renderer = rendererRef.current;
    const graph = graphRef.current;
    if (!renderer || !graph) return { type: 'none', idx: -1 };

    const world = renderer.screenToWorld(screenX, screenY);
    const hitRadiusWorld = HIT_THRESHOLD_PX / renderer.camera.zoom;

    const nearestNode = graph.findNearestNode(world.x, world.y, hitRadiusWorld);
    if (nearestNode >= 0) {
      return { type: 'node', idx: nearestNode };
    }

    const nearestEdge = graph.findNearestEdge(world.x, world.y, hitRadiusWorld);
    if (nearestEdge >= 0) {
      return { type: 'edge', idx: nearestEdge };
    }

    return { type: 'none', idx: -1 };
  }, []);

  // Mouse handlers
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const renderer = rendererRef.current;
    const graph = graphRef.current;
    if (!renderer || !graph) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    const screenX = (e.clientX - rect.left) * dpr;
    const screenY = (e.clientY - rect.top) * dpr;
    const world = renderer.screenToWorld(screenX, screenY);

    dragStartScreen.current = { x: e.clientX, y: e.clientY };
    dragStartWorld.current = world;

    switch (mode) {
      case 'pan':
        isDragging.current = true;
        break;

      case 'select': {
        const hit = hitTest(screenX, screenY);
        if (hit.type === 'node') {
          const newSelection = toggleNodeSelection(selection, hit.idx, e.shiftKey);
          setSelection(newSelection);

          if (newSelection.nodes.has(hit.idx)) {
            isDragging.current = true;
            draggedNodes.current.clear();
            for (const nodeIdx of newSelection.nodes) {
              draggedNodes.current.set(nodeIdx, {
                startX: graph.nodeX[nodeIdx],
                startY: graph.nodeY[nodeIdx],
              });
            }
          }
        } else if (hit.type === 'edge') {
          setSelection(toggleEdgeSelection(selection, hit.idx, e.shiftKey));
        } else {
          if (!e.shiftKey) {
            setSelection(createEmptySelection());
          }
          isDragging.current = true;
        }
        break;
      }

      case 'addNode': {
        const cmd = new AddNodeCommand(graph, world.x, world.y);
        commandHistoryRef.current.execute(cmd);
        const newNodeIdx = cmd.getNodeIdx();
        setSelection({ nodes: new Set([newNodeIdx]), edges: new Set() });
        updateStats();
        break;
      }

      case 'addEdge': {
        const hit = hitTest(screenX, screenY);
        if (hit.type === 'node') {
          if (pendingEdgeSource === null) {
            setPendingEdgeSource(hit.idx);
            setSelection({ nodes: new Set([hit.idx]), edges: new Set() });
          } else if (hit.idx !== pendingEdgeSource) {
            const cmd = new AddEdgeCommand(graph, pendingEdgeSource, hit.idx);
            commandHistoryRef.current.execute(cmd);
            const newEdgeIdx = cmd.getEdgeIdx();
            if (newEdgeIdx >= 0) {
              setSelection({ nodes: new Set(), edges: new Set([newEdgeIdx]) });
            }
            setPendingEdgeSource(null);
            renderer.setPreviewEdge(false);
            updateStats();
          }
        } else {
          setPendingEdgeSource(null);
          renderer.setPreviewEdge(false);
        }
        break;
      }

      case 'delete': {
        const hit = hitTest(screenX, screenY);
        if (hit.type === 'node') {
          const cmd = new BatchDeleteCommand(graph, [hit.idx], []);
          commandHistoryRef.current.execute(cmd);
          setSelection(createEmptySelection());
          updateStats();
        } else if (hit.type === 'edge') {
          const cmd = new BatchDeleteCommand(graph, [], [hit.idx]);
          commandHistoryRef.current.execute(cmd);
          setSelection(createEmptySelection());
          updateStats();
        }
        break;
      }

      case 'polygonSelect': {
        if (e.detail === 2 && polygonPoints.length >= 3) {
          completePolygonSelection(e.shiftKey);
        } else {
          setPolygonPoints(prev => [...prev, world]);
        }
        break;
      }

      case 'lassoSelect': {
        isDrawingLassoRef.current = true;
        setPolygonPoints([world]);
        break;
      }
    }
  }, [mode, selection, pendingEdgeSource, hitTest, updateStats, polygonPoints]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const renderer = rendererRef.current;
    const graph = graphRef.current;
    if (!renderer || !graph) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    const screenX = (e.clientX - rect.left) * dpr;
    const screenY = (e.clientY - rect.top) * dpr;
    const world = renderer.screenToWorld(screenX, screenY);

    if (mode === 'addEdge' && pendingEdgeSource !== null) {
      const srcX = graph.nodeX[pendingEdgeSource];
      const srcY = graph.nodeY[pendingEdgeSource];
      renderer.setPreviewEdge(true, srcX, srcY, world.x, world.y);
    }

    if (mode === 'lassoSelect' && isDrawingLassoRef.current) {
      setPolygonPoints(prev => [...prev, world]);
      return;
    }

    if (!isDragging.current) return;

    const dx = e.clientX - dragStartScreen.current.x;
    const dy = e.clientY - dragStartScreen.current.y;

    switch (mode) {
      case 'pan':
        pan(dx, dy);
        dragStartScreen.current = { x: e.clientX, y: e.clientY };
        break;

      case 'select':
        if (draggedNodes.current.size > 0) {
          const deltaX = world.x - dragStartWorld.current.x;
          const deltaY = world.y - dragStartWorld.current.y;

          for (const [nodeIdx, start] of draggedNodes.current) {
            graph.updateNode(nodeIdx, start.startX + deltaX, start.startY + deltaY);
          }
        }
        break;
    }
  }, [mode, pendingEdgeSource, pan]);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    const graph = graphRef.current;

    if (mode === 'select' && isDragging.current && draggedNodes.current.size > 0 && graph) {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvasRef.current?.getBoundingClientRect();
      if (rect && rendererRef.current) {
        const screenX = (e.clientX - rect.left) * dpr;
        const screenY = (e.clientY - rect.top) * dpr;
        const world = rendererRef.current.screenToWorld(screenX, screenY);

        const movedDistance = Math.hypot(
          world.x - dragStartWorld.current.x,
          world.y - dragStartWorld.current.y
        );

        if (movedDistance > 1) {
          for (const [nodeIdx, start] of draggedNodes.current) {
            const cmd = new MoveNodeCommand(graph, nodeIdx, graph.nodeX[nodeIdx], graph.nodeY[nodeIdx]);
            (cmd as any).oldX = start.startX;
            (cmd as any).oldY = start.startY;
            commandHistoryRef.current.execute(cmd);
          }
          updateStats();
        }
      }
    }

    if (mode === 'lassoSelect' && isDrawingLassoRef.current && polygonPoints.length >= 3) {
      completeLassoSelection(e.shiftKey);
    }

    isDragging.current = false;
    draggedNodes.current.clear();
    isDrawingLassoRef.current = false;
  }, [mode, updateStats, polygonPoints]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (!rendererRef.current) return;
    e.preventDefault();

    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    const x = (e.clientX - rect.left) * (window.devicePixelRatio || 1);
    const y = (e.clientY - rect.top) * (window.devicePixelRatio || 1);

    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    zoomAt(x, y, factor);
  }, [zoomAt]);

  // Actions
  const toggleBasemap = useCallback(() => {
    setBasemapEnabled(prev => {
      const next = !prev;
      rendererRef.current?.setBasemapEnabled(next);
      return next;
    });
  }, []);

  const changeBasemapStyle = useCallback((styleId: string) => {
    setBasemapStyle(styleId);
    const provider = TILE_PROVIDERS[styleId as keyof typeof TILE_PROVIDERS]
      || CUSTOM_TILE_PROVIDERS[styleId as keyof typeof CUSTOM_TILE_PROVIDERS];
    if (provider && rendererRef.current) {
      rendererRef.current.setTileProvider(provider);
    }
  }, []);

  const deleteSelection = useCallback(() => {
    const graph = graphRef.current;
    if (!graph || selectionCount(selection) === 0) return;

    const cmd = new BatchDeleteCommand(
      graph,
      Array.from(selection.nodes),
      Array.from(selection.edges)
    );
    commandHistoryRef.current.execute(cmd);
    setSelection(createEmptySelection());
    updateStats();
  }, [selection, updateStats]);

  const undo = useCallback(() => {
    const cmd = commandHistoryRef.current.undo();
    if (cmd) {
      setSelection(createEmptySelection());
      updateStats();
    }
  }, [updateStats]);

  const redo = useCallback(() => {
    const cmd = commandHistoryRef.current.redo();
    if (cmd) {
      setSelection(createEmptySelection());
      updateStats();
    }
  }, [updateStats]);

  // Mode change handler
  const handleModeChange = useCallback((newMode: EditorMode) => {
    setMode(newMode);
    if (newMode !== 'addEdge') setPendingEdgeSource(null);
    setPolygonPoints([]);
    rendererRef.current?.setPreviewEdge(false);
  }, []);

  // Cursor based on mode and state
  const getCursor = useCallback(() => {
    if (isDragging.current) {
      return mode === 'pan' ? 'grabbing' : 'move';
    }
    switch (mode) {
      case 'pan': return 'grab';
      case 'select': return 'default';
      case 'polygonSelect': return 'crosshair';
      case 'lassoSelect': return 'crosshair';
      case 'addNode': return 'crosshair';
      case 'addEdge': return pendingEdgeSource !== null ? 'crosshair' : 'pointer';
      case 'delete': return 'not-allowed';
      default: return 'default';
    }
  }, [mode, pendingEdgeSource]);

  // Complete polygon selection
  const completePolygonSelection = useCallback((addToSelection: boolean) => {
    const graph = graphRef.current;
    if (!graph || polygonPoints.length < 3) return;

    const nodesInPolygon = findNodesInPolygon(graph, polygonPoints);
    setSelection(selectNodes(selection, nodesInPolygon, addToSelection));
    setPolygonPoints([]);
  }, [polygonPoints, selection]);

  // Complete lasso selection
  const completeLassoSelection = useCallback((addToSelection: boolean) => {
    const graph = graphRef.current;
    if (!graph || polygonPoints.length < 3) return;

    const minDist = 10 / (rendererRef.current?.camera.zoom || 1);
    const simplified = simplifyPath(polygonPoints, minDist);

    if (simplified.length >= 3) {
      const nodesInLasso = findNodesInPolygon(graph, simplified);
      setSelection(selectNodes(selection, nodesInLasso, addToSelection));
    }
    setPolygonPoints([]);
  }, [polygonPoints, selection]);

  // Analysis functions
  const computeStatistics = useCallback(() => {
    const graph = graphRef.current;
    if (!graph) return;

    setIsComputing(true);
    setTimeout(() => {
      const stats = graph.computeStatistics();
      setGraphStats(stats);
      setIsComputing(false);
    }, 10);
  }, []);

  const setColorMode = useCallback((mode: 0 | 1 | 2) => {
    const renderer = rendererRef.current;
    if (!renderer) return;

    setColorModeState(mode);
    renderer.setColorMode(mode);
  }, []);

  const removeIsolatedNodes = useCallback(() => {
    const graph = graphRef.current;
    if (!graph) return;

    setIsComputing(true);
    setTimeout(() => {
      const removed = graph.removeIsolatedNodes();
      setIsComputing(false);
      updateStats();
      computeStatistics();
      alert(`Removed ${removed} isolated nodes`);
    }, 10);
  }, [updateStats, computeStatistics]);

  const keepOnlyGiantComponent = useCallback(() => {
    const graph = graphRef.current;
    if (!graph) return;

    if (!confirm('This will remove all nodes not in the giant component. Continue?')) return;

    setIsComputing(true);
    setTimeout(() => {
      const removed = graph.keepOnlyGiantComponent();
      setIsComputing(false);
      updateStats();
      computeStatistics();
      if (colorMode !== 0) {
        rendererRef.current?.updateComponentIds();
      }
      alert(`Removed ${removed} nodes from smaller components`);
    }, 10);
  }, [updateStats, computeStatistics, colorMode]);

  const selectGiantComponent = useCallback(() => {
    const graph = graphRef.current;
    if (!graph) return;

    setIsComputing(true);
    setTimeout(() => {
      const giantNodes = graph.getGiantComponentNodes();
      setSelection({ nodes: new Set(giantNodes), edges: new Set() });
      setIsComputing(false);
    }, 10);
  }, []);

  if (error) {
    return (
      <div className="error-overlay">
        <h2>Error</h2>
        <p>{error}</p>
      </div>
    );
  }

  return (
    <div className="app-container">
      {loading && (
        <div className="loading-overlay">
          <div className="loading-spinner" />
          <h2>Loading network data...</h2>
        </div>
      )}

      <div className="overlay">
        <h1>Network Inspector</h1>
        {!loading && (
          <>
            <Toolbar mode={mode} onModeChange={handleModeChange} />

            <Controls
              canUndo={canUndo}
              canRedo={canRedo}
              canDelete={selectionCount(selection) > 0}
              basemapEnabled={basemapEnabled}
              onUndo={undo}
              onRedo={redo}
              onDelete={deleteSelection}
              onResetView={resetView}
              onToggleBasemap={toggleBasemap}
            />

            {basemapEnabled && (
              <BasemapSelector
                currentStyle={basemapStyle}
                onStyleChange={changeBasemapStyle}
              />
            )}
          </>
        )}
      </div>

      <AnalysisPanel
        isOpen={showAnalysisPanel}
        onToggle={() => setShowAnalysisPanel(!showAnalysisPanel)}
        graphStats={graphStats}
        isComputing={isComputing}
        colorMode={colorMode}
        onComputeStatistics={computeStatistics}
        onSetColorMode={setColorMode}
        onSelectGiantComponent={selectGiantComponent}
        onRemoveIsolatedNodes={removeIsolatedNodes}
        onKeepOnlyGiantComponent={keepOnlyGiantComponent}
      />

      <DataLayersPanel
        isOpen={showRecipesPanel}
        onToggle={() => setShowRecipesPanel(!showRecipesPanel)}
        activeDatasets={activeDatasets}
        onAddRecipe={addRecipeDatasets}
        onToggleDataset={toggleDataset}
        onRemoveDataset={removeDataset}
        onAddCustomDataset={addCustomDataset}
        datasetLoading={datasetLoading}
        datasetError={datasetError}
        onClearError={clearError}
        showZoomWarning={showZoomWarning}
      />

      <StatusBar
        nodeCount={stats.nodes}
        edgeCount={stats.edges}
        fps={stats.fps}
        selection={selection}
        mode={mode}
        pendingEdgeSource={pendingEdgeSource}
        polygonPointCount={polygonPoints.length}
      />

      <canvas
        ref={canvasRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
        style={{ cursor: getCursor() }}
      />

      {/* Overlay canvas for polygon/lasso drawing */}
      <canvas
        ref={overlayCanvasRef}
        className="overlay-canvas"
        style={{
          pointerEvents: (mode === 'polygonSelect' || mode === 'lassoSelect') ? 'auto' : 'none',
          cursor: getCursor()
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
      />
    </div>
  );
}

export default App;
