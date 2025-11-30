import { useState, useRef, useCallback, useEffect } from 'react';
import {
  SocrataClient,
  webMercatorToLatLon,
  convertGeoJSONToWebMercator,
} from '../lib/socrata';
import type { SocrataDataset, Recipe } from '../lib/socrata';
import type { WebGPURenderer } from '../lib/renderer';

const OVERLAY_ZOOM_THRESHOLD = 0.5;

interface UseDataLayersOptions {
  renderer: WebGPURenderer | null;
  loading: boolean;
  cameraVersion: number;
}

export function useDataLayers({ renderer, loading, cameraVersion }: UseDataLayersOptions) {
  const [activeDatasets, setActiveDatasets] = useState<SocrataDataset[]>([]);
  const [datasetLoading, setDatasetLoading] = useState<string | null>(null);
  const [datasetError, setDatasetError] = useState<string | null>(null);
  const socrataClientRef = useRef<SocrataClient | null>(null);
  const lastViewportRef = useRef<{ minX: number; minY: number; maxX: number; maxY: number } | null>(null);

  // Initialize client
  useEffect(() => {
    socrataClientRef.current = new SocrataClient();
  }, []);

  // Load overlay data for active datasets when zoomed in
  const loadOverlayData = useCallback(async () => {
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

    // Convert Web Mercator bounds to lat/lon for query
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
  }, [activeDatasets, renderer]);

  // Trigger overlay data loading on camera change
  useEffect(() => {
    if (loading || activeDatasets.length === 0) return;
    loadOverlayData();
  }, [loading, activeDatasets, loadOverlayData, cameraVersion]);

  // Dataset management
  const addRecipeDatasets = useCallback((recipe: Recipe) => {
    setActiveDatasets(prev => {
      const newDatasets = recipe.datasets.filter(
        d => !prev.some(existing => existing.id === d.id)
      );
      return [...prev, ...newDatasets];
    });
    // Trigger immediate load
    lastViewportRef.current = null;
  }, []);

  const toggleDataset = useCallback((datasetId: string) => {
    setActiveDatasets(prev =>
      prev.map(d => d.id === datasetId ? { ...d, enabled: !d.enabled } : d)
    );

    // If disabling, remove the layer
    const dataset = activeDatasets.find(d => d.id === datasetId);
    if (dataset?.enabled) {
      renderer?.removeGeoJSONLayer(datasetId);
    } else {
      lastViewportRef.current = null;
    }
  }, [activeDatasets, renderer]);

  const removeDataset = useCallback((datasetId: string) => {
    setActiveDatasets(prev => prev.filter(d => d.id !== datasetId));
    renderer?.removeGeoJSONLayer(datasetId);
  }, [renderer]);

  const addCustomDataset = useCallback((dataset: SocrataDataset) => {
    setActiveDatasets(prev => [...prev, dataset]);
    lastViewportRef.current = null;
  }, []);

  const clearError = useCallback(() => {
    setDatasetError(null);
  }, []);

  const showZoomWarning = !!(renderer && renderer.camera.zoom < OVERLAY_ZOOM_THRESHOLD);

  return {
    activeDatasets,
    datasetLoading,
    datasetError,
    showZoomWarning,
    addRecipeDatasets,
    toggleDataset,
    removeDataset,
    addCustomDataset,
    clearError,
    loadOverlayData,
  };
}

