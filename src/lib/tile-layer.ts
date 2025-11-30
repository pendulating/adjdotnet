// XYZ Tile Layer for WebGPU
// Supports OpenStreetMap and other XYZ tile providers

const TILE_SIZE = 256;
const EARTH_RADIUS = 6378137; // meters (Web Mercator)
const ORIGIN_SHIFT = Math.PI * EARTH_RADIUS; // ~20037508.34 meters

export interface TileCoord {
  z: number;
  x: number;
  y: number;
}

export interface TileProvider {
  name: string;
  url: string; // Template with {z}, {x}, {y}
  attribution: string;
  maxZoom: number;
}

// Standard basemap providers
export const TILE_PROVIDERS: Record<string, TileProvider> = {
  osm: {
    name: 'OpenStreetMap',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19,
  },
  cartoDark: {
    name: 'Carto Dark',
    url: 'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
    attribution: '© CARTO © OpenStreetMap contributors',
    maxZoom: 20,
  },
  cartoLight: {
    name: 'Carto Light',
    url: 'https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
    attribution: '© CARTO © OpenStreetMap contributors',
    maxZoom: 20,
  },
  cartoVoyager: {
    name: 'Carto Voyager',
    url: 'https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png',
    attribution: '© CARTO © OpenStreetMap contributors',
    maxZoom: 20,
  },
};

// Custom/regional basemap providers
export const CUSTOM_TILE_PROVIDERS: Record<string, TileProvider> = {
  nycOrthos2024: {
    name: 'NYC 2024 Satellite',
    // ArcGIS tile service uses {z}/{y}/{x} format
    url: 'https://tiles.arcgis.com/tiles/yG5s3afENB5iO9fj/arcgis/rest/services/NYC_Orthos_2024/MapServer/tile/{z}/{y}/{x}',
    attribution: '© NYC OTI',
    maxZoom: 23,
  },
};

// Convert Web Mercator meters to tile coordinates
export function metersToTile(mx: number, my: number, zoom: number): TileCoord {
  const res = (2 * ORIGIN_SHIFT) / (TILE_SIZE * Math.pow(2, zoom));
  const px = (mx + ORIGIN_SHIFT) / res;
  const py = (ORIGIN_SHIFT - my) / res; // Y is flipped
  
  return {
    z: zoom,
    x: Math.floor(px / TILE_SIZE),
    y: Math.floor(py / TILE_SIZE),
  };
}

// Get tile bounds in Web Mercator meters
export function tileBounds(tile: TileCoord): { minX: number; minY: number; maxX: number; maxY: number } {
  const tileCount = Math.pow(2, tile.z);
  const tileSize = (2 * ORIGIN_SHIFT) / tileCount;
  
  const minX = tile.x * tileSize - ORIGIN_SHIFT;
  const maxX = (tile.x + 1) * tileSize - ORIGIN_SHIFT;
  const maxY = ORIGIN_SHIFT - tile.y * tileSize;
  const minY = ORIGIN_SHIFT - (tile.y + 1) * tileSize;
  
  return { minX, minY, maxX, maxY };
}

// Calculate appropriate zoom level for given meters-per-pixel
export function zoomForResolution(metersPerPixel: number): number {
  // At zoom 0, one pixel = (2 * ORIGIN_SHIFT) / 256 meters
  const zoom0Res = (2 * ORIGIN_SHIFT) / TILE_SIZE;
  const zoom = Math.log2(zoom0Res / metersPerPixel);
  return Math.max(0, Math.min(20, Math.round(zoom)));
}

export class TileCache {
  private memoryCache = new Map<string, HTMLImageElement>();
  private pending = new Map<string, Promise<HTMLImageElement | null>>();
  private maxMemorySize = 100;
  private provider: TileProvider;
  private providerId: string;
  private persistentCache: typeof import('./cache').persistentCache | null = null;

  constructor(provider: TileProvider = TILE_PROVIDERS.cartoDark) {
    this.provider = provider;
    this.providerId = this.getProviderId(provider);
    this.initPersistentCache();
  }

  private async initPersistentCache() {
    try {
      const { persistentCache } = await import('./cache');
      this.persistentCache = persistentCache;
      await persistentCache.init();
    } catch (e) {
      console.warn('Persistent cache not available:', e);
    }
  }

  private getProviderId(provider: TileProvider): string {
    // Create a stable ID from the URL pattern
    return provider.url.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
  }

  setProvider(provider: TileProvider) {
    this.provider = provider;
    this.providerId = this.getProviderId(provider);
    this.memoryCache.clear();
    this.pending.clear();
  }

  private tileKey(tile: TileCoord): string {
    return `${tile.z}/${tile.x}/${tile.y}`;
  }

  private tileUrl(tile: TileCoord): string {
    return this.provider.url
      .replace('{z}', tile.z.toString())
      .replace('{x}', tile.x.toString())
      .replace('{y}', tile.y.toString());
  }

  async getTile(tile: TileCoord): Promise<HTMLImageElement | null> {
    const key = this.tileKey(tile);
    
    // Check memory cache first
    if (this.memoryCache.has(key)) {
      return this.memoryCache.get(key)!;
    }

    // Check if request is pending
    if (this.pending.has(key)) {
      return this.pending.get(key)!;
    }

    // Create promise that checks persistent cache then fetches
    const promise = this.loadTile(tile);
    this.pending.set(key, promise);

    try {
      const img = await promise;
      this.pending.delete(key);
      return img;
    } catch (e) {
      this.pending.delete(key);
      return null;
    }
  }

  private async loadTile(tile: TileCoord): Promise<HTMLImageElement | null> {
    const key = this.tileKey(tile);

    // Check persistent cache
    if (this.persistentCache) {
      const cached = await this.persistentCache.getTile(
        this.providerId,
        tile.z,
        tile.x,
        tile.y
      );
      if (cached) {
        this.addToMemoryCache(key, cached);
        return cached;
      }
    }

    // Fetch from network
    try {
      const img = await this.fetchTile(tile);
      this.addToMemoryCache(key, img);
      
      // Store in persistent cache
      if (this.persistentCache) {
        this.persistentCache.setTile(this.providerId, tile.z, tile.x, tile.y, img);
      }
      
      return img;
    } catch (e) {
      return null;
    }
  }

  private addToMemoryCache(key: string, img: HTMLImageElement): void {
    // Evict old tiles if cache is full
    if (this.memoryCache.size >= this.maxMemorySize) {
      const firstKey = this.memoryCache.keys().next().value;
      if (firstKey) this.memoryCache.delete(firstKey);
    }
    this.memoryCache.set(key, img);
  }

  private fetchTile(tile: TileCoord): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Failed to load tile ${this.tileKey(tile)}`));
      img.src = this.tileUrl(tile);
    });
  }

  getImmediate(tile: TileCoord): HTMLImageElement | null {
    return this.memoryCache.get(this.tileKey(tile)) || null;
  }

  /**
   * Clear all tiles for current provider
   */
  async clearCache(): Promise<void> {
    this.memoryCache.clear();
    if (this.persistentCache) {
      await this.persistentCache.clearProviderTiles(this.providerId);
    }
  }
}

// Get visible tiles for a viewport
export function getVisibleTiles(
  centerX: number, // Absolute Web Mercator X
  centerY: number, // Absolute Web Mercator Y
  viewportWidth: number, // pixels
  viewportHeight: number, // pixels
  zoom: number, // camera zoom (pixels per meter)
): TileCoord[] {
  // Calculate meters per pixel
  const metersPerPixel = 1 / zoom;
  
  // Get appropriate tile zoom level
  const tileZoom = zoomForResolution(metersPerPixel);
  
  // Calculate viewport bounds in meters
  const halfWidthMeters = (viewportWidth / 2) * metersPerPixel;
  const halfHeightMeters = (viewportHeight / 2) * metersPerPixel;
  
  const minX = centerX - halfWidthMeters;
  const maxX = centerX + halfWidthMeters;
  const minY = centerY - halfHeightMeters;
  const maxY = centerY + halfHeightMeters;
  
  // Get tile range
  const minTile = metersToTile(minX, maxY, tileZoom);
  const maxTile = metersToTile(maxX, minY, tileZoom);
  
  const tiles: TileCoord[] = [];
  const maxTileIdx = Math.pow(2, tileZoom) - 1;
  
  for (let x = Math.max(0, minTile.x); x <= Math.min(maxTileIdx, maxTile.x); x++) {
    for (let y = Math.max(0, minTile.y); y <= Math.min(maxTileIdx, maxTile.y); y++) {
      tiles.push({ z: tileZoom, x, y });
    }
  }
  
  return tiles;
}


