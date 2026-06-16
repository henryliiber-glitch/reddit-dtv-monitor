const Parser = require('rss-parser');
const crypto = require('crypto');

const parser = new Parser({ timeout: 30000 });

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const CHECK_INTERVAL_MINUTES = Number(process.env.CHECK_INTERVAL_MINUTES || 30);
const IGNORE_EXISTING_ON_START = (process.env.IGNORE_EXISTING_ON_START || 'true').toLowerCase() === 'true';
const REDDIT_USER_AGENT = process.env.REDDIT_USER_AGENT || 'Mozilla/5.0 reddit-dtv-monitor/1.0 by henryliiber';

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID environment variable.');
  process.exit(1);
}

// Search RSS endpoints get rate-limited easily from cloud IPs. New-post subreddit RSS feeds are more stable.
// We read newest posts from relevant subreddits and filter locally by DTV/visa keywords.
const feeds = (process.env.REDDIT_FEEDS || `
https://www.reddit.com/r/ThailandTourism/new.rss
https://www.reddit.com/r/digitalnomad/new.rss
https://www.reddit.com/r/Thailand/new.rss
https://www.reddit.com/r/ThailandExpats/new.rss
https://www.reddit.com/r/expats/new.rss
https://www.reddit.com/r/visas/new.rss
`).split('\n').map(s => s.trim()).filter(Boolean);

const positiveKeywords = [
  'dtv visa',
  'destination thailand visa',
  'thailand dtv',
  'thai dtv',
  'dtv thailand',
  'dtv from',
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

const seen = new Set();
const leads = new Map();
let firstRun = true;
let telegramOffset = 0;
let checkingFeeds = false;
let rateLimitedUntil = 0;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function idFor(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 16);
}

function stripHtml(html = '') {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function isRelevant(item) {
  const text = `${item.title || ''} ${stripHtml(item.content || item.contentSnippet || '')}`.toLowerCase();
  if (negativeKeywords.some(k => text.includes(k))) return false;
  return positiveKeywords.some(k => text.includes(k));
}

function escapeHtml(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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

async function fetchFeed(feedUrl) {
  const res = await fetch(feedUrl, {
    headers: {
      'user-agent': REDDIT_USER_AGENT,
      'accept': 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
      'cache-control': 'no-cache'
    }
  });

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after') || 1800);
    rateLimitedUntil = Date.now() + Math.max(retryAfter, 1800) * 1000;
    throw new Error(`Reddit rate limit 429. Pausing Reddit checks for ${Math.round((rateLimitedUntil - Date.now()) / 60000)} min.`);
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const xml = await res.text();
  return parser.parseString(xml);
}

function fallbackReply(item) {
  return `Hi! If you are looking at the Thailand DTV visa, the key points are: it is a 5-year multiple-entry visa, each entry can allow up to 180 days, and the application usually has to be made from outside Thailand. Requirements depend on the route: Remote Work, Soft Power, or Dependant.\n\nWe help applicants prepare the correct document package and choose a suitable embassy route. Feel free to message us here: https://wa.me/3725050256`;
}

async function generateReply(item) {
  if (!OPENAI_API_KEY) return fallbackReply(item);

  const bodyText = stripHtml(item.content || item.contentSnippet || '').slice(0, 1200);
  const prompt = `Write a helpful, non-spammy Reddit reply for a person asking about Thailand DTV visa. Do not claim guaranteed approval. Keep it short and useful. End with a soft invitation to contact https://wa.me/3725050256 only if it feels natural.\n\nPost title: ${item.title}\nPost text: ${bodyText}`;

  try {
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        input: prompt,
        max_output_tokens: 350
      })
    });
    const data = await res.json();
    const text = data.output_text || data.output?.flatMap(o => o.content || []).map(c => c.text || '').join('\n');
    return text?.trim() || fallbackReply(item);
  } catch (err) {
    console.error('OpenAI fallback:', err.message);
    return fallbackReply(item);
  }
}

async function notifyLead(item, feedUrl) {
  const leadId = idFor(item.link || item.guid || item.title);
  const reply = await generateReply(item);
  const text = stripHtml(item.content || item.contentSnippet || '').slice(0, 500);

  leads.set(leadId, { item, reply, feedUrl, createdAt: Date.now() });

  const message = `<b>Uus võimalik DTV lead Redditist</b>\n\n<b>Pealkiri:</b> ${escapeHtml(item.title || 'No title')}\n<b>Link:</b> ${escapeHtml(item.link || '')}\n\n<b>Postituse algus:</b>\n${escapeHtml(text || 'Pole teksti')}\n\n<b>Soovitatud vastus:</b>\n${escapeHtml(reply)}`;

  await telegram('sendMessage', {
    chat_id: TELEGRAM_CHAT_ID,
    text: message,
    parse_mode: 'HTML',
    disable_web_page_preview: false,
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ APPROVE', callback_data: `approve:${leadId}` },
          { text: '❌ SKIP', callback_data: `skip:${leadId}` }
        ],
        [
          { text: '🔗 Open Reddit post', url: item.link || 'https://reddit.com' }
        ]
      ]
    }
  });
}

async function checkFeeds() {
  if (checkingFeeds) return;
  if (Date.now() < rateLimitedUntil) {
    console.log(`Skipping Reddit check because of rate limit. Next retry at ${new Date(rateLimitedUntil).toISOString()}`);
    return;
  }

  checkingFeeds = true;

  try {
    console.log(`[${new Date().toISOString()}] Checking ${feeds.length} subreddit feeds...`);

    for (const feedUrl of feeds) {
      if (Date.now() < rateLimitedUntil) break;

      try {
        const feed = await fetchFeed(feedUrl);
        const items = (feed.items || []).slice(0, 25).reverse();
        console.log(`Feed OK: ${feedUrl} (${items.length} items)`);

        for (const item of items) {
          const unique = item.guid || item.link || item.title;
          if (!unique) continue;
          const key = idFor(unique);
          if (seen.has(key)) continue;
          seen.add(key);

          if (firstRun && IGNORE_EXISTING_ON_START) continue;
          if (!isRelevant(item)) continue;

          await notifyLead(item, feedUrl);
          await sleep(3000);
        }
      } catch (err) {
        console.error(`Feed error ${feedUrl}:`, err.message);
      }

      await sleep(20000);
    }

    firstRun = false;
  } finally {
    checkingFeeds = false;
  }
}

async function pollTelegramLoop() {
  // Long-polling loop. Do not use setInterval here, otherwise overlapping getUpdates calls cause Telegram 409 conflict.
  while (true) {
    try {
      const updates = await telegram('getUpdates', {
        offset: telegramOffset,
        timeout: 25,
        allowed_updates: ['callback_query']
      });

      for (const update of updates) {
        telegramOffset = update.update_id + 1;
        const cb = update.callback_query;
        if (!cb?.data) continue;

        const [action, leadId] = cb.data.split(':');
        const lead = leads.get(leadId);

        if (!lead) {
          await telegram('answerCallbackQuery', {
            callback_query_id: cb.id,
            text: 'Lead info expired. Open the Reddit link from the message.',
            show_alert: true
          });
          continue;
        }

        if (action === 'approve') {
          await telegram('answerCallbackQuery', {
            callback_query_id: cb.id,
            text: 'Approved. Copy the reply text and post manually on Reddit.',
            show_alert: false
          });
          await telegram('sendMessage', {
            chat_id: TELEGRAM_CHAT_ID,
            text: `<b>APPROVED reply text</b>\n\n${escapeHtml(lead.reply)}\n\n<b>Reddit link:</b> ${escapeHtml(lead.item.link || '')}`,
            parse_mode: 'HTML',
            disable_web_page_preview: true
          });
        }

        if (action === 'skip') {
          await telegram('answerCallbackQuery', {
            callback_query_id: cb.id,
            text: 'Skipped.',
            show_alert: false
          });
        }
      }
    } catch (err) {
      console.error('Telegram polling error:', err.message);
      await sleep(10000);
    }
  }
}

async function main() {
  await telegram('deleteWebhook', { drop_pending_updates: false }).catch(err => {
    console.error('deleteWebhook warning:', err.message);
  });

  await telegram('sendMessage', {
    chat_id: TELEGRAM_CHAT_ID,
    text: '✅ Reddit DTV monitor started. Kontrollin uusi Redditi postitusi automaatselt.'
  });

  await checkFeeds();
  setInterval(checkFeeds, CHECK_INTERVAL_MINUTES * 60 * 1000);
  pollTelegramLoop();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});