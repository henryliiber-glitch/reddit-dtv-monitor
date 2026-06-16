const Parser = require('rss-parser');
const crypto = require('crypto');

const parser = new Parser({ timeout: 30000 });

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CHECK_INTERVAL_MINUTES = Number(process.env.CHECK_INTERVAL_MINUTES || 30);
const IGNORE_EXISTING_ON_START = (process.env.IGNORE_EXISTING_ON_START || 'true').toLowerCase() === 'true';
const REDDIT_USER_AGENT = process.env.REDDIT_USER_AGENT || 'Mozilla/5.0 reddit-dtv-monitor/1.0 by henryliiber';
const SEND_STARTUP_MESSAGE = (process.env.SEND_STARTUP_MESSAGE || 'false').toLowerCase() === 'true';

const APIFY_TOKEN = process.env.APIFY_TOKEN;
const APIFY_TASK_ID = process.env.APIFY_TASK_ID;
const X_CHECK_INTERVAL_MINUTES = Number(process.env.X_CHECK_INTERVAL_MINUTES || 180);
const X_IGNORE_EXISTING_ON_START = (process.env.X_IGNORE_EXISTING_ON_START || 'true').toLowerCase() === 'true';
const APIFY_WAIT_SECONDS = Number(process.env.APIFY_WAIT_SECONDS || 180);

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID environment variable.');
  process.exit(1);
}

const feeds = (process.env.REDDIT_FEEDS || `
https://www.reddit.com/r/ThailandVisa/new.rss
`).split('\n').map(s => s.trim()).filter(Boolean);

const positiveKeywords = [
  'dtv visa',
  'destination thailand visa',
  'thailand dtv',
  'thai dtv',
  'dtv thailand',
  'dtv from',
  'dtv application',
  'dtv requirements',
  'dtv approved',
  'dtv rejected',
  'thailand visa',
  'thai visa',
  'remote work thailand',
  'digital nomad thailand',
  'apply from vietnam',
  'apply in vietnam',
  'hanoi embassy',
  'laos embassy',
  'thai embassy',
  'soft power visa',
  'muay thai visa',
  '500k baht',
  '500,000 baht'
];

const negativeKeywords = [
  'us visa',
  'schengen visa',
  'student visa usa',
  'canada visa',
  'uk visa'
];

const redditSeen = new Set();
const xSeen = new Set();
let redditFirstRun = true;
let xFirstRun = true;
let checkingFeeds = false;
let checkingX = false;
const feedCooldownUntil = new Map();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function idFor(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 16);
}

function stripHtml(html = '') {
  return String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeHtml(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function isRelevantText(textInput) {
  const text = String(textInput || '').toLowerCase();
  if (negativeKeywords.some(k => text.includes(k))) return false;
  return positiveKeywords.some(k => text.includes(k));
}

function isRelevantReddit(item) {
  const text = `${item.title || ''} ${stripHtml(item.content || item.contentSnippet || '')}`;
  return isRelevantText(text);
}

async function telegram(method, payload) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(`Telegram ${method} failed: ${JSON.stringify(data)}`);
  }
  return data.result;
}

async function sendTelegramMessage(message, options = {}) {
  await telegram('sendMessage', {
    chat_id: TELEGRAM_CHAT_ID,
    text: message,
    parse_mode: 'HTML',
    disable_web_page_preview: options.disable_web_page_preview ?? false
  });
}

async function fetchFeed(feedUrl) {
  const res = await fetch(feedUrl, {
    headers: {
      'user-agent': REDDIT_USER_AGENT,
      'accept': 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
      'cache-control': 'no-cache'
    }
  });

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after') || 3600);
    const cooldownMs = Math.max(retryAfter, 3600) * 1000;
    feedCooldownUntil.set(feedUrl, Date.now() + cooldownMs);
    throw new Error(`Reddit rate limit 429. Skipping this feed for ${Math.round(cooldownMs / 60000)} min.`);
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const xml = await res.text();
  return parser.parseString(xml);
}

async function notifyRedditLead(item, feedUrl) {
  const body = stripHtml(item.content || item.contentSnippet || '').slice(0, 700);
  const message = `<b>🔥 Reddit lead</b>\n\n<b>Feed:</b> ${escapeHtml(feedUrl)}\n<b>Title:</b> ${escapeHtml(item.title || 'No title')}\n\n<b>Text:</b>\n${escapeHtml(body || 'No text')}\n\n<b>Link:</b>\n${escapeHtml(item.link || '')}`;
  await sendTelegramMessage(message);
}

async function checkRedditFeeds() {
  if (checkingFeeds) return;
  checkingFeeds = true;

  try {
    console.log(`[${new Date().toISOString()}] Checking ${feeds.length} subreddit feeds...`);

    for (const feedUrl of feeds) {
      const cooldownUntil = feedCooldownUntil.get(feedUrl) || 0;
      if (Date.now() < cooldownUntil) {
        console.log(`Skipping ${feedUrl} because it is rate-limited until ${new Date(cooldownUntil).toISOString()}`);
        continue;
      }

      try {
        const feed = await fetchFeed(feedUrl);
        const items = (feed.items || []).slice(0, 25).reverse();
        console.log(`Feed OK: ${feedUrl} (${items.length} items)`);

        for (const item of items) {
          const unique = item.guid || item.link || item.title;
          if (!unique) continue;
          const key = idFor(unique);
          if (redditSeen.has(key)) continue;
          redditSeen.add(key);

          if (redditFirstRun && IGNORE_EXISTING_ON_START) continue;
          if (!isRelevantReddit(item)) continue;

          console.log(`Reddit lead match: ${item.title || 'No title'} ${item.link || ''}`);
          await notifyRedditLead(item, feedUrl);
          await sleep(3000);
        }
      } catch (err) {
        console.error(`Feed error ${feedUrl}:`, err.message);
      }

      await sleep(45000);
    }

    redditFirstRun = false;
    console.log(`[${new Date().toISOString()}] Reddit feed check finished. Next check in ${CHECK_INTERVAL_MINUTES} minutes.`);
  } finally {
    checkingFeeds = false;
  }
}

function getXUrl(item) {
  return item.url || item.twitterUrl || item.tweetUrl || item.link || '';
}

function getXText(item) {
  return item.text || item.fullText || item.content || item.description || '';
}

function getXAuthor(item) {
  const direct = item.author || item.username || item.userName || item.screenName || item.user?.username || item.user?.screenName;
  if (!direct) return '';
  return String(direct).startsWith('@') ? String(direct) : `@${direct}`;
}

async function runApifyTask() {
  if (!APIFY_TOKEN || !APIFY_TASK_ID) return null;

  const url = `https://api.apify.com/v2/actor-tasks/${encodeURIComponent(APIFY_TASK_ID)}/runs?token=${encodeURIComponent(APIFY_TOKEN)}&waitForFinish=${APIFY_WAIT_SECONDS}`;
  const res = await fetch(url, { method: 'POST' });
  const data = await res.json().catch(() => ({}));

  if (!res.ok || !data?.data) {
    throw new Error(`Apify task run failed: ${JSON.stringify(data).slice(0, 500)}`);
  }

  return data.data;
}

async function fetchApifyDatasetItems(datasetId) {
  const url = `https://api.apify.com/v2/datasets/${encodeURIComponent(datasetId)}/items?token=${encodeURIComponent(APIFY_TOKEN)}&clean=true`;
  const res = await fetch(url);
  const data = await res.json().catch(() => []);

  if (!res.ok) {
    throw new Error(`Apify dataset fetch failed: ${JSON.stringify(data).slice(0, 500)}`);
  }

  return Array.isArray(data) ? data : [];
}

async function notifyXLead(item) {
  const url = getXUrl(item);
  const text = getXText(item).slice(0, 900);
  const author = getXAuthor(item);
  const createdAt = item.createdAt || item.created_at || item.date || '';

  const message = `<b>🔥 X lead</b>\n\n${author ? `<b>Author:</b> ${escapeHtml(author)}\n` : ''}${createdAt ? `<b>Created:</b> ${escapeHtml(createdAt)}\n` : ''}\n<b>Text:</b>\n${escapeHtml(text || 'No text')}\n\n<b>Link:</b>\n${escapeHtml(url || 'No URL found')}`;
  await sendTelegramMessage(message);
}

async function checkXLeads() {
  if (!APIFY_TOKEN || !APIFY_TASK_ID) {
    console.log('X monitor disabled. Missing APIFY_TOKEN or APIFY_TASK_ID.');
    return;
  }
  if (checkingX) return;
  checkingX = true;

  try {
    console.log(`[${new Date().toISOString()}] Running Apify X task ${APIFY_TASK_ID}...`);
    const run = await runApifyTask();

    if (run.status !== 'SUCCEEDED') {
      console.log(`Apify run ended with status ${run.status}. Skipping dataset read.`);
      return;
    }

    const datasetId = run.defaultDatasetId;
    if (!datasetId) {
      console.log('Apify run has no defaultDatasetId.');
      return;
    }

    const items = await fetchApifyDatasetItems(datasetId);
    console.log(`Apify X task OK: ${items.length} items`);

    for (const item of items.reverse()) {
      const unique = item.id || getXUrl(item) || getXText(item);
      if (!unique) continue;
      const key = idFor(unique);
      if (xSeen.has(key)) continue;
      xSeen.add(key);

      if (xFirstRun && X_IGNORE_EXISTING_ON_START) continue;
      if (!isRelevantText(`${getXText(item)} ${getXUrl(item)}`)) continue;

      console.log(`X lead match: ${getXUrl(item)}`);
      await notifyXLead(item);
      await sleep(3000);
    }

    xFirstRun = false;
    console.log(`[${new Date().toISOString()}] X check finished. Next check in ${X_CHECK_INTERVAL_MINUTES} minutes.`);
  } catch (err) {
    console.error('X monitor error:', err.message);
  } finally {
    checkingX = false;
  }
}

async function main() {
  await telegram('deleteWebhook', { drop_pending_updates: false }).catch(err => {
    console.error('deleteWebhook warning:', err.message);
  });

  if (SEND_STARTUP_MESSAGE) {
    await sendTelegramMessage('✅ Lead monitor started. Kontrollin Redditi ja X-i leade automaatselt.', { disable_web_page_preview: true });
  }

  await checkRedditFeeds();
  setInterval(checkRedditFeeds, CHECK_INTERVAL_MINUTES * 60 * 1000);

  if (APIFY_TOKEN && APIFY_TASK_ID) {
    await checkXLeads();
    setInterval(checkXLeads, X_CHECK_INTERVAL_MINUTES * 60 * 1000);
  } else {
    console.log('X monitor disabled. Add APIFY_TOKEN and APIFY_TASK_ID to enable it.');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});