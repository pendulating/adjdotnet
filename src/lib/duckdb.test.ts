import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DuckDBLayer } from './duckdb';

// Mock Worker
global.Worker = class Worker {
    constructor(stringUrl) {}
    postMessage(msg) {}
    onmessage() {}
    terminate() {}
} as any;

// Mock the @duckdb/duckdb-wasm module
vi.mock('@duckdb/duckdb-wasm', async () => {
  return {
    AsyncDuckDB: class MockAsyncDuckDB {
      async instantiate() { return; }
      async connect() { 
          return {
              query: vi.fn().mockResolvedValue({ numRows: 100 })
          };
      }
      async registerFileBuffer() { return; }
    },
    ConsoleLogger: class {},
    selectBundle: async () => ({
        mainModule: 'mock-module',
        mainWorker: 'mock-worker'
    })
  };
});

describe('DuckDBLayer', () => {
    // Reset singleton before each test if possible, but singleton pattern makes it hard.
    // We will just test the singleton instance.
    
    it('should be a singleton', () => {
        const db1 = DuckDBLayer.getInstance();
        const db2 = DuckDBLayer.getInstance();
        expect(db1).toBe(db2);
    });

    it('should initialize successfully', async () => {
        const db = DuckDBLayer.getInstance();
        await expect(db.init()).resolves.not.toThrow();
    });

    // Since we mocked connect(), query should work
    it('should run a query', async () => {
        const db = DuckDBLayer.getInstance();
        // Ensure init is called
        await db.init(); 
        const res = await db.query('SELECT 1');
        expect(res).toBeDefined();
        expect(res.numRows).toBe(100);
    });
});

