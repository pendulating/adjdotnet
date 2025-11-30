# WebGPU Geospatial Network Inspector

This project is a high-performance, WebGPU-powered application for visualizing and editing large-scale geospatial networks (e.g., sidewalk graphs). It uses DuckDB-Wasm for data management and a custom Rust WASM module for graph metrics.

## Architecture

- **Frontend**: React + Vite + TypeScript
- **Rendering**: Custom WebGPU Renderer (Nodes/Edges/Picking)
- **Data Backend**: DuckDB-Wasm (GeoParquet loading)
- **Graph Logic**: `GraphState` (Structure of Arrays for GPU mapping)
- **Physics**: Compute Shader (Force-Directed Layout - basic integration)
- **Metrics**: Rust WASM (`petgraph`)

## Setup

1. **Install Dependencies**:
   ```bash
   cd web-app
   pnpm install
   ```

2. **Data Prep**:
   (Requires Python environment with `duckdb`, `geopandas`, `pyarrow`)
   ```bash
   python scripts/prep_web_data.py
   ```

3. **Build WASM Module**:
   (Requires `wasm-pack`)
   ```bash
   cd rust-graph
   wasm-pack build --target web
   cp -r pkg/* ../web-app/src/lib/wasm/
   ```

4. **Run Dev Server**:
   ```bash
   cd web-app
   pnpm dev
   ```

## Testing

- **Frontend Units**: `cd web-app && pnpm test` (Vitest)
- **Rust Units**: `cd rust-graph && cargo test`

## Features

- **Efficient Data Loading**: Uses Arrow for zero-copy data transfer from DuckDB to JS.
- **High Performance**: WebGPU renders 100k+ nodes efficiently.
- **Interactive**: Node picking implemented via GPU selection.
- **Resilient**: Graph state automatically resizes to accommodate new nodes/edges.





