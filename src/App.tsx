import { useEffect, useRef, useState, useCallback } from 'react';
import './App.css';
import { WebGPURenderer } from './lib/renderer';
import { GraphState } from './lib/graph-state';
import { DuckDBLayer } from './lib/duckdb';

interface NetworkMetadata {
  center_x: number;
  center_y: number;
  crs: string;
}

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<WebGPURenderer | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState({ nodes: 0, edges: 0, fps: 0 });

  // Pan/zoom state
  const isDragging = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });

  useEffect(() => {
    let cancelled = false;
    
    async function init() {
      try {
        // Load metadata first
        const metaRes = await fetch('/data/network_metadata.json');
        const metadata: NetworkMetadata = await metaRes.json();

        if (cancelled) return;

        // Init DuckDB
        const db = DuckDBLayer.getInstance();
        await db.init();
        
        if (cancelled) return;

        await db.loadParquet('/data/nodes.parquet', 'nodes');
        await db.loadParquet('/data/edges.parquet', 'edges');

        if (cancelled) return;

        // Load data to GraphState
        const graph = new GraphState();
        const nodesResult = await db.query('SELECT * FROM nodes');
        const edgesResult = await db.query('SELECT * FROM edges');
        
        graph.loadFromArrow(nodesResult, edgesResult);

        if (cancelled) return;

        setStats(s => ({ ...s, nodes: graph.nodeCount, edges: graph.edgeCount }));

        // Wait for canvas to be ready
        const canvas = canvasRef.current;
        if (!canvas) {
          console.error('Canvas not ready');
          return;
        }
        
        // Set canvas size to match display
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;

        const renderer = new WebGPURenderer(canvas, graph);
        await renderer.init();

        if (cancelled) {
          renderer.destroy();
          return;
        }

        // Center camera on data (node positions are offsets from center, so center at origin)
        // Initial zoom based on typical sidewalk network extent (~2km)
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

  // Mouse handlers for pan/zoom
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    isDragging.current = true;
    lastMouse.current = { x: e.clientX, y: e.clientY };
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging.current || !rendererRef.current) return;
    
    const dx = e.clientX - lastMouse.current.x;
    const dy = e.clientY - lastMouse.current.y;
    
    rendererRef.current.pan(dx, dy);
    
    lastMouse.current = { x: e.clientX, y: e.clientY };
  }, []);

  const handleMouseUp = useCallback(() => {
    isDragging.current = false;
  }, []);

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

  const resetView = useCallback(() => {
    if (!rendererRef.current) return;
    rendererRef.current.setCamera(0, 0, 0.1);
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
          <div className="controls">
            <button onClick={resetView}>Reset View</button>
          </div>
        )}
      </div>

      <div className="stats">
        <span>{stats.nodes.toLocaleString()} nodes</span>
        <span>{stats.edges.toLocaleString()} edges</span>
        <span>{stats.fps} fps</span>
      </div>

      <canvas
        ref={canvasRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
        style={{ cursor: isDragging.current ? 'grabbing' : 'grab' }}
      />
    </div>
  );
}

export default App;
