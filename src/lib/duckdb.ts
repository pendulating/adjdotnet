import * as duckdb from '@duckdb/duckdb-wasm';
import duckdb_wasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import duckdb_wasm_eh from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import duckdb_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import duckdb_worker_eh from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';

export class DuckDBLayer {
  private static instance: DuckDBLayer;
  private db: duckdb.AsyncDuckDB | null = null;
  private conn: duckdb.AsyncDuckDBConnection | null = null;

  private constructor() {}

  public static getInstance(): DuckDBLayer {
    if (!DuckDBLayer.instance) {
      DuckDBLayer.instance = new DuckDBLayer();
    }
    return DuckDBLayer.instance;
  }

  public async init() {
    if (this.db) return;

    const MANUAL_BUNDLES: duckdb.DuckDBBundles = {
      mvp: {
        mainModule: duckdb_wasm,
        mainWorker: duckdb_worker,
      },
      eh: {
        mainModule: duckdb_wasm_eh,
        mainWorker: duckdb_worker_eh,
      },
    };

    // Select a bundle based on browser support
    const bundle = await duckdb.selectBundle(MANUAL_BUNDLES);
    // Instantiate the worker
    const worker = new Worker(bundle.mainWorker!);
    const logger = new duckdb.ConsoleLogger();
    
    this.db = new duckdb.AsyncDuckDB(logger, worker);
    await this.db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    this.conn = await this.db.connect();

    console.log("DuckDB initialized");
  }

  public async loadParquet(url: string, tableName: string) {
    if (!this.db || !this.conn) throw new Error("DuckDB not initialized");

    const res = await fetch(url);
    const buffer = await res.arrayBuffer();
    
    await this.db.registerFileBuffer(url, new Uint8Array(buffer));
    
    await this.conn.query(`
      CREATE TABLE ${tableName} AS SELECT * FROM parquet_scan('${url}')
    `);
    
    console.log(`Table ${tableName} created from ${url}`);
  }

  public async query(sql: string) {
    if (!this.conn) throw new Error("DuckDB not connected");
    return await this.conn.query(sql);
  }
}




