# Uptime check (GitHub Actions + n8n email)

GitHub Actions checks your sites every 5 minutes. It only calls your n8n webhook when a site **goes down** or **comes back up**, so n8n runs about twice per outage.

## How it behaves

- Checks all sites at the same time. A site that fails is checked again 5 seconds later in the same run.
- A site counts as **down** after 2 failed runs in a row (about 10 minutes). You get one email, not one every 5 minutes.
- When it comes back, you get a **back up** email with how long it was down.
- If several sites change in the same run, you get one email that lists them all.
- If n8n can't be reached, the run fails and GitHub emails you about the failed run. The alert is tried again on the next run.
- Up/down state is saved in `state.json`, keyed by a hash, so the file never contains your URLs.

## Setup (about 10 minutes)

### 1. Create the repo

Create a new **public** GitHub repo and add `check.mjs`, `sites.json` and `.github/workflows/uptime.yml`.

Public, because Actions minutes are free for public repos. In a private repo every run is billed as at least 1 minute, so running every 5 minutes uses about 8,600 minutes a month. The free private allowance is 2,000.

### 2. List your sites

Edit `sites.json`:

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
| `expectStatus` | Optional. Requires this exact status code. Without it, any status under 400 counts as up. |

**To keep the list private:** put the same JSON in a repo secret called `SITES_JSON` instead. It overrides `sites.json`. Site names still appear in the public run logs, so use neutral names if that matters.

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

### 5. Test it

**Actions** tab → **Uptime check** → **Run workflow**. To see an email, add a fake URL such as `https://this-does-not-exist-123.com` and run the workflow twice.

## Settings

These are in `.github/workflows/uptime.yml`:

- `cron: '*/5 * * * *'`: how often to check (5 minutes is GitHub's minimum)
- `FAIL_THRESHOLD: 2`: failed runs in a row before a "down" email
- `TIMEOUT_MS: 15000`: how long to wait for a response
- `TIMEZONE: UTC`: time zone used in emails, e.g. `Africa/Lagos` or `Europe/London`

## Limits to know

- **GitHub's schedule is best effort.** Runs often start 5–30 minutes late and are occasionally skipped. If you need checks on time, use a free external scheduler such as [cron-job.org](https://cron-job.org) to start the workflow every 5 minutes:
  - `POST https://api.github.com/repos/OWNER/REPO/actions/workflows/uptime.yml/dispatches`
  - Headers: `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`
  - Body: `{"ref":"main"}`
  - Token: a fine-grained personal access token limited to this repo, with **Actions: Read and write**.
  - Keep the GitHub `cron` line as a backup.
- **60-day rule:** GitHub turns off schedules in public repos that have no activity for 60 days. The script updates `state.json` once a week to prevent that.
- **One location:** checks run from GitHub's servers, mostly in the US. Some sites with strict bot protection return 403 to data-centre IPs. If that happens, set `expectStatus: 403` for that site or check a health URL instead.
