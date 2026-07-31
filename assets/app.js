const state = {
  papers: [],
  history: {},
  status: {},
  filters: {
    search: "",
    topic: "",
    taxon: "",
    date: "",
    high: false,
    readFirst: false,
    openAccess: false,
    archive: false,
    sort: "relevance"
  }
};

const storage = {
  read: new Set(JSON.parse(localStorage.getItem("umrd-read") || "[]")),
  saved: new Set(JSON.parse(localStorage.getItem("umrd-saved") || "[]")),
  savedPapers: new Map(
    JSON.parse(localStorage.getItem("umrd-saved-papers") || "[]")
      .filter((paper) => paper?.id)
      .map((paper) => [paper.id, paper])
  )
};

const fields = {
  search: document.querySelector("#search"),
  topic: document.querySelector("#topic-filter"),
  taxon: document.querySelector("#taxon-filter"),
  date: document.querySelector("#date-filter"),
  high: document.querySelector("#high-relevance"),
  readFirst: document.querySelector("#read-first-only"),
  openAccess: document.querySelector("#open-access-only"),
  archive: document.querySelector("#include-archive"),
  sort: document.querySelector("#sort")
};

const dataVersion = Date.now();
const data = await Promise.all([
  fetch(`data/papers.json?v=${dataVersion}`, { cache: "no-store" }).then((response) => response.json()),
  fetch(`data/history.json?v=${dataVersion}`, { cache: "no-store" }).then((response) => response.json()),
  fetch(`data/run-status.json?v=${dataVersion}`, { cache: "no-store" }).then((response) => response.json())
]);

state.papers = data[0].papers;
state.history = data[1];
state.status = data[2];
refreshSavedPaperCache();
hydrateControls();
render();

Object.entries(fields).forEach(([name, node]) => {
  node.addEventListener("input", () => {
    if (node.type === "checkbox") state.filters[name] = node.checked;
    else state.filters[name] = node.value;
    render();
  });
});

document.querySelector("#export-csv").addEventListener("click", exportCsv);
document.querySelector("#export-bibtex").addEventListener("click", exportBibtex);

function hydrateControls() {
  fillSelect(fields.topic, unique(state.papers.map((paper) => paper.topic)));
  fillSelect(fields.taxon, unique(state.papers.map((paper) => paper.taxon)));
}

function fillSelect(select, options) {
  options.forEach((option) => {
    const node = document.createElement("option");
    node.value = option;
    node.textContent = option;
    select.append(node);
  });
}

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function render() {
  const papers = filteredPapers();
  const latest = state.status.runDate || latestDate(state.papers);
  document.querySelector("#latest-update").textContent = `Latest weekly check: ${formatDate(latest)}. Publication window: ${formatDateRange(state.status.windowStart, state.status.windowEnd)}.`;
  document.querySelector("#stat-new").textContent = state.status.acceptedCount ?? state.papers.filter(isCurrentWindowPaper).length;
  document.querySelector("#stat-total").textContent = state.papers.length;
  document.querySelector("#stat-topics").textContent = (state.status.topics || []).filter((topic) => topic.count > 0).length;
  document.querySelector("#result-count").textContent = `${papers.length} paper${papers.length === 1 ? "" : "s"} shown.`;
  renderWeeklyStatus();
  renderReadFirst();
  renderDigest(papers.filter((paper) => !paper.isPreprint));
  renderPreprints(papers.filter((paper) => paper.isPreprint));
  renderArchive();
  renderReadingList();
}

function filteredPapers() {
  const query = state.filters.search.trim().toLowerCase();
  return state.papers
    .filter((paper) => state.filters.archive || isCurrentWindowPaper(paper))
    .filter((paper) => !query || haystack(paper).includes(query))
    .filter((paper) => !state.filters.topic || paper.topic === state.filters.topic)
    .filter((paper) => !state.filters.taxon || paper.taxon === state.filters.taxon)
    .filter((paper) => !state.filters.date || paper.onlinePublicationDate >= state.filters.date)
    .filter((paper) => !state.filters.high || paper.relevanceScore >= 70)
    .filter((paper) => !state.filters.readFirst || paper.readFirst)
    .filter((paper) => !state.filters.openAccess || paper.openAccess === true)
    .sort((a, b) => {
      if (state.filters.sort === "date") return b.onlinePublicationDate.localeCompare(a.onlinePublicationDate);
      return b.relevanceScore - a.relevanceScore || b.onlinePublicationDate.localeCompare(a.onlinePublicationDate);
    });
}

function haystack(paper) {
  return [
    paper.title,
    paper.authors?.join(" "),
    paper.journal,
    paper.topic,
    paper.taxon,
    paper.summary,
    paper.mainFinding,
    paper.whyItMatters,
    paper.virus,
    paper.countryOrRegion,
    paper.vectorSpecies,
    paper.hostSpecies,
    paper.relevanceReasons?.join(" ")
  ].filter(Boolean).join(" ").toLowerCase();
}

function renderReadFirst() {
  const container = document.querySelector("#read-first-list");
  const papers = state.papers
    .filter((paper) => isCurrentWindowPaper(paper) && paper.readFirst)
    .sort((a, b) => a.readFirstRank - b.readFirstRank)
    .slice(0, 3);
  container.replaceChildren(...(papers.length ? papers.map(cardFor) : [empty("No new papers identified this week.")]));
}

function renderWeeklyStatus() {
  const container = document.querySelector("#weekly-status");
  const topics = state.status.topics || [];
  document.querySelector("#coverage-window").textContent = `Papers first published online ${formatDateRange(state.status.windowStart, state.status.windowEnd)}.`;
  container.replaceChildren(...topics.map((topic) => {
    const node = document.createElement("div");
    node.className = "weekly-status-item";
    node.dataset.hasPapers = topic.count > 0 ? "true" : "false";
    node.innerHTML = `<strong>${escapeHtml(topic.name)}</strong><span>${escapeHtml(topic.message)}</span>`;
    return node;
  }));
}

function renderDigest(papers) {
  const container = document.querySelector("#digest");
  if (!papers.length) {
    container.replaceChildren(empty("No papers match the current filters."));
    return;
  }

  const byTopic = groupBy(papers, (paper) => paper.topic);
  const groups = [...byTopic.entries()].map(([topic, topicPapers]) => {
    const details = document.createElement("details");
    details.className = "topic-group";
    details.open = true;
    const summary = document.createElement("summary");
    summary.textContent = `${topic} (${topicPapers.length})`;
    const grid = document.createElement("div");
    grid.className = "paper-grid";
    grid.append(...topicPapers.map(cardFor));
    details.append(summary, grid);
    return details;
  });

  container.replaceChildren(...groups);
}

function renderPreprints(papers) {
  const section = document.querySelector("#preprints-section");
  const container = document.querySelector("#preprints");
  section.hidden = papers.length === 0;
  if (!papers.length) {
    container.replaceChildren();
    return;
  }
  const grid = document.createElement("div");
  grid.className = "paper-grid";
  grid.append(...papers.map(cardFor));
  container.replaceChildren(grid);
}

function renderArchive() {
  const container = document.querySelector("#archive-list");
  const byWeek = groupBy(state.papers, (paper) => paper.week);
  const weeks = [...byWeek.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  container.replaceChildren(...weeks.map(([week, papers]) => {
    const node = document.createElement("div");
    node.className = "archive-week";
    node.innerHTML = `<strong>${escapeHtml(formatDate(week))}</strong><span>${papers.length} paper${papers.length === 1 ? "" : "s"} archived across ${unique(papers.map((paper) => paper.topic)).length} topic${unique(papers.map((paper) => paper.topic)).length === 1 ? "" : "s"}.</span>`;
    return node;
  }));
}

function renderReadingList() {
  const saved = savedPaperRecords();
  const container = document.querySelector("#reading-list");
  container.replaceChildren(...(saved.length ? saved.map(cardFor) : [empty("No saved papers yet.")]));
}

function cardFor(paper) {
  const template = document.querySelector("#paper-card-template");
  const node = template.content.firstElementChild.cloneNode(true);
  node.querySelector(".topic-pill").textContent = paper.topic;
  const status = node.querySelector(".status-pill");
  status.textContent = paper.isPreprint ? "Preprint" : paper.openAccess ? "Open access" : "Access unknown";
  if (paper.isPreprint) status.classList.add("preprint");
  const score = formatRelevanceScore(paper.relevanceScore);
  node.dataset.relevance = score >= 8 ? "high" : score >= 6 ? "medium" : "general";
  node.querySelector(".relevance-score strong").textContent = `${score}/10`;
  node.querySelector("h3").innerHTML = italicizeSpecies(escapeHtml(paper.title));
  node.querySelector(".meta").textContent = `${paper.authors?.join(", ") || "Authors unavailable"} · ${formatDate(paper.onlinePublicationDate)}`;
  node.querySelector(".relevance-basis").textContent = paper.relevanceReasons?.length
    ? `Score basis: ${paper.relevanceReasons.join(" · ")}`
    : "";
  node.querySelector(".summary").textContent = paper.summary || "Abstract unavailable";

  const journal = [paper.journal || "Journal unavailable", paper.source].filter(Boolean).join(" · ");
  const facts = [
    ["Species", paper.taxon || "Not specified"],
    ["Journal", journal],
    ["Methodology", methodologyFor(paper)]
  ];

  node.querySelector(".paper-facts").replaceChildren(...facts.flatMap(([term, value]) => {
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = term;
    dd.innerHTML = italicizeSpecies(escapeHtml(String(value)));
    return [dt, dd];
  }));

  node.querySelector(".finding").innerHTML = `<strong>Main finding:</strong> ${italicizeSpecies(escapeHtml(paper.mainFinding || "Not stated in available metadata."))}`;
  node.querySelector(".matters").innerHTML = `<strong>Why it matters:</strong> ${italicizeSpecies(escapeHtml(paper.whyItMatters || "Relevance not yet assessed."))}`;
  node.querySelector(".read-first-note").innerHTML = paper.readFirstReason ? `<strong>Read-first reason:</strong> ${escapeHtml(paper.readFirstReason)}` : "";

  const doiLink = node.querySelector(".doi-link");
  if (paper.doi) doiLink.href = `https://doi.org/${paper.doi}`;
  else doiLink.setAttribute("aria-disabled", "true");
  node.querySelector(".copy-citation").addEventListener("click", () => copyCitation(paper));
  const readButton = node.querySelector(".mark-read");
  readButton.textContent = storage.read.has(paper.id) ? "Read" : "Mark read";
  readButton.addEventListener("click", () => toggleSet(storage.read, paper.id, "umrd-read", render));
  const saveButton = node.querySelector(".save-paper");
  saveButton.textContent = storage.saved.has(paper.id) ? "Saved" : "Save";
  saveButton.addEventListener("click", () => toggleSavedPaper(paper));
  return node;
}

function copyCitation(paper) {
  const citation = `${paper.authors?.join(", ") || "Authors unavailable"} (${paper.onlinePublicationDate.slice(0, 4)}). ${paper.title}. ${paper.journal || "Journal unavailable"}. ${paper.doi ? `https://doi.org/${paper.doi}` : ""}`;
  navigator.clipboard.writeText(citation);
}

function toggleSet(set, id, key, after) {
  if (set.has(id)) set.delete(id);
  else set.add(id);
  localStorage.setItem(key, JSON.stringify([...set]));
  after();
}

function toggleSavedPaper(paper) {
  if (storage.saved.has(paper.id)) {
    storage.saved.delete(paper.id);
    storage.savedPapers.delete(paper.id);
  } else {
    storage.saved.add(paper.id);
    storage.savedPapers.set(paper.id, paper);
  }
  persistSavedPapers();
  render();
}

function refreshSavedPaperCache() {
  state.papers
    .filter((paper) => storage.saved.has(paper.id))
    .forEach((paper) => storage.savedPapers.set(paper.id, paper));
  persistSavedPapers();
}

function persistSavedPapers() {
  localStorage.setItem("umrd-saved", JSON.stringify([...storage.saved]));
  localStorage.setItem("umrd-saved-papers", JSON.stringify([...storage.savedPapers.values()]));
}

function savedPaperRecords() {
  return [...storage.saved]
    .map((id) => state.papers.find((paper) => paper.id === id) || storage.savedPapers.get(id))
    .filter(Boolean);
}

function exportCsv() {
  const papers = savedPaperRecords();
  const rows = [["title", "authors", "journal", "online_publication_date", "doi", "topic"], ...papers.map((paper) => [
    paper.title,
    paper.authors?.join("; ") || "",
    paper.journal || "",
    paper.onlinePublicationDate,
    paper.doi || "",
    paper.topic
  ])];
  download("urban-mosquito-reading-list.csv", rows.map((row) => row.map(csvCell).join(",")).join("\n"));
}

function exportBibtex() {
  const papers = savedPaperRecords();
  const text = papers.map((paper) => {
    const key = `${paper.authors?.[0]?.split(" ").at(-1) || "paper"}${paper.onlinePublicationDate.slice(0, 4)}`.replace(/\W/g, "");
    return `@article{${key},\n  title = {${paper.title}},\n  author = {${paper.authors?.join(" and ") || ""}},\n  journal = {${paper.journal || ""}},\n  year = {${paper.onlinePublicationDate.slice(0, 4)}},\n  doi = {${paper.doi || ""}}\n}`;
  }).join("\n\n");
  download("urban-mosquito-reading-list.bib", text);
}

function csvCell(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function download(filename, text) {
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function latestDate(papers) {
  return papers.map((paper) => paper.week).sort().at(-1) || new Date().toISOString().slice(0, 10);
}

function isCurrentWindowPaper(paper) {
  const start = state.status.windowStart;
  const end = state.status.windowEnd;
  if (start && end) {
    return paper.onlinePublicationDate >= start && paper.onlinePublicationDate <= end;
  }
  return paper.week === state.status.runDate;
}

function groupBy(items, selector) {
  const map = new Map();
  items.forEach((item) => {
    const key = selector(item);
    map.set(key, [...(map.get(key) || []), item]);
  });
  return map;
}

function formatDate(date) {
  if (!date) return "date unavailable";
  return new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(`${date}T00:00:00Z`));
}

function formatDateRange(start, end) {
  if (!start || !end) return "date window unavailable";
  return `${formatDate(start)}–${formatDate(end)}`;
}

function formatRelevanceScore(score) {
  return Math.round((Number(score) || 0)) / 10;
}

function methodologyFor(paper) {
  const approach = [paper.studyType, paper.evidenceLabel]
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(" with ");
  const details = [];
  if (paper.countryOrRegion) details.push(paper.countryOrRegion);
  if (paper.virus) details.push(paper.virus);
  if (paper.vectorSpecies) details.push(`vector: ${paper.vectorSpecies}`);
  if (paper.hostSpecies && !paper.hostSpecies.startsWith("Not applicable")) details.push(`host: ${paper.hostSpecies}`);
  if (paper.studyPeriod && !paper.studyPeriod.startsWith("Not specified")) details.push(paper.studyPeriod);
  return [approach || "Method not specified", details.join("; ")].filter(Boolean).join(". ");
}

function empty(text) {
  const node = document.createElement("p");
  node.className = "empty";
  node.textContent = text;
  return node;
}

function escapeHtml(text) {
  const node = document.createElement("span");
  node.textContent = text;
  return node.innerHTML;
}

function italicizeSpecies(html) {
  return html.replaceAll("Culex pipiens", "<i>Culex pipiens</i>").replaceAll("Cx. pipiens", "<i>Cx. pipiens</i>");
}
