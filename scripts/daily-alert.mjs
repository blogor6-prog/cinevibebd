import fs from 'fs';

const TMDB_KEY = '8265bd1679663a7ea12ac168da84d2e8';
const SITE_URL = 'https://cinevibebd.pages.dev/';
const BOT_TOKEN = (process.env.TG_BOT_TOKEN || '').trim();
const ADMIN_CHAT_ID = (process.env.TG_ADMIN_CHAT_ID || '').trim();
const rawChannel = (process.env.TG_CHANNEL_ID || '').trim();
const CHANNEL_ID = rawChannel.replace(/^https?:\/\/(t\.me|telegram\.me)\//i, '@');
const CACHE_FILE = './scripts/notified-cache.json';

const LANG_NAMES = {
  bn: 'বাংলা (Bengali)',
  hi: 'হিন্দি (Hindi)',
  en: 'ইংরেজি (English)',
  ta: 'তামিল (Tamil)',
  te: 'তেলুগু (Telugu)',
  ml: 'মালয়ালম (Malayalam)',
  kn: 'কন্নড় (Kannada)',
  ko: 'কোরিয়ান (Korean)'
};

const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function loadCache() {
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    return {
      channelPosted: Array.isArray(data.channelPosted) ? data.channelPosted : [],
      adminNotified: Array.isArray(data.adminNotified) ? data.adminNotified : [],
      newsPosted: Array.isArray(data.newsPosted) ? data.newsPosted : []
    };
  } catch {
    return { channelPosted: [], adminNotified: [], newsPosted: [] };
  }
}

function saveCache(cache) {
  cache.channelPosted = cache.channelPosted.slice(-200);
  cache.adminNotified = cache.adminNotified.slice(-200);
  cache.newsPosted = cache.newsPosted.slice(-100);
  fs.mkdirSync('./scripts', { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

function getUploadedTitles() {
  try {
    const raw = JSON.parse(fs.readFileSync('./movies.json', 'utf8'));
    return new Set(raw.map(m => (m.title || '').toLowerCase().replace(/[^a-z0-9]/g, '')));
  } catch {
    return new Set();
  }
}

function isAlreadyOnSite(title, uploadedSet) {
  const clean = (title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!clean) return false;
  for (const ex of uploadedSet) {
    if (ex.includes(clean) || clean.includes(ex)) return true;
  }
  return false;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function telegramApi(method, payload) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const rawText = await res.text();
    if (res.ok) return { ok: true };

    if (res.status === 401) {
      throw new Error('TG_BOT_TOKEN ভুল আছে (401 Unauthorized)!');
    }

    if (res.status === 429) {
      let waitSec = 20;
      try {
        const parsed = JSON.parse(rawText);
        waitSec = parsed?.parameters?.retry_after || 20;
      } catch {}
      const finalWait = Math.min(waitSec, 70) + 2;
      console.log(`Telegram rate limit (429): waiting ${finalWait}s before retry #${attempt}...`);
      await sleep(finalWait * 1000);
      continue;
    }

    console.error(`${method} failed:`, res.status, rawText);
    return { ok: false, status: res.status, error: rawText };
  }
  return { ok: false, status: 429, error: 'Max retries reached' };
}

async function sendTelegramPhoto(chatId, photoUrl, caption) {
  if (!BOT_TOKEN || !chatId) return false;
  const safeCaption = caption.slice(0, 1000);

  if (photoUrl) {
    const r1 = await telegramApi('sendPhoto', {
      chat_id: chatId,
      photo: photoUrl,
      caption: safeCaption,
      parse_mode: 'HTML'
    });
    if (r1.ok) return true;
  }

  const r2 = await telegramApi('sendMessage', {
    chat_id: chatId,
    text: safeCaption,
    parse_mode: 'HTML',
    disable_web_page_preview: false
  });
  return r2.ok;
}

async function sendTelegramText(chatId, text) {
  if (!BOT_TOKEN || !chatId) return false;
  const r = await telegramApi('sendMessage', {
    chat_id: chatId,
    text: text.slice(0, 4000),
    parse_mode: 'HTML',
    disable_web_page_preview: true
  });
  return r.ok;
}

async function fetchBanglaMovieNews() {
  try {
    const rssUrl = 'https://news.google.com/rss/search?q=' +
      encodeURIComponent('বাংলা সিনেমা OR বাংলা মুভি OR বলিউড মুভি রিলিজ') +
      '&hl=bn&gl=BD&ceid=BD:bn';
    const xml = await (await fetch(rssUrl)).text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 5);
    return items.map(m => {
      const titleMatch = m[1].match(/<title>([\s\S]*?)<\/title>/);
      return titleMatch ? titleMatch[1].replace(/^<!\[CDATA\[|\]\]>$/g, '').trim() : '';
    }).filter(Boolean);
  } catch {
    return [];
  }
}

async function run() {
  if (!BOT_TOKEN) throw new Error('TG_BOT_TOKEN Secret সেট করা হয়নি!');

  const cache = loadCache();
  const uploadedSet = getUploadedTitles();

  const bdNow = new Date(Date.now() + 6 * 3600 * 1000);
  const todayStr = bdNow.toISOString().split('T')[0];
  const tomorrowStr = new Date(bdNow.getTime() + 1 * 86400000).toISOString().split('T')[0];
  const next14Str = new Date(bdNow.getTime() + 14 * 86400000).toISOString().split('T')[0];

  const [
    releaseTodayGlobal,
    releaseTodayRegional,
    trendingToday,
    upcomingGlobal,
    upcomingRegional,
    bnNews
  ] = await Promise.all([
    fetchJson(`https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_KEY}&primary_release_date.gte=${todayStr}&primary_release_date.lte=${todayStr}&sort_by=popularity.desc`),
    fetchJson(`https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_KEY}&with_original_language=bn|hi|ta|te|ml&primary_release_date.gte=${todayStr}&primary_release_date.lte=${todayStr}&sort_by=popularity.desc`),
    fetchJson(`https://api.themoviedb.org/3/trending/all/day?api_key=${TMDB_KEY}`),
    fetchJson(`https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_KEY}&primary_release_date.gte=${tomorrowStr}&primary_release_date.lte=${next14Str}&sort_by=popularity.desc`),
    fetchJson(`https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_KEY}&with_original_language=bn|hi|ta|te|ml&primary_release_date.gte=${tomorrowStr}&primary_release_date.lte=${next14Str}&sort_by=popularity.desc`),
    fetchBanglaMovieNews()
  ]);

  let adminSentCount = 0;
  let channelSentCount = 0;

  // ১) এডমিনকে আজকের রিলিজ
  const todayReleasesMap = new Map();
  [...(releaseTodayRegional.results || []), ...(releaseTodayGlobal.results || [])].forEach(m => {
    if (m.id && m.poster_path && !todayReleasesMap.has(m.id)) todayReleasesMap.set(m.id, m);
  });

  const todayReleases = [...todayReleasesMap.values()]
    .filter(m => !isAlreadyOnSite(m.title, uploadedSet) && !cache.adminNotified.includes(`rel_${m.id}`))
    .slice(0, 2);

  for (const m of todayReleases) {
    const poster = `https://image.tmdb.org/t/p/w500${m.poster_path}`;
    const lang = LANG_NAMES[m.original_language] || (m.original_language || '').toUpperCase();
    const caption =
      `🚨 <b>আজকে রিলিজ হয়েছে — এখনই আপলোড করুন!</b>\n\n` +
      `🎬 <b>নাম:</b> ${esc(m.title)}\n` +
      `📅 <b>রিলিজ তারিখ:</b> ${todayStr}\n` +
      `🗣️ <b>ভাষা:</b> ${esc(lang)}\n` +
      `⭐ <b>রেটিং:</b> ${m.vote_average ? m.vote_average.toFixed(1) : 'New'}\n\n` +
      `🌐 <b>আমাদের সাইট:</b> ${SITE_URL}`;

    const sent = await sendTelegramPhoto(ADMIN_CHAT_ID, poster, caption);
    if (sent) {
      cache.adminNotified.push(`rel_${m.id}`);
      adminSentCount++;
      console.log('Sent today release to Admin:', m.title);
    }
    await sleep(3500);
  }

  // ২) এডমিনকে ট্রেন্ডিং সাজেশন
  const adminTrending = (trendingToday.results || [])
    .filter(m => {
      const name = m.title || m.name;
      const rel = m.release_date || m.first_air_date || '';
      if (rel && rel > todayStr) return false;
      return name && m.poster_path && !isAlreadyOnSite(name, uploadedSet) && !cache.adminNotified.includes(`tr_${m.id}`);
    })
    .slice(0, 2);

  for (const m of adminTrending) {
    const name = m.title || m.name;
    const poster = `https://image.tmdb.org/t/p/w500${m.poster_path}`;
    const lang = LANG_NAMES[m.original_language] || (m.original_language || '').toUpperCase();
    const rate = m.vote_average ? m.vote_average.toFixed(1) : '7.5';
    const caption =
      `🔥 <b>ট্রেন্ডিং — আজকে এটি আপলোড করতে পারেন!</b>\n\n` +
      `🎬 <b>নাম:</b> ${esc(name)}\n` +
      `⭐ <b>রেটিং:</b> ${rate}/10\n` +
      `🗣️ <b>ভাষা:</b> ${esc(lang)}\n` +
      `📅 <b>রিলিজ:</b> ${m.release_date || m.first_air_date || 'N/A'}\n\n` +
      `🌐 <b>আমাদের সাইট:</b> ${SITE_URL}`;

    const sent = await sendTelegramPhoto(ADMIN_CHAT_ID, poster, caption);
    if (sent) {
      cache.adminNotified.push(`tr_${m.id}`);
      adminSentCount++;
      console.log('Sent trending to Admin:', name);
    }
    await sleep(3500);
  }

  // ৩) চ্যানেলে আপকামিং মুভি নিউজ
  const upcomingMap = new Map();
  [...(upcomingRegional.results || []), ...(upcomingGlobal.results || [])].forEach(m => {
    if (m.id && m.poster_path && !upcomingMap.has(m.id)) upcomingMap.set(m.id, m);
  });

  const upcomingForChannel = [...upcomingMap.values()]
    .filter(m => !cache.channelPosted.includes(`up_${m.id}`))
    .slice(0, 2);

  for (const m of upcomingForChannel) {
    const poster = `https://image.tmdb.org/t/p/w500${m.poster_path}`;
    const lang = LANG_NAMES[m.original_language] || (m.original_language || '').toUpperCase();
    const caption =
      `📢 <b>আপকামিং মুভি আপডেট!</b>\n\n` +
      `🎬 <b>নাম:</b> ${esc(m.title)}\n` +
      `🗓️ <b>রিলিজ তারিখ:</b> ${m.release_date}\n` +
      `🗣️ <b>ভাষা:</b> ${esc(lang)}\n\n` +
      `রিলিজ হওয়ার সাথে সাথেই HD কোয়ালিটিতে দেখতে ও ডাউনলোড করতে আমাদের সাইটে ভিজিট করুন!\n\n` +
      `🌐 <b>ওয়েবসাইট:</b> ${SITE_URL}`;

    const sent = await sendTelegramPhoto(CHANNEL_ID, poster, caption);
    if (sent) {
      cache.channelPosted.push(`up_${m.id}`);
      channelSentCount++;
      console.log('Sent upcoming to Channel:', m.title);
    }
    await sleep(3500);
  }

  // ৪) চ্যানেলে বাংলা মুভি নিউজ
  const freshNews = bnNews.filter(t => !cache.newsPosted.includes(t)).slice(0, 4);
  if (freshNews.length > 0) {
    let newsMsg = `📰 <b>আজকের বাংলা ও সিনেমাপাড়ার তাজা খবর</b> (${todayStr})\n\n`;
    freshNews.forEach(t => {
      newsMsg += `🔸 ${esc(t)}\n\n`;
    });
    newsMsg += `🎬 সব লেটেস্ট মুভি ও ওয়েব সিরিজ দেখতে ভিজিট করুন:\n🌐 ${SITE_URL}`;

    const sent = await sendTelegramText(CHANNEL_ID, newsMsg);
    if (sent) {
      freshNews.forEach(t => cache.newsPosted.push(t));
      channelSentCount++;
      console.log('Sent Bangla news to Channel');
    }
  }

  saveCache(cache);
  console.log('Summary:', { adminSentCount, channelSentCount });
  if (adminSentCount === 0 && channelSentCount === 0) {
    throw new Error('কোনো মেসেজ পাঠানো যায়নি! লগ চেক করুন।');
  }
}

run();
