// IP Australia's five growth territories, used as fixed centroids for the
// "opinionated" clustering view: every entry belongs to the territory whose centroid
// embedding it is most similar to (like one assignment step of k-means with k = 5 and
// hand-made centroids).
//
// Each territory's centroid is built from its own text. Every statement is embedded
// separately (with the territory's name as its title, the same "title, line break,
// text" format as entries), statements are averaged within each section, and the
// section averages are combined with SECTION_WEIGHTS. The result is normalised.
//
// Changing any text here changes the centroids. Existing plots keep their stored
// similarities until they are recalculated (Spreadsheets > Recalculate clusters) or
// another spreadsheet is uploaded; TERRITORIES_VERSION records which text was used.

export const TERRITORIES_VERSION = '2026-10-15';

export const TERRITORIES = [
  {
    key: 'protect',
    name: 'Protect Australian IP',
    aim: 'Uncover how we can strengthen the protection and enforcement of IP',
    imagine: [
      'We collaborate with other government agencies to identify and address IP infringement',
      'We support IP right holders to enforce IP domestically and internationally',
      'Australian businesses can enter overseas markets confident in their ability to protect their IP',
    ],
    changed: [
      'IP First Response has built customer insight and capabilities in post-registration support',
      'Its development has strengthened relationships with stakeholders involved in IP protection',
      'Discussions with brand protection providers suggest gaps in coverage within Australia',
    ],
    jobsLead: 'Further intervention that supports small businesses to',
    jobs: [
      'Reduce the cost of IP protection',
      'Reduce stress for SMEs',
      'Reduce reliance on costly processes',
    ],
    whyNow: 'In 2021 The Australian Institute of Criminology estimated the value of counterfeit and pirated goods in the Australian market to be $6.17b with an estimated increase of 0.27% per year. Combined with political tensions globally, we can assume Australian IP Rights holders are concerned about IP infringement. With our wealth of data and skilled workforce, IP Australia is ideally positioned to identify and implement opportunities that will protect Australian IP domestically and internationally.',
  },
  {
    key: 'empower',
    name: 'Empower others',
    aim: 'Equip stakeholders with more ways to use the IP System',
    imagine: [
      'Innovators can identify what is worth protecting and secure suitable IP rights with confidence',
      'Innovators can collaborate with confidence in how their IP will be protected',
      'The timing and cost of protection accommodate experimentation and iterative development',
    ],
    changed: [
      'Digital and AI tools create new opportunities to simplify IP identification and application',
      'Recent research links first patent grants and trade mark registrations with business growth and productivity',
      'IP First Response highlights gaps in timely awareness while other barriers and underserved users remain opaque',
    ],
    jobsLead: 'Further intervention that enables IP Australia to',
    jobs: [
      'Help SMEs identify what is worth protecting and prepare better applications',
      'Make suitable protection timely, affordable and adaptable as ideas evolve',
      'Identify unmet needs among innovators underserved by existing IP services',
    ],
    whyNow: 'Innovative businesses are missing out on, or deciding against, IP registration. Complexity and cost of both registration and enforcement are some of the key blockers. Innovation and design practices have also changed significantly in the last decade. Therefore new policy initiatives and tools can be explored for IP Australia to improve the uptake of IP rights by viable industry sectors.',
  },
  {
    key: 'amplify',
    name: 'Amplify Australian IP',
    aim: 'Meaningfully extend the utility and value of IP',
    imagine: [
      'Businesses can understand and demonstrate the commercial value of their IP',
      'Registered IP helps businesses accelerate commercialisation and growth',
      'Australian IP attracts investment and supports business growth in Australia',
    ],
    changed: [
      'Government priorities emphasise innovation and commercialisation in manufacturing, critical minerals and emerging technologies',
      'Customer testing has highlighted the difficulty of valuing IP',
      'Platforms such as Amazon link registered trade marks and eligible pending applications to commercial tools and services',
    ],
    jobsLead: 'Intervention that supports small businesses to',
    jobs: [
      'Understand and demonstrate the commercial value of their IP',
      'Use IP to attract investment and access finance',
      'Turn IP into commercial opportunities through licensing and partnerships',
    ],
    whyNow: 'Innovation is an important contributor to economic performance, however only 1 to 2% of businesses leverage innovation. With increasing global competition and challenging economic times, we need to amplify how the Australian IP system contributes to innovation and productivity in Australia. The Productivity Commission in their report on “Innovation for the 98%”, cites the importance of innovation and diffusion in government services and how government services may be well-known but underexploited, specifically stating that IP “reforms could better enable the diffusion of good ideas”. The Patents Accessibility Review has similarly flagged the need for government commercial intervention.',
  },
  {
    key: 'cultivate',
    name: 'Cultivate our ecosystem',
    aim: 'Work in new ways with ecosystem actors',
    imagine: [
      'Businesses access connected IP support through organisations they already trust',
      'Partnerships extend IP Australia’s reach, services and capabilities',
      'IP support is embedded in the wider services businesses use to innovate, trade and grow',
    ],
    changed: [
      'IP Australia’s expanded post-registration role creates opportunities for new partnerships',
      'IP First Response has deepened relationships with organisations involved in IP protection and dispute resolution',
      'Education and awareness activities have broadened public engagement with the IP system',
    ],
    jobsLead: 'Intervention that enables IP Australia and its partners to',
    jobs: [
      'Reach businesses beyond our existing customer base',
      'Connect IP support with the services businesses already use',
      'Address gaps in support through shared expertise and capabilities',
    ],
    whyNow: 'The key to staying relevant and successful lies in having the foresight and agility to skate where the puck is going to be, rather than where it is. IP Australia must anticipate and assess trends and actors access the IP ecosystem to capitalise and be a driver of where the market and emerging ecosystems are going.',
  },
  {
    key: 'revisit',
    name: 'Revisit our purpose',
    aim: 'Reconsider our raison d’etre in light of a changing world',
    imagine: [
      'IP is used to help solve societal problems',
      'Protection enables wider sharing and use of ideas and knowledge',
      'Access to some forms of IP is recognised as a right',
      'Government uses IP to shape incentives and advance public policy goals',
    ],
    changed: [
      'Generative AI is changing how ideas are created and challenging assumptions about inventorship, ownership and value',
      'Developments in Indigenous Knowledge and geographical indication protection raise questions about whose interests and knowledge the system recognises',
      'Geopolitical shifts and digital platforms are changing how Australian businesses access markets and use IP',
      'IP Australia’s expanded post-registration role prompts questions about the scope of our purpose and responsibilities',
    ],
    jobsLead: 'Exploration that helps IP Australia to',
    jobs: [
      'Test assumptions about who the IP system serves and the value it creates',
      'Explore how protection, sharing and access can support public benefit',
      'Identify where our purpose and role need to evolve',
    ],
    whyNow: 'The foundations of the IP system have been relatively settled for over 100 years while there has been tremendous change in the surrounding context. The economic benefits of innovation are (and have been) crucial, yet innovation is increasingly recognised as being also essential in addressing societal problems and certain types of IP are heading towards being ‘on-tap’ with AI platforms powering new designs and inventions. New models are not only becoming possible but may be unavoidable.',
  },
];

// How much each section contributes to a centroid. "What has recently changed" is
// mostly about IP Australia's own recent work (IP First Response appears in three
// territories), so it counts for half; the other sections count equally.
export const SECTION_WEIGHTS = { headline: 1, imagine: 1, changed: 0.5, jobs: 1, whyNow: 1 };

// The model is uncased, so this only keeps the statements readable for people.
const PROPER = /^(Australian?|IP|SMEs?|AI|Amazon|Indigenous)\b/;
const lowerFirst = (s) => (PROPER.test(s) ? s : s[0].toLowerCase() + s.slice(1));

/** The statements embedded for one territory: [{ section, title, summary }]. */
export function territoryStatements(t) {
  const out = [{ section: 'headline', title: t.name, summary: `${t.aim}.` }];
  for (const s of t.imagine) out.push({ section: 'imagine', title: t.name, summary: `Imagine a world where ${lowerFirst(s)}.` });
  for (const s of t.changed) out.push({ section: 'changed', title: t.name, summary: `${s}.` });
  for (const s of t.jobs) out.push({ section: 'jobs', title: t.name, summary: `${t.jobsLead} ${lowerFirst(s)}.` });
  out.push({ section: 'whyNow', title: t.name, summary: t.whyNow });
  return out;
}

/** Every statement of every territory, in order, tagged with its territory index. */
export function allTerritoryStatements() {
  return TERRITORIES.flatMap((t, ti) => territoryStatements(t).map((s) => ({ ...s, territory: ti })));
}

/**
 * Combine statement embeddings (Float32Array, one row per allTerritoryStatements()
 * entry) into one unit-length centroid per territory. Returns a Float32Array (5 × dim).
 */
export function territoryCentroids(vectors, dim) {
  const statements = allTerritoryStatements();
  const out = new Float32Array(TERRITORIES.length * dim);
  TERRITORIES.forEach((_, ti) => {
    const sums = new Map();
    statements.forEach((s, i) => {
      if (s.territory !== ti) return;
      if (!sums.has(s.section)) sums.set(s.section, { v: new Float64Array(dim), n: 0 });
      const acc = sums.get(s.section);
      for (let t = 0; t < dim; t += 1) acc.v[t] += vectors[i * dim + t];
      acc.n += 1;
    });
    const c = new Float64Array(dim);
    for (const [section, { v, n }] of sums) {
      const w = (SECTION_WEIGHTS[section] ?? 1) / n;
      for (let t = 0; t < dim; t += 1) c[t] += w * v[t];
    }
    let norm = 0;
    for (let t = 0; t < dim; t += 1) norm += c[t] * c[t];
    norm = Math.sqrt(norm) || 1;
    for (let t = 0; t < dim; t += 1) out[ti * dim + t] = c[t] / norm;
  });
  return out;
}

/**
 * Cosine similarity of every entry (unit vectors, n × dim) to every centroid.
 * Returns a flat array of n × 5 values rounded to four decimal places.
 */
export function territorySimilarities(vectors, n, dim, centroids) {
  const k = centroids.length / dim;
  const out = new Array(n * k);
  for (let i = 0; i < n; i += 1) {
    for (let c = 0; c < k; c += 1) {
      let s = 0;
      for (let t = 0; t < dim; t += 1) s += vectors[i * dim + t] * centroids[c * dim + t];
      out[i * k + c] = Math.round(s * 1e4) / 1e4;
    }
  }
  return out;
}

/** Index of the most similar territory for entry i (ties go to the earlier territory). */
export function nearestTerritory(sims, i, k = TERRITORIES.length) {
  let best = 0;
  for (let c = 1; c < k; c += 1) if (sims[i * k + c] > sims[i * k + best]) best = c;
  return best;
}

/** Corners of a regular pentagon (first at the top, then clockwise), radius 1. */
export function territoryAnchors(k = TERRITORIES.length) {
  return Array.from({ length: k }, (_, c) => {
    const a = Math.PI / 2 - (2 * Math.PI * c) / k;
    return [Math.cos(a), Math.sin(a)];
  });
}

/**
 * The territories layout: each entry sits at the softmax-weighted average of the five
 * anchor positions, weighted by how much more similar it is to each territory than
 * to the others. Entries that clearly belong to one territory sit close to its
 * anchor; entries split between territories sit between them; entries equally
 * similar to all five sit near the centre.
 *
 * Similarities are compared within each entry (so a corpus that is all about IP,
 * where every similarity is high, still spreads out) and scaled by the typical spread
 * of similarities in this plot. sharpness controls how strongly entries are pulled
 * towards their nearest anchor. Returns a Float32Array (2n) in [-1, 1].
 */
export function territoryLayout(sims, n, { k = TERRITORIES.length, sharpness = 2.2 } = {}) {
  const anchors = territoryAnchors(k);
  const out = new Float32Array(2 * n);
  if (!n) return out;
  // Typical spread: the median, over entries, of the standard deviation of that
  // entry's similarities to the five territories.
  const spreads = [];
  for (let i = 0; i < n; i += 1) {
    let mean = 0;
    for (let c = 0; c < k; c += 1) mean += sims[i * k + c];
    mean /= k;
    let v = 0;
    for (let c = 0; c < k; c += 1) v += (sims[i * k + c] - mean) ** 2;
    spreads.push(Math.sqrt(v / k));
  }
  spreads.sort((a, b) => a - b);
  const scale = spreads[Math.floor(n / 2)] || 1e-3;
  const w = new Float64Array(k);
  for (let i = 0; i < n; i += 1) {
    let max = -Infinity;
    for (let c = 0; c < k; c += 1) max = Math.max(max, sims[i * k + c]);
    let total = 0;
    for (let c = 0; c < k; c += 1) {
      w[c] = Math.exp((sharpness * (sims[i * k + c] - max)) / scale);
      total += w[c];
    }
    let x = 0;
    let y = 0;
    for (let c = 0; c < k; c += 1) {
      x += (w[c] / total) * anchors[c][0];
      y += (w[c] / total) * anchors[c][1];
    }
    out[2 * i] = Math.round(x * 1e4) / 1e4;
    out[2 * i + 1] = Math.round(y * 1e4) / 1e4;
  }
  return out;
}
