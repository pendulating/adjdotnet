import { useState, useRef, useCallback } from 'react';
import type { WebGPURenderer } from '../lib/renderer';

interface UseCameraOptions {
  renderer: WebGPURenderer | null;
}

export function useCamera({ renderer }: UseCameraOptions) {
  const [cameraVersion, setCameraVersion] = useState(0);
  const cameraChangeTimeout = useRef<number | null>(null);

  // Debounced camera change notification
  const notifyCameraChange = useCallback(() => {
    if (cameraChangeTimeout.current) {
      clearTimeout(cameraChangeTimeout.current);
    }
    cameraChangeTimeout.current = window.setTimeout(() => {
      setCameraVersion(v => v + 1);
    }, 300);
  }, []);

  const pan = useCallback((dx: number, dy: number) => {
    renderer?.pan(dx, dy);
    notifyCameraChange();
  }, [renderer, notifyCameraChange]);

  const zoomAt = useCallback((x: number, y: number, factor: number) => {
    renderer?.zoomAt(x, y, factor);
    notifyCameraChange();
  }, [renderer, notifyCameraChange]);

  const resetView = useCallback(() => {
    renderer?.setCamera(0, 0, 0.1);
    notifyCameraChange();
  }, [renderer, notifyCameraChange]);

  return {
    cameraVersion,
    notifyCameraChange,
    pan,
    zoomAt,
    resetView,
  };
}

