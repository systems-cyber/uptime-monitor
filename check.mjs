// Uptime check, run by GitHub Actions on a schedule.
// Checks every site, remembers each site's up/down state in state.json, and
// calls your n8n webhook only when a site goes down or comes back up.
// No dependencies: needs Node 18+ (GitHub's runners already have it).

import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const FAIL_THRESHOLD = Math.max(1, Number(process.env.FAIL_THRESHOLD || 2)); // failed runs in a row before "down"
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 15000);
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS ?? 5000); // wait before re-checking a failed site in the same run
const TIMEZONE = process.env.TIMEZONE || 'UTC';
const SITES_FILE = process.env.SITES_FILE || 'sites.json';
const STATE_FILE = process.env.STATE_FILE || 'state.json';
const WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const DRY_RUN = Boolean(process.env.DRY_RUN);
const KEEPALIVE_MS = 7 * 24 * 60 * 60 * 1000; // touch state.json weekly so GitHub keeps the schedule on
const RUN_URL = process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : null;

const FRIENDLY_ERRORS = {
  ENOTFOUND: 'Domain not found (DNS lookup failed)',
  EAI_AGAIN: 'DNS lookup failed',
  ECONNREFUSED: 'Connection refused',
  ECONNRESET: 'Connection reset by the server',
  ETIMEDOUT: 'Connection timed out',
  UND_ERR_CONNECT_TIMEOUT: 'Connection timed out',
  CERT_HAS_EXPIRED: 'SSL certificate has expired',
  ERR_TLS_CERT_ALTNAME_INVALID: 'SSL certificate does not match the domain',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'Self-signed SSL certificate',
  SELF_SIGNED_CERT_IN_CHAIN: 'Self-signed SSL certificate',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'SSL certificate could not be verified',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// SITES_JSON (a repo secret) wins over sites.json, so the list can stay out of a public repo.
// In that case the (public) run logs show "Site 01", "Site 02"... instead of names.
const PRIVATE_LIST = Boolean(process.env.SITES_JSON?.trim());

async function loadSites() {
  let raw = process.env.SITES_JSON?.trim();
  if (!raw) {
    try {
      raw = await readFile(SITES_FILE, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') throw new Error(`No sites to check: set the SITES_JSON secret or add ${SITES_FILE}`);
      throw err;
    }
  }
  const list = JSON.parse(raw);
  if (!Array.isArray(list) || list.length === 0) throw new Error('Site list must be a non-empty JSON array');
  return list.map((entry, i) => {
    const site = typeof entry === 'string' ? { url: entry } : entry;
    if (!site?.url) throw new Error(`Site entry ${i + 1} has no "url"`);
    const name = site.name || new URL(site.url).hostname;
    if (PRIVATE_LIST && process.env.GITHUB_ACTIONS) {
      // Ask GitHub to hide these values anywhere they would appear in the public log.
      for (const secret of new Set([site.url, name, new URL(site.url).hostname])) console.log(`::add-mask::${secret}`);
    }
    return {
      ...site,
      name,
      label: PRIVATE_LIST ? `Site ${String(i + 1).padStart(2, '0')}` : name,
      // State is keyed by a hash so state.json never contains your URLs.
      id: createHash('sha256').update(`${site.url}|${site.keyword ?? ''}`).digest('hex').slice(0, 12),
    };
  });
}

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return { sites: {} };
    throw err;
  }
}

async function checkOnce(site) {
  const started = Date.now();
  try {
    const res = await fetch(site.url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        // Browser-like headers: some firewalls block requests that look like bots.
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 uptime-check/1.0',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-AU,en;q=0.9',
      },
    });
    const statusOk = site.expectStatus ? [].concat(site.expectStatus).includes(res.status) : res.status < 400;
    if (!statusOk) {
      await res.body?.cancel();
      return { ok: false, error: `HTTP ${res.status}` };
    }
    if (site.keyword) {
      const body = await res.text();
      if (!body.includes(site.keyword)) return { ok: false, error: `Text "${site.keyword}" not found on the page` };
    } else {
      await res.body?.cancel();
    }
    return { ok: true, status: res.status, ms: Date.now() - started };
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return { ok: false, error: `No response within ${TIMEOUT_MS / 1000}s` };
    }
    const code = err.cause?.code;
    return { ok: false, error: FRIENDLY_ERRORS[code] || code || err.cause?.message || err.message };
  }
}

async function check(site) {
  const first = await checkOnce(site);
  if (first.ok) return first;
  await sleep(RETRY_DELAY_MS);
  return checkOnce(site);
}

function formatDuration(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

const timeFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIMEZONE,
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZoneName: 'short',
});
const formatTime = (iso) => timeFormat.format(new Date(iso));

function buildMessage(events, now) {
  const down = events.filter((e) => e.type === 'down');
  const up = events.filter((e) => e.type === 'recovered');

  let subject;
  if (events.length === 1) {
    const e = events[0];
    subject = e.type === 'down' ? `DOWN: ${e.name}` : `BACK UP: ${e.name} (was down ${e.duration})`;
  } else {
    const parts = [];
    if (down.length) parts.push(`${down.length} site${down.length > 1 ? 's' : ''} down`);
    if (up.length) parts.push(`${up.length} back up`);
    subject = `Uptime: ${parts.join(', ')}`;
  }

  const lines = [];
  for (const e of down) {
    lines.push(`DOWN: ${e.name}`, `  ${e.url}`, `  Problem: ${e.error}`, `  Failing since ${formatTime(e.since)} (${e.duration})`, '');
  }
  for (const e of up) {
    lines.push(`BACK UP: ${e.name}`, `  ${e.url}`, `  Was down for ${e.duration} (since ${formatTime(e.since)})`, '');
  }
  lines.push(`Checked ${formatTime(now.toISOString())}`);
  if (RUN_URL) lines.push(`Run details: ${RUN_URL}`);

  return { subject, text: lines.join('\n') };
}

async function notify(events, now) {
  const payload = { ...buildMessage(events, now), events, checkedAt: now.toISOString(), runUrl: RUN_URL };

  if (DRY_RUN) {
    console.log(`DRY_RUN: would send to n8n:\n${JSON.stringify(payload, null, 2)}`);
    return;
  }
  if (!WEBHOOK_URL) throw new Error('N8N_WEBHOOK_URL is not set, so this alert could not be sent');

  const headers = { 'content-type': 'application/json' };
  if (WEBHOOK_SECRET) headers['x-monitor-secret'] = WEBHOOK_SECRET;
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`n8n webhook returned HTTP ${res.status}`);
  console.log(`Sent ${events.length} change(s) to n8n`);
}

async function main() {
  const now = new Date();
  const sites = await loadSites();
  const previous = await loadState();
  const results = await Promise.all(sites.map(check));

  const nextSites = {};
  const events = [];

  sites.forEach((site, i) => {
    const result = results[i];
    const prev = previous.sites?.[site.id] ?? { status: 'up', fails: 0, failingSince: null };
    const next = { status: prev.status, fails: prev.fails ?? 0, failingSince: prev.failingSince ?? null };

    if (result.ok) {
      console.log(`UP    ${site.label} (HTTP ${result.status}, ${result.ms} ms)`);
      if (prev.status === 'down') {
        events.push({
          type: 'recovered',
          name: site.name,
          url: site.url,
          since: prev.failingSince,
          duration: formatDuration(now - new Date(prev.failingSince)),
        });
      }
      Object.assign(next, { status: 'up', fails: 0, failingSince: null });
    } else {
      next.fails = Math.min(next.fails + 1, FAIL_THRESHOLD); // capped so state.json stops changing during a long outage
      next.failingSince ??= now.toISOString();
      const confirmed = next.fails >= FAIL_THRESHOLD;
      console.log(`FAIL  ${site.label} (${result.error})${confirmed ? '' : ` [${next.fails}/${FAIL_THRESHOLD}]`}`);
      if (prev.status !== 'down' && confirmed) {
        next.status = 'down';
        events.push({
          type: 'down',
          name: site.name,
          url: site.url,
          error: result.error,
          since: next.failingSince,
          duration: formatDuration(now - new Date(next.failingSince)),
        });
      }
    }
    nextSites[site.id] = next;
  });

  // If this throws (n8n down, bad URL), state is NOT saved, so the next run retries
  // the alert, and the failed run makes GitHub email you as a backup.
  if (events.length) await notify(events, now);

  const lastKeepalive = previous.lastKeepalive && now - new Date(previous.lastKeepalive) < KEEPALIVE_MS
    ? previous.lastKeepalive
    : now.toISOString();

  await writeFile(STATE_FILE, `${JSON.stringify({ lastKeepalive, sites: nextSites }, null, 2)}\n`);
}

try {
  await main();
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
}
