/**
 * Persistent IndexedDB cache for tiles and GeoJSON data
 * Provides smart caching with LRU eviction and stale-while-revalidate
 */

const DB_NAME = 'adjnet-cache';
const DB_VERSION = 1;
const TILE_STORE = 'tiles';
const DATA_STORE = 'data';

interface CacheEntry<T> {
  key: string;
  data: T;
  timestamp: number;
  accessTime: number;
  size: number;
}

interface TileCacheEntry extends CacheEntry<Blob> {
  provider: string;
  z: number;
  x: number;
  y: number;
}

interface DataCacheEntry extends CacheEntry<string> {
  datasetId: string;
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

class PersistentCache {
  private db: IDBDatabase | null = null;
  private initPromise: Promise<void> | null = null;
  private memoryTileCache = new Map<string, HTMLImageElement>();
  private memoryDataCache = new Map<string, { data: unknown; timestamp: number }>();
  
  // Config
  private maxTileCount = 1000;        // Max tiles in IndexedDB
  private maxTileMemory = 100;        // Max tiles in memory
  private maxDataEntries = 200;       // Max data entries in IndexedDB
  private tileMaxAge = 7 * 24 * 60 * 60 * 1000;  // 7 days for tiles
  private dataMaxAge = 24 * 60 * 60 * 1000;       // 24 hours for data
  private dataStaleAge = 5 * 60 * 1000;           // 5 min before stale-while-revalidate

  async init(): Promise<void> {
    if (this.db) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        console.warn('IndexedDB not available, using memory-only cache');
        resolve();
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Tiles store with indexes for cleanup
        if (!db.objectStoreNames.contains(TILE_STORE)) {
          const tileStore = db.createObjectStore(TILE_STORE, { keyPath: 'key' });
          tileStore.createIndex('accessTime', 'accessTime');
          tileStore.createIndex('provider', 'provider');
          tileStore.createIndex('timestamp', 'timestamp');
        }

        // Data store with indexes for spatial queries
        if (!db.objectStoreNames.contains(DATA_STORE)) {
          const dataStore = db.createObjectStore(DATA_STORE, { keyPath: 'key' });
          dataStore.createIndex('accessTime', 'accessTime');
          dataStore.createIndex('datasetId', 'datasetId');
          dataStore.createIndex('timestamp', 'timestamp');
        }
      };
    });

    return this.initPromise;
  }

  // ==================== TILE CACHING ====================

  private tileKey(provider: string, z: number, x: number, y: number): string {
    return `${provider}:${z}/${x}/${y}`;
  }

  /**
   * Get tile from cache (memory first, then IndexedDB)
   */
  async getTile(
    provider: string,
    z: number,
    x: number,
    y: number
  ): Promise<HTMLImageElement | null> {
    const key = this.tileKey(provider, z, x, y);

    // Check memory cache first
    if (this.memoryTileCache.has(key)) {
      return this.memoryTileCache.get(key)!;
    }

    // Check IndexedDB
    await this.init();
    if (!this.db) return null;

    return new Promise((resolve) => {
      const tx = this.db!.transaction(TILE_STORE, 'readonly');
      const store = tx.objectStore(TILE_STORE);
      const request = store.get(key);

      request.onsuccess = async () => {
        const entry = request.result as TileCacheEntry | undefined;
        if (!entry) {
          resolve(null);
          return;
        }

        // Check if expired
        if (Date.now() - entry.timestamp > this.tileMaxAge) {
          this.deleteTile(key);
          resolve(null);
          return;
        }

        // Convert blob back to image
        const img = await this.blobToImage(entry.data);
        if (img) {
          // Add to memory cache
          this.addToMemoryTileCache(key, img);
          // Update access time
          this.updateTileAccessTime(key);
        }
        resolve(img);
      };

      request.onerror = () => resolve(null);
    });
  }

  /**
   * Store tile in cache
   */
  async setTile(
    provider: string,
    z: number,
    x: number,
    y: number,
    image: HTMLImageElement
  ): Promise<void> {
    const key = this.tileKey(provider, z, x, y);

    // Add to memory cache
    this.addToMemoryTileCache(key, image);

    // Store in IndexedDB
    await this.init();
    if (!this.db) return;

    const blob = await this.imageToBlob(image);
    if (!blob) return;

    const entry: TileCacheEntry = {
      key,
      provider,
      z,
      x,
      y,
      data: blob,
      timestamp: Date.now(),
      accessTime: Date.now(),
      size: blob.size,
    };

    const tx = this.db.transaction(TILE_STORE, 'readwrite');
    const store = tx.objectStore(TILE_STORE);
    store.put(entry);

    // Trigger cleanup if needed
    this.cleanupTiles();
  }

  private addToMemoryTileCache(key: string, img: HTMLImageElement): void {
    // Evict if full
    if (this.memoryTileCache.size >= this.maxTileMemory) {
      const firstKey = this.memoryTileCache.keys().next().value;
      if (firstKey) this.memoryTileCache.delete(firstKey);
    }
    this.memoryTileCache.set(key, img);
  }

  private async updateTileAccessTime(key: string): Promise<void> {
    if (!this.db) return;
    const tx = this.db.transaction(TILE_STORE, 'readwrite');
    const store = tx.objectStore(TILE_STORE);
    const request = store.get(key);
    
    request.onsuccess = () => {
      const entry = request.result;
      if (entry) {
        entry.accessTime = Date.now();
        store.put(entry);
      }
    };
  }

  private deleteTile(key: string): void {
    if (!this.db) return;
    const tx = this.db.transaction(TILE_STORE, 'readwrite');
    tx.objectStore(TILE_STORE).delete(key);
  }

  private async cleanupTiles(): Promise<void> {
    if (!this.db) return;

    const tx = this.db.transaction(TILE_STORE, 'readwrite');
    const store = tx.objectStore(TILE_STORE);
    const countRequest = store.count();

    countRequest.onsuccess = () => {
      const count = countRequest.result;
      if (count <= this.maxTileCount) return;

      // Delete oldest accessed tiles
      const deleteCount = count - this.maxTileCount + 50; // Delete extra 50 for buffer
      const index = store.index('accessTime');
      const cursorRequest = index.openCursor();
      let deleted = 0;

      cursorRequest.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor && deleted < deleteCount) {
          cursor.delete();
          deleted++;
          cursor.continue();
        }
      };
    };
  }

  /**
   * Clear tiles for a specific provider
   */
  async clearProviderTiles(provider: string): Promise<void> {
    // Clear memory cache
    for (const key of this.memoryTileCache.keys()) {
      if (key.startsWith(provider + ':')) {
        this.memoryTileCache.delete(key);
      }
    }

    // Clear IndexedDB
    if (!this.db) return;
    
    const tx = this.db.transaction(TILE_STORE, 'readwrite');
    const store = tx.objectStore(TILE_STORE);
    const index = store.index('provider');
    const cursorRequest = index.openCursor(IDBKeyRange.only(provider));

    cursorRequest.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
  }

  // ==================== DATA CACHING ====================

  private dataKey(datasetId: string, bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number }): string {
    const precision = 4;
    return `${datasetId}:${bbox.minLat.toFixed(precision)},${bbox.minLon.toFixed(precision)},${bbox.maxLat.toFixed(precision)},${bbox.maxLon.toFixed(precision)}`;
  }

  /**
   * Get data from cache with stale-while-revalidate support
   * Returns { data, isStale } where isStale indicates if data should be refreshed
   */
  async getData<T>(
    datasetId: string,
    bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number }
  ): Promise<{ data: T; isStale: boolean } | null> {
    const key = this.dataKey(datasetId, bbox);

    // Check memory cache first
    const memCached = this.memoryDataCache.get(key);
    if (memCached) {
      const age = Date.now() - memCached.timestamp;
      if (age < this.dataMaxAge) {
        return {
          data: memCached.data as T,
          isStale: age > this.dataStaleAge,
        };
      }
      this.memoryDataCache.delete(key);
    }

    // Check IndexedDB
    await this.init();
    if (!this.db) return null;

    return new Promise((resolve) => {
      const tx = this.db!.transaction(DATA_STORE, 'readonly');
      const store = tx.objectStore(DATA_STORE);
      const request = store.get(key);

      request.onsuccess = () => {
        const entry = request.result as DataCacheEntry | undefined;
        if (!entry) {
          resolve(null);
          return;
        }

        const age = Date.now() - entry.timestamp;
        
        // Check if completely expired
        if (age > this.dataMaxAge) {
          this.deleteData(key);
          resolve(null);
          return;
        }

        const data = JSON.parse(entry.data) as T;
        
        // Add to memory cache
        this.memoryDataCache.set(key, { data, timestamp: entry.timestamp });
        
        // Update access time
        this.updateDataAccessTime(key);

        resolve({
          data,
          isStale: age > this.dataStaleAge,
        });
      };

      request.onerror = () => resolve(null);
    });
  }

  /**
   * Store data in cache
   */
  async setData<T>(
    datasetId: string,
    bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number },
    data: T
  ): Promise<void> {
    const key = this.dataKey(datasetId, bbox);
    const jsonString = JSON.stringify(data);

    // Add to memory cache
    this.memoryDataCache.set(key, { data, timestamp: Date.now() });

    // Store in IndexedDB
    await this.init();
    if (!this.db) return;

    const entry: DataCacheEntry = {
      key,
      datasetId,
      minLat: bbox.minLat,
      minLon: bbox.minLon,
      maxLat: bbox.maxLat,
      maxLon: bbox.maxLon,
      data: jsonString,
      timestamp: Date.now(),
      accessTime: Date.now(),
      size: jsonString.length,
    };

    const tx = this.db.transaction(DATA_STORE, 'readwrite');
    const store = tx.objectStore(DATA_STORE);
    store.put(entry);

    // Trigger cleanup if needed
    this.cleanupData();
  }

  private async updateDataAccessTime(key: string): Promise<void> {
    if (!this.db) return;
    const tx = this.db.transaction(DATA_STORE, 'readwrite');
    const store = tx.objectStore(DATA_STORE);
    const request = store.get(key);
    
    request.onsuccess = () => {
      const entry = request.result;
      if (entry) {
        entry.accessTime = Date.now();
        store.put(entry);
      }
    };
  }

  private deleteData(key: string): void {
    this.memoryDataCache.delete(key);
    if (!this.db) return;
    const tx = this.db.transaction(DATA_STORE, 'readwrite');
    tx.objectStore(DATA_STORE).delete(key);
  }

  private async cleanupData(): Promise<void> {
    if (!this.db) return;

    const tx = this.db.transaction(DATA_STORE, 'readwrite');
    const store = tx.objectStore(DATA_STORE);
    const countRequest = store.count();

    countRequest.onsuccess = () => {
      const count = countRequest.result;
      if (count <= this.maxDataEntries) return;

      // Delete oldest accessed entries
      const deleteCount = count - this.maxDataEntries + 20;
      const index = store.index('accessTime');
      const cursorRequest = index.openCursor();
      let deleted = 0;

      cursorRequest.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor && deleted < deleteCount) {
          cursor.delete();
          deleted++;
          cursor.continue();
        }
      };
    };
  }

  /**
   * Clear all data for a specific dataset
   */
  async clearDatasetCache(datasetId: string): Promise<void> {
    // Clear memory cache
    for (const key of this.memoryDataCache.keys()) {
      if (key.startsWith(datasetId + ':')) {
        this.memoryDataCache.delete(key);
      }
    }

    // Clear IndexedDB
    if (!this.db) return;
    
    const tx = this.db.transaction(DATA_STORE, 'readwrite');
    const store = tx.objectStore(DATA_STORE);
    const index = store.index('datasetId');
    const cursorRequest = index.openCursor(IDBKeyRange.only(datasetId));

    cursorRequest.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
  }

  // ==================== UTILITIES ====================

  private imageToBlob(img: HTMLImageElement): Promise<Blob | null> {
    return new Promise((resolve) => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(null);
        return;
      }
      ctx.drawImage(img, 0, 0);
      canvas.toBlob((blob) => resolve(blob), 'image/png');
    });
  }

  private blobToImage(blob: Blob): Promise<HTMLImageElement | null> {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      img.src = url;
    });
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<{
    tileCount: number;
    dataCount: number;
    memoryTileCount: number;
    memoryDataCount: number;
  }> {
    await this.init();
    
    let tileCount = 0;
    let dataCount = 0;

    if (this.db) {
      const tx = this.db.transaction([TILE_STORE, DATA_STORE], 'readonly');
      
      await Promise.all([
        new Promise<void>((resolve) => {
          const request = tx.objectStore(TILE_STORE).count();
          request.onsuccess = () => {
            tileCount = request.result;
            resolve();
          };
          request.onerror = () => resolve();
        }),
        new Promise<void>((resolve) => {
          const request = tx.objectStore(DATA_STORE).count();
          request.onsuccess = () => {
            dataCount = request.result;
            resolve();
          };
          request.onerror = () => resolve();
        }),
      ]);
    }

    return {
      tileCount,
      dataCount,
      memoryTileCount: this.memoryTileCache.size,
      memoryDataCount: this.memoryDataCache.size,
    };
  }

  /**
   * Clear all caches
   */
  async clearAll(): Promise<void> {
    this.memoryTileCache.clear();
    this.memoryDataCache.clear();

    if (!this.db) return;
    
    const tx = this.db.transaction([TILE_STORE, DATA_STORE], 'readwrite');
    tx.objectStore(TILE_STORE).clear();
    tx.objectStore(DATA_STORE).clear();
  }
}

// Singleton instance
export const persistentCache = new PersistentCache();

