// Topic keywords by class-based TF-IDF (c-TF-IDF, as in BERTopic): the text of every
// entry in a cluster is pooled into one document, and a term scores highly when it is
// frequent in that cluster but rare across the other clusters.
//
//   W(t, c) = tf(t, c) × log(1 + A / f(t))
//
// tf(t, c) is the frequency of term t in cluster c, normalised by the cluster's total
// term count; f(t) is the frequency of t across all clusters; A is the average number
// of terms per cluster. Unclustered entries count as one more class, so terms that are
// common everywhere are discounted, but they are never given keywords themselves.
// Candidate terms are single words and pairs of adjacent words, with simple plurals
// folded together.

// scikit-learn's English stop words, less words that carry meaning in this domain
// (such as "system", "interest" and "part"), plus a few reporting words.
const STOP_WORDS = new Set(`a about above across after afterwards again against all almost alone along already also
although always am among amongst amoungst an and another any anyhow anyone anything anyway anywhere are around as at be
became because become becomes becoming been before beforehand behind being below beside besides between beyond both but
by can cannot cant could couldnt do does done down due during each eg eight either eleven else elsewhere enough etc even
ever every everyone everything everywhere except few fifteen fifty first five for former formerly forty four from further
get had has hasnt have he hence her here hereafter hereby herein hereupon hers herself him himself his how however hundred
i ie if in inc indeed into is it its itself last latter latterly least less ltd many may me meanwhile might mine more
moreover most mostly much must my myself namely neither never nevertheless next nine no nobody none noone nor not nothing
now nowhere of off often on once one only onto or other others otherwise our ours ourselves out over own per perhaps
please rather re same see seem seemed seeming seems several she should since six sixty so some somehow someone something
sometime sometimes somewhere still such ten than that the their them themselves then thence there thereafter thereby
therefore therein thereupon these they third this those though three through throughout thru thus to together too toward
towards twelve twenty two un under until up upon us very via was we well were what whatever when whence whenever where
whereafter whereas whereby wherein whereupon wherever whether which while whither who whoever whole whom whose why will
with within without would yet you your yours yourself yourselves
said says say including include includes included like just new et al use used uses using based way ways`.split(/\s+/));

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

/** Lower-cased words of a text, with possessives and edge punctuation removed. */
export function words(text) {
  const out = [];
  for (const m of text.toLowerCase().matchAll(WORD_RE)) {
    const w = m[0].replace(/['’]s$/u, '').replace(/['’-]+$/u, '');
    out.push(w);
  }
  return out;
}

const isContent = (w) => w.length >= 2 && !STOP_WORDS.has(w) && !/^[\p{N}'’-]+$/u.test(w) && !/^\p{N}/u.test(w);

/**
 * Candidate terms of a text: content words (unigrams) and pairs of adjacent content
 * words (bigrams, such as "trade mark"). Stop words break bigrams.
 */
export function candidateTerms(text) {
  const terms = [];
  let prev = null;
  for (const w of words(text)) {
    if (!isContent(w)) { prev = null; continue; }
    terms.push(w);
    if (prev) terms.push(`${prev} ${w}`);
    prev = w;
  }
  return terms;
}

/** Fold simple English plurals onto a singular that also occurs ("marks" → "mark"). */
function pluralFolder(vocabulary) {
  const singular = (w) => {
    if (w.length > 4 && w.endsWith('ies') && vocabulary.has(`${w.slice(0, -3)}y`)) return `${w.slice(0, -3)}y`;
    if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && vocabulary.has(w.slice(0, -1))) return w.slice(0, -1);
    return w;
  };
  return (term) => {
    const parts = term.split(' ');
    parts[parts.length - 1] = singular(parts[parts.length - 1]);
    return parts.join(' ');
  };
}

/**
 * Keywords for every cluster.
 * texts: one string per entry; labels: cluster per entry (-1 for unclustered).
 * Returns a Map from cluster label to [{ term, score }], best first.
 */
export function topicKeywords(texts, labels, { top = 8, maxDocShare = 0.5 } = {}) {
  const docs = texts.map(candidateTerms);
  const vocabulary = new Set(docs.flat().filter((t) => !t.includes(' ')));
  const fold = pluralFolder(vocabulary);
  // Display each folded term in its most common surface form.
  const surface = new Map();
  const classes = new Map();
  const docFreq = new Map();
  const corpusFreq = new Map();
  docs.forEach((terms, i) => {
    const label = labels[i];
    if (!classes.has(label)) classes.set(label, { counts: new Map(), total: 0, size: 0 });
    const cls = classes.get(label);
    cls.size += 1;
    const seen = new Set();
    for (const raw of terms) {
      const t = fold(raw);
      cls.counts.set(t, (cls.counts.get(t) || 0) + 1);
      cls.total += 1;
      if (!surface.has(t)) surface.set(t, new Map());
      surface.get(t).set(raw, (surface.get(t).get(raw) || 0) + 1);
      if (!seen.has(t)) {
        seen.add(t);
        corpusFreq.set(t, (corpusFreq.get(t) || 0) + 1);
        const key = `${label}\u0000${t}`;
        docFreq.set(key, (docFreq.get(key) || 0) + 1);
      }
    }
  });
  const totalFreq = new Map();
  for (const cls of classes.values()) for (const [t, c] of cls.counts) totalFreq.set(t, (totalFreq.get(t) || 0) + c);
  const avg = Math.max(1, Math.floor([...classes.values()].reduce((s, c) => s + c.total, 0) / Math.max(1, classes.size)));
  // Terms in most entries (boilerplate such as a newsletter's name) describe the
  // whole plot rather than any one cluster, so they are left out (like max_df).
  const maxDocs = texts.length >= 10 ? maxDocShare * texts.length : Infinity;
  const display = (t) => [...surface.get(t).entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];

  const out = new Map();
  for (const [label, cls] of classes) {
    if (label < 0) continue;
    // In clusters of three or more, a keyword must come from at least two entries so a
    // single long summary cannot dominate the label.
    const minDocs = cls.size >= 3 ? 2 : 1;
    const scored = [];
    for (const [t, c] of cls.counts) {
      if (corpusFreq.get(t) > maxDocs) continue;
      const tf = c / Math.max(1, cls.total);
      const score = tf * Math.log(1 + avg / totalFreq.get(t));
      scored.push({ t, score, enough: docFreq.get(`${label}\u0000${t}`) >= minDocs });
    }
    scored.sort((a, b) => (b.enough - a.enough) || (b.score - a.score) || a.t.localeCompare(b.t));
    out.set(label, selectKeywords(scored, cls.counts, display, top));
  }
  return out;
}

// Two terms are treated as one phrase when the shorter is mostly used inside the
// longer: at least this share of its uses.
const OVERLAP = 0.6;

/**
 * Pick the top keywords from scored terms without repeating words: a pair that
 * accounts for most uses of the chosen words in it replaces them ("trade" becomes
 * "trade mark"),
 * pairs that chain join into one phrase ("united states" and "states supreme" and
 * "supreme court"), and any other term that repeats a chosen word is skipped.
 */
function selectKeywords(scored, counts, display, top) {
  const chosen = []; // { words, terms, head, tail, score, count }
  const covers = (bigger, smaller) => bigger >= OVERLAP * smaller;
  const uses = (c, w) => c.terms.includes(w);
  for (const s of scored) {
    if (chosen.length >= top) break;
    const parts = s.t.split(' ');
    const count = counts.get(s.t);
    const shown = display(s.t).split(' ');
    if (parts.length === 1) {
      if (!chosen.some((c) => uses(c, s.t))) chosen.push({ words: shown, terms: [s.t], score: s.score, count });
      continue;
    }
    const [first, last] = parts;
    // The word a chain would add must not already be shown anywhere.
    const free = (w) => !chosen.some((c) => uses(c, w));
    const chain = chosen.find((c) => c.words.length > 1 && covers(Math.min(c.count, count), Math.max(c.count, count))
      && ((c.tail === first && free(last)) || (c.head === last && free(first))));
    if (chain) {
      if (chain.tail === first) { chain.words.push(shown[1]); chain.tail = last; } else { chain.words.unshift(shown[0]); chain.head = first; }
      chain.terms.push(s.t, first, last);
      chain.count = Math.min(chain.count, count);
      continue;
    }
    const overlapping = chosen.filter((c) => uses(c, first) || uses(c, last));
    const entry = { words: shown, terms: [s.t, first, last], head: first, tail: last, score: s.score, count };
    if (!overlapping.length) {
      chosen.push(entry);
    } else if (overlapping.every((c) => c.words.length === 1 && covers(count, c.count))) {
      // The pair replaces the words it is made of, in the place of the first one.
      chosen[chosen.indexOf(overlapping[0])] = { ...entry, score: overlapping[0].score };
      if (overlapping[1]) chosen.splice(chosen.indexOf(overlapping[1]), 1);
    }
  }
  return chosen.map((c) => ({ term: c.words.join(' '), score: +c.score.toFixed(5) }));
}
