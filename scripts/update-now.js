import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  addToHistory,
  buildSummary,
  classifyTopic,
  earliestOnlineDate,
  isDuplicate,
  isEuropeanArbovirusRecord,
  isWithinPrecedingDays,
  findLinkedPreprint,
  normalizeDoi,
  scoreRelevance,
  stableId
} from "./lib.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataPath = path.join(root, "data", "papers.json");
const historyPath = path.join(root, "data", "history.json");
const configPath = path.join(root, "data", "search-config.json");
const runDate = process.env.RUN_DATE || new Date().toISOString().slice(0, 10);

const [paperArchive, history, config] = await Promise.all([
  readJson(dataPath),
  readJson(historyPath),
  readJson(configPath)
]);

const fetched = process.env.MOCK_RECORDS
  ? await readJson(path.resolve(process.env.MOCK_RECORDS))
  : await fetchAll(config);
const accepted = [];

for (const raw of fetched) {
  const onlineDate = earliestOnlineDate(raw);
  if (!isWithinPrecedingDays(onlineDate, runDate, config.lookbackDays)) continue;

  const topic = classifyTopic(raw, config);
  if (topic === "European arbovirus dynamics" && !isEuropeanArbovirusRecord(raw)) continue;

  const record = normalizeRecord(raw, topic, onlineDate, config);
  const linkedPreprint = findLinkedPreprint(record, paperArchive);
  if ((!linkedPreprint && isDuplicate(record, history)) || isDuplicate(record, {
    doiHistory: accepted.map((item) => item.doi).filter(Boolean),
    titleHistory: accepted.map((item) => item.title)
  })) continue;

  if (linkedPreprint) {
    history.preprintLinks.push({
      preprintId: linkedPreprint.id,
      publicationId: record.id,
      linkedAt: new Date().toISOString()
    });
    record.linkedPreprintId = linkedPreprint.id;
    record.readFirstReason = "Journal version linked to an earlier preprint; not counted as an entirely unrelated new study.";
  }

  accepted.push(record);
  addToHistory(record, history);
}

if (!accepted.length) {
  const topicNames = config.topics.map((topic) => topic.name);
  console.log("No qualifying new papers found for this weekly run.");
  topicNames.forEach((topic) => console.log(`${topic}: No new papers identified this week`));
  process.exit(0);
}

await addOptionalAiSummaries(accepted);
markReadFirst(accepted);

const nextArchive = {
  generatedAt: new Date().toISOString(),
  papers: [...accepted, ...paperArchive.papers].sort((a, b) => b.onlinePublicationDate.localeCompare(a.onlinePublicationDate))
};

if (process.env.DRY_RUN === "1") {
  console.log(`Dry run accepted ${accepted.length} new paper${accepted.length === 1 ? "" : "s"}; archive not written.`);
  process.exit(0);
}

await fs.writeFile(dataPath, `${JSON.stringify(nextArchive, null, 2)}\n`);
await fs.writeFile(historyPath, `${JSON.stringify(history, null, 2)}\n`);
console.log(`Added ${accepted.length} new paper${accepted.length === 1 ? "" : "s"}.`);

async function fetchAll(config) {
  const records = [];
  for (const topic of config.topics) {
    for (const query of topic.queries) {
      records.push(...await fetchOpenAlex(query));
      records.push(...await fetchCrossref(query));
      records.push(...await fetchEuropePmc(query));
    }
  }
  return records;
}

async function addOptionalAiSummaries(records) {
  if (!process.env.OPENAI_API_KEY) return;
  for (const record of records) {
    if (record.aiSummary?.text) continue;
    const prompt = [
      "Summarize this paper for a PhD project on urban-rural Culex pipiens eco-evolution in Belgium.",
      "Use only the title, abstract and metadata provided. Do not infer absent results.",
      "Distinguish evolutionary evidence from observational or phenotypic association.",
      "Distinguish laboratory findings from demonstrated field effectiveness.",
      "Return three short sentences: summary, main finding, and why it matters.",
      "",
      `Title: ${record.title}`,
      `Abstract or metadata summary: ${record.summary}`,
      `Topic: ${record.topic}`,
      `Study type: ${record.studyType}`,
      `Evidence label: ${record.evidenceLabel}`
    ].join("\n");
    try {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || "gpt-5.6-luna",
          input: prompt,
          text: { verbosity: "low" },
          max_output_tokens: 260
        })
      });
      if (!response.ok) throw new Error(`OpenAI API ${response.status}`);
      const json = await response.json();
      const text = json.output_text || json.output?.flatMap((item) => item.content || []).map((item) => item.text).filter(Boolean).join("\n");
      if (text) {
        record.summary = text.trim();
        record.aiSummary = {
          model: process.env.OPENAI_MODEL || "gpt-5.6-luna",
          createdAt: new Date().toISOString(),
          text: text.trim()
        };
      }
    } catch (error) {
      console.warn(`AI summary skipped for "${record.title}": ${error.message}`);
    }
  }
}

function markReadFirst(records) {
  records
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, 3)
    .forEach((record, index) => {
      record.readFirst = true;
      record.readFirstRank = index + 1;
      record.readFirstReason = explainReadFirst(record);
    });
}

function explainReadFirst(record) {
  const reasons = [];
  const text = `${record.title} ${record.summary} ${record.topic}`.toLowerCase();
  if (text.includes("culex pipiens")) reasons.push("directly involves Culex pipiens");
  if (text.includes("urban") || text.includes("rural")) reasons.push("matches the urban-rural gradient");
  if (text.includes("ctmax") || text.includes("ctmin") || text.includes("thermal") || text.includes("temperature")) reasons.push("supports thermal-tolerance or temperature-response work");
  if (text.includes("common garden")) reasons.push("has strong value for genetic-versus-plastic inference");
  if (text.includes("predator") || text.includes("mesocosm")) reasons.push("supports predator-control experiments");
  if (text.includes("edna")) reasons.push("supports eDNA surveillance");
  if (record.virus) reasons.push("connects to European WNV/SINV transmission risk");
  return reasons.length ? `Ranked highly because it ${reasons.slice(0, 3).join(", ")}.` : "Ranked by overall relevance score across the configured research priorities.";
}

async function fetchOpenAlex(query) {
  const url = new URL("https://api.openalex.org/works");
  url.searchParams.set("search", query);
  url.searchParams.set("per-page", "25");
  url.searchParams.set("mailto", process.env.OPENALEX_MAILTO || "example@example.com");
  const json = await fetchJson(url);
  return (json.results || []).map((item) => ({
    title: item.title,
    abstract: openAlexAbstract(item.abstract_inverted_index),
    doi: item.doi,
    journal: item.primary_location?.source?.display_name,
    authors: item.authorships?.map((author) => author.author?.display_name).filter(Boolean),
    publishedOnline: item.publication_date,
    publicationDate: item.publication_date,
    openAccess: item.open_access?.is_oa ?? null,
    source: "OpenAlex",
    isPreprint: item.type === "preprint"
  }));
}

async function fetchCrossref(query) {
  const url = new URL("https://api.crossref.org/works");
  url.searchParams.set("query.bibliographic", query);
  url.searchParams.set("rows", "25");
  const json = await fetchJson(url);
  return (json.message?.items || []).map((item) => ({
    title: item.title?.[0],
    abstract: stripTags(item.abstract || ""),
    doi: item.DOI,
    journal: item["container-title"]?.[0],
    authors: item.author?.map((author) => [author.given, author.family].filter(Boolean).join(" ")).filter(Boolean),
    publishedOnline: dateParts(item["published-online"]),
    publicationDate: dateParts(item.published),
    createdDate: dateParts(item.created),
    openAccess: null,
    source: "Crossref",
    isPreprint: /posted-content|preprint/i.test(item.type || "")
  }));
}

async function fetchEuropePmc(query) {
  const url = new URL("https://www.ebi.ac.uk/europepmc/webservices/rest/search");
  url.searchParams.set("query", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("pageSize", "25");
  const json = await fetchJson(url);
  return (json.resultList?.result || []).map((item) => ({
    title: item.title,
    abstract: item.abstractText,
    doi: item.doi,
    journal: item.journalTitle,
    authors: item.authorString ? item.authorString.split(",").map((name) => name.trim()).filter(Boolean) : [],
    publishedOnline: item.firstPublicationDate,
    publicationDate: item.firstPublicationDate || item.pubYear,
    openAccess: item.isOpenAccess === "Y",
    source: "Europe PMC",
    isPreprint: item.source === "PPR"
  }));
}

function normalizeRecord(raw, topic, onlineDate, config) {
  const record = {
    id: stableId(raw),
    title: raw.title || "Title unavailable",
    authors: raw.authors || [],
    journal: raw.journal || "",
    onlinePublicationDate: onlineDate,
    week: runDate,
    doi: normalizeDoi(raw.doi),
    topic,
    taxon: inferTaxon(raw),
    studyType: inferStudyType(raw),
    evidenceLabel: inferEvidence(raw),
    summary: buildSummary(raw),
    mainFinding: raw.abstract ? "See abstract-derived summary; main finding requires manual review if absent from the abstract." : "Not stated in available metadata.",
    whyItMatters: explainRelevance(raw, topic),
    openAccess: raw.openAccess,
    source: raw.source,
    relevanceScore: 0,
    readFirst: false,
    readFirstRank: null,
    readFirstReason: "",
    isPreprint: raw.isPreprint,
    countryOrRegion: topic === "European arbovirus dynamics" ? inferCountry(raw) : undefined,
    virus: inferVirus(raw),
    vectorSpecies: inferVector(raw),
    hostSpecies: inferHost(raw),
    studyPeriod: "Not specified in available metadata",
    arbovirusEvidenceType: topic === "European arbovirus dynamics" ? inferEvidence(raw) : undefined,
    europeanTransmissionRisk: topic === "European arbovirus dynamics" ? "Relevant to European circulation, emergence or transmission risk; verify details during manual read." : undefined
  };
  record.relevanceScore = scoreRelevance(record, config);
  return record;
}

function inferTaxon(raw) {
  const text = `${raw.title || ""} ${raw.abstract || ""}`.toLowerCase();
  if (text.includes("culex pipiens")) return "Culex pipiens";
  if (text.includes("mosquito")) return "Mosquitoes";
  if (text.includes("vector")) return "Disease vectors";
  return "Other urban-adapted organisms";
}

function inferStudyType(raw) {
  const text = `${raw.title || ""} ${raw.abstract || ""}`.toLowerCase();
  if (raw.isPreprint) return "preprint";
  if (text.includes("model")) return "modelling";
  if (text.includes("genom")) return "genomic";
  if (text.includes("common garden")) return "common garden";
  if (text.includes("laboratory") || text.includes("experiment")) return "laboratory";
  if (text.includes("review")) return "review";
  return "field";
}

function inferEvidence(raw) {
  const text = `${raw.title || ""} ${raw.abstract || ""}`.toLowerCase();
  if (text.includes("vector competence")) return "vector competence";
  if (text.includes("genom")) return "genomic epidemiology";
  if (text.includes("outbreak")) return "outbreak analysis";
  if (text.includes("model")) return "modelling";
  if (text.includes("surveillance")) return "surveillance";
  if (text.includes("common garden")) return "common-garden evidence";
  if (text.includes("experiment")) return "experimental infection";
  return "phenotypic association";
}

function inferVirus(raw) {
  const text = `${raw.title || ""} ${raw.abstract || ""}`.toLowerCase();
  if (text.includes("sindbis") || text.includes("sinv")) return "SINV";
  if (text.includes("west nile") || text.includes("wnv")) return "WNV";
  return "";
}

function inferVector(raw) {
  const text = `${raw.title || ""} ${raw.abstract || ""}`.toLowerCase();
  if (text.includes("culex pipiens")) return "Culex pipiens";
  if (text.includes("culex")) return "Culex spp.";
  if (text.includes("mosquito")) return "Mosquitoes";
  return "";
}

function inferHost(raw) {
  const text = `${raw.title || ""} ${raw.abstract || ""}`.toLowerCase();
  if (text.includes("avian") || text.includes("bird")) return "Avian hosts";
  if (text.includes("horse")) return "Horses";
  if (text.includes("human")) return "Humans";
  return "";
}

function inferCountry(raw) {
  const text = `${raw.title || ""} ${raw.abstract || ""}`.toLowerCase();
  const hit = ["belgium", "netherlands", "france", "germany", "italy", "spain", "greece", "romania", "serbia", "hungary", "europe"].find((term) => text.includes(term));
  return hit ? hit[0].toUpperCase() + hit.slice(1) : "Europe";
}

function explainRelevance(raw, topic) {
  if (topic === "European arbovirus dynamics") return "Matches the European WNV/SINV surveillance, vector competence, host interaction or outbreak-risk watch.";
  if (topic.includes("Thermal")) return "Relevant to CTmax, CTmin, temperature-dependent life-history responses or thermal adaptation.";
  if (topic.includes("Predator")) return "Relevant to context-dependent predator efficiency and mosquito control in aquatic habitats.";
  if (topic.includes("eDNA")) return "Relevant to eDNA surveillance of native or invasive mosquitoes and disease vectors.";
  if (topic.includes("Urban")) return "Relevant to separating genetic, plastic and environmental components of urban-rural trait differences.";
  return "Conceptual or methodological relevance to mosquito eco-evolution and vector ecology.";
}

function openAlexAbstract(index) {
  if (!index) return "";
  const words = [];
  for (const [word, positions] of Object.entries(index)) {
    positions.forEach((position) => words[position] = word);
  }
  return words.join(" ");
}

function dateParts(date) {
  const parts = date?.["date-parts"]?.[0];
  if (!parts) return "";
  const [year, month = 1, day = 1] = parts;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function stripTags(text) {
  return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`API failed: ${url.hostname} ${response.status}`);
  return response.json();
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}
