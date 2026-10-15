// Shared constants for the Canard front end.
// server/app/schema.py mirrors these values; tests/js/schema-parity.test.mjs keeps them in sync.

export const COLUMNS = [
  { key: 'title', header: 'Title' },
  { key: 'summary', header: 'Summary' },
  { key: 'link', header: 'Source link' },
  { key: 'date', header: 'Publication Date' },
  { key: 'sourceType', header: 'Source type' },
];

export const EMBEDDING = {
  // Hugging Face model id used by transformers.js in the browser.
  model: 'Xenova/bge-small-en-v1.5',
  dtype: 'fp32',
  pooling: 'cls',
  normalize: true,
  dim: 384,
  // Maximum sequence length of the model, including the [CLS] and [SEP] special tokens.
  maxTokens: 512,
};

export const LIMITS = {
  maxCsvBytes: 5_000_000,
  maxRowsPerUpload: 2000,
  maxPointsPerPlot: 5000,
  maxErrors: 100,
  maxSourceTypeLength: 60,
  maxTagLength: 40,
  maxTagsPerPoint: 30,
  maxPlotNameLength: 80,
  maxPlotDescriptionLength: 500,
};

// Projection methods, in the order they appear in the interface.
export const METHODS = [
  { key: 'umap', label: 'UMAP', blurb: 'Uniform manifold approximation and projection. Keeps local neighbourhoods tight while preserving more of the global layout than t-SNE.' },
  { key: 'tsne', label: 't-SNE', blurb: 't-distributed stochastic neighbour embedding. Excellent at separating tight clusters; distances between clusters are not meaningful.' },
  { key: 'gauss', label: 'Gaussian kernel', blurb: 'Kernel PCA with a Gaussian (RBF) kernel. A smooth, deterministic non-linear projection that keeps broad similarity structure.' },
  { key: 'pca', label: 'PCA', blurb: 'Principal component analysis. A linear projection onto the two directions of greatest variation.' },
];

/** The text that is embedded for each entry. */
export function embeddingText(title, summary) {
  return `${title}\n${summary}`;
}
