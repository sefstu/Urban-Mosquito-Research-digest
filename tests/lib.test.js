import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyTopic,
  hasVerifiedScholarlyIdentity,
  isDuplicate,
  isEuropeanArbovirusRecord,
  isWithinPrecedingDays,
  findLinkedPreprint,
  matchesExclusionRules,
  matchesSpeciesScope,
  normalizeDoi,
  normalizeTitle,
  scoreRelevance
} from "../scripts/lib.js";
import config from "../data/search-config.json" with { type: "json" };

test("normalizes DOI variants", () => {
  assert.equal(normalizeDoi("https://doi.org/10.1186/S13071-016-1677-0"), "10.1186/s13071-016-1677-0");
  assert.equal(normalizeDoi("doi: 10.1111/MVE.12251 "), "10.1111/mve.12251");
});

test("normalizes titles for durable deduplication", () => {
  assert.equal(
    normalizeTitle("Urban-rural common-garden: Culex pipiens responses!"),
    "urban rural common garden culex pipiens responses"
  );
});

test("deduplicates by DOI before normalized title", () => {
  const history = {
    doiHistory: ["10.1111/mve.12251"],
    titleHistory: ["existing title"]
  };
  assert.equal(isDuplicate({ doi: "DOI:10.1111/MVE.12251", title: "Different title" }, history), true);
  assert.equal(isDuplicate({ doi: "", title: "Existing   title" }, history), true);
  assert.equal(isDuplicate({ doi: "", title: "New title" }, history), false);
});

test("uses preceding seven days, excluding run date itself", () => {
  assert.equal(isWithinPrecedingDays("2026-07-17", "2026-07-24", 7), true);
  assert.equal(isWithinPrecedingDays("2026-07-24", "2026-07-24", 7), false);
  assert.equal(isWithinPrecedingDays("2026-07-16", "2026-07-24", 7), false);
});

test("enforces strict European arbovirus geography", () => {
  assert.equal(isEuropeanArbovirusRecord({
    title: "West Nile virus circulation in Italy",
    abstract: "Culex pipiens and avian hosts were sampled."
  }), true);
  assert.equal(isEuropeanArbovirusRecord({
    title: "West Nile virus circulation in North America",
    abstract: "Local transmission dynamics are analysed."
  }), false);
});

test("scores user research context strongly", () => {
  const score = scoreRelevance({
    title: "Culex pipiens urban-rural common garden CTmax eDNA WNV Europe",
    abstract: "Predator mesocosm and vector competence study",
    topic: "European arbovirus dynamics",
    isPreprint: false
  }, config);
  assert.equal(score, 100);
});

test("links later journal articles to matching preprints", () => {
  const archive = {
    papers: [{
      id: "preprint-1",
      title: "Sindbis virus circulation in European mosquito and avian host networks",
      isPreprint: true
    }]
  };
  const linked = findLinkedPreprint({
    title: "Sindbis virus circulation in European mosquito and avian host networks",
    isPreprint: false
  }, archive);
  assert.equal(linked.id, "preprint-1");
});

test("rejects placeholders and records without a DOI", () => {
  assert.equal(hasVerifiedScholarlyIdentity({
    title: "Urban mosquito common-garden sample record",
    doi: "10.1000/sample",
    source: "Local sample data"
  }), false);
  assert.equal(hasVerifiedScholarlyIdentity({
    title: "A real mosquito ecology paper",
    doi: ""
  }), false);
  assert.equal(hasVerifiedScholarlyIdentity({
    title: "A real mosquito ecology paper",
    doi: "10.1000/real-paper"
  }), true);
});

test("prioritizes Culex, Aedes and Anopheles while retaining transferable methods", () => {
  assert.equal(matchesSpeciesScope({
    title: "Swimming behaviour in Culex pupae"
  }, config), true);
  assert.equal(matchesSpeciesScope({
    title: "Mosquito eDNA surveillance in aquatic habitats"
  }, config), true);
  assert.equal(matchesSpeciesScope({
    title: "Urban-rural common garden in great tits"
  }, config), true);
  assert.equal(matchesSpeciesScope({
    title: "Crop yield responses in wheat"
  }, config), false);
});

test("applies configured exclusions and refuses zero-hit topic classification", () => {
  assert.equal(matchesExclusionRules({
    title: "Editorial without data on mosquito control"
  }, config.exclusionTerms), false);
  assert.equal(classifyTopic({
    title: "Unrelated crop chemistry",
    abstract: ""
  }, config), "");
});
