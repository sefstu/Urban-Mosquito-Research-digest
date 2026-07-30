# Urban Mosquito Research Digest

A lightweight static weekly research digest for urban adaptation in `Culex pipiens`, mosquito ecology, thermal biology, predator-based mosquito control, eDNA surveillance, and European WNV/SINV dynamics.

## Local Preview

```powershell
node scripts/serve.js
```

Then open `http://localhost:4173`.

If Node is not on your PATH in Codex Desktop, use the bundled runtime:

```powershell
C:\Users\youss\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe scripts/serve.js
```

## Folder Structure

- `index.html` is the static page served by GitHub Pages.
- `assets/styles.css` contains the responsive academic design.
- `assets/app.js` powers filtering, sorting, copy citation, read state, reading list, CSV export and BibTeX export.
- `data/papers.json` is the readable paper archive.
- `data/history.json` is the permanent DOI and normalized-title deduplication history.
- `data/search-config.json` contains editable search terms, topic weights, exclusion terms, the strict seven-day publication rule, and the research-context relevance weights.
- `scripts/update-now.js` runs the weekly API update.
- `scripts/lib.js` contains DOI normalization, title normalization, date checks, European arbovirus filtering and relevance scoring.
- `tests/lib.test.js` tests normalization, deduplication, strict date handling, European arbovirus geography and relevance scoring.
- `.github/workflows/update-digest.yml` runs every Tuesday morning and can also be triggered manually.

## Manual Update

```powershell
npm run update
```

The script queries OpenAlex, Crossref and Europe PMC. It only accepts papers whose earliest verified online-publication date falls in the preceding seven days. API indexing dates and metadata update dates are not treated as new publication dates.

When no topic has qualifying papers, the script prints `No new papers identified this week` for each topic and leaves the archive unchanged.

## GitHub Pages Deployment

1. Create a new GitHub repository.
2. Copy this project into the repository root.
3. Commit and push all files.
4. In GitHub, open `Settings` -> `Pages`.
5. Under `Build and deployment`, choose `Deploy from a branch`.
6. Select the `main` branch and `/ (root)` folder.
7. Save. GitHub will publish the site at the Pages URL shown in that settings panel.

## Optional OpenAI Summaries

The site works without AI and uses only metadata and abstracts from scholarly APIs. If `OPENAI_API_KEY` is present, the update script uses the OpenAI Responses API with the economical `gpt-5.6-luna` default model to create concise cached summaries for newly accepted papers only.

1. In GitHub, open the repository `Settings`.
2. Go to `Secrets and variables` -> `Actions`.
3. Choose `New repository secret`.
4. Name it `OPENAI_API_KEY`.
5. Paste the API key and save.

The workflow already passes `OPENAI_API_KEY` to the updater. To use a different model, add an Actions variable named `OPENAI_MODEL`.

## European Arbovirus Rules

The `European arbovirus dynamics` topic applies a strict geographic filter:

- Include Europe-wide studies and studies from individual European countries.
- Include non-European research only when it directly analyses consequences for European transmission or emergence.
- Report country or region, virus, mosquito vector species, host species when relevant, study period, evidence type, main change or finding, and relevance to European transmission risk.
- Keep preprints separate and link later journal versions rather than counting them as entirely new studies.

## Limitations

- Sample records are included so the interface is immediately usable. They are clearly marked as sample data where appropriate.
- Automated extraction of study period, host species and fine-grained arbovirus evidence depends on what APIs expose in title and abstract metadata; ambiguous fields are marked as not specified for manual review.
- DOI link validation is handled structurally by normalized DOI links; a deeper HTTP validation pass can be added if you want the update script to check every DOI URL before commit.
