import { createHash } from "node:crypto";

export const EUROPE_TERMS = [
  "europe", "european", "albania", "andorra", "austria", "belarus", "belgium",
  "bosnia", "bulgaria", "croatia", "cyprus", "czech", "denmark", "estonia",
  "finland", "france", "germany", "greece", "hungary", "iceland", "ireland",
  "italy", "kosovo", "latvia", "liechtenstein", "lithuania", "luxembourg",
  "malta", "moldova", "monaco", "montenegro", "netherlands", "norway",
  "poland", "portugal", "romania", "serbia", "slovakia", "slovenia", "spain",
  "sweden", "switzerland", "ukraine", "united kingdom", "england", "scotland",
  "wales", "northern ireland", "balkans", "mediterranean", "scandinavia"
];

export function normalizeDoi(doi = "") {
  return String(doi)
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .toLowerCase();
}

export function normalizeTitle(title = "") {
  return String(title)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function stableId(record) {
  const doi = normalizeDoi(record.doi);
  if (doi) return `doi-${doi.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
  const digest = createHash("sha1").update(normalizeTitle(record.title)).digest("hex").slice(0, 12);
  return `title-${digest}`;
}

export function isDuplicate(record, history) {
  const doi = normalizeDoi(record.doi);
  const title = normalizeTitle(record.title);
  return Boolean(
    (doi && history.doiHistory.includes(doi)) ||
    (title && history.titleHistory.includes(title))
  );
}

export function hasVerifiedScholarlyIdentity(record) {
  const doi = normalizeDoi(record.doi);
  const title = normalizeTitle(record.title);
  const metadata = searchableText(record);
  const looksLikeDoi = /^10\.\d{4,9}\/\S+$/i.test(doi);
  const isPlaceholder = /\b(sample data|sample record|placeholder|demo record|local sample)\b/i.test(metadata);
  return Boolean(title.length >= 12 && looksLikeDoi && !isPlaceholder);
}

export function matchesExclusionRules(record, exclusionTerms = []) {
  const text = searchableText(record);
  return !exclusionTerms.some((term) => text.includes(String(term).toLowerCase()));
}

export function matchesSpeciesScope(record, config) {
  const text = searchableText(record);
  const scope = config.speciesScope || {};
  const priorityGenera = scope.priorityGenera || ["culex", "aedes", "anopheles"];
  if (priorityGenera.some((genus) => {
    const escaped = String(genus).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "i").test(text);
  })) return true;

  const isMosquitoPaper = /\b(mosquito|mosquitoes|culicidae)\b/i.test(text);
  const methodTerms = (scope.transferableMethodTerms || []).map((term) => String(term).toLowerCase());
  if (isMosquitoPaper && scope.allowOtherMosquitoesForTransferableMethods !== false) {
    return methodTerms.some((term) => text.includes(term));
  }

  if (scope.allowNonMosquitoUrbanModels !== false) {
    const conceptualTerms = (scope.nonMosquitoConceptualTerms || [
      "urban adaptation",
      "urban evolution",
      "urban rural",
      "common garden",
      "reciprocal transplant"
    ]).map((term) => String(term).toLowerCase());
    return conceptualTerms.some((term) => text.includes(term));
  }

  return false;
}

export function addToHistory(record, history) {
  const doi = normalizeDoi(record.doi);
  const title = normalizeTitle(record.title);
  if (doi && !history.doiHistory.includes(doi)) history.doiHistory.push(doi);
  if (title && !history.titleHistory.includes(title)) history.titleHistory.push(title);
}

export function findLinkedPreprint(record, archive) {
  if (record.isPreprint) return null;
  const title = normalizeTitle(record.title);
  return archive.papers.find((paper) => paper.isPreprint && normalizeTitle(paper.title) === title) || null;
}

export function papersForWeeklyStatus(accepted, archive, runDate) {
  const seen = new Set();
  return [
    ...accepted,
    ...archive.papers.filter((paper) => paper.week === runDate)
  ].filter((paper) => {
    const key = paper.id || normalizeDoi(paper.doi) || normalizeTitle(paper.title);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function isWithinPrecedingDays(dateString, runDateString, lookbackDays) {
  if (!dateString) return false;
  const date = utcDay(dateString);
  const runDate = utcDay(runDateString);
  const min = new Date(runDate);
  min.setUTCDate(min.getUTCDate() - lookbackDays);
  return date >= min && date < runDate;
}

export function earliestOnlineDate(record) {
  const candidates = [
    record.onlinePublicationDate,
    record.publishedOnline,
    record.publicationDate,
    record.from_online_date
  ].filter(Boolean).sort();
  return candidates[0] || "";
}

export function isEuropeanArbovirusRecord(record) {
  const text = searchableText(record);
  const mentionsVirus = /\b(wnv|west nile virus|sinv|sindbis virus)\b/i.test(text);
  const mentionsEurope = EUROPE_TERMS.some((term) => text.includes(term));
  const explicitEuropeConsequence = /european transmission|european emergence|risk for europe|introduction into europe/i.test(text);
  return mentionsVirus && (mentionsEurope || explicitEuropeConsequence);
}

export function scoreRelevance(record, config) {
  const text = searchableText(record);
  let score = 0;
  for (const [phrase, weight] of Object.entries(config.relevanceWeights)) {
    const terms = phrase.toLowerCase().split(/\s+or\s+|\s+/).filter((term) => term.length > 2);
    if (terms.some((term) => text.includes(term))) score += Number(weight);
  }
  const topic = config.topics.find((item) => item.name === record.topic);
  if (topic) score += topic.weight;
  if (record.isPreprint) score -= 6;
  return Math.max(0, Math.min(100, score));
}

export function classifyTopic(record, config) {
  const text = searchableText(record);
  let best = config.topics[0];
  let bestScore = -1;
  let bestHits = 0;
  for (const topic of config.topics) {
    const hits = topic.includeTerms.filter((term) => text.includes(term.toLowerCase())).length;
    const score = hits * topic.weight;
    if (score > bestScore) {
      best = topic;
      bestScore = score;
      bestHits = hits;
    }
  }
  return bestHits > 0 ? best.name : "";
}

export function buildSummary(record) {
  if (!record.abstract) return "Abstract unavailable";
  const sentences = record.abstract.replace(/\s+/g, " ").match(/[^.!?]+[.!?]+/g) || [record.abstract];
  return sentences.slice(0, 2).join(" ").trim();
}

export function searchableText(record) {
  return [
    record.title,
    record.abstract,
    record.journal,
    record.source,
    record.topic,
    record.taxon,
    record.countryOrRegion,
    record.virus,
    record.vectorSpecies,
    record.hostSpecies
  ].filter(Boolean).join(" ").toLowerCase();
}

function utcDay(dateString) {
  return new Date(`${dateString.slice(0, 10)}T00:00:00Z`);
}
