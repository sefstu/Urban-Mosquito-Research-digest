import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  addToHistory,
  buildSummary,
  classifyTopic,
  earliestOnlineDate,
  hasVerifiedScholarlyIdentity,
  isDuplicate,
  isEuropeanArbovirusRecord,
  isWithinPrecedingDays,
  findLinkedPreprint,
  matchesExclusionRules,
  matchesSpeciesScope,
  normalizeDoi,
  scoreRelevance,
  stableId
} from "./lib.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataPath = path.join(root, "data", "papers.json");
const historyPath = path.join(root, "data", "history.json");
const configPath = path.join(root, "data", "search-config.json");
const runStatusPath = path.join(root, "data", "run-status.json");
const runDate = process.env.RUN_DATE || new Date().toISOString().slice(0, 10);

const [paperArchive, history, config] = await Promise.all([
  readJson(dataPath),
  readJson(historyPath),
  readJson(configPath)
]);

const retrieval = process.env.MOCK_RECORDS
  ? {
      records: await readJson(path.resolve(process.env.MOCK_RECORDS)),
      sourceStatus: { Mock: { requests: 1, failures: 0, records: 0 } }
    }
  : await fetchAll(config, runDate);
const accepted = [];

for (const raw of retrieval.records) {
  if (!hasVerifiedScholarlyIdentity(raw)) continue;
  if (!matchesExclusionRules(raw, config.exclusionTerms)) continue;
  if (!matchesSpeciesScope(raw, config)) continue;

  const onlineDate = earliestOnlineDate(raw);
  if (!isWithinPrecedingDays(onlineDate, runDate, config.lookbackDays)) continue;

  const topic = classifyTopic(raw, config);
  if (!topic) continue;
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

await addOptionalAiSummaries(accepted);
markReadFirst(accepted);

const window = publicationWindow(runDate, config.lookbackDays);
const runStatus = {
  runDate,
  windowStart: window.start,
  windowEnd: window.end,
  completedAt: new Date().toISOString(),
  acceptedCount: accepted.length,
  topics: config.topics.map((topic) => {
    const count = accepted.filter((paper) => paper.topic === topic.name).length;
    return {
      name: topic.name,
      count,
      message: count
        ? `${count} new paper${count === 1 ? "" : "s"} identified this week`
        : "No new papers identified this week"
    };
  }),
  sources: retrieval.sourceStatus
};

const nextArchive = {
  generatedAt: new Date().toISOString(),
  papers: [...accepted, ...paperArchive.papers].sort((a, b) => b.onlinePublicationDate.localeCompare(a.onlinePublicationDate))
};

if (process.env.DRY_RUN === "1") {
  console.log(`Dry run accepted ${accepted.length} new paper${accepted.length === 1 ? "" : "s"}; archive not written.`);
  process.exit(0);
}

await fs.writeFile(runStatusPath, `${JSON.stringify(runStatus, null, 2)}\n`);
if (accepted.length) {
  await fs.writeFile(dataPath, `${JSON.stringify(nextArchive, null, 2)}\n`);
  await fs.writeFile(historyPath, `${JSON.stringify(history, null, 2)}\n`);
  console.log(`Added ${accepted.length} new paper${accepted.length === 1 ? "" : "s"}.`);
} else {
  console.log("No qualifying new papers found for this weekly run.");
  runStatus.topics.forEach((topic) => console.log(`${topic.name}: ${topic.message}`));
}

async function fetchAll(config, date) {
  const records = [];
  const sourceStatus = {
    OpenAlex: { requests: 0, failures: 0, records: 0 },
    Crossref: { requests: 0, failures: 0, records: 0 },
    "Europe PMC": { requests: 0, failures: 0, records: 0 }
  };
  let successfulRequests = 0;
  const window = publicationWindow(date, config.lookbackDays);
  for (const topic of config.topics) {
    for (const query of topic.queries) {
      const sources = [
        ["OpenAlex", fetchOpenAlex],
        ["Crossref", fetchCrossref],
        ["Europe PMC", fetchEuropePmc]
      ];
      const results = await Promise.allSettled(
        sources.map(([, fetcher]) => fetcher(query, window))
      );
      results.forEach((result, index) => {
        const name = sources[index][0];
        sourceStatus[name].requests += 1;
        if (result.status === "fulfilled") {
          successfulRequests += 1;
          sourceStatus[name].records += result.value.length;
          records.push(...result.value);
        } else {
          sourceStatus[name].failures += 1;
          console.warn(`${name} query failed: ${result.reason?.message || "unknown error"}`);
        }
      });
    }
  }
  if (!successfulRequests) {
    throw new Error("All scholarly data sources failed; the existing digest was left unchanged.");
  }
  return { records, sourceStatus };
}

async function addOptionalAiSummaries(records) {
  if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_MODEL) return;
  for (const record of records) {
    if (record.aiSummary?.text) continue;
    const prompt = [
      "Summarize this paper for a PhD project on urban-rural Culex pipiens eco-evolution in Belgium.",
      "Use only the title, abstract and metadata provided. Do not infer absent results.",
      "Distinguish evolutionary evidence from observational or phenotypic association.",
      "Distinguish laboratory findings from demonstrated field effectiveness.",
      "Return exactly three labelled lines: SUMMARY:, MAIN FINDING:, and WHY IT MATTERS:.",
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
          model: process.env.OPENAI_MODEL,
          input: prompt,
          text: { verbosity: "low" },
          max_output_tokens: 260
        })
      });
      if (!response.ok) throw new Error(`OpenAI API ${response.status}`);
      const json = await response.json();
      const text = json.output_text || json.output?.flatMap((item) => item.content || []).map((item) => item.text).filter(Boolean).join("\n");
      if (text) {
        const parsed = parseAiSummary(text);
        if (parsed.summary) record.summary = parsed.summary;
        if (parsed.mainFinding) record.mainFinding = parsed.mainFinding;
        if (parsed.whyItMatters) record.whyItMatters = parsed.whyItMatters;
        record.aiSummary = {
          model: process.env.OPENAI_MODEL,
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

async function fetchOpenAlex(query, window) {
  const url = new URL("https://api.openalex.org/works");
  url.searchParams.set("search", query);
  url.searchParams.set("filter", `from_publication_date:${window.start},to_publication_date:${window.end}`);
  url.searchParams.set("per-page", "100");
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

async function fetchCrossref(query, window) {
  const url = new URL("https://api.crossref.org/works");
  url.searchParams.set("query.bibliographic", query);
  url.searchParams.set("filter", `from-pub-date:${window.start},until-pub-date:${window.end}`);
  url.searchParams.set("rows", "100");
  const json = await fetchJson(url);
  return (json.message?.items || []).map((item) => ({
    title: item.title?.[0],
    abstract: stripTags(item.abstract || ""),
    doi: item.DOI,
    journal: item["container-title"]?.[0],
    authors: item.author?.map((author) => [author.given, author.family].filter(Boolean).join(" ")).filter(Boolean),
    publishedOnline: dateParts(item["published-online"]),
    openAccess: null,
    source: "Crossref",
    isPreprint: /posted-content|preprint/i.test(item.type || "")
  }));
}

async function fetchEuropePmc(query, window) {
  const url = new URL("https://www.ebi.ac.uk/europepmc/webservices/rest/search");
  url.searchParams.set("query", `FIRST_PDATE:[${window.start} TO ${window.end}] AND (${query})`);
  url.searchParams.set("format", "json");
  url.searchParams.set("pageSize", "100");
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
    mainFinding: extractMainFinding(raw.abstract),
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
  const genera = [
    ["culex", "Culex"],
    ["aedes", "Aedes"],
    ["anopheles", "Anopheles"]
  ].filter(([term]) => text.includes(term)).map(([, label]) => label);
  if (genera.length) return `${genera.join(", ")} mosquitoes`;
  if (text.includes("mosquito") || text.includes("culicidae")) return "Other mosquitoes";
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
  if (topic.includes("control")) return "Relevant to context-dependent predator or microbial control efficiency in aquatic mosquito habitats.";
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

function extractMainFinding(abstract = "") {
  if (!abstract) return "Not stated in available metadata.";
  const sentences = abstract.replace(/\s+/g, " ").match(/[^.!?]+[.!?]+/g) || [abstract];
  return sentences.at(-1).trim();
}

function parseAiSummary(text) {
  const value = text.trim();
  return {
    summary: value.match(/SUMMARY:\s*(.+)/i)?.[1]?.trim() || "",
    mainFinding: value.match(/MAIN FINDING:\s*(.+)/i)?.[1]?.trim() || "",
    whyItMatters: value.match(/WHY IT MATTERS:\s*(.+)/i)?.[1]?.trim() || ""
  };
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`API failed: ${url.hostname} ${response.status}`);
  return response.json();
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

function publicationWindow(date, lookbackDays) {
  const end = new Date(`${date}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(`${date}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - lookbackDays);
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10)
  };
}
