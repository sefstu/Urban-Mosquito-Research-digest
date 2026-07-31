import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyTopic,
  hasVerifiedScholarlyIdentity,
  isDuplicate,
  isEuropeanArbovirusRecord,
  isWnvOrSinvRecord,
  isWithinPrecedingDays,
  findLinkedPreprint,
  matchesExclusionRules,
  matchesSpeciesScope,
  normalizeDoi,
  normalizeTitle,
  papersForWeeklyStatus,
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
  assert.equal(isWnvOrSinvRecord({
    title: "Urban-rural West Nile virus dynamics in North American mosquitoes"
  }), true);
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

test("preserves the current weekly status on an idempotent rerun", () => {
  const weekly = papersForWeeklyStatus([], {
    papers: [
      {
        id: "current",
        onlinePublicationDate: "2026-07-26",
        week: "2026-07-28",
        topic: "Mosquito ecology and vector biology"
      },
      {
        id: "older",
        onlinePublicationDate: "2026-07-20",
        week: "2026-07-30",
        topic: "Mosquito ecology and vector biology"
      }
    ]
  }, "2026-07-30");
  assert.deepEqual(weekly.map((paper) => paper.id), ["current"]);
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

test("uses work-package fit rather than mosquito genus alone", () => {
  assert.equal(matchesSpeciesScope({
    title: "Culex pipiens oviposition preferences across water volumes"
  }, config), true);
  assert.equal(matchesSpeciesScope({
    title: "Urban-rural evolution of thermal tolerance in Aedes mosquitoes"
  }, config), true);
  assert.equal(matchesSpeciesScope({
    title: "Infrared thermal imaging of Aedes mosquito habitats"
  }, config), true);
  assert.equal(matchesSpeciesScope({
    title: "Thermal tolerance and body size of Anopheles mosquitoes in Spain"
  }, config), true);
  assert.equal(matchesSpeciesScope({
    title: "Toxorhynchites predation rate as mosquito biological control"
  }, config), true);
  assert.equal(matchesSpeciesScope({
    title: "Temperature variation as a driver of Wolbachia release efficacy in mosquitoes"
  }, config), true);
  assert.equal(matchesSpeciesScope({
    title: "Mosquito eDNA surveillance in aquatic habitats"
  }, config), true);
  assert.equal(matchesSpeciesScope({
    title: "Diversity of insect-specific viruses in Culex mosquitoes from Papua New Guinea"
  }, config), false);
  assert.equal(matchesSpeciesScope({
    title: "Early-evening foraging by Anopheles mosquitoes in Zambia"
  }, config), false);
  assert.equal(matchesSpeciesScope({
    title: "Oviposition activity of Aedes mosquitoes in Brazil"
  }, config), false);
  assert.equal(matchesSpeciesScope({
    title: "Urban-rural common garden in great tits"
  }, config), false);
  assert.equal(matchesSpeciesScope({
    title: "Nonlinear effects of the digital economy on urban-rural integration"
  }, config), false);
  assert.equal(matchesSpeciesScope({
    title: "Greywater reuse for urban agriculture",
    abstract: "Urbanisation affects water management and may create mosquito habitat."
  }, config), false);
});

test("ranks the user-selected Mbaoma and Drerup papers highly", () => {
  const mbaoma = {
    title: "Insight into eco-epidemiological traits of European native vector mosquitoes for disease transmission",
    abstract: "The review includes Culex pipiens and other European native vectors.",
    topic: "Mosquito ecology and vector biology"
  };
  const drerup = {
    title: "Distinct Swimming Behaviours in Pupae of Aedes, Anopheles and Culex Mosquitoes",
    abstract: "A comparative experiment quantified pupal movement.",
    topic: "Mosquito ecology and vector biology"
  };
  assert.equal(matchesSpeciesScope(mbaoma, config), true);
  assert.equal(matchesSpeciesScope(drerup, config), true);
  assert.ok(scoreRelevance(mbaoma, config) >= 90);
  assert.ok(scoreRelevance(drerup, config) >= 75);
});

test("gives strong transfer scores to predator and thermal biocontrol", () => {
  const predatorScore = scoreRelevance({
    title: "Eco-friendly mosquito control using Toxorhynchites brevipalpis",
    abstract: "An experiment measured larvivorous predation rates against Aedes larvae."
  }, config);
  const wolbachiaScore = scoreRelevance({
    title: "Temperature variation as a driver of Wolbachia release efficacy",
    abstract: "The model evaluates mosquito control in warming climates.",
    isPreprint: true
  }, config);
  assert.ok(predatorScore >= 80);
  assert.ok(wolbachiaScore >= 70);
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
