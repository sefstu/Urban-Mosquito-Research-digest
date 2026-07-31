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
  const text = researchText(record);
  const rules = config.retrievalRules || {};
  const isMosquitoPaper = hasAny(
    text,
    rules.mosquitoTerms || ["mosquito", "culicidae", "culex", "aedes", "anopheles"]
  );
  if (!isMosquitoPaper) return false;

  const isCulex = /\bculex\b|\bcx\.\s/i.test(text);
  const isEuropean = EUROPE_TERMS.some((term) => text.includes(term));
  const isOviposition = hasAny(text, rules.ovipositionTerms);
  const isUrbanRural = hasAny(text, rules.urbanRuralTerms);
  const isLifeHistory = hasAny(text, rules.lifeHistoryTerms);
  const isThermalMethod = hasAny(text, rules.thermalMethodTerms);
  const isInvertebrateControl = hasAny(text, rules.invertebratePredatorTerms);
  const isAquaticBehaviour = hasAny(text, rules.aquaticBehaviourTerms);
  const isOtherBiocontrol = hasAny(text, rules.otherBiocontrolTerms);
  const hasEcologicalContext = hasAny(text, rules.ecologicalContextTerms);
  const isEdna = hasAny(text, rules.ednaTerms);
  const isPopulationStudy = hasAny(text, rules.populationTerms);
  const isEuropeanVectorTraitStudy = isEuropean && hasAny(text, rules.europeanVectorTraitTerms);

  return Boolean(
    (isCulex && isOviposition) ||
    isUrbanRural ||
    (isEuropean && isLifeHistory) ||
    isThermalMethod ||
    isInvertebrateControl ||
    isAquaticBehaviour ||
    (isOtherBiocontrol && hasEcologicalContext) ||
    isEdna ||
    (isEuropean && isCulex && isPopulationStudy) ||
    isEuropeanVectorTraitStudy ||
    isEuropeanArbovirusRecord(record)
  );
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

export function papersForWeeklyStatus(accepted, archive, runDate, lookbackDays = 7) {
  const seen = new Set();
  return [
    ...accepted,
    ...archive.papers.filter((paper) => isWithinPrecedingDays(
      paper.onlinePublicationDate,
      runDate,
      lookbackDays
    ))
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
  const text = researchText(record);
  const mentionsVirus = isWnvOrSinvRecord(record);
  const mentionsEurope = EUROPE_TERMS.some((term) => text.includes(term));
  const explicitEuropeConsequence = /european transmission|european emergence|risk for europe|introduction into europe/i.test(text);
  return mentionsVirus && (mentionsEurope || explicitEuropeConsequence);
}

export function isWnvOrSinvRecord(record) {
  return /\b(wnv|west nile virus|sinv|sindbis virus)\b/i.test(researchText(record));
}

export function scoreRelevance(record, config) {
  const text = researchText(record);
  const rules = config.retrievalRules || {};
  const reasons = [];
  const add = (points, reason) => {
    reasons.push({ points, reason });
    return points;
  };
  const isCulex = /\bculex\b|\bcx\.\s/i.test(text);
  const isPipiens = /\bculex pipiens\b|\bcx\.\s*pipiens\b/i.test(text);
  const isEuropean = EUROPE_TERMS.some((term) => text.includes(term));
  const isOviposition = hasAny(text, rules.ovipositionTerms);
  const isUrbanRural = hasAny(text, rules.urbanRuralTerms);
  const isLifeHistory = hasAny(text, rules.lifeHistoryTerms);
  const isThermalMethod = hasAny(text, rules.thermalMethodTerms);
  const isInvertebrateControl = hasAny(text, rules.invertebratePredatorTerms);
  const isAquaticBehaviour = hasAny(text, rules.aquaticBehaviourTerms);
  const isOtherBiocontrol = hasAny(text, rules.otherBiocontrolTerms);
  const hasEcologicalContext = hasAny(text, rules.ecologicalContextTerms);
  const isEdna = hasAny(text, rules.ednaTerms);
  const isPopulationStudy = hasAny(text, rules.populationTerms);
  const isArbovirus = isEuropeanArbovirusRecord(record);
  const isEuropeanVectorTraitStudy = isEuropean && hasAny(text, rules.europeanVectorTraitTerms);

  let score = 8;
  if (isCulex && isOviposition) score += add(58, "WP1 Culex oviposition");
  if (isOviposition && hasAny(text, ["water volume", "temperature", "surface area", "water surface"])) {
    score += add(18, "WP1 habitat-choice variable");
  }
  if (isUrbanRural) score += add(64, "urban-rural mosquito comparison");
  if (isUrbanRural && isLifeHistory) score += add(18, "WP2 trait response");
  if (isEuropean && isLifeHistory) score += add(54, "European mosquito life history");
  if (isThermalMethod) score += add(48, "transferable mosquito thermal method");
  if (isInvertebrateControl) score += add(76, "WP3 invertebrate predator biocontrol");
  if (isInvertebrateControl && hasAny(text, ["predation rate", "functional response", "mesocosm", "experiment"])) {
    score += add(16, "WP3 experimental method");
  }
  if (isAquaticBehaviour) score += add(70, "aquatic behaviour affecting predator exposure");
  if (isOtherBiocontrol && hasEcologicalContext) score += add(55, "context-dependent mosquito biocontrol");
  if (isOtherBiocontrol && hasAny(text, ["temperature", "thermal", "climate", "warming", "heatwave"])) {
    score += add(15, "temperature-dependent control efficacy");
  }
  if (isEdna) score += add(60, "mosquito eDNA surveillance");
  if (isEuropean && isCulex && isPopulationStudy) score += add(60, "European Culex population structure");
  if (isEuropeanVectorTraitStudy) score += add(70, "European vector-trait synthesis");
  if (isArbovirus) score += add(64, "European WNV/SINV dynamics");

  if (isPipiens) score += add(14, "Culex pipiens");
  else if (isCulex && isOviposition) score += add(7, "Culex");
  if (isEuropean && (isOviposition || isUrbanRural || isLifeHistory || isInvertebrateControl || isAquaticBehaviour || isEdna)) {
    score += add(7, "European setting");
  }
  if (hasAny(text, ["common garden", "reciprocal transplant", "reared population", "laboratory reared"])) {
    score += add(10, "genetic-versus-environmental design");
  }
  if (record.isPreprint) score -= 2;

  record.relevanceReasons = reasons
    .sort((a, b) => b.points - a.points)
    .slice(0, 3)
    .map((item) => item.reason);
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
    record.hostSpecies,
    record.summary,
    record.mainFinding,
    record.whyItMatters,
    record.studyType,
    record.evidenceLabel
  ].filter(Boolean).join(" ").toLowerCase();
}

function hasAny(text, terms = []) {
  return terms.some((term) => text.includes(String(term).toLowerCase()));
}

function researchText(record) {
  return [
    record.title,
    record.abstract,
    record.journal,
    record.taxon,
    record.countryOrRegion,
    record.virus,
    record.vectorSpecies,
    record.hostSpecies,
    record.summary,
    record.mainFinding,
    record.studyType,
    record.evidenceLabel
  ].filter(Boolean).join(" ").toLowerCase();
}

function utcDay(dateString) {
  return new Date(`${dateString.slice(0, 10)}T00:00:00Z`);
}
