# Uptime check (GitHub Actions + n8n email)

GitHub Actions checks your sites every 5 minutes. It only calls your n8n webhook when a site **goes down** or **comes back up**, so n8n runs about twice per outage.

## How it behaves

- A site counts as **down** after 2 failed runs in a row, and the "down" email goes out in that second run. The two failures must be at least 3 minutes apart, so two runs that happen to start a minute apart can't alert on a brief blip. With checks every 5 minutes, you hear about an outage 5–10 minutes after it starts.
- You get one email per outage, not one every 5 minutes. When the site comes back, you get a **back up** email with how long it was down.
- If several sites change in the same run, you get one email that lists them all.
- If n8n can't be reached, the run fails and GitHub emails you about the failed run. The alert is tried again on the next run.
- Up/down state is saved in `state.json`, keyed by a hash, so the file never contains your URLs.

## What is checked

A site can answer "200 OK" and still be broken for visitors. Each run checks every site in four ways, at the same time:

1. **Public DNS.** Looks the domain up with Cloudflare's and Google's public DNS, as visitors' devices do. This catches an expired domain or a DNSSEC fault that GitHub's own DNS can miss.
2. **The page, from GitHub's servers (US).**
   - Follows redirects, and fails if they lead to a different website, such as a parking page or a hacked redirect.
   - Fails on any error status.
   - Reads the page and fails if it is blank, a database or WordPress "critical error" page, a PHP crash, a "page not found" page, a suspended-hosting page, a web server default page, a domain-for-sale page, or a maintenance or "coming soon" page.
   - Adds a unique `?_uptime=` value so CDNs and page caches pass the request to the real server. A dead server hiding behind a cached copy still counts as down.
   - Apps built with React or similar send an empty page and draw it with JavaScript. For those, the check requires the app's main script file to load as real JavaScript instead of reading the page's text.
   - A failure is re-checked 5 seconds later in the same run.
3. **The same page from Australia,** through [Globalping](https://globalping.io)'s free test network. It prefers home and office internet connections over data centres. A failure there only counts if a second Australian location fails too. A site that only fails from Australia is down, because that's where the visitors are. A site that fails from the US but works from Australia counts as up; some hosts block overseas data centres. A content problem such as an error page still counts.
4. **The SSL certificate.** You get one warning email 14 days before it expires.

Not covered: things that need a real browser, such as forms, checkout or a page that loads but shows the wrong content. IPv6 isn't tested either, because GitHub's servers have no IPv6. If a page matters, monitor it directly with `keyword` set to text only that page shows.

## Setup (about 10 minutes)

### 1. Create the repo

Create a new **public** GitHub repo and add `check.mjs`, `sites.example.json` and `.github/workflows/uptime.yml`.

Public, because Actions minutes are free for public repos. In a private repo every run is billed as at least 1 minute, so running every 5 minutes uses about 8,600 minutes a month. The free private allowance is 2,000.

### 2. List your sites

The list is a JSON array (see `sites.example.json`). Put it in one of two places:

- **Private (this repo uses this):** a repo secret called `SITES_JSON`. The public run logs then show `Site 01`, `Site 02`… in list order instead of domains. Your alert emails still use the real names.
- **Public:** a `sites.json` file in the repo. Anyone can see it, and the logs show the names.

If neither is set, the run fails, so a missing list can't go unnoticed.

```json
[
  "https://simple-site.com",
  { "name": "Client shop", "url": "https://shop.example.com", "keyword": "Add to cart" },
  { "name": "API health", "url": "https://api.example.com/health", "expectStatus": 200 }
]
```

| Field | Meaning |
|---|---|
| `url` | Required. |
| `name` | Shown in emails. Defaults to the domain. |
| `keyword` | Optional. The page must contain this text, which catches "200 OK but broken" pages. |
| `expectStatus` | Optional. A status code, or a list such as `[200, 403]`, that counts as up. Without it, any status under 400 counts as up. |
| `userAgent` | Optional. Overrides the default user agent (`uptime-check/1.0` plus the repo link) for a site whose firewall blocks it. |
| `allowHosts` | Optional. Other domains the site may redirect to, e.g. `["shop.otherdomain.com"]`. Subdomains of the site's own domain are always allowed. |
| `minText` | Optional. Least visible text (characters) before a page counts as blank. Default 100; `0` turns the blank-page check off. |
| `cacheBust` | Optional. `false` stops adding `?_uptime=` to the URL. |

### 3. Build the n8n workflow (2 nodes)

1. **Webhook** node
   - HTTP Method: `POST`
   - Path: e.g. `uptime-alert`
   - Authentication: *Header Auth*, then **Create new credential**. n8n may preselect an existing Header Auth credential; don't reuse it.
   - Header name `x-monitor-secret`, value: a long random string (`openssl rand -hex 24` makes one).
2. **Gmail** (or **Send Email**) node
   - To: your address
   - Subject: `{{ $json.body.subject }}`
   - Message (text): `{{ $json.body.text }}`

Activate the workflow and copy the webhook's **Production URL**.

The webhook body also has an `events` array (`type`, `name`, `url`, `error`, `since`, `duration`) if you want to build your own message or send it to Slack/WhatsApp as well.

### 4. Add the secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
|---|---|
| `N8N_WEBHOOK_URL` | The Production URL from step 3 |
| `WEBHOOK_SECRET` | The same random string as the Header Auth value |
| `SITES_JSON` | Optional. Your site list (see step 2). |
| `GLOBALPING_TOKEN` | Optional. A free token from [globalping.io](https://globalping.io) (sign in, then Tokens). Without it the Australia check gets 250 tests an hour per IP address, and 20 sites every 5 minutes uses about 240. With it you get 500 an hour. If the limit is reached, the Australia check is skipped for that run, and the other checks still run. |

### 5. Test it

**Actions** tab → **Uptime check** → **Run workflow**, tick **Send a test alert email only**, then **Run workflow**. You should get a "TEST: uptime alerts are working" email within a minute. No sites are checked and no state changes.

If the run fails, its log says why: HTTP 404 means the n8n workflow isn't published (or the URL is wrong); 403 means `WEBHOOK_SECRET` doesn't match the Header Auth value in n8n.

Run it again with the box unticked to check your sites right away. Tick **Check the sites and show results only** instead to see every site's results in the run log without sending emails or saving anything, which is useful after changing the site list.

## Settings

These are in `.github/workflows/uptime.yml`:

- `cron: '*/5 * * * *'`: how often to check (5 minutes is GitHub's minimum)
- `FAIL_THRESHOLD: 2`: failed runs in a row before a "down" email
- `MIN_DOWN_MINUTES: 3`: the first and last of those failures must be at least this far apart
- `TIMEOUT_MS: 15000`: how long to wait for a response
- `CERT_WARN_DAYS: 14`: days of warning before an SSL certificate expires
- `TIMEZONE: UTC`: time zone used in emails, e.g. `Africa/Lagos` or `Europe/London`

## Run checks on time with cron-job.org

GitHub's `cron` schedule is best effort, and on a new repo it can be very sparse: this repo got 2 scheduled runs in its first 21 hours instead of about 250. A free external scheduler fixes that by starting the workflow every 5 minutes. Keep the GitHub `cron` line as a backup.

1. **Make a GitHub token** (as the account that owns the repo): **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
   - Repository access: **Only select repositories** → this repo
   - Repository permissions: **Actions: Read and write** (nothing else)
   - Copy the token. GitHub shows it only once.
2. **Create the job** at [cron-job.org](https://cron-job.org) (free account) → **Create cronjob**:
   - URL: `https://api.github.com/repos/OWNER/REPO/actions/workflows/uptime.yml/dispatches`
   - Schedule: every 5 minutes
   - **Advanced** tab:
     - Request method: `POST`
     - Headers: `Authorization: Bearer <your token>` and `Accept: application/vnd.github+json`
     - Request body: `{"ref":"main"}`
   - Turn on cron-job.org's email notification for failed executions.
3. Click **Test run**. GitHub answers **204** and a new run appears in the Actions tab.

When the token expires, GitHub starts answering 401 and cron-job.org emails you. Make a new token and paste it into the job.

## Limits to know

- **60-day rule:** GitHub turns off schedules in public repos that have no activity for 60 days. The script updates `state.json` once a week to prevent that.
- **Bot protection:** some sites with strict bot protection return 403 to data-centre IPs such as GitHub's. If the Australia check gets the real page, the site still counts as up. If both are blocked, set `expectStatus: [200, 403]` for that site, or monitor a URL the firewall lets through.
- **Third-party networks:** the Australia check sends each site's address to Globalping, and the DNS check sends each domain name to Cloudflare and Google. They see only public website addresses. Set `AU_CHECK: 0` in the workflow to turn the Australia check off.
