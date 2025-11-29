import { useEffect, useRef, useState } from 'react';
import './App.css';
import { WebGPURenderer } from './lib/renderer';
import { GraphState } from './lib/graph-state';
import { DuckDBLayer } from './lib/duckdb';

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [renderer, setRenderer] = useState<WebGPURenderer | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function init() {
      try {
        // 1. Init DuckDB
        const db = DuckDBLayer.getInstance();
        await db.init();
        await db.loadParquet('/data/nodes.parquet', 'nodes');
        await db.loadParquet('/data/edges.parquet', 'edges');

        // 2. Load Data to GraphState
        const graph = new GraphState();
        
        // Fetch data back from DuckDB as Arrow
        // In a real app, we might scan the parquet file directly to arrow without SQL query overhead if trivial
        // but here we use SQL to filter if needed.
        const nodesConn = await db.query('SELECT * FROM nodes');
        const edgesConn = await db.query('SELECT * FROM edges');
        
        graph.loadFromArrow(nodesConn, edgesConn);

        // 3. Init WebGPU
        if (canvasRef.current) {
            const r = new WebGPURenderer(canvasRef.current, graph);
            await r.init();
            setRenderer(r);
        }
        setLoading(false);
      } catch (e) {
        console.error(e);
      }
    }
    init();

    return () => {
        renderer?.destroy();
    }
  }, []);

  return (
    <div className="app-container">
      <div className="overlay">
        <h1>WebGPU Network Inspector</h1>
        {loading && <p>Loading data...</p>}
        <div className="controls">
            <button onClick={() => console.log('Run Physics')}>Run Physics</button>
        </div>
      </div>
      <canvas 
        ref={canvasRef} 
        width={window.innerWidth} 
        height={window.innerHeight} 
        style={{ display: 'block' }}
      />
    </div>
  );
}

export default App;




