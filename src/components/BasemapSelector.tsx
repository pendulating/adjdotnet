const BASEMAP_OPTIONS = [
  { id: 'cartoDark', label: 'Dark' },
  { id: 'cartoLight', label: 'Light' },
  { id: 'cartoVoyager', label: 'Voyager' },
  { id: 'osm', label: 'OpenStreetMap' },
] as const;

const CUSTOM_BASEMAP_OPTIONS = [
  { id: 'nycOrthos2024', label: 'NYC 2024 Satellite' },
] as const;

interface BasemapSelectorProps {
  currentStyle: string;
  onStyleChange: (styleId: string) => void;
}

export function BasemapSelector({ currentStyle, onStyleChange }: BasemapSelectorProps) {
  return (
    <>
      <div className="basemap-selector">
        {BASEMAP_OPTIONS.map(opt => (
          <button
            key={opt.id}
            onClick={() => onStyleChange(opt.id)}
            className={currentStyle === opt.id ? 'active' : ''}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Custom basemaps */}
      <div className="basemap-selector custom-basemaps">
        <span className="basemap-label">Custom:</span>
        {CUSTOM_BASEMAP_OPTIONS.map(opt => (
          <button
            key={opt.id}
            onClick={() => onStyleChange(opt.id)}
            className={currentStyle === opt.id ? 'active satellite' : ''}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </>
  );
}

