// Uptime check, run by GitHub Actions every 5 minutes (started by cron-job.org, with GitHub's
// own schedule as a backup). For every site it checks, at the same time:
//   1. Public DNS: asks Cloudflare's and Google's public resolvers, as visitors' devices do.
//      This catches expired domains and DNSSEC faults that GitHub's own resolver can miss.
//   2. The page, from GitHub's servers (US): follows redirects and requires a working status,
//      a page on the same website, and real content (not blank, and not a known error, parking,
//      suspended or maintenance page). It bypasses CDN caches, so a dead server hiding behind a
//      cached copy still counts as down.
//   3. The same page from a home/office internet connection in Australia (Globalping), where
//      most visitors are. A failure there is re-tested from a second location before it counts.
//   4. When the SSL certificate expires, with a warning email CERT_WARN_DAYS ahead.
// A site counts as down only once it has failed every check for MIN_DOWN_MINUTES (15) in a row;
// one successful check restarts the clock. The "down" email goes out in the run that reaches
// 15 minutes. n8n is only called when something changes. No dependencies: needs Node 20+.

import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import tls from 'node:tls';

const env = process.env;
const num = (value, fallback) => (value === undefined || value === '' ? fallback : Number(value));

const FAIL_THRESHOLD = Math.max(1, num(env.FAIL_THRESHOLD, 2)); // at least this many failed runs in a row...
const MIN_DOWN_MS = num(env.MIN_DOWN_MINUTES, 15) * 60_000; // ...covering at least this long, before "down"
const SCHEDULE_SLACK_MS = 60_000; // runs start a few seconds early or late; don't make a 14:58 streak wait another run
const TIMEOUT_MS = num(env.TIMEOUT_MS, 15000);
const RETRY_DELAY_MS = num(env.RETRY_DELAY_MS, 5000); // wait before re-checking a failed site in the same run
const MIN_TEXT = num(env.MIN_TEXT, 100); // a page with less visible text than this counts as blank
const CERT_WARN_DAYS = num(env.CERT_WARN_DAYS, 14);
const TIMEZONE = env.TIMEZONE || 'UTC';
const SITES_FILE = env.SITES_FILE || 'sites.json';
const STATE_FILE = env.STATE_FILE || 'state.json';
const WEBHOOK_URL = env.N8N_WEBHOOK_URL;
const WEBHOOK_SECRET = env.WEBHOOK_SECRET;
const DRY_RUN = Boolean(env.DRY_RUN); // check and log only: no emails, no saved state
const AU_CHECK = env.AU_CHECK !== '0';
const GLOBALPING_API = env.GLOBALPING_API || 'https://api.globalping.io/v1';
const GLOBALPING_TOKEN = env.GLOBALPING_TOKEN; // optional: raises Globalping's free limit
const DOH_RESOLVERS = (env.DOH_RESOLVERS || 'https://cloudflare-dns.com/dns-query,https://dns.google/resolve').split(',');
const KEEPALIVE_MS = 7 * 24 * 60 * 60 * 1000; // touch state.json weekly so GitHub keeps the schedule on
const DEFAULT_USER_AGENT = env.GITHUB_REPOSITORY
  ? `uptime-check/1.0 (+${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY})`
  : 'uptime-check/1.0';
const RUN_URL = env.GITHUB_RUN_ID
  ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
  : null;

const FRIENDLY_ERRORS = {
  ENOTFOUND: 'Domain not found (DNS lookup failed)',
  EAI_AGAIN: 'DNS lookup failed',
  ECONNREFUSED: 'Connection refused',
  ECONNRESET: 'Connection reset by the server',
  ETIMEDOUT: 'Connection timed out',
  UND_ERR_CONNECT_TIMEOUT: 'Connection timed out',
  UND_ERR_SOCKET: 'Connection closed by the server',
  CERT_HAS_EXPIRED: 'SSL certificate has expired',
  ERR_TLS_CERT_ALTNAME_INVALID: 'SSL certificate does not match the domain',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'Self-signed SSL certificate',
  SELF_SIGNED_CERT_IN_CHAIN: 'Self-signed SSL certificate',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'SSL certificate could not be verified',
};

// Page titles that mean visitors are not seeing the real website, even with HTTP 200.
const ERROR_TITLES = [
  [/error establishing a database connection|^database error$/i, 'Database connection error'],
  [/critical error|wordpress\s*›\s*error/i, 'WordPress error page'],
  [/briefly unavailable for scheduled maintenance/i, 'WordPress is stuck in maintenance mode'],
  [/account (has been )?suspended|suspended page/i, 'Hosting account suspended'],
  [/^index of \//i, 'Folder listing instead of the website (site files missing?)'],
  [/apache2? .*default page|welcome to nginx|test page for the (apache|nginx)|^it works!?$|default web site page|iis windows server/i, 'Web server default page instead of the website'],
  [/domain (name )?(is )?(for sale|parked)|parked domain|buy this domain|domain (has )?expired|this domain is available/i, 'Domain parking or for-sale page'],
  [/^(400|401|403|404|410|429|500|502|503|504)\b|page not found|404 not found|internal server error|bad gateway|service (temporarily )?unavailable|gateway time-?out/i, 'Error page'],
  [/under maintenance|maintenance mode|coming soon|under construction|site is offline/i, 'Maintenance or coming-soon page'],
  [/^just a moment\.{0,3}$|attention required!? \| cloudflare|^access denied$|checking your browser|^one moment/i, 'Shown a bot check instead of the page', 'blocked'],
];
// Firewalls and bot-protection software sometimes show data centres (like GitHub's) a short
// "verifying your browser" page. Real visitors pass it, so it is not downtime.
const CHALLENGE = /verif(y|ying|ied|ication)|checking (your|the) browser|just a moment|please wait|one moment|enable (javascript|cookies)|are you (a )?human|captcha|bot protection|ddos protection|security check/i;
// Exact messages from WordPress and cPanel error pages. Checked only on short pages, so a
// normal page (or blog post) that mentions one of these phrases doesn't trigger an alert.
const ERROR_TEXTS = [
  [/error establishing a database connection/i, 'Database connection error'],
  [/there has been a critical error on (this|your) website|the site is experiencing technical difficulties/i, 'WordPress critical error'],
  [/briefly unavailable for scheduled maintenance/i, 'WordPress is stuck in maintenance mode'],
  [/this account has been suspended/i, 'Hosting account suspended'],
];
const PHP_FATAL = /<b>(fatal|parse) error<\/b>:/i; // PHP printed a crash into the page
// App-style sites (React, Vue, Next...) send an empty shell and draw the page with JavaScript, so
// their text can't be judged without a browser. Instead, their main script files must load.
const APP_SHELL = /<(div|main)\b[^>]*\bid=["']?(root|app|__next|__nuxt|svelte|q-app)["']?[^>]*>\s*<\/\1>|<app-root[^>]*>\s*<\/app-root>/i;
const isAppShell = (html) => APP_SHELL.test(html) && /<script\b[^>]*\bsrc=/i.test(html);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// SITES_JSON (a repo secret) wins over sites.json, so the list can stay out of a public repo.
// In that case the (public) run logs show "Site 01", "Site 02"... and never domains or page
// titles; the emails still show everything.
const PRIVATE_LIST = Boolean(env.SITES_JSON?.trim());
const mask = (value) => {
  if (PRIVATE_LIST && env.GITHUB_ACTIONS && value) console.log(`::add-mask::${value}`);
};

async function loadSites() {
  let raw = env.SITES_JSON?.trim();
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
  const runStamp = String(Date.now());
  return list.map((entry, i) => {
    const site = typeof entry === 'string' ? { url: entry } : entry;
    if (!site?.url) throw new Error(`Site entry ${i + 1} has no "url"`);
    const url = new URL(site.url);
    const name = site.name || url.hostname;
    const baseDomain = url.hostname.replace(/^www\./, '');
    for (const value of new Set([site.url, name, url.hostname, baseDomain])) mask(value);
    // A unique query string makes CDNs and page caches pass the request to the real server.
    const checkUrl = new URL(url);
    if (site.cacheBust !== false) checkUrl.searchParams.set('_uptime', runStamp);
    return {
      ...site,
      name,
      hostname: url.hostname,
      baseDomain,
      allowHosts: [].concat(site.allowHosts ?? []),
      checkUrl: checkUrl.href,
      stamp: runStamp,
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

// ---------- 1. Public DNS ----------

async function resolve(resolver, name, type) {
  const res = await fetch(`${resolver}?name=${encodeURIComponent(name)}&type=${type}`, {
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`resolver returned HTTP ${res.status}`);
  const data = await res.json();
  return { status: data.Status, addresses: (data.Answer ?? []).filter((a) => a.type === 1 || a.type === 28) };
}

async function checkDns(hostname) {
  if (isIP(hostname)) return { ok: true, skipped: true };
  const verdicts = await Promise.all(
    DOH_RESOLVERS.map(async (resolver) => {
      try {
        let answer = await resolve(resolver, hostname, 'A');
        if (answer.status === 0 && !answer.addresses.length) answer = await resolve(resolver, hostname, 'AAAA');
        return answer.status === 0 && answer.addresses.length ? { ok: true } : { ok: false, status: answer.status };
      } catch {
        return null; // this resolver couldn't be reached, so it has no say
      }
    }),
  );
  const answered = verdicts.filter(Boolean);
  if (!answered.length) return { ok: true, unknown: true };
  if (answered.some((v) => v.ok)) return { ok: true };
  const { status } = answered[0];
  const error =
    status === 3 ? 'Domain does not exist in public DNS (expired or deleted?)'
    : status === 2 ? 'Public DNS servers cannot look up the domain (SERVFAIL, often a DNSSEC or name server fault)'
    : status === 0 ? 'Domain has no IP address in public DNS'
    : `Public DNS lookup failed (status ${status})`;
  return { ok: false, error };
}

// ---------- 2. Page check (shared by the GitHub and Australia checks) ----------

const decode = (s) =>
  s.replace(/&(amp|lt|gt|quot|apos|nbsp|rsaquo|ndash|mdash|#\d+);/gi, (m, e) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsaquo: '›', ndash: '–', mdash: '—' };
    if (e[0] === '#') return String.fromCharCode(Number(e.slice(1)));
    return named[e.toLowerCase()] ?? m;
  });

function visibleText(html) {
  const body = html.match(/<body[\s>][\s\S]*$/i)?.[0] ?? html;
  return decode(
    body
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

const isSameSite = (site, host) =>
  host === site.baseDomain || host.endsWith(`.${site.baseDomain}`) || site.allowHosts.includes(host);

function redirectProblem(site, target) {
  if (!isSameSite(site, target.hostname)) {
    mask(target.hostname);
    return { kind: 'redirect', error: 'Redirects to a different website', detail: `Ends up at ${target.hostname}` };
  }
  if (/suspendedpage\.cgi/i.test(target.pathname)) return { kind: 'content', error: 'Hosting account suspended' };
  return null;
}

// Returns null when the response looks like the real website, or { kind, error, detail }.
// `error` is safe for the public log; `detail` (page title or text, keyword) only goes in emails.
// kind 'blocked' means a bot check was shown instead of the page: inconclusive, never downtime.
// `deep` marks problems that can sit past the first 10 KB, which is all the Australia check sees.
function inspectResponse(site, { status, contentType = '', body = '', truncated = false, botCheck = false }) {
  const statusOk = site.expectStatus ? [].concat(site.expectStatus).includes(status) : status < 400;
  if (!statusOk) {
    return botCheck
      ? { kind: 'blocked', error: `Shown a bot check instead of the page (HTTP ${status})` }
      : { kind: 'status', error: `HTTP ${status}` };
  }
  if (status < 200 || status >= 300) return null; // an accepted non-2xx status (expectStatus): nothing more to read

  const minText = site.minText ?? MIN_TEXT;
  if (!body.trim()) return status === 204 || minText === 0 ? null : { kind: 'content', error: 'Page is blank (empty response)' };
  if (site.keyword && !body.includes(site.keyword) && !truncated) {
    return { kind: 'content', deep: true, error: 'Expected text not found on the page', detail: `Looked for "${site.keyword}"` };
  }
  if (!/html/i.test(contentType) && !/^\s*</.test(body)) return null; // not a web page (e.g. a JSON health check)

  const title = decode(body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  for (const [pattern, label, kind = 'content'] of ERROR_TITLES) {
    if (pattern.test(title)) return { kind, error: label, detail: `Page title: "${title.slice(0, 100)}"` };
  }
  if (PHP_FATAL.test(body)) return { kind: 'content', deep: true, error: 'PHP fatal error printed on the page' };
  const text = visibleText(body);
  if (text.length < 3000) {
    for (const [pattern, label] of ERROR_TEXTS) if (pattern.test(text)) return { kind: 'content', error: label };
  }
  if (!truncated && text.length < minText && !isAppShell(body)) {
    const detail = text ? `Page text: "${text.slice(0, 150)}"` : null;
    if (CHALLENGE.test(`${title} ${text}`) || /<meta[^>]+http-equiv=["']?refresh/i.test(body)) {
      return { kind: 'blocked', error: 'Shown a bot check instead of the page', detail };
    }
    // Some text but very little is often a firewall page shown only to data centres, so it
    // needs the Australia check to agree before it counts (needsSecondOpinion).
    return text.length
      ? { kind: 'content', needsSecondOpinion: true, error: `Page is nearly blank (${text.length} characters of text)`, detail }
      : { kind: 'content', error: 'Page is blank', detail };
  }
  return null;
}

// The app's own main scripts: module scripts, or else bundles in the usual build folders.
// Analytics and other third-party scripts are left out, as the page works without them.
function appScripts(html, pageUrl, site) {
  const tags = [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
  const src = (tag) => tag.match(/\bsrc=["']([^"']+)["']/i)?.[1];
  const modules = tags.filter((tag) => src(tag) && /\btype=["']?module/i.test(tag));
  const chosen = modules.length ? modules : tags.filter((tag) => /\/(assets|static|_next|_nuxt|build|dist)\//i.test(src(tag) ?? ''));
  return chosen.map((tag) => new URL(src(tag), pageUrl)).filter((u) => isSameSite(site, u.hostname)).slice(0, 3);
}

async function checkAppScripts(site, html, pageUrl, signal) {
  for (const script of appScripts(html, pageUrl, site)) {
    const res = await fetch(script, { signal, headers: { 'user-agent': site.userAgent ?? DEFAULT_USER_AGENT } });
    const type = res.headers.get('content-type') ?? '';
    const content = await res.text();
    if (/html/i.test(type) && content.length < 20000 && CHALLENGE.test(visibleText(content))) {
      return { kind: 'blocked', error: 'Shown a bot check instead of the app script' };
    }
    // A missing file often comes back as the HTML page with status 200, which breaks the app just the same.
    // Only GitHub loads scripts, so the Australia check can't clear this problem (githubOnly).
    if (!res.ok || /html/i.test(type) || content.length === 0) {
      const got = !res.ok ? `HTTP ${res.status}` : content.length === 0 ? 'an empty file' : 'a web page instead of JavaScript';
      return { kind: 'content', githubOnly: true, error: "The site's app script fails to load, so visitors see a blank page", detail: `${script.pathname} returned ${got}` };
    }
  }
  return null;
}

function networkError(err) {
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return `No response within ${TIMEOUT_MS / 1000}s`;
  const code = err.cause?.code;
  return FRIENDLY_ERRORS[code] || code || err.cause?.message || err.message;
}

async function checkFromGitHubOnce(site) {
  const started = Date.now();
  const signal = AbortSignal.timeout(TIMEOUT_MS); // covers every redirect and the page download
  let url = new URL(site.checkUrl);
  try {
    for (let hop = 0; ; hop++) {
      const res = await fetch(url, {
        redirect: 'manual',
        signal,
        headers: {
          // Identify honestly: some firewalls block or break on imitation browser user agents.
          'user-agent': site.userAgent ?? DEFAULT_USER_AGENT,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'en-AU,en;q=0.9',
          'cache-control': 'no-cache',
          pragma: 'no-cache',
        },
      });
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel();
        if (hop >= 10) return { ok: false, kind: 'status', error: 'Too many redirects' };
        url = new URL(location, url);
        const problem = redirectProblem(site, url);
        if (problem) return { ok: false, ...problem };
        continue;
      }
      const body = await res.text();
      const problem = inspectResponse(site, {
        status: res.status,
        contentType: res.headers.get('content-type') ?? '',
        body,
        botCheck: res.headers.get('cf-mitigated') === 'challenge',
      }) ?? (res.ok && isAppShell(body) ? await checkAppScripts(site, body, url, signal) : null);
      const ms = Date.now() - started;
      if (problem) return { ok: false, status: res.status, ms, ...problem };
      return { ok: true, status: res.status, ms, finalUrl: url.href };
    }
  } catch (err) {
    return { ok: false, kind: 'network', error: networkError(err) };
  }
}

async function checkFromGitHub(site) {
  const first = await checkFromGitHubOnce(site);
  if (first.ok) return first;
  await sleep(RETRY_DELAY_MS);
  return checkFromGitHubOnce(site);
}

// ---------- 3. Australia check (Globalping) ----------

const globalping = (path, options = {}) =>
  fetch(`${GLOBALPING_API}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(GLOBALPING_TOKEN && { authorization: `Bearer ${GLOBALPING_TOKEN}` }) },
    signal: AbortSignal.timeout(10000),
  });

const headerValue = (headers, name) => [].concat(headers?.[name] ?? []).join(', ');

function rawError(raw = '') {
  const code = Object.keys(FRIENDLY_ERRORS).find((c) => raw.includes(c));
  if (code) return FRIENDLY_ERRORS[code];
  if (/time(d)? ?out/i.test(raw)) return 'No response in time';
  return raw.split('\n')[0].slice(0, 120) || 'Request failed';
}

// One request from a random Australian test location, preferring home/office connections
// ("eyeball networks"), which see a site the way visitors do.
async function measureFromAustralia(url) {
  const target = new URL(url);
  const measurementOptions = {
    protocol: target.protocol === 'http:' ? 'HTTP' : 'HTTPS',
    request: { method: 'GET', path: target.pathname, query: target.search.slice(1), headers: { 'cache-control': 'no-cache' } },
  };
  if (target.port) measurementOptions.port = Number(target.port);
  for (const locations of [[{ country: 'AU', tags: ['eyeball-network'] }], [{ country: 'AU' }]]) {
    const created = await globalping('/measurements', {
      method: 'POST',
      body: JSON.stringify({ type: 'http', target: target.hostname, locations, limit: 1, measurementOptions }),
    });
    if (created.status === 422) { await created.body?.cancel(); continue; } // none online: try any Australian location
    if (!created.ok) {
      await created.body?.cancel();
      return { unavailable: created.status === 429 ? 'Globalping limit reached' : `Globalping returned HTTP ${created.status}` };
    }
    const { id } = await created.json();
    for (const deadline = Date.now() + 30000; Date.now() < deadline; ) {
      await sleep(1000);
      const measurement = await (await globalping(`/measurements/${id}`)).json();
      if (measurement.status === 'in-progress') continue;
      const test = measurement.results?.[0];
      return test ? { probe: test.probe, result: test.result } : { unavailable: 'Globalping returned no result' };
    }
    return { unavailable: 'Globalping did not finish in time' };
  }
  return { unavailable: 'no Australian test location online' };
}

async function checkFromAustraliaOnce(site, url) {
  try {
    let current = new URL(url);
    for (let hop = 0; hop <= 3; hop++) {
      const m = await measureFromAustralia(current.href);
      if (m.unavailable) return { unavailable: m.unavailable };
      const where = [m.probe.city, m.probe.network].filter(Boolean).join(', ');
      const r = m.result;
      if (r.status !== 'finished') return { ok: false, kind: 'network', where, error: rawError(r.rawOutput) };
      if (r.tls && r.tls.authorized === false) {
        return { ok: false, kind: 'network', where, error: 'SSL certificate rejected', detail: r.tls.error };
      }
      const location = headerValue(r.headers, 'location');
      if (r.statusCode >= 300 && r.statusCode < 400 && location) {
        current = new URL(location, current);
        const problem = redirectProblem(site, current);
        if (problem) return { ok: false, where, ...problem };
        continue;
      }
      const problem = inspectResponse(site, {
        status: r.statusCode,
        contentType: headerValue(r.headers, 'content-type'),
        body: r.rawBody ?? '',
        truncated: r.truncated, // Globalping returns only the first 10 KB of the page
        botCheck: headerValue(r.headers, 'cf-mitigated') === 'challenge',
      });
      if (problem) return { ok: false, where, status: r.statusCode, ...problem };
      return { ok: true, where, status: r.statusCode, ms: r.timings?.total, truncated: r.truncated };
    }
    return { ok: false, kind: 'status', error: 'Too many redirects' };
  } catch (err) {
    return { unavailable: `Globalping error: ${err.message}` };
  }
}

// A failure only counts when a second, randomly chosen Australian location fails too.
async function checkFromAustralia(site, url) {
  const first = await checkFromAustraliaOnce(site, url);
  if (first.ok !== false) return first;
  const second = await checkFromAustraliaOnce(site, url);
  if (second.ok) return { ...second, note: `another Australian location failed (${first.error})` };
  if (second.ok === false) return { ...second, where: `${first.where} and ${second.where}`, confirmed: true };
  return { ...first, confirmed: false };
}

// ---------- 4. SSL certificate expiry ----------

function certificateExpiry(hostname) {
  if (isIP(hostname)) return Promise.resolve(null);
  return new Promise((resolveExpiry) => {
    const socket = tls.connect({ host: hostname, port: 443, servername: hostname, timeout: 10000 }, () => {
      const validTo = socket.getPeerCertificate()?.valid_to;
      socket.end();
      resolveExpiry(validTo ? new Date(validTo) : null);
    });
    socket.once('error', () => resolveExpiry(null)); // the page check reports broken certificates
    socket.once('timeout', () => { socket.destroy(); resolveExpiry(null); });
  });
}

// ---------- Putting the checks together ----------

async function checkSite(site) {
  const [dns, github] = await Promise.all([checkDns(site.hostname), checkFromGitHub(site)]);
  const pageUrl = new URL(github.ok ? github.finalUrl : site.checkUrl);
  if (site.cacheBust !== false) pageUrl.searchParams.set('_uptime', site.stamp); // a redirect may have dropped it
  const [australia, certExpires] = await Promise.all([
    AU_CHECK ? checkFromAustralia(site, pageUrl.href) : { unavailable: 'turned off' },
    pageUrl.protocol === 'https:' ? certificateExpiry(pageUrl.hostname) : null,
  ]);

  let problem = null;
  let detail = null;
  if (!dns.ok) problem = dns.error;
  // If GitHub (US) has a problem but Australia gets the real page, visitors are fine: firewalls
  // and bot protection often treat overseas data centres differently. The exception is a problem
  // that can sit past the first 10 KB, which is all Australia sees of a long page, or one only
  // GitHub checks (the app's script files).
  const australiaVouches = australia.ok && !github.githubOnly && !(github.deep && australia.truncated);
  // A bot check shown to GitHub is never downtime on its own: real visitors get past it.
  // A nearly blank page only counts if Australia sees a problem too.
  const inconclusive = github.kind === 'blocked' || (github.needsSecondOpinion && australia.ok !== false);
  if (!problem && !github.ok && !australiaVouches && !inconclusive) {
    problem = github.error;
    detail = github.detail ?? null;
  }
  if (!problem && australia.ok === false && australia.confirmed && australia.kind !== 'blocked') {
    problem = `Not working from Australia: ${australia.error}`;
    detail = australia.detail ?? null;
  }
  return { down: Boolean(problem), problem, detail, dns, github, australia, certExpires };
}

const describe = {
  dns: (r) => (r.dns.skipped ? 'not needed' : r.dns.unknown ? 'not checked (resolvers unreachable)' : r.dns.ok ? 'OK' : r.dns.error),
  github: (r) => (r.github.ok ? `HTTP ${r.github.status} in ${r.github.ms} ms` : r.github.error),
  australia: (r) =>
    r.australia.unavailable ? `not checked (${r.australia.unavailable})`
    : r.australia.ok ? `HTTP ${r.australia.status}${r.australia.ms ? ` in ${r.australia.ms} ms` : ''}`
    : r.australia.confirmed ? r.australia.error
    : `${r.australia.error} (not confirmed by a second location, so ignored)`,
};

function logLine(site, r, suffix = '') {
  const au = r.australia.unavailable ? `not checked (${r.australia.unavailable})`
    : `${describe.australia(r)}${r.australia.where ? ` [${r.australia.where}]` : ''}`;
  const parts = [`US: ${describe.github(r)}`, `AU: ${au}`, `DNS: ${describe.dns(r)}`];
  if (r.certExpires) parts.push(`SSL: ${Math.floor((r.certExpires - Date.now()) / 86_400_000)} days left`);
  const head = r.down ? `FAIL  ${site.label}  ${r.problem}${suffix}` : `UP    ${site.label}`;
  console.log(`${head}\n        ${parts.join(' | ')}`);
  if (!r.down && !r.github.ok) {
    console.log(r.australia.ok
      ? '        Counted as up: it works from Australia, where visitors are.'
      : r.github.kind === 'blocked'
        ? '        Counted as up: GitHub was shown a bot check, which real visitors get past (no Australian result to compare).'
        : '        Counted as up for now: only GitHub saw this, and there is no Australian result to confirm it.');
  }
  if (r.australia.note) console.log(`        Note: ${r.australia.note}.`);
}

// ---------- Emails ----------

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
const dateFormat = new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, day: 'numeric', month: 'short', year: 'numeric' });

function buildMessage(events, now) {
  const down = events.filter((e) => e.type === 'down');
  const up = events.filter((e) => e.type === 'recovered');
  const warnings = events.filter((e) => e.type === 'warning');

  let subject;
  if (events.length === 1) {
    const e = events[0];
    subject = e.type === 'down' ? `DOWN: ${e.name}`
      : e.type === 'recovered' ? `BACK UP: ${e.name} (was down ${e.duration})`
      : `SSL EXPIRING: ${e.name} (${e.days} days left)`;
  } else {
    const parts = [];
    if (down.length) parts.push(`${down.length} site${down.length > 1 ? 's' : ''} down`);
    if (up.length) parts.push(`${up.length} back up`);
    if (warnings.length) parts.push(`${warnings.length} SSL warning${warnings.length > 1 ? 's' : ''}`);
    subject = `Uptime: ${parts.join(', ')}`;
  }

  const lines = [];
  for (const e of down) {
    lines.push(`DOWN: ${e.name}`, `  ${e.url}`, `  Problem: ${e.error}`);
    if (e.detail) lines.push(`  ${e.detail}`);
    lines.push(`  From GitHub (US): ${e.checks.github}`, `  From Australia: ${e.checks.australia}`, `  Public DNS: ${e.checks.dns}`);
    lines.push(`  Failing since ${formatTime(e.since)} (${e.duration})`, '');
  }
  for (const e of up) {
    lines.push(`BACK UP: ${e.name}`, `  ${e.url}`, `  Was down for ${e.duration} (since ${formatTime(e.since)})`, '');
  }
  for (const e of warnings) {
    lines.push(
      `SSL EXPIRING: ${e.name}`,
      `  ${e.url}`,
      `  The SSL certificate expires on ${dateFormat.format(new Date(e.expires))} (${e.days} days left).`,
      '  If it is not renewed, browsers will block visitors with a security warning.',
      '',
    );
  }
  lines.push(`Checked ${formatTime(now.toISOString())}`);
  if (RUN_URL) lines.push(`Run details: ${RUN_URL}`);

  return { subject, text: lines.join('\n') };
}

const WEBHOOK_HINTS = {
  401: 'WEBHOOK_SECRET does not match the Header Auth value in n8n',
  403: 'WEBHOOK_SECRET does not match the Header Auth value in n8n',
  404: 'is the n8n workflow published, and is N8N_WEBHOOK_URL its Production URL?',
};

async function sendToN8n(payload, what) {
  if (DRY_RUN) {
    // Names in the subject are masked in the public log.
    console.log(PRIVATE_LIST && env.GITHUB_ACTIONS
      ? `DRY_RUN: would email "${payload.subject}"`
      : `DRY_RUN: would send to n8n:\n${JSON.stringify(payload, null, 2)}`);
    return;
  }
  if (!WEBHOOK_URL) throw new Error(`N8N_WEBHOOK_URL is not set, so the ${what} could not be sent`);

  const headers = { 'content-type': 'application/json' };
  if (WEBHOOK_SECRET) headers['x-monitor-secret'] = WEBHOOK_SECRET;
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const hint = WEBHOOK_HINTS[res.status];
    throw new Error(`n8n webhook returned HTTP ${res.status}${hint ? `: ${hint}` : ''}`);
  }
  console.log(`Sent ${what} to n8n`);
}

const notify = (events, now) =>
  sendToN8n(
    { ...buildMessage(events, now), events, checkedAt: now.toISOString(), runUrl: RUN_URL },
    `${events.length} change(s)`,
  );

// Run by hand with "Send a test alert" ticked: proves GitHub -> n8n -> email works
// without checking any site or touching state.json.
async function sendTestAlert(now) {
  const lines = [
    'This is a test from your uptime check.',
    'If you are reading this, down and back-up alerts will reach you.',
    '',
    `Sent ${formatTime(now.toISOString())}`,
  ];
  if (RUN_URL) lines.push(`Run details: ${RUN_URL}`);
  await sendToN8n(
    { subject: 'TEST: uptime alerts are working', text: lines.join('\n'), events: [], test: true, checkedAt: now.toISOString(), runUrl: RUN_URL },
    'test alert',
  );
}

// ---------- Main ----------

async function main() {
  const now = new Date();
  if (env.TEST_ALERT) return sendTestAlert(now);
  const sites = await loadSites();
  const previous = await loadState();
  console.log(`Checking ${sites.length} site(s) from GitHub (US)${AU_CHECK ? ' and Australia' : ''}${DRY_RUN ? ' (dry run: no emails, no saved state)' : ''}\n`);
  const results = await Promise.all(sites.map(checkSite));

  const nextSites = {};
  const events = [];

  sites.forEach((site, i) => {
    const r = results[i];
    const prev = previous.sites?.[site.id] ?? { status: 'up', fails: 0, failingSince: null };
    const next = { status: prev.status, fails: prev.fails ?? 0, failingSince: prev.failingSince ?? null, certWarned: prev.certWarned ?? null };
    const checks = { github: describe.github(r), australia: describe.australia(r), dns: describe.dns(r) };
    if (r.australia.where) checks.australia += ` (${r.australia.where})`;

    if (!r.down) {
      logLine(site, r);
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
      const failingFor = now - new Date(next.failingSince);
      const confirmed = next.fails >= FAIL_THRESHOLD && failingFor >= Math.max(0, MIN_DOWN_MS - SCHEDULE_SLACK_MS);
      const suffix = prev.status !== 'down' && !confirmed
        ? ` [failing for ${formatDuration(failingFor)}; alert only if still failing at ${MIN_DOWN_MS / 60000}m]`
        : '';
      logLine(site, r, suffix);
      if (prev.status !== 'down' && confirmed) {
        next.status = 'down';
        events.push({
          type: 'down',
          name: site.name,
          url: site.url,
          error: r.problem,
          detail: r.detail,
          checks,
          since: next.failingSince,
          duration: formatDuration(failingFor),
        });
      }
    }

    if (r.certExpires) {
      const days = Math.floor((r.certExpires - now) / 86_400_000);
      const expires = r.certExpires.toISOString();
      if (days > CERT_WARN_DAYS) next.certWarned = null; // renewed (or never close): arm the warning again
      else if (prev.certWarned !== expires) {
        events.push({ type: 'warning', name: site.name, url: site.url, days, expires });
        next.certWarned = expires; // one warning per certificate
      }
    }
    nextSites[site.id] = next;
  });

  // If this throws (n8n down, bad URL), state is NOT saved, so the next run retries
  // the alert, and the failed run makes GitHub email you as a backup.
  if (events.length) await notify(events, now);
  if (DRY_RUN) return;

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
