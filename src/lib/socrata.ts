/**
 * Socrata Open Data API client for fetching GeoJSON datasets
 * Supports SODA 2.0/3.0 APIs with spatial queries
 */

// Extend ImportMeta for our custom env var
declare global {
  interface ImportMeta {
    env: {
      NYCOD_APP_TOKEN?: string;
    };
  }
}

export type DatasetType = 'socrata' | 'arcgis';

export interface SocrataDataset {
  id: string;
  name: string;
  type: DatasetType;
  // Socrata-specific
  domain?: string;      // e.g., "data.cityofnewyork.us"
  resourceId?: string;  // e.g., "5xvt-8cbk"
  geometryColumn?: string; // e.g., "the_geom"
  // ArcGIS FeatureServer-specific
  featureServerUrl?: string;  // e.g., "https://services6.arcgis.com/.../FeatureServer"
  layerId?: number;           // e.g., 5
  // Common
  color: string;       // Hex color for rendering
  enabled: boolean;
}

export interface Recipe {
  id: string;
  name: string;
  description: string;
  datasets: SocrataDataset[];
}

export interface BoundingBox {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

export interface GeoJSONFeature {
  type: 'Feature';
  geometry: {
    type: string;
    coordinates: number[] | number[][] | number[][][] | number[][][][];
  };
  properties: Record<string, unknown>;
}

export interface GeoJSONFeatureCollection {
  type: 'FeatureCollection';
  features: GeoJSONFeature[];
}

// Predefined recipes
export const RECIPES: Recipe[] = [
  {
    id: 'nyc-street-network',
    name: 'NYC Street Network',
    description: 'Sidewalks, curbs, and curb cuts from NYC Open Data',
    datasets: [
      {
        id: 'nyc-sidewalks',
        name: 'NYC Sidewalks',
        type: 'arcgis',
        featureServerUrl: 'https://services6.arcgis.com/yG5s3afENB5iO9fj/arcgis/rest/services/Sidewalk_2022/FeatureServer',
        layerId: 22, // SIDEWALK layer
        color: '#64748b', // Slate gray
        enabled: true,
      },
      {
        id: 'nyc-curbs',
        name: 'NYC Curbs',
        type: 'socrata',
        domain: 'data.cityofnewyork.us',
        resourceId: '5xvt-8cbk',
        geometryColumn: 'the_geom',
        color: '#f59e0b', // Amber
        enabled: true,
      },
      {
        id: 'nyc-curb-cuts',
        name: 'NYC Curb Cuts',
        type: 'arcgis',
        featureServerUrl: 'https://services6.arcgis.com/yG5s3afENB5iO9fj/arcgis/rest/services/Curb_Cut_2022/FeatureServer',
        layerId: 5, // CURB_CUT layer
        color: '#ec4899', // Pink
        enabled: true,
      },
    ],
  },
];

/**
 * Convert Web Mercator (EPSG:3857) coordinates to WGS84 (lat/lon)
 */
export function webMercatorToLatLon(x: number, y: number): { lat: number; lon: number } {
  const lon = (x / 20037508.34) * 180;
  let lat = (y / 20037508.34) * 180;
  lat = (180 / Math.PI) * (2 * Math.atan(Math.exp((lat * Math.PI) / 180)) - Math.PI / 2);
  return { lat, lon };
}

/**
 * Convert WGS84 (lat/lon) to Web Mercator (EPSG:3857)
 */
export function latLonToWebMercator(lat: number, lon: number): { x: number; y: number } {
  const x = (lon * 20037508.34) / 180;
  let y = Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) / (Math.PI / 180);
  y = (y * 20037508.34) / 180;
  return { x, y };
}

/**
 * Get bounding box from Web Mercator viewport
 */
export function getViewportBoundingBox(
  centerX: number,
  centerY: number,
  viewportWidth: number,
  viewportHeight: number,
  scale: number
): BoundingBox {
  const halfWidth = (viewportWidth / 2) / scale;
  const halfHeight = (viewportHeight / 2) / scale;
  
  const minCorner = webMercatorToLatLon(centerX - halfWidth, centerY - halfHeight);
  const maxCorner = webMercatorToLatLon(centerX + halfWidth, centerY + halfHeight);
  
  return {
    minLat: minCorner.lat,
    maxLat: maxCorner.lat,
    minLon: minCorner.lon,
    maxLon: maxCorner.lon,
  };
}

/**
 * Data API client - supports Socrata and ArcGIS FeatureServer
 * Uses persistent IndexedDB cache with stale-while-revalidate
 */
export class SocrataClient {
  private appToken: string | null;
  private pendingRequests: Map<string, Promise<GeoJSONFeatureCollection>> = new Map();
  private persistentCache: typeof import('./cache').persistentCache | null = null;

  constructor(appToken?: string) {
    this.appToken = appToken || import.meta.env.NYCOD_APP_TOKEN || null;
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

  /**
   * Build Socrata API URL with spatial query
   */
  private buildSocrataUrl(
    dataset: SocrataDataset,
    bbox: BoundingBox,
    limit: number = 5000
  ): string {
    const baseUrl = `https://${dataset.domain}/resource/${dataset.resourceId}.geojson`;
    
    // Build $where clause for spatial query using within_box
    // within_box(location_column, north_lat, west_lon, south_lat, east_lon)
    const whereClause = `within_box(${dataset.geometryColumn}, ${bbox.maxLat}, ${bbox.minLon}, ${bbox.minLat}, ${bbox.maxLon})`;
    
    const params = new URLSearchParams({
      $where: whereClause,
      $limit: limit.toString(),
    });
    
    if (this.appToken) {
      params.set('$$app_token', this.appToken);
    }
    
    return `${baseUrl}?${params.toString()}`;
  }

  /**
   * Build ArcGIS FeatureServer URL with spatial query
   */
  private buildArcGISUrl(
    dataset: SocrataDataset,
    bbox: BoundingBox,
    limit: number = 5000
  ): string {
    const baseUrl = `${dataset.featureServerUrl}/${dataset.layerId}/query`;
    
    // ArcGIS uses envelope geometry for spatial queries
    // geometry format: xmin,ymin,xmax,ymax
    const envelope = `${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat}`;
    
    const params = new URLSearchParams({
      where: '1=1',
      geometry: envelope,
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',    // Input spatial reference (WGS84)
      outSR: '4326',   // Output spatial reference (WGS84)
      spatialRel: 'esriSpatialRelIntersects',
      outFields: '*',
      returnGeometry: 'true',
      resultRecordCount: limit.toString(),
      f: 'geojson',
    });
    
    return `${baseUrl}?${params.toString()}`;
  }

  /**
   * Build URL based on dataset type
   */
  private buildUrl(dataset: SocrataDataset, bbox: BoundingBox, limit: number = 5000): string {
    if (dataset.type === 'arcgis') {
      return this.buildArcGISUrl(dataset, bbox, limit);
    }
    return this.buildSocrataUrl(dataset, bbox, limit);
  }

  /**
   * Round bbox for cache key (reduces fragmentation)
   */
  private roundBbox(bbox: BoundingBox): { minLat: number; minLon: number; maxLat: number; maxLon: number } {
    const precision = 4;
    return {
      minLat: parseFloat(bbox.minLat.toFixed(precision)),
      minLon: parseFloat(bbox.minLon.toFixed(precision)),
      maxLat: parseFloat(bbox.maxLat.toFixed(precision)),
      maxLon: parseFloat(bbox.maxLon.toFixed(precision)),
    };
  }

  /**
   * Generate cache key for a dataset + bbox query
   */
  private getCacheKey(dataset: SocrataDataset, bbox: BoundingBox): string {
    const rounded = this.roundBbox(bbox);
    return `${dataset.id}:${rounded.minLat},${rounded.minLon},${rounded.maxLat},${rounded.maxLon}`;
  }

  /**
   * Fetch GeoJSON data from Socrata or ArcGIS FeatureServer
   * Uses persistent cache with stale-while-revalidate
   */
  async fetchDataset(
    dataset: SocrataDataset,
    bbox: BoundingBox
  ): Promise<GeoJSONFeatureCollection> {
    const cacheKey = this.getCacheKey(dataset, bbox);
    const roundedBbox = this.roundBbox(bbox);
    
    // Check persistent cache first
    if (this.persistentCache) {
      const cached = await this.persistentCache.getData<GeoJSONFeatureCollection>(
        dataset.id,
        roundedBbox
      );
      
      if (cached) {
        // If not stale, return immediately
        if (!cached.isStale) {
          console.log(`Cache hit for ${dataset.name} (fresh)`);
          return cached.data;
        }
        
        // Stale-while-revalidate: return cached data but refresh in background
        console.log(`Cache hit for ${dataset.name} (stale, refreshing in background)`);
        this.refreshInBackground(dataset, bbox, roundedBbox);
        return cached.data;
      }
    }
    
    // Check if request is already pending
    const pending = this.pendingRequests.get(cacheKey);
    if (pending) {
      return pending;
    }
    
    // Make request
    const requestPromise = this.fetchFromNetwork(dataset, bbox, roundedBbox);
    this.pendingRequests.set(cacheKey, requestPromise);
    
    try {
      const data = await requestPromise;
      this.pendingRequests.delete(cacheKey);
      return data;
    } catch (error) {
      this.pendingRequests.delete(cacheKey);
      throw error;
    }
  }

  private async fetchFromNetwork(
    dataset: SocrataDataset,
    bbox: BoundingBox,
    roundedBbox: { minLat: number; minLon: number; maxLat: number; maxLon: number }
  ): Promise<GeoJSONFeatureCollection> {
    const url = this.buildUrl(dataset, bbox);
    console.log(`Fetching ${dataset.type} data: ${dataset.name}`, { bbox });
    
    const response = await fetch(url);
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API error: ${response.status} - ${errorText}`);
    }
    
    const data = await response.json() as GeoJSONFeatureCollection;
    console.log(`Loaded ${data.features?.length || 0} features from ${dataset.name}`);
    
    // Store in persistent cache
    if (this.persistentCache) {
      this.persistentCache.setData(dataset.id, roundedBbox, data);
    }
    
    return data;
  }

  private refreshInBackground(
    dataset: SocrataDataset,
    bbox: BoundingBox,
    roundedBbox: { minLat: number; minLon: number; maxLat: number; maxLon: number }
  ): void {
    // Fire and forget background refresh
    this.fetchFromNetwork(dataset, bbox, roundedBbox).catch((err) => {
      console.warn(`Background refresh failed for ${dataset.name}:`, err);
    });
  }

  /**
   * Clear cache for a specific dataset
   */
  async clearDatasetCache(datasetId: string): Promise<void> {
    if (this.persistentCache) {
      await this.persistentCache.clearDatasetCache(datasetId);
    }
  }

  /**
   * Clear all caches
   */
  async clearCache(): Promise<void> {
    if (this.persistentCache) {
      await this.persistentCache.clearAll();
    }
  }
}

/**
 * Parse a Socrata dataset URL into components
 * Supports formats like:
 * - https://data.cityofnewyork.us/resource/5xvt-8cbk.geojson
 * - https://dev.socrata.com/foundry/data.cityofnewyork.us/5xvt-8cbk
 * - data.cityofnewyork.us/5xvt-8cbk
 */
export function parseDatasetUrl(url: string): { domain: string; resourceId: string } | null {
  // Try foundry format
  const foundryMatch = url.match(/foundry\/([^/]+)\/([a-z0-9]{4}-[a-z0-9]{4})/i);
  if (foundryMatch) {
    return { domain: foundryMatch[1], resourceId: foundryMatch[2] };
  }
  
  // Try resource format
  const resourceMatch = url.match(/([^/]+)\/resource\/([a-z0-9]{4}-[a-z0-9]{4})/i);
  if (resourceMatch) {
    return { domain: resourceMatch[1], resourceId: resourceMatch[2] };
  }
  
  // Try simple domain/id format
  const simpleMatch = url.match(/([a-z0-9.-]+\.[a-z]+)\/([a-z0-9]{4}-[a-z0-9]{4})/i);
  if (simpleMatch) {
    return { domain: simpleMatch[1], resourceId: simpleMatch[2] };
  }
  
  return null;
}

/**
 * Convert GeoJSON coordinates to Web Mercator
 * Handles Point, LineString, Polygon, MultiPoint, MultiLineString, MultiPolygon
 */
export function convertGeoJSONToWebMercator(geojson: GeoJSONFeatureCollection): GeoJSONFeatureCollection {
  const convertCoord = (coord: number[]): number[] => {
    const { x, y } = latLonToWebMercator(coord[1], coord[0]);
    return [x, y];
  };

  const convertCoords = (coords: unknown): unknown => {
    if (typeof coords[0] === 'number') {
      // Single coordinate [lon, lat]
      return convertCoord(coords as number[]);
    }
    // Nested array
    return (coords as unknown[]).map(convertCoords);
  };

  return {
    type: 'FeatureCollection',
    features: geojson.features.map((feature) => ({
      ...feature,
      geometry: {
        ...feature.geometry,
        coordinates: convertCoords(feature.geometry.coordinates) as typeof feature.geometry.coordinates,
      },
    })),
  };
}

