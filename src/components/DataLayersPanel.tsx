import { useState } from 'react';
import { RECIPES, parseDatasetUrl } from '../lib/socrata';
import type { SocrataDataset, Recipe } from '../lib/socrata';

interface DataLayersPanelProps {
  isOpen: boolean;
  onToggle: () => void;
  activeDatasets: SocrataDataset[];
  onAddRecipe: (recipe: Recipe) => void;
  onToggleDataset: (datasetId: string) => void;
  onRemoveDataset: (datasetId: string) => void;
  onAddCustomDataset: (dataset: SocrataDataset) => void;
  datasetLoading: string | null;
  datasetError: string | null;
  onClearError: () => void;
  showZoomWarning: boolean;
}

export function DataLayersPanel({
  isOpen,
  onToggle,
  activeDatasets,
  onAddRecipe,
  onToggleDataset,
  onRemoveDataset,
  onAddCustomDataset,
  datasetLoading,
  datasetError,
  onClearError,
  showZoomWarning,
}: DataLayersPanelProps) {
  const [customDatasetUrl, setCustomDatasetUrl] = useState('');
  const [customDatasetName, setCustomDatasetName] = useState('');
  const [customDatasetColor, setCustomDatasetColor] = useState('#22c55e');
  const [localError, setLocalError] = useState<string | null>(null);

  const handleAddCustomDataset = () => {
    if (!customDatasetUrl.trim()) {
      setLocalError('Please enter a dataset URL');
      return;
    }

    const parsed = parseDatasetUrl(customDatasetUrl);
    if (!parsed) {
      setLocalError('Invalid dataset URL format');
      return;
    }

    const newDataset: SocrataDataset = {
      id: `custom-${Date.now()}`,
      name: customDatasetName.trim() || `Custom: ${parsed.resourceId}`,
      type: 'socrata',
      domain: parsed.domain,
      resourceId: parsed.resourceId,
      geometryColumn: 'the_geom',
      color: customDatasetColor,
      enabled: true,
    };

    onAddCustomDataset(newDataset);
    setCustomDatasetUrl('');
    setCustomDatasetName('');
    setLocalError(null);
    onClearError();
  };

  const displayError = localError || datasetError;

  return (
    <div className={`recipes-panel ${isOpen ? 'open' : ''}`}>
      <button className="recipes-toggle" onClick={onToggle}>
        Data {isOpen ? '◀' : '▶'}
      </button>

      {isOpen && (
        <div className="recipes-content">
          <h3>Data Layers</h3>

          {/* Zoom warning */}
          {showZoomWarning && (
            <div className="zoom-warning">
              ⚠️ Zoom in further to load overlay data
            </div>
          )}

          {/* Active Datasets */}
          {activeDatasets.length > 0 && (
            <div className="active-datasets">
              <h4>Active Layers</h4>
              {activeDatasets.map(dataset => (
                <div key={dataset.id} className="dataset-item">
                  <button
                    className={`dataset-toggle ${dataset.enabled ? 'enabled' : ''}`}
                    onClick={() => onToggleDataset(dataset.id)}
                    style={{ borderLeftColor: dataset.color }}
                  >
                    <span className="dataset-checkbox">
                      {dataset.enabled ? '☑' : '☐'}
                    </span>
                    <span className="dataset-name">{dataset.name}</span>
                    {datasetLoading === dataset.id && (
                      <span className="loading-indicator">⋯</span>
                    )}
                  </button>
                  <button
                    className="dataset-remove"
                    onClick={() => onRemoveDataset(dataset.id)}
                    title="Remove layer"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Recipes */}
          <div className="recipes-list">
            <h4>Recipes</h4>
            {RECIPES.map(recipe => (
              <div key={recipe.id} className="recipe-item">
                <button
                  className="recipe-btn"
                  onClick={() => onAddRecipe(recipe)}
                  disabled={recipe.datasets.every(d =>
                    activeDatasets.some(a => a.id === d.id)
                  )}
                >
                  <span className="recipe-name">{recipe.name}</span>
                  <small className="recipe-desc">{recipe.description}</small>
                </button>
              </div>
            ))}
          </div>

          {/* Custom Dataset */}
          <div className="custom-dataset">
            <h4>Add Custom Dataset</h4>
            <input
              type="text"
              placeholder="Dataset name (optional)"
              value={customDatasetName}
              onChange={e => setCustomDatasetName(e.target.value)}
            />
            <input
              type="text"
              placeholder="Socrata URL or resource ID"
              value={customDatasetUrl}
              onChange={e => {
                setCustomDatasetUrl(e.target.value);
                setLocalError(null);
                onClearError();
              }}
            />
            <div className="color-picker-row">
              <label>Color:</label>
              <input
                type="color"
                value={customDatasetColor}
                onChange={e => setCustomDatasetColor(e.target.value)}
              />
            </div>
            <button onClick={handleAddCustomDataset}>Add Dataset</button>

            {displayError && (
              <div className="dataset-error">{displayError}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

