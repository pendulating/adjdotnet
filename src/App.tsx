import { useEffect, useRef, useState, useCallback } from 'react';
import './App.css';
import { WebGPURenderer } from './lib/renderer';
import { GraphState } from './lib/graph-state';
import { DuckDBLayer } from './lib/duckdb';
import { TILE_PROVIDERS } from './lib/tile-layer';
import type { EditorMode, Selection, Point } from './lib/editor-state';
import {
  EDITOR_MODES,
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
import {
  SocrataClient,
  RECIPES,
  webMercatorToLatLon,
  convertGeoJSONToWebMercator,
  parseDatasetUrl,
} from './lib/socrata';
import type { SocrataDataset, Recipe } from './lib/socrata';

interface NetworkMetadata {
  center_x: number;
  center_y: number;
  crs: string;
}

interface GraphStatistics {
  nodeCount: number;
  edgeCount: number;
  numComponents: number;
  giantComponentSize: number;
  giantComponentPercent: number;
  avgDegree: number;
  isolatedNodes: number;
}

const BASEMAP_OPTIONS = [
  { id: 'cartoDark', label: 'Dark' },
  { id: 'cartoLight', label: 'Light' },
  { id: 'cartoVoyager', label: 'Voyager' },
  { id: 'osm', label: 'OpenStreetMap' },
] as const;

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
  const [colorMode, setColorModeState] = useState<0 | 1 | 2>(0); // 0=none, 1=all components, 2=highlight giant
  const [isComputing, setIsComputing] = useState(false);

  // Socrata/Recipes state
  const [showRecipesPanel, setShowRecipesPanel] = useState(false);
  const [activeDatasets, setActiveDatasets] = useState<SocrataDataset[]>([]);
  const [customDatasetUrl, setCustomDatasetUrl] = useState('');
  const [customDatasetName, setCustomDatasetName] = useState('');
  const [customDatasetColor, setCustomDatasetColor] = useState('#22c55e');
  const [datasetLoading, setDatasetLoading] = useState<string | null>(null);
  const [datasetError, setDatasetError] = useState<string | null>(null);
  const socrataClientRef = useRef<SocrataClient | null>(null);
  const lastViewportRef = useRef<{ minX: number; minY: number; maxX: number; maxY: number } | null>(null);

  // Zoom threshold for loading overlay data (zoom level where we load datasets)
  const OVERLAY_ZOOM_THRESHOLD = 0.5;

  // Drag state
  const isDragging = useRef(false);
  const dragStartScreen = useRef({ x: 0, y: 0 });
  const dragStartWorld = useRef({ x: 0, y: 0 });
  const draggedNodes = useRef<Map<number, { startX: number; startY: number }>>(new Map());

  // Polygon/Lasso selection state
  const [polygonPoints, setPolygonPoints] = useState<Point[]>([]);
  const isDrawingLassoRef = useRef(false);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);

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
        
        // Initialize Socrata client
        socrataClientRef.current = new SocrataClient();
        
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

    // Match overlay canvas size to main canvas
    const rect = mainCanvas.getBoundingClientRect();
    overlayCanvas.width = rect.width;
    overlayCanvas.height = rect.height;

    const ctx = overlayCanvas.getContext('2d');
    if (!ctx) return;

    // Clear canvas
    ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

    // Draw polygon/lasso if we have points
    if (polygonPoints.length < 2) return;

    // Convert world coordinates to screen coordinates
    const dpr = window.devicePixelRatio || 1;
    const screenPoints = polygonPoints.map(p => {
      const screen = renderer.worldToScreen(p.x, p.y);
      return { x: screen.x / dpr, y: screen.y / dpr };
    });

    // Draw the polygon path
    ctx.beginPath();
    ctx.moveTo(screenPoints[0].x, screenPoints[0].y);
    for (let i = 1; i < screenPoints.length; i++) {
      ctx.lineTo(screenPoints[i].x, screenPoints[i].y);
    }

    // Close the path for filling (both polygon and lasso)
    if (polygonPoints.length >= 3) {
      ctx.closePath();
    }

    // Fill with semi-transparent color
    ctx.fillStyle = mode === 'lassoSelect' 
      ? 'rgba(34, 197, 94, 0.2)'  // Green for lasso
      : 'rgba(59, 130, 246, 0.15)'; // Blue for polygon
    ctx.fill();

    // Stroke the outline
    ctx.strokeStyle = mode === 'lassoSelect' ? '#22c55e' : '#3b82f6';
    ctx.lineWidth = 2;
    ctx.setLineDash(mode === 'polygonSelect' ? [5, 5] : []);
    ctx.stroke();

    // Draw vertices for polygon mode
    if (mode === 'polygonSelect') {
      ctx.fillStyle = '#3b82f6';
      for (const p of screenPoints) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }, [polygonPoints, mode]);

  // Load overlay data for active datasets when zoomed in
  const loadOverlayData = useCallback(async () => {
    const renderer = rendererRef.current;
    const client = socrataClientRef.current;
    if (!renderer || !client || activeDatasets.length === 0) return;

    const zoom = renderer.camera.zoom;
    if (zoom < OVERLAY_ZOOM_THRESHOLD) {
      // Too zoomed out, clear overlay layers
      for (const dataset of activeDatasets) {
        renderer.removeGeoJSONLayer(dataset.id);
      }
      return;
    }

    const bounds = renderer.getViewportBounds();
    
    // Check if viewport has changed significantly
    const last = lastViewportRef.current;
    if (last) {
      const threshold = 100; // meters
      if (
        Math.abs(bounds.minX - last.minX) < threshold &&
        Math.abs(bounds.maxX - last.maxX) < threshold &&
        Math.abs(bounds.minY - last.minY) < threshold &&
        Math.abs(bounds.maxY - last.maxY) < threshold
      ) {
        return; // Viewport hasn't changed enough
      }
    }
    lastViewportRef.current = bounds;

    // Convert Web Mercator bounds to lat/lon for Socrata query
    const minCorner = webMercatorToLatLon(bounds.minX, bounds.minY);
    const maxCorner = webMercatorToLatLon(bounds.maxX, bounds.maxY);
    
    const bbox = {
      minLat: minCorner.lat,
      maxLat: maxCorner.lat,
      minLon: minCorner.lon,
      maxLon: maxCorner.lon,
    };

    // Load each active dataset
    for (const dataset of activeDatasets) {
      if (!dataset.enabled) continue;
      
      try {
        setDatasetLoading(dataset.id);
        const geojson = await client.fetchDataset(dataset, bbox);
        
        if (geojson.features && geojson.features.length > 0) {
          // Convert to Web Mercator
          const mercatorGeoJson = convertGeoJSONToWebMercator(geojson);
          
          // Extract line vertices for rendering
          const vertices: number[] = [];
          
          for (const feature of mercatorGeoJson.features) {
            const { geometry } = feature;
            
            if (geometry.type === 'LineString') {
              const coords = geometry.coordinates as number[][];
              for (let i = 0; i < coords.length - 1; i++) {
                vertices.push(coords[i][0], coords[i][1]);
                vertices.push(coords[i + 1][0], coords[i + 1][1]);
              }
            } else if (geometry.type === 'MultiLineString') {
              const lines = geometry.coordinates as number[][][];
              for (const line of lines) {
                for (let i = 0; i < line.length - 1; i++) {
                  vertices.push(line[i][0], line[i][1]);
                  vertices.push(line[i + 1][0], line[i + 1][1]);
                }
              }
            } else if (geometry.type === 'Polygon') {
              const rings = geometry.coordinates as number[][][];
              for (const ring of rings) {
                for (let i = 0; i < ring.length - 1; i++) {
                  vertices.push(ring[i][0], ring[i][1]);
                  vertices.push(ring[i + 1][0], ring[i + 1][1]);
                }
              }
            } else if (geometry.type === 'MultiPolygon') {
              const polygons = geometry.coordinates as number[][][][];
              for (const polygon of polygons) {
                for (const ring of polygon) {
                  for (let i = 0; i < ring.length - 1; i++) {
                    vertices.push(ring[i][0], ring[i][1]);
                    vertices.push(ring[i + 1][0], ring[i + 1][1]);
                  }
                }
              }
            } else if (geometry.type === 'Point') {
              // Draw a small cross for points
              const [x, y] = geometry.coordinates as number[];
              const size = 5 / renderer.camera.zoom;
              vertices.push(x - size, y, x + size, y);
              vertices.push(x, y - size, x, y + size);
            }
          }
          
          renderer.setGeoJSONLayer(dataset.id, vertices, dataset.color);
        }
        
        setDatasetLoading(null);
        setDatasetError(null);
      } catch (err) {
        console.error(`Failed to load dataset ${dataset.name}:`, err);
        setDatasetError(err instanceof Error ? err.message : 'Failed to load dataset');
        setDatasetLoading(null);
      }
    }
  }, [activeDatasets]);

  // Trigger overlay data loading on camera change (debounced)
  useEffect(() => {
    if (loading || activeDatasets.length === 0) return;
    
    const timer = setTimeout(() => {
      loadOverlayData();
    }, 300); // Debounce 300ms
    
    return () => clearTimeout(timer);
  }, [loading, activeDatasets, loadOverlayData]);

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
      // Don't handle if focused on input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      // Mode shortcuts
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
            setIsDrawingLasso(false);
            rendererRef.current?.setPreviewEdge(false);
            return;
          case 'enter':
            // Complete polygon selection
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

      // Undo/Redo
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
  }, [selection]);

  // Hit testing
  const hitTest = useCallback((screenX: number, screenY: number): { type: 'node' | 'edge' | 'none'; idx: number } => {
    const renderer = rendererRef.current;
    const graph = graphRef.current;
    if (!renderer || !graph) return { type: 'none', idx: -1 };

    const world = renderer.screenToWorld(screenX, screenY);
    const hitRadiusWorld = HIT_THRESHOLD_PX / renderer.camera.zoom;

    // Check nodes first (they're on top)
    const nearestNode = graph.findNearestNode(world.x, world.y, hitRadiusWorld);
    if (nearestNode >= 0) {
      return { type: 'node', idx: nearestNode };
    }

    // Then check edges
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

          // Start drag if clicking on a selected node
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
          // Click on empty space - start box selection or clear
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
            // First click - select source
            setPendingEdgeSource(hit.idx);
            setSelection({ nodes: new Set([hit.idx]), edges: new Set() });
          } else if (hit.idx !== pendingEdgeSource) {
            // Second click - create edge
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
          // Click on empty space - cancel
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
        // Double-click to close polygon
        if (e.detail === 2 && polygonPoints.length >= 3) {
          completePolygonSelection(e.shiftKey);
        } else {
          // Add point to polygon
          setPolygonPoints(prev => [...prev, world]);
        }
        break;
      }

      case 'lassoSelect': {
        // Start lasso drawing
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

    // Preview edge in addEdge mode
    if (mode === 'addEdge' && pendingEdgeSource !== null) {
      const srcX = graph.nodeX[pendingEdgeSource];
      const srcY = graph.nodeY[pendingEdgeSource];
      renderer.setPreviewEdge(true, srcX, srcY, world.x, world.y);
    }

    // Lasso drawing - handle before isDragging check since it uses its own ref
    if (mode === 'lassoSelect' && isDrawingLassoRef.current) {
      setPolygonPoints(prev => [...prev, world]);
      return;
    }

    if (!isDragging.current) return;

    const dx = e.clientX - dragStartScreen.current.x;
    const dy = e.clientY - dragStartScreen.current.y;

    switch (mode) {
      case 'pan':
        renderer.pan(dx, dy);
        dragStartScreen.current = { x: e.clientX, y: e.clientY };
        break;

      case 'select':
        // Drag selected nodes
        if (draggedNodes.current.size > 0) {
          const deltaX = world.x - dragStartWorld.current.x;
          const deltaY = world.y - dragStartWorld.current.y;

          for (const [nodeIdx, start] of draggedNodes.current) {
            graph.updateNode(nodeIdx, start.startX + deltaX, start.startY + deltaY);
          }
        }
        break;
    }
  }, [mode, pendingEdgeSource]);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    const graph = graphRef.current;

    // Finalize node drag as a command
    if (mode === 'select' && isDragging.current && draggedNodes.current.size > 0 && graph) {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvasRef.current?.getBoundingClientRect();
      if (rect && rendererRef.current) {
        const screenX = (e.clientX - rect.left) * dpr;
        const screenY = (e.clientY - rect.top) * dpr;
        const world = rendererRef.current.screenToWorld(screenX, screenY);

        // Check if actually moved
        const movedDistance = Math.hypot(
          world.x - dragStartWorld.current.x,
          world.y - dragStartWorld.current.y
        );

        if (movedDistance > 1) {
          // Create move commands for all dragged nodes
          // For simplicity, we create individual commands (could optimize to batch)
          for (const [nodeIdx, start] of draggedNodes.current) {
            const cmd = new MoveNodeCommand(graph, nodeIdx, graph.nodeX[nodeIdx], graph.nodeY[nodeIdx]);
            // Override the old position for correct undo
            (cmd as any).oldX = start.startX;
            (cmd as any).oldY = start.startY;
            commandHistoryRef.current.execute(cmd);
          }
          updateStats();
        }
      }
    }

    // Complete lasso selection
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
    rendererRef.current.zoomAt(x, y, factor);
  }, []);

  // Actions
  const resetView = useCallback(() => {
    rendererRef.current?.setCamera(0, 0, 0.1);
  }, []);

  const toggleBasemap = useCallback(() => {
    setBasemapEnabled(prev => {
      const next = !prev;
      rendererRef.current?.setBasemapEnabled(next);
      return next;
    });
  }, []);

  const changeBasemapStyle = useCallback((styleId: string) => {
    setBasemapStyle(styleId);
    const provider = TILE_PROVIDERS[styleId as keyof typeof TILE_PROVIDERS];
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

    // Simplify the lasso path for performance
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
    // Use setTimeout to not block UI
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

  // Dataset management functions
  const addRecipeDatasets = useCallback((recipe: Recipe) => {
    setActiveDatasets(prev => {
      const newDatasets = recipe.datasets.filter(
        d => !prev.some(existing => existing.id === d.id)
      );
      return [...prev, ...newDatasets];
    });
    // Trigger immediate load
    lastViewportRef.current = null;
    loadOverlayData();
  }, [loadOverlayData]);

  const toggleDataset = useCallback((datasetId: string) => {
    setActiveDatasets(prev => 
      prev.map(d => d.id === datasetId ? { ...d, enabled: !d.enabled } : d)
    );
    
    // If disabling, remove the layer
    const dataset = activeDatasets.find(d => d.id === datasetId);
    if (dataset?.enabled) {
      rendererRef.current?.removeGeoJSONLayer(datasetId);
    } else {
      lastViewportRef.current = null;
      loadOverlayData();
    }
  }, [activeDatasets, loadOverlayData]);

  const removeDataset = useCallback((datasetId: string) => {
    setActiveDatasets(prev => prev.filter(d => d.id !== datasetId));
    rendererRef.current?.removeGeoJSONLayer(datasetId);
  }, []);

  const addCustomDataset = useCallback(() => {
    if (!customDatasetUrl.trim()) {
      setDatasetError('Please enter a dataset URL');
      return;
    }

    const parsed = parseDatasetUrl(customDatasetUrl);
    if (!parsed) {
      setDatasetError('Invalid dataset URL format');
      return;
    }

    const newDataset: SocrataDataset = {
      id: `custom-${Date.now()}`,
      name: customDatasetName.trim() || `Custom: ${parsed.resourceId}`,
      domain: parsed.domain,
      resourceId: parsed.resourceId,
      geometryColumn: 'the_geom',
      color: customDatasetColor,
      enabled: true,
    };

    setActiveDatasets(prev => [...prev, newDataset]);
    setCustomDatasetUrl('');
    setCustomDatasetName('');
    setDatasetError(null);
    
    // Trigger load
    lastViewportRef.current = null;
    loadOverlayData();
  }, [customDatasetUrl, customDatasetName, customDatasetColor, loadOverlayData]);

  // Dummy function for setIsDrawingLasso (not used anymore but referenced)
  const setIsDrawingLasso = useCallback((_: boolean) => {}, []);

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
            {/* Mode toolbar */}
            <div className="toolbar">
              {EDITOR_MODES.map(m => (
                <button
                  key={m.id}
                  onClick={() => {
                    setMode(m.id);
                    if (m.id !== 'addEdge') setPendingEdgeSource(null);
                    setPolygonPoints([]);
                    setIsDrawingLasso(false);
                    rendererRef.current?.setPreviewEdge(false);
                  }}
                  className={mode === m.id ? 'active' : ''}
                  title={`${m.label} (${m.shortcut})`}
                >
                  <span className="icon">{m.icon}</span>
                  <span className="label">{m.label}</span>
                </button>
              ))}
            </div>

            {/* Action buttons */}
            <div className="controls">
              <button onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)">
                ↶ Undo
              </button>
              <button onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Y)">
                ↷ Redo
              </button>
              <button
                onClick={deleteSelection}
                disabled={selectionCount(selection) === 0}
                title="Delete Selection (Del)"
              >
                🗑 Delete
              </button>
              <span className="separator" />
              <button onClick={resetView}>Reset View</button>
              <button 
                onClick={toggleBasemap}
                className={basemapEnabled ? 'active' : ''}
              >
                {basemapEnabled ? 'Hide Map' : 'Show Map'}
              </button>
            </div>

            {/* Basemap selector */}
            {basemapEnabled && (
              <div className="basemap-selector">
                {BASEMAP_OPTIONS.map(opt => (
                  <button
                    key={opt.id}
                    onClick={() => changeBasemapStyle(opt.id)}
                    className={basemapStyle === opt.id ? 'active' : ''}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Analysis Panel (right side) */}
      <div className={`analysis-panel ${showAnalysisPanel ? 'open' : ''}`}>
        <button 
          className="analysis-toggle"
          onClick={() => {
            setShowAnalysisPanel(!showAnalysisPanel);
            if (!showAnalysisPanel && !graphStats) {
              computeStatistics();
            }
          }}
        >
          {showAnalysisPanel ? '▶' : '◀'} Analysis
        </button>

        {showAnalysisPanel && (
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
                    onClick={() => setColorMode(colorMode === 1 ? 0 : 1)}
                    className={colorMode === 1 ? 'active' : ''}
                  >
                    {colorMode === 1 ? '● ' : '○ '}
                    Color All Components
                  </button>
                  <button
                    onClick={() => setColorMode(colorMode === 2 ? 0 : 2)}
                    className={colorMode === 2 ? 'active highlight-giant' : ''}
                  >
                    {colorMode === 2 ? '● ' : '○ '}
                    Highlight Giant Only
                  </button>
                  <button onClick={selectGiantComponent}>
                    Select Giant Component
                  </button>
                </div>

                <div className="action-group">
                  <h4>Clean Up</h4>
                  <button onClick={removeIsolatedNodes}>
                    Remove Isolated Nodes
                  </button>
                  <button onClick={keepOnlyGiantComponent} className="destructive">
                    Keep Only Giant Component
                  </button>
                </div>

                <button className="refresh-btn" onClick={computeStatistics}>
                  ↻ Refresh Statistics
                </button>
              </>
            ) : (
              <button onClick={computeStatistics}>Compute Statistics</button>
            )}
          </div>
        )}
      </div>

      {/* Recipes Panel (left side) */}
      <div className={`recipes-panel ${showRecipesPanel ? 'open' : ''}`}>
        <button 
          className="recipes-toggle"
          onClick={() => setShowRecipesPanel(!showRecipesPanel)}
        >
          Data {showRecipesPanel ? '◀' : '▶'}
        </button>

        {showRecipesPanel && (
          <div className="recipes-content">
            <h3>Data Layers</h3>
            
            {/* Zoom warning */}
            {rendererRef.current && rendererRef.current.camera.zoom < OVERLAY_ZOOM_THRESHOLD && (
              <div className="zoom-warning">
                ⚠️ Zoom in further to load overlay data
              </div>
            )}

            {/* Active Datasets */}
            {activeDatasets.length > 0 && (
              <div className="active-datasets">
                <h4>Active Layers</h4>
                {activeDatasets.map(dataset => (
                  <div key={dataset.id} className="dataset-item">
                    <button
                      className={`dataset-toggle ${dataset.enabled ? 'enabled' : ''}`}
                      onClick={() => toggleDataset(dataset.id)}
                      style={{ borderLeftColor: dataset.color }}
                    >
                      <span className="dataset-checkbox">
                        {dataset.enabled ? '☑' : '☐'}
                      </span>
                      <span className="dataset-name">{dataset.name}</span>
                      {datasetLoading === dataset.id && (
                        <span className="loading-indicator">⋯</span>
                      )}
                    </button>
                    <button
                      className="dataset-remove"
                      onClick={() => removeDataset(dataset.id)}
                      title="Remove layer"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Recipes */}
            <div className="recipes-list">
              <h4>Recipes</h4>
              {RECIPES.map(recipe => (
                <div key={recipe.id} className="recipe-item">
                  <button
                    className="recipe-btn"
                    onClick={() => addRecipeDatasets(recipe)}
                    disabled={recipe.datasets.every(d => 
                      activeDatasets.some(a => a.id === d.id)
                    )}
                  >
                    <span className="recipe-name">{recipe.name}</span>
                    <small className="recipe-desc">{recipe.description}</small>
                  </button>
                </div>
              ))}
            </div>

            {/* Custom Dataset */}
            <div className="custom-dataset">
              <h4>Add Custom Dataset</h4>
              <input
                type="text"
                placeholder="Dataset name (optional)"
                value={customDatasetName}
                onChange={e => setCustomDatasetName(e.target.value)}
              />
              <input
                type="text"
                placeholder="Socrata URL or resource ID"
                value={customDatasetUrl}
                onChange={e => {
                  setCustomDatasetUrl(e.target.value);
                  setDatasetError(null);
                }}
              />
              <div className="color-picker-row">
                <label>Color:</label>
                <input
                  type="color"
                  value={customDatasetColor}
                  onChange={e => setCustomDatasetColor(e.target.value)}
                />
              </div>
              <button onClick={addCustomDataset}>Add Dataset</button>
              
              {datasetError && (
                <div className="dataset-error">{datasetError}</div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Status bar */}
      <div className="stats">
        <span>{stats.nodes.toLocaleString()} nodes</span>
        <span>{stats.edges.toLocaleString()} edges</span>
        <span>{stats.fps} fps</span>
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
        {mode === 'polygonSelect' && polygonPoints.length > 0 && (
          <span className="mode-hint">
            {polygonPoints.length} points • Double-click or Enter to select
          </span>
        )}
        {mode === 'lassoSelect' && polygonPoints.length === 0 && (
          <span className="mode-hint">Click and drag to draw selection</span>
        )}
      </div>

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
