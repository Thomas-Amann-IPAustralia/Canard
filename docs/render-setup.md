# Setting up the Render back end

This guide connects the Canard website (on GitHub Pages) to its small editing server (on Render's free plan). Viewing plots works without the server. You need the server for uploading, deleting and tagging.

It takes about 20 minutes. You need:

- admin access to the `Thomas-Amann-IPAustralia/Canard` repository on GitHub
- a Render account (the free plan is enough)

Screens change from time to time, so a button may be worded slightly differently from what is written here. The wording on Render and GitHub that is quoted below is shown in **bold**.

## Overview

| Part | Where | What you do |
| --- | --- | --- |
| 1 | GitHub | Turn on GitHub Pages |
| 2 | GitHub | Merge the pull request into `main` |
| 3 | Anywhere | Choose two passwords |
| 4 | GitHub | Create a token that lets the server save data to the repository |
| 5 | Render | Create the server from the repository's `render.yaml` Blueprint |
| 6 | GitHub | Point the website at the server (only if Render gives a different address) |
| 7 | Browser | Check everything works |

## Part 1: Turn on GitHub Pages

Do this before merging, so the first deployment runs straight away.

1. Go to https://github.com/Thomas-Amann-IPAustralia/Canard.
2. Click **Settings** (the tab with the gear icon, at the right of the row of tabs under the repository name).
3. In the left sidebar, under **Code and automation**, click **Pages**.
4. Under **Build and deployment**, open the **Source** drop-down and choose **GitHub Actions**.

There is nothing to save; the setting applies immediately.

## Part 2: Merge the pull request

1. Click the **Pull requests** tab and open the pull request that adds Canard.
2. Click **Merge pull request**, then **Confirm merge**.
3. Click the **Actions** tab. A run called **Publish site** starts within a few seconds. Wait for the green tick (about one minute).
4. Open https://thomas-amann-ipaustralia.github.io/Canard/. The example plot appears. The header shows **Waking server…** and, after about two minutes, **Server unavailable**. That is expected until Part 5 is done.

If **Publish site** did not start, or failed because Pages was not yet turned on: in **Actions**, click **Publish site** in the left list, click **Run workflow** on the right, keep **Branch: main** and click the green **Run workflow** button.

## Part 3: Choose two passwords

| Password | Who needs it | What it allows |
| --- | --- | --- |
| Upload password | People who manage the data | Uploading spreadsheets, deleting spreadsheets and plots, and tagging |
| Tagging password | People who only tag | Tagging (entered once per browser session) |

Use long passphrases (for example four or five random words) and keep them in your password manager. You will paste them into Render in Part 5. If you only want one password, use the same value for both.

## Part 4: Create the GitHub token

The server saves every change as a commit in the repository. It needs a token that can write to this one repository and nothing else.

1. On GitHub, click your **profile picture** (top right), then **Settings**.
2. At the bottom of the left sidebar, click **Developer settings**.
3. Click **Personal access tokens**, then **Fine-grained tokens**.
4. Click **Generate new token**. (GitHub may ask you to confirm your password or use two-factor authentication.)
5. Fill in the form:
   - **Token name:** `Canard server`
   - **Description:** `Lets the Canard API on Render commit to data/`
   - **Resource owner:** `Thomas-Amann-IPAustralia`
   - **Expiration:** choose **Custom** and pick a date up to a year away. Put a reminder in your calendar a week before it (see "Renewing the token" below).
   - **Repository access:** choose **Only select repositories**, then in **Select repositories** pick **Thomas-Amann-IPAustralia/Canard**.
6. Under **Permissions**, set **Repository permissions > Contents** to **Read and write**.
   - In the newer layout, click **Add permissions**, tick **Contents**, close the list, then change its access from **Read-only** to **Read and write**.
   - **Metadata: Read-only** is added automatically. Leave every other permission off.
7. Click **Generate token** at the bottom (confirm if asked).
8. Click the **copy** icon next to the token (it starts with `github_pat_`). GitHub only shows it once, so paste it somewhere safe until Part 5. Treat it like a password.

## Part 5: Create the server on Render

1. Go to https://dashboard.render.com and sign in.
2. Click **+ New** (top right), then **Blueprint**.
3. If Render does not list your GitHub repositories yet, connect GitHub:
   1. Click **GitHub** (or **Connect GitHub** / **Configure account**).
   2. On the GitHub page that opens, choose the **Thomas-Amann-IPAustralia** account.
   3. Under **Repository access**, choose **Only select repositories**, select **Canard**, then click **Install** (or **Save**).
   4. You return to Render with the repository listed.
4. Next to **Thomas-Amann-IPAustralia / Canard**, click **Connect**.
5. On the Blueprint form:
   - **Blueprint Name:** `canard`
   - **Branch:** `main`
6. Render reads `render.yaml` and lists one resource: a **Web Service** called **canard-api** on the **Free** instance type. Below it, Render asks for the values that are kept out of the repository. Enter:

   | Key | Value |
   | --- | --- |
   | `GITHUB_TOKEN` | the token from Part 4 |
   | `CANARD_ADMIN_PASSWORD` | the upload password from Part 3 |
   | `CANARD_TAG_PASSWORD` | the tagging password from Part 3 |

   The other settings are filled in from `render.yaml`, including a randomly generated `CANARD_SESSION_SECRET`. Leave them as they are.
7. Click **Deploy Blueprint** (the button may say **Apply**).
8. Click through to the **canard-api** service (from the Blueprint page, or from **Dashboard** in the left sidebar). The **Events** or **Logs** view shows the build. After two to four minutes it says the service is **Live** (the log ends with a line containing `Canard API 1.0.0 ready (store=github, writable=True)`).
9. Near the top of the service page, under the name, is the service's address, for example `https://canard-api.onrender.com`. Copy it.
10. Open that address with `/api/health` on the end, for example https://canard-api.onrender.com/api/health. You should see a line of text that includes `"ok":true`, `"store":"github"` and `"writable":true`.

Render's free plan does not need a payment method. If Render asks for one, check that the instance type in step 6 is **Free**.

## Part 6: Point the website at the server

The website expects the server at `https://canard-api.onrender.com`.

- **If the address you copied in Part 5 is exactly that**, skip to Part 7.
- **If Render added something** (for example `https://canard-api-x7k2.onrender.com`, which happens when the name is already taken):
  1. In the GitHub repository, click **Settings**.
  2. In the left sidebar, under **Security**, click **Secrets and variables**, then **Actions**.
  3. Click the **Variables** tab, then **New repository variable**.
  4. **Name:** `CANARD_API_URL`. **Value:** the address from Part 5, with no slash at the end. Click **Add variable**.
  5. Click the **Actions** tab, click **Publish site** in the left list, click **Run workflow**, keep **Branch: main** and click **Run workflow**. Wait for the green tick.

## Part 7: Check everything works

1. Open https://thomas-amann-ipaustralia.github.io/Canard/ (reload if it was already open).
2. Watch the header. It shows **Waking server…** for up to a minute, then **Server ready** with a green dot.
3. Click **Unlock tagging**, enter the tagging password and click **Unlock**.
4. Click any point, type `test` in the tag box and click **Add**.
5. In GitHub, open the repository's **Commits** (click the clock icon with the commit count, near the top of the file list). Within a few seconds there is a new commit by **Canard** called something like `Tag 1 entry in "Example: landmark documents" (+test)`.
6. Back in Canard, click the **×** on the `test` tag to remove it. That makes a second commit.

Everything is working. When you have uploaded your own spreadsheets, delete the example plot: **Spreadsheets > Delete plot…**, then enter the upload password.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| The header stays on **Server unavailable** | Open the `/api/health` address from Part 5 in a new tab. If it does not load, look at the service's **Logs** in Render. If it loads, the site is pointing at the wrong address: repeat Part 6. |
| `/api/health` shows `"writable":false` | `CANARD_ADMIN_PASSWORD` is missing. In Render, open **canard-api > Environment**, add it, and save (Render redeploys). |
| **The server's GitHub token was rejected** | The token has expired or lacks **Contents: Read and write** on this repository. Create a new one (Part 4) and update `GITHUB_TOKEN` (see "Renewing the token"). |
| The browser console mentions **CORS**, and uploads or tags fail | In Render, **canard-api > Environment**, check `CANARD_ALLOWED_ORIGINS` is exactly `https://thomas-amann-ipaustralia.github.io` (no `/Canard`, no trailing slash). |
| **Too many incorrect passwords** | Ten wrong attempts lock that computer out for 15 minutes. Wait, then try again. |
| A change does not appear on the site straight away | GitHub Pages takes a minute or two to republish. In the meantime the page loads the latest data from the server, so a reload shows it once the server is awake. |
| The Render build fails | Open the failed deploy's log in Render. The build needs Python 3.12, which is set by `PYTHON_VERSION` in `render.yaml`. |

## Looking after the server

### How the free plan behaves

- The server goes to sleep after 15 minutes without requests and takes up to a minute to wake. The site wakes it as soon as someone opens the page, so it is usually ready by the time anyone uploads or tags.
- Each Render workspace gets 750 free instance hours a month, which is enough for this one service. Sleeping time does not count.
- Render redeploys the server automatically when files in `server/` change on `main`. Data commits do not trigger a redeploy.

### Changing a password

1. In Render, open **canard-api**, then **Environment** in the left sidebar.
2. Click **Edit**, change `CANARD_ADMIN_PASSWORD` or `CANARD_TAG_PASSWORD`, then save (the button may read **Save, rebuild, and deploy**).

Tagging sessions that are already open stay valid for up to 12 hours. To sign everyone out at once, also replace `CANARD_SESSION_SECRET` with a new long random value.

### Renewing the token

1. On GitHub, go to **Settings > Developer settings > Personal access tokens > Fine-grained tokens** and click **Canard server**.
2. Click **Regenerate token**, choose a new expiry, confirm, and copy the new token.
3. In Render, open **canard-api > Environment**, click **Edit**, paste the new value into `GITHUB_TOKEN`, and save.

### Server settings reference

All settings are listed in the README under "Server settings".
