// Works out the clustering data stored with a plot (points.json "clusters"): the
// automatic topic cluster of every entry, and every entry's similarity to each growth
// territory. Used when a spreadsheet is uploaded and when a plot's clusters are
// recalculated. Needs the embedding model, which is loaded for both.
import { EMBEDDING } from './schema.js';
import { embedEntries } from './embedder.js';
import { TERRITORIES, TERRITORIES_VERSION, SECTION_WEIGHTS, allTerritoryStatements, territoryCentroids, territorySimilarities } from './territories.js';

let centroidPromise = null;

/** Embed the growth territory statements once per page and combine them into centroids. */
export function loadTerritoryCentroids() {
  if (!centroidPromise) {
    centroidPromise = embedEntries(allTerritoryStatements())
      .then((vectors) => territoryCentroids(vectors, EMBEDDING.dim));
    centroidPromise.catch(() => { centroidPromise = null; });
  }
  return centroidPromise;
}

/**
 * The request fields for the clusters: { clusters, clusterParams }.
 * vectors: Float32Array (n × dim) in the order of the plot's points; topics: the
 * result of computeTopics or computeTopicsInWorker.
 */
export function clusterPayload(vectors, n, topics, centroids) {
  return {
    clusters: {
      topic: Array.from(topics.labels),
      territory: territorySimilarities(vectors, n, EMBEDDING.dim, centroids),
    },
    clusterParams: {
      topics: topics.params,
      territories: {
        version: TERRITORIES_VERSION,
        names: TERRITORIES.map((t) => t.name),
        sectionWeights: SECTION_WEIGHTS,
        similarity: 'cosine',
      },
    },
  };
}
