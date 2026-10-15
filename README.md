# Canard

Canard turns a hand-made spreadsheet of sources into a semantic map. Each row's title and summary is converted into a vector by an embedding model, and the vectors are plotted in two dimensions so that entries about similar things sit close together. You can switch between four projections (UMAP, t-SNE, Gaussian kernel PCA and PCA), see entries grouped into automatic topic clusters or into IP Australia's five growth territories, filter by metadata, select points individually or with a lasso, read each entry in a side panel and tag groups of entries.

![Canard showing the example plot in the t-SNE view, with one entry open in the side panel](docs/screenshot.png)

- **Site:** https://thomas-amann-ipaustralia.github.io/Canard/ (after the set-up below)
- **Viewing** needs no password. **Uploading or deleting** a spreadsheet needs the upload password every time. **Tagging** needs the tagging password once per browser session.
- Everything is stored in this repository's `data/` folder. Because the repository is public, **anything you upload (titles, summaries, links and tags) is public too.**

## How it works

```
 Browser (GitHub Pages)                                Render (free)            GitHub
 ┌──────────────────────────────────────────┐        ┌────────────────┐      ┌──────────────┐
 │ view: reads data/ straight from Pages    │        │ Canard API     │      │ this repo    │
 │ upload: validate CSV → embed → layouts ──┼──────► │ check password │ ───► │ data/ commit │
 │ tag: optimistic update ──────────────────┼──────► │ re-validate    │      └──────┬───────┘
 └──────────────────────────────────────────┘        └────────────────┘             │
              ▲                                                                       │
              └──────────── GitHub Actions republishes the site (about a minute) ◄───┘
```

- **The heavy work happens in the browser.** Render's free tier has a tenth of a CPU, so the uploader's browser validates the CSV, runs the embedding model ([bge-small-en-v1.5](https://huggingface.co/BAAI/bge-small-en-v1.5) through [transformers.js](https://github.com/huggingface/transformers.js), on the GPU where available) and computes all four layouts and the topic clusters in web workers.
- **Nothing comes from third-party servers on the published site.** Many workplace networks block Hugging Face and jsDelivr, so the Pages workflow copies the model, transformers.js and the ONNX Runtime files onto the site (`scripts/fetch-model-assets.mjs`). The browser only falls back to those servers when the copies are missing, for example on the dev server.
- **The server is small.** It checks passwords, repeats every validation check (including the token limit, with the same tokenizer), and commits the result to `data/` as a single commit through the GitHub API.
- **Switching views is instant** because all four layouts are calculated at upload time and stored. Switching only animates points between stored positions.
- **New uploads keep the map's orientation.** Each new layout is rotated to line up with the previous one, so existing clusters stay roughly where they were.

### Coping with Render's cold starts

Render's free service sleeps after 15 minutes without traffic and takes up to about a minute to wake. Canard hides this where it can:

- Viewing never touches the server, so plots appear immediately.
- The page starts waking the server as soon as it loads, and a status indicator in the header shows progress.
- During an upload, the password check (which wakes the server) runs at the same time as the model download and embedding, so the wait overlaps with work that has to happen anyway.
- Tag changes appear on screen immediately and are saved in the background.
- While an upload dialog is open or tagging is unlocked, the page pings the server every 10 minutes so it does not fall asleep mid-session.
- After a change, GitHub Pages takes a minute or two to republish. In the meantime the page reads the latest data through the server, so a reload never shows stale data.

## Set-up

For a click-by-click walkthrough, including checks and troubleshooting, see **[Setting up the Render back end](docs/render-setup.md)**. In short:

1. **Merge this branch into `main`.**
2. **Turn on GitHub Pages.** In the repository go to *Settings > Pages* and set *Source* to **GitHub Actions**. The *Publish site* workflow then deploys the site on every push to `main`.
3. **Create a GitHub token for the server.** Go to *GitHub > Settings > Developer settings > Fine-grained personal access tokens*, create a token with access to **only** `Thomas-Amann-IPAustralia/Canard` and the repository permission **Contents: Read and write**. Copy it.
4. **Create the Render service.** In Render choose *New > Blueprint*, connect this repository and accept `render.yaml`. When prompted, enter:
   - `GITHUB_TOKEN`: the token from step 3
   - `CANARD_ADMIN_PASSWORD`: the password for uploading and deleting
   - `CANARD_TAG_PASSWORD`: the password for tagging (the upload password also works for tagging)

   `CANARD_SESSION_SECRET` is generated automatically.
5. **Check the server address.** The site expects `https://canard-api.onrender.com`. If Render gave the service a different address, add a repository variable named `CANARD_API_URL` with that address (*Settings > Secrets and variables > Actions > Variables*), then re-run the *Publish site* workflow.
6. Open the site. The header shows **Server ready** once the server is awake.

The repository includes an example plot (*Example: landmark documents*) so there is something to explore straight away. Delete it from the *Spreadsheets* dialog once you have uploaded your own data.

### Server settings

| Variable | Purpose | Default |
| --- | --- | --- |
| `CANARD_ADMIN_PASSWORD` | Password for uploads and deletions (and tagging). Editing is switched off if it is missing. | none |
| `CANARD_TAG_PASSWORD` | Password for tagging sessions | the admin password |
| `CANARD_SESSION_SECRET` | Signs tagging sessions so they survive server restarts | random at start-up |
| `CANARD_SESSION_HOURS` | How long a tagging session lasts | `12` |
| `GITHUB_TOKEN` | Fine-grained token with Contents read and write on this repository | none |
| `GITHUB_REPO`, `GITHUB_BRANCH` | Where data is committed | `Thomas-Amann-IPAustralia/Canard`, `main` |
| `CANARD_DATA_DIR` | Folder in the repository that holds the data | `data` |
| `CANARD_ALLOWED_ORIGINS` | Comma-separated sites allowed to call the API | the GitHub Pages site and localhost |
| `CANARD_STORE` | `github`, or `local` to write to a folder (development) | `github` when a token is set |

Ten wrong passwords from one address within 15 minutes lock that address out for the rest of the window, and 100 wrong passwords in total lock all password checks for 15 minutes.

## Using Canard

### Preparing a spreadsheet

Download the template from the *Upload* dialog or the *More options* menu. The CSV must have exactly these five columns, in this order:

| Column | Rules |
| --- | --- |
| Title | Required |
| Summary | Required. Line breaks are fine (Excel handles the quoting). |
| Source link | Required. A full web address starting with `http://` or `https://`. |
| Publication Date | Required. `YYYY-MM-DD` is safest. `DD/MM/YYYY` (Australian order), `5 March 2024` and `March 5, 2024` also work. If only the year or month is known, use the first day. |
| Source type | Required. A short category such as *Journal article* or *News* (60 characters at most). Capitalisation is matched to entries already in the plot. |

The title and summary of each entry together must fit in the embedding model's limit of **512 tokens** (roughly 380 words). In Excel, save with *File > Save As > CSV UTF-8 (Comma delimited)*.

Files that break a rule are rejected before anything is uploaded, with a list of every problem and the spreadsheet row it is on, for example:

> **Row 7** ("Patent reform in…"): the title and summary together are 634 tokens long, but the embedding model accepts at most 512. Shorten this entry by at least 122 tokens (roughly 92 words).

At most 2,000 entries can be uploaded at once, and a plot can hold up to 5,000 entries.

### Uploading

Choose *Upload*, pick an existing plot or create a new one, choose the file and enter the upload password. The first upload on a computer downloads the embedding model (about 128 MB, cached afterwards). Embedding runs on the GPU where the browser supports WebGPU, and otherwise across several CPU cores. As a guide, embedding 600 entries took about 30 seconds on a four-core test machine without a GPU, and the layouts a further 2 seconds.

### Exploring

- **Views:** UMAP, t-SNE, Gaussian kernel PCA and PCA (keys 1 to 4), and Territories (key 5). Distances between t-SNE clusters are not meaningful; UMAP keeps more of the overall shape; the Gaussian kernel and PCA views are smooth, repeatable projections. See below for the territories view.
- **Zoom and pan:** scroll or pinch to zoom, drag to pan, double-click to zoom in, `0` to fit everything.
- **Read an entry:** click a point (or an item in the *Matching entries* list) to open the side panel with the summary and a link to the original source.
- **Select a group:** use the lasso (`L`), or hold Shift and drag. Shift adds to the selection and Alt removes from it. Shift-click adds or removes single points.
- **Filter:** by words in the title or summary, publication date, source type, tag, spreadsheet, topic cluster and growth territory. Non-matching points fade (or hide, if you prefer).
- **Colour:** by source type, tag, spreadsheet, publication date, topic cluster or growth territory. Up to three values are highlighted at a time so the colours stay easy to tell apart; choose which with *Choose colours*. Topic clusters are also labelled on the plot, and territories by their rings, so the rest stay identifiable in grey.
- **Export:** *More options > Download matching entries* saves the filtered entries, with their tags, topic cluster and growth territory, as a CSV.

### Topic clusters and growth territories

Every upload also groups the plot's entries in two ways. Both are stored with the plot, so they appear instantly.

**Topic clusters** are found automatically, in the style of [BERTopic](https://maartengr.github.io/BERTopic/):

1. The 384-dimension embeddings from the transformer encoder (the same vectors as the map).
2. [UMAP](https://umap-learn.readthedocs.io/) reduces them to **five dimensions** (15 neighbours, cosine distance, `min_dist` 0 so clusters pack tightly). Clustering happens here, where far more of the structure survives than in the two dimensions on screen; the map only pictures the result.
3. [HDBSCAN](https://hdbscan.readthedocs.io/) finds dense groups of any shape and leaves entries that fit no group **unclustered** rather than forcing them into one. The smallest cluster grows slowly with the plot (3 entries for small plots, 12 for 600, at most 25), and clusters are numbered by size.
4. **c-TF-IDF** (class-based TF-IDF) describes each cluster: the titles and summaries of a cluster are pooled into one document, and a term scores `tf × log(1 + A / f)`, so words that are frequent in that cluster but rare across the others rank highest. Single words and pairs of words are considered, simple plurals are folded together, and words found in more than half of all entries are left out.

Choose *Colour by > Topic cluster* to see them. Each cluster is labelled on the plot with its top keywords, and the *Topic cluster* filter lists them all.

**Growth territories** are an opinionated alternative, like k-means with k = 5 and hand-made centroids. Each of IP Australia's five growth territories (defined in [`site/js/territories.js`](site/js/territories.js)) becomes a centroid: every statement in it (the aim, each "imagine a world where", each recent change, each job to be done and the "why now" statement) is embedded with the same model, statements are averaged within each section, and the sections are combined (recent changes count for half, as they mostly describe IP Australia's own work). Each entry belongs to the territory whose centroid it is most similar to (cosine similarity).

The **Territories** view (key `5`) is the only place the five centroids are drawn: as labelled rings at the corners of a pentagon. Each entry sits among them according to how much more similar it is to each territory than to the others, so entries that clearly belong to one territory sit close to its ring, entries split between two sit between them, and entries equally close to all five sit near the middle. Clicking an entry shows its similarity to every territory.

**Older plots and changed territories.** Plots uploaded before clustering was added, and plots whose territory text has since changed, can be updated with *Spreadsheets > Recalculate clusters* (upload password). This loads the embedding model, recalculates both groupings from the stored vectors and leaves the layouts unchanged. If you edit the territory text, also change `TERRITORIES_VERSION` in the same file so the dialog can tell which plots are out of date. Deleting a spreadsheet keeps the remaining entries' clusters as they were.

### Tagging

Choose *Unlock tagging* and enter the tagging password once; the session lasts until the browser tab is closed. Then select points and type tags (comma-separated) in the side panel. Tags are added to every selected entry, can be removed with the × on each tag, and become filters straight away.

### Deleting

*Spreadsheets* lists the spreadsheets in the current plot, lets you download each original file, and deletes a spreadsheet (with its entries and tags) or the whole plot with the upload password. The remaining points keep their positions. Deleted data stays in the repository's git history.

## Data layout

```
data/
  index.json                                 list of plots
  plots/<plot>/plot.json                     name, embedding model, spreadsheets, layout and clustering settings
  plots/<plot>/points.json                   every entry with its tags, coordinates for each view and clusters
  plots/<plot>/sheets/<sheet>/source.csv     the spreadsheet as uploaded
  plots/<plot>/sheets/<sheet>/vectors.json   the 384-dimension embedding of each entry
```

Files are written one entry per line, so commits show readable diffs. Coordinates are scaled to the range −1 to 1. In `points.json`, `clusters.topic` holds each entry's topic cluster (−1 for unclustered) and `clusters.territory` its similarity to each of the five growth territories, five numbers per entry in territory order. The territories view and the keywords are worked out from these when a plot is shown.

## Development

```bash
# Tests (no installs needed for the JavaScript tests)
npm test
pip install -r server/requirements-dev.txt
cd server && python -m pytest -q

# Run everything locally, writing to ./data instead of GitHub
cd server
CANARD_STORE=local CANARD_ADMIN_PASSWORD=admin CANARD_SESSION_SECRET=dev uvicorn app.main:app --port 8787
# in another terminal, from the repository root
CANARD_API_URL=http://localhost:8787 node scripts/dev-server.mjs 8000

# Optional: copy the model and runtime into site/ (ignored by git), as the Pages workflow does,
# so the dev server needs no access to Hugging Face or jsDelivr
node scripts/fetch-model-assets.mjs
```

An end-to-end test drives the whole workflow in Chromium (upload, views, lasso, tagging, reload and deletion):

```bash
npm install --no-save playwright && npx playwright install chromium
node tests/e2e/upload-flow.mjs
```

### Code map

| Path | What it does |
| --- | --- |
| `site/js/csv.js`, `server/app/validation.py` | CSV parsing and validation. The two are kept identical by the shared cases in `tests/fixtures/csv` (regenerate the expected output with `npm run fixtures`). |
| `site/js/projection/` | t-SNE (Barnes-Hut), UMAP, Gaussian kernel PCA and PCA, written for typed arrays. Their quality was checked against scikit-learn and umap-learn on the digits data set (trustworthiness within 0.001 of the reference libraries). |
| `site/js/clustering/` | Topic clustering: HDBSCAN (checked against scikit-learn in `tests/fixtures/hdbscan`), the UMAP-to-HDBSCAN pipeline, and c-TF-IDF keywords. UMAP itself (in `projection/umap.js`) handles any number of output dimensions. |
| `site/js/territories.js` | The five growth territories, how their centroids are built, and the territories layout |
| `site/js/cluster-data.js`, `site/js/cluster-view.js` | Working out the stored clusters (upload and recalculation) and turning them into labels, filters and the territories view |
| `site/js/layout-runner.js` | Runs the layouts and the clustering in four web workers at once |
| `site/js/embedder.js` | Runs the embedding model in web workers |
| `site/js/scatter.js` | Canvas scatter plot: zoom, pan, hover, lasso and animated transitions |
| `server/app/` | FastAPI service: passwords, sessions, validation and commits through the GitHub Git Data API |

The tokenizer (`tokenizer.json`) is stored in the repository twice, for the browser and the server; a test checks the copies are identical. The browser tokenizer library is vendored in `site/vendor/` (Apache 2.0).
