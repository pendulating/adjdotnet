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
    description: 'Curbs, curb cuts, and street infrastructure from NYC Open Data',
    datasets: [
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
 */
export class SocrataClient {
  private appToken: string | null;
  private cache: Map<string, { data: GeoJSONFeatureCollection; timestamp: number }> = new Map();
  private cacheMaxAge = 60000; // 1 minute cache
  private pendingRequests: Map<string, Promise<GeoJSONFeatureCollection>> = new Map();

  constructor(appToken?: string) {
    this.appToken = appToken || import.meta.env.NYCOD_APP_TOKEN || null;
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
   * Generate cache key for a dataset + bbox query
   */
  private getCacheKey(dataset: SocrataDataset, bbox: BoundingBox): string {
    // Round bbox to reduce cache fragmentation
    const precision = 4;
    return `${dataset.id}:${bbox.minLat.toFixed(precision)},${bbox.minLon.toFixed(precision)},${bbox.maxLat.toFixed(precision)},${bbox.maxLon.toFixed(precision)}`;
  }

  /**
   * Fetch GeoJSON data from Socrata or ArcGIS FeatureServer
   */
  async fetchDataset(
    dataset: SocrataDataset,
    bbox: BoundingBox
  ): Promise<GeoJSONFeatureCollection> {
    const cacheKey = this.getCacheKey(dataset, bbox);
    
    // Check cache
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheMaxAge) {
      return cached.data;
    }
    
    // Check if request is already pending
    const pending = this.pendingRequests.get(cacheKey);
    if (pending) {
      return pending;
    }
    
    // Make request
    const url = this.buildUrl(dataset, bbox);
    console.log(`Fetching ${dataset.type} data: ${dataset.name}`, { bbox, url });
    
    const requestPromise = fetch(url)
      .then(async (response) => {
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Socrata API error: ${response.status} - ${errorText}`);
        }
        return response.json() as Promise<GeoJSONFeatureCollection>;
      })
      .then((data) => {
        // Cache result
        this.cache.set(cacheKey, { data, timestamp: Date.now() });
        this.pendingRequests.delete(cacheKey);
        console.log(`Loaded ${data.features?.length || 0} features from ${dataset.name}`);
        return data;
      })
      .catch((error) => {
        this.pendingRequests.delete(cacheKey);
        throw error;
      });
    
    this.pendingRequests.set(cacheKey, requestPromise);
    return requestPromise;
  }

  /**
   * Clear the cache
   */
  clearCache(): void {
    this.cache.clear();
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

