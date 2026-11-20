/*  Artur product · бот @ArturProductBot: выдача гайда после подписки на канал + антиспам в чате обсуждения
 *  Cloudflare Worker + та же база D1 artur-stats. Один файл, без зависимостей.
 *
 *  POST /tg/webhook          — сюда Telegram присылает сообщения боту
 *  GET  /tg/setup            — один раз подключает вебхук и показывает права бота в чате (повторный вызов ничего не ломает)
 *  GET  /tg/stats?key=…      — сколько людей запросили и получили гайд (?days=7, 0 = всё время)
 *  GET  /tg/mod?key=…        — что удалил и кого забанил антиспам (?days=7)
 *  GET  /tg/thread?post=N    — номер треда комментариев к посту канала (для tools/tgpost.py)
 *  GET  /health              — проверка, что сервер жив
 *
 *  Настройки (Settings → Variables and Secrets):
 *   BOT_TOKEN       — токен бота @ArturProductBot (секрет)
 *   WEBHOOK_SECRET  — необязательно: ключ для /tg/stats и /tg/mod (секрет). Без него ключ вебхука выводится из BOT_TOKEN
 *   CHANNEL         — канал для проверки подписки, по умолчанию @arturproduct1
 *   GUIDE_URL       — ссылка на PDF гайда (каждую новую версию заливать под новым именем — бот запоминает файл по ссылке)
 *   GUIDE_FILENAME  — имя файла, которое увидит читатель (по умолчанию «Гайд_5_товаров_Ozon.pdf»)
 *   GUIDE_THUMB_URL — обложка для превью в чате: JPEG до 320 px и 200 КБ (необязательно)
 *   GUIDE_WEB_URL   — онлайн-версия гайда, кнопка «Открыть онлайн» (необязательно)
 *   GROUP_ID        — чат обсуждения, где работает антиспам (по умолчанию -1002336097706, «Чат | Artur product»)
 *   ANTISPAM        — off = выключить антиспам, не трогая остальное (необязательно)
 *   NOTICE          — off = не писать в чат «сообщение удалено» новичкам (необязательно)
 *   CAS_TOKEN       — ключ базы спамеров CAS, если она перестанет работать без ключа (необязательно)
 *  Привязка (Settings → Bindings): база D1 artur-stats с именем переменной DB.
 *
 *  Антиспам (бот должен быть админом чата с правами «Удаление сообщений» и «Блокировка пользователей»):
 *   — админов чата, сам канал и анонимных админов не трогает;
 *   — новичок (меньше 3 обычных сообщений в чате) из баз спамеров lols.bot / CAS → удалить и забанить;
 *   — стоп-слова (продажа номеров и аккаунтов, казино, 18+, «загляни в профиль»…) → новичка забанить, остальным удалить;
 *     буквы-двойники (латинская «о» вместо русской, жирные шрифты) приводятся к обычным;
 *   — новичок со ссылкой на чужой сайт или Telegram, упоминанием чужого @канала, пересылкой, кнопками,
 *     рекламой «заработок от … в день / пиши в лс» → удалить; второй раз за неделю → бан;
 *     ссылки на Ozon, WB, 1688, AliExpress, Amazon, YouTube и наш канал разрешены всем;
 *   — сообщение от имени чужого канала → удалить и забанить канал;
 *   — сообщения «вступил / вышел из группы» удаляются; вступившего проверяют по базам спамеров;
 *   — правки сообщений проверяются так же (спамеры часто дописывают ссылку потом);
 *   — отчёт о каждом действии приходит админу в личку с кнопками «Разбанить» / «Забанить» / «Это не спам».
 *     Включить отчёты: админ чата пишет боту /antispam, выключить — /antispam off.
 *
 *  Как человек получает гайд:
 *   ссылка t.me/ArturProductBot?start=guide (можно guide_ig, guide_tt — метка площадки для статистики)
 *   или любое сообщение со словом «товар» → бот проверяет подписку на канал →
 *   подписан: присылает PDF; не подписан: кнопки «Подписаться» и «Я подписался ✅».
 */

const DEF_CHANNEL = '@arturproduct1';
const CHANNEL_URL = 'https://t.me/arturproduct1';
const BASE_URL = 'https://t.me/ArturProductBot/base';
const GUIDE_NAME = '«5 товаров с Ozon, которые продаются прямо сейчас»';

const TXT = {
  hello: 'Привет! Это бот канала Artur product.\n\n' +
         'Здесь можно забрать гайд ' + GUIDE_NAME + ' и открыть «Базу товаров» — все разборы канала в одном приложении.',
  needSub: 'Гайд ' + GUIDE_NAME + ' — для подписчиков канала Artur product.\n\n' +
           'Подпишитесь на канал и нажмите «Я подписался ✅» — пришлю PDF сюда.',
  stillNo: 'Пока не вижу подписки. Подпишитесь на канал и нажмите кнопку ещё раз.',
  caption: 'Гайд ' + GUIDE_NAME + '.\n\n' +
           'Ссылки и QR-коды в PDF нажимаются. Если в вашем просмотрщике не нажимаются, откройте онлайн-версию по кнопке ниже.\n' +
           'Карточки Ozon открываются без VPN.\n\nНовые разборы выходят в канале.',
  help: 'Чтобы получить гайд, напишите «товар» или нажмите кнопку ниже.',
};

TXT.helloNoGuide = 'Привет! Это бот канала Artur product.\n\nЗдесь открывается «База товаров» — все разборы канала в одном приложении.';
const kbNoGuide = { inline_keyboard: [[{ text: 'База товаров', url: BASE_URL }, { text: 'Канал', url: CHANNEL_URL }]] };
const kbStart = { inline_keyboard: [
  [{ text: '📎 Получить гайд', callback_data: 'guide:start' }],
  [{ text: 'База товаров', url: BASE_URL }, { text: 'Канал', url: CHANNEL_URL }],
] };
const kbNeedSub = (src) => ({ inline_keyboard: [
  [{ text: 'Подписаться на канал', url: CHANNEL_URL }],
  [{ text: 'Я подписался ✅', callback_data: 'check:' + src }],
] });
const kbAfter = (env) => ({ inline_keyboard: [
  ...(env.GUIDE_WEB_URL ? [[{ text: '🌐 Открыть онлайн', url: env.GUIDE_WEB_URL }]] : []),
  [{ text: 'Открыть канал', url: CHANNEL_URL }, { text: 'База товаров', url: BASE_URL }],
] });

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' } });
const now = () => Math.floor(Date.now() / 1000);
const clean = (s, n = 40) => String(s || '').replace(/[^\w\-]/g, '').slice(0, n);

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  let d = {};
  try { d = await r.json(); } catch (e) { d = { ok: false, description: 'bad json' }; }
  return d;
}

let schemaReady = false;
async function schema(env) {
  if (schemaReady || !env.DB) return;
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS bot_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, uid INTEGER, type TEXT NOT NULL, src TEXT DEFAULT \'\', username TEXT DEFAULT \'\', first_name TEXT DEFAULT \'\')'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS be_type_ts ON bot_events (type, ts)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS threads (post_id INTEGER PRIMARY KEY, thread_id INTEGER NOT NULL, ts INTEGER NOT NULL)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS mod_users (chat_id INTEGER NOT NULL, uid INTEGER NOT NULL, username TEXT DEFAULT \'\', first_ts INTEGER, last_ts INTEGER, ok INTEGER DEFAULT 0, strikes INTEGER DEFAULT 0, strike_ts INTEGER DEFAULT 0, db_ts INTEGER DEFAULT 0, PRIMARY KEY (chat_id, uid))'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS mu_name ON mod_users (chat_id, username)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS mod_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, chat_id INTEGER, uid INTEGER, username TEXT DEFAULT \'\', name TEXT DEFAULT \'\', action TEXT NOT NULL, reason TEXT DEFAULT \'\', text TEXT DEFAULT \'\')'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS ml_ts ON mod_log (ts)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS mod_notes (chat_id INTEGER NOT NULL, msg_id INTEGER NOT NULL, del_at INTEGER NOT NULL, PRIMARY KEY (chat_id, msg_id))'),
  ]);
  schemaReady = true;
}

async function log(env, user, type, src) {
  if (!env.DB) return;
  try {
    await schema(env);
    await env.DB.prepare('INSERT INTO bot_events (ts, uid, type, src, username, first_name) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(now(), user.id || 0, type, clean(src), clean(user.username, 64), String(user.first_name || '').slice(0, 64)).run();
  } catch (e) { /* статистика не должна ломать выдачу */ }
}

async function kvGet(env, k) {
  if (!env.DB) return null;
  try { await schema(env); const r = await env.DB.prepare('SELECT v FROM kv WHERE k = ?').bind(k).first(); return r ? r.v : null; } catch (e) { return null; }
}
async function kvSet(env, k, v) {
  if (!env.DB) return;
  try { await schema(env); await env.DB.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, v).run(); } catch (e) {}
}

// подписан ли человек на канал; null — не удалось проверить
async function isSubscribed(env, uid) {
  const r = await tg(env, 'getChatMember', { chat_id: env.CHANNEL || DEF_CHANNEL, user_id: uid });
  if (!r.ok) return null;
  const m = r.result || {};
  if (['creator', 'administrator', 'member'].includes(m.status)) return true;
  if (m.status === 'restricted') return !!m.is_member;
  return false;
}

// первая отправка: скачиваем PDF и загружаем файлом — так у него будет нормальное имя и обложка
async function uploadGuide(env, chatId) {
  try {
    const pdf = await fetch(env.GUIDE_URL);
    if (!pdf.ok) throw new Error('pdf ' + pdf.status);
    const fd = new FormData();
    fd.append('chat_id', String(chatId));
    fd.append('caption', TXT.caption);
    fd.append('reply_markup', JSON.stringify(kbAfter(env)));
    fd.append('document', new Blob([await pdf.arrayBuffer()], { type: 'application/pdf' }), env.GUIDE_FILENAME || 'Гайд_5_товаров_Ozon.pdf');
    if (env.GUIDE_THUMB_URL) {
      const th = await fetch(env.GUIDE_THUMB_URL);
      if (th.ok) fd.append('thumbnail', new Blob([await th.arrayBuffer()], { type: 'image/jpeg' }), 'thumb.jpg');
    }
    const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, { method: 'POST', body: fd });
    return await r.json();
  } catch (e) {
    return { ok: false, description: String(e && e.message) };
  }
}

async function sendGuide(env, chatId, user, src) {
  const url = env.GUIDE_URL;
  const key = 'guide_file:' + (url || '');
  const cached = await kvGet(env, key);
  let r = cached
    ? await tg(env, 'sendDocument', { chat_id: chatId, document: cached, caption: TXT.caption, reply_markup: kbAfter(env) })
    : await uploadGuide(env, chatId);
  if (!r.ok) { // запасной путь: Telegram сам скачает файл по ссылке
    r = await tg(env, 'sendDocument', { chat_id: chatId, document: url, caption: TXT.caption, reply_markup: kbAfter(env) });
  }
  if (r.ok) {
    const fid = r.result && r.result.document && r.result.document.file_id;
    if (fid && fid !== cached) await kvSet(env, key, fid);
    await log(env, user, 'guide_sent', src);
  } else {
    await log(env, user, 'guide_error', src);
    await tg(env, 'sendMessage', { chat_id: chatId, text: 'Не получилось отправить файл. Попробуйте ещё раз через минуту.' });
  }
  return r.ok;
}

// главный сценарий: проверить подписку и выдать гайд
async function handleGuide(env, chatId, user, src, cbId) {
  if (!env.GUIDE_URL) {
    if (cbId) await tg(env, 'answerCallbackQuery', { callback_query_id: cbId });
    return tg(env, 'sendMessage', { chat_id: chatId, text: TXT.helloNoGuide, reply_markup: kbNoGuide });
  }
  await log(env, user, cbId ? 'guide_check' : 'guide_request', src);
  const sub = await isSubscribed(env, user.id);
  if (sub === false) {
    await log(env, user, 'guide_nosub', src);
    if (cbId) {
      await tg(env, 'answerCallbackQuery', { callback_query_id: cbId, text: TXT.stillNo, show_alert: true });
    } else {
      await tg(env, 'sendMessage', { chat_id: chatId, text: TXT.needSub, reply_markup: kbNeedSub(src || 'bot') });
    }
    return;
  }
  if (sub === null) await log(env, user, 'sub_check_failed', src); // не теряем человека: выдаём гайд
  if (cbId) await tg(env, 'answerCallbackQuery', { callback_query_id: cbId });
  await sendGuide(env, chatId, user, src);
}

/* ───────────────────────── Антиспам в чате обсуждения ───────────────────────── */

const DEF_GROUP = '-1002336097706';
const TRUST_AFTER = 3;                 // столько обычных сообщений — и человек больше не новичок
const STRIKE_DAYS = 7;                 // второе нарушение за эти дни → бан
const WL_TG = ['arturproduct1', 'arturproductbot'];
const WL_HOSTS = ['arturproduct.github.io', 'ozon.ru', 'wildberries.ru', 'wb.ru', 'market.yandex.ru', 'avito.ru',
  '1688.com', 'alibaba.com', 'aliexpress.ru', 'aliexpress.com', 'taobao.com', 'pinduoduo.com', 'amazon.com', 'temu.com',
  'youtube.com', 'youtu.be', 'tiktok.com', 'instagram.com', 'vk.com', 'mpstats.io'];

// \w и \b в JS понимают только латиницу — подменяем на версии для любых букв
const WC = '[\\p{L}\\p{N}_]';
const WB = `(?:(?<!${WC})(?=${WC})|(?<=${WC})(?!${WC}))`;
const rx = (s) => new RegExp(s.replace(/\\w/g, WC).replace(/\\b/g, WB), 'iu');

// однозначный спам: новичка банить, у остальных удалять
const HARD = [
  String.raw`\b(прода[юм]|скупаю|куплю|сдаю)\s+(\w+\s+){0,2}(номер(а|ов)|акк(и|ов)|аккаунт(ы|ов)|сим.?карт\w*|симк\w*)\b`,
  String.raw`\bномер(а|ов)\s+(для\s+)?(тг|tg|телеграм\w*|telegram|whatsapp|ватсап\w*|вацап\w*)\b`,
  String.raw`\bвиртуальн\w*\s+номер`,
  String.raw`\b(казино|casino|1xbet|1win|pin.?up|мостбет\w*|mostbet|vavada|вавада|букмекер\w*|фриспин\w*)\b`,
  String.raw`\b(интим|интим\w*\s+услуг\w*|эскорт\w*|escort|onlyfans|онлифанс\w*|нюдс\w*|nudes|порн\w*|porn\w*)\b`,
  String.raw`🔞`,
  String.raw`\b(мефедрон\w*|меф|гашиш\w*|кокаин\w*|амфетамин\w*)\b`,
  String.raw`\bобнал\w*`,
  String.raw`\bпробив\w*\s+(по|людей|номер\w*|данны\w*|человек\w*)`,
  String.raw`\b(в|на)\s+(моём|моем|мой|мою|моей)\s+(профил\w*|био|bio|аватар\w*|аве|аву)\b`,
  String.raw`\b(загляни|заходи|зайди|жми|кликай|переходи)\w*\s+(в|на)\s+(мой\s+|мою\s+)?(профил\w*|био|bio|аву|аватар\w*)\b`,
].map(rx);

// похоже на рекламу: два признака, или признак + ссылка/упоминание → удалить
const SOFT = [
  String.raw`\b(доход\w*|заработ\w*|прибыл\w*|зарплат\w*|зп)\s+(от|до|по)?\s*\d[\d\s.,]*\s*(к|тыс\w*|т\.р|₽|р|руб\w*|\$|usdt|долл\w*|евро)(?!\p{L})`,
  String.raw`\d[\d\s.,]*\s*(к|тыс\w*|₽|р|руб\w*|\$|usdt|долл\w*)(?!\p{L})\.?\s*(в|за)\s*(день|сутки|час|недел\w*)\b`,
  String.raw`\b(смотр\w*|глянь\w*)\s+(в\s+|на\s+)?(профил\w*|био|bio|аву|аватар\w*)\b`,
  String.raw`\b(в|на)\s+(моём|моем|мой|мою|моей)\s+(канал\w*|страниц\w*)`,
  String.raw`\b(загляни|заходи|приходи)\w*\s+ко\s+мне\b`,
  String.raw`(^|\s)18\s*\+`,
  String.raw`\b(пиш\w*|напиш\w*|обращайт\w*|стучи\w*|жду)\s+(мне\s+)?(в\s+)?(лс|л\.с|личк\w*|личн\w*|директ|dm)`,
  String.raw`\b(удал[её]нн\w*|на\s+дому|из\s+дома|онлайн)\s+(работ\w*|заработ\w*|подработ\w*|доход\w*)`,
  String.raw`\bподработ\w*`,
  String.raw`\bудал[её]нк\w*`,
  String.raw`\b(zarabot\w*|zarabat\w*|dohod\w*|podrabot\w*|rabota\s+na\s+domu)\b`,
  String.raw`\bбез\s+(вложени\w*|опыта|навыков)\b`,
  String.raw`\b(ищу|ищем|набира\w*|нужн\w*|требу\w*)\s+(\d+\s+)?(людей|люди|человек\w*|партн[её]р\w*|сотрудник\w*|в\s+команду|помощник\w*|курьер\w*)`,
  String.raw`\b(крипт\w*|usdt|арбитраж\w*|p2p|трейд\w*|форекс|forex|инвест\w*|биткоин\w*|bitcoin)\b[^.\n]{0,40}(доход\w*|заработ\w*|прибыл\w*|сигнал\w*|пассивн\w*|\d+\s*%)`,
  String.raw`\bпассивн\w*\s+доход\w*`,
  String.raw`\b(бесплатн\w*|дарю|раздаю|раздач\w*|розыгрыш\w*)\b[^.\n]{0,25}(iphone|айфон\w*|деньг\w*|денег|usdt|звезд\w*|stars|премиум\w*|premium)`,
  String.raw`\b(звезд\w*|stars|премиум\w*|premium)\b[^.\n]{0,20}(дешев\w*|дёшев\w*|скидк\w*|продаю|продам)`,
  String.raw`\bнакрутк\w*\s+(подписчик\w*|просмотр\w*|лайк\w*|реакци\w*|отзыв\w*)`,
  String.raw`\b(кто\s+хочет|хочешь|хотите)\s+(зараб\w*|доход\w*|деньг\w*)`,
  String.raw`\b(ссылк\w*|подробн\w*|детали|инфа)\s+(в\s+)?(профил\w*|био|bio|закреп\w*)`,
].map(rx);

// буквы-двойники: «зapaбoтoк» с латиницей, «𝐳𝐚𝐫𝐚𝐛𝐨𝐭𝐨𝐤», невидимые символы
const LAT2CYR = { a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м', n: 'п', o: 'о', p: 'р', r: 'г', t: 'т', u: 'и', x: 'х', y: 'у' };
const norm = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[​-‏⁠­️]/g, '').replace(/ё/g, 'е').replace(/\s+/g, ' ');
const toCyr = (s) => s
  .replace(/(?<=\p{L})[03](?=\p{L})/gu, (d) => (d === '0' ? 'о' : 'з'))
  .replace(/\p{L}+/gu, (w) => (/[а-я]/.test(w) && /[a-z]/.test(w) ? w.replace(/[a-z]/g, (c) => LAT2CYR[c] || c) : w));
const hits = (list, ...texts) => {
  const out = [];
  for (const r of list) for (const t of texts) { const m = t && t.match(r); if (m) { out.push(m[0].trim().slice(0, 40)); break; } }
  return out;
};
const fullName = (u) => [u.first_name, u.last_name].filter(Boolean).join(' ').trim();
const whoLine = (u) => `${fullName(u) || 'без имени'}${u.username ? ' @' + u.username : ''} (id ${u.id})`;

async function q1(env, sql, ...b) { if (!env.DB) return null; try { await schema(env); return await env.DB.prepare(sql).bind(...b).first(); } catch (e) { return null; } }
async function run(env, sql, ...b) { if (!env.DB) return; try { await schema(env); await env.DB.prepare(sql).bind(...b).run(); } catch (e) {} }
const botId = (env) => Number(String(env.BOT_TOKEN || '').split(':')[0]) || 0;
const isAdminStatus = (m) => m && (m.status === 'creator' || m.status === 'administrator');

// админы чата и привязанный канал — кэш на 10 минут
async function groupInfo(env, chatId) {
  const k = 'grp:' + chatId;
  let old = null;
  try { old = JSON.parse(await kvGet(env, k) || 'null'); } catch (e) {}
  if (old && now() - old.ts < 600) return old;
  const [a, c] = await Promise.all([tg(env, 'getChatAdministrators', { chat_id: chatId }), tg(env, 'getChat', { chat_id: chatId })]);
  if (!a.ok && old) return old;
  const info = {
    ok: !!a.ok,
    ts: now(),
    admins: a.ok ? a.result.map((x) => x.user.id) : [],
    names: a.ok ? a.result.map((x) => String(x.user.username || '').toLowerCase()).filter(Boolean) : [],
    linked: c.ok ? c.result.linked_chat_id || 0 : (old ? old.linked : 0),
  };
  if (a.ok) await kvSet(env, k, JSON.stringify(info));
  return info;
}

// базы спамеров: lols.bot и CAS. Не ответили — пропускаем человека, а не блокируем
async function spamDb(env, uid) {
  const get = async (url, headers = {}) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 2500);
    try { const r = await fetch(url, { headers, signal: ac.signal }); return r.ok ? await r.json() : null; } catch (e) { return null; } finally { clearTimeout(t); }
  };
  const [lols, cas] = await Promise.all([
    get('https://api.lols.bot/account?id=' + uid),
    get('https://api.cas.chat/check?user_id=' + uid, env.CAS_TOKEN ? { authorization: 'Bearer ' + env.CAS_TOKEN } : {}),
  ]);
  const answered = !!(lols && typeof lols === 'object') || !!(cas && typeof cas === 'object');
  if (lols && lols.ok === true && lols.banned === true && (lols.user_id == null || Number(lols.user_id) === Number(uid))) return { hit: 'lols.bot', answered };
  if (cas && cas.ok === true && cas.result) return { hit: 'CAS', answered };
  return { hit: null, answered };
}

async function userRec(env, chatId, u) {
  const t = now();
  await run(env, 'INSERT INTO mod_users (chat_id, uid, username, first_ts, last_ts) VALUES (?, ?, ?, ?, ?) ON CONFLICT(chat_id, uid) DO UPDATE SET last_ts = excluded.last_ts, username = excluded.username',
    chatId, u.id, String(u.username || '').toLowerCase(), t, t);
  return (await q1(env, 'SELECT * FROM mod_users WHERE chat_id = ? AND uid = ?', chatId, u.id)) || { ok: 0, strikes: 0, strike_ts: 0, db_ts: 0 };
}

async function dbCheck(env, chatId, u, rec) {
  if (rec.db_ts && now() - rec.db_ts < 6 * 3600) return null;
  const r = await spamDb(env, u.id);
  if (r.answered && !r.hit) await run(env, 'UPDATE mod_users SET db_ts = ? WHERE chat_id = ? AND uid = ?', now(), chatId, u.id);
  return r.hit;
}

function okUrl(raw) {
  let s = String(raw || '').trim();
  if (/^tg:/i.test(s)) return false;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  let host = '', path = '';
  try { const x = new URL(s); host = x.hostname.toLowerCase().replace(/^www\./, ''); path = x.pathname; } catch (e) { return false; }
  if (['t.me', 'telegram.me', 'telegram.dog'].includes(host)) return WL_TG.includes((path.split('/')[1] || '').toLowerCase());
  return WL_HOSTS.some((d) => host === d || host.endsWith('.' + d));
}

// ссылки, упоминания, пересылки, кнопки — для новичков
async function signals(env, m, chatId, text, g) {
  const out = [];
  const ents = m.entities || m.caption_entities || [];
  for (const e of ents) {
    const s = text.substr(e.offset, e.length);
    if ((e.type === 'url' || e.type === 'text_link') && !okUrl(e.type === 'url' ? s : e.url)) out.push('ссылка ' + (e.type === 'url' ? s : e.url).slice(0, 60));
    if (e.type === 'mention') {
      const name = s.replace(/^@/, '').toLowerCase();
      if (WL_TG.includes(name) || g.names.includes(name)) continue;
      const seen = await q1(env, 'SELECT 1 AS x FROM mod_users WHERE chat_id = ? AND username = ?', chatId, name);
      if (!seen) out.push('упоминание ' + s);
    }
  }
  const t = norm(text);
  const ob = t.match(/(?:^|[^a-z0-9а-я])[tт]\s*[.,·]\s*(?:me|ме)\s*\/\s*([a-z0-9_+]+)/i);
  if (ob && !WL_TG.includes(ob[1].toLowerCase()) && !out.some((x) => x.startsWith('ссылка'))) out.push('ссылка на Telegram');
  // пересылки и цитаты из нашего же канала — можно
  const own = String(env.CHANNEL || DEF_CHANNEL).replace(/^@/, '').toLowerCase();
  const ours = (c) => !!c && ((g.linked && c.id === g.linked) || String(c.username || '').toLowerCase() === own);
  const fo = m.forward_origin;
  if ((fo || m.forward_from || m.forward_from_chat || m.forward_sender_name) && !ours((fo && fo.chat) || m.forward_from_chat)) out.push('пересылка');
  if (m.story) out.push('пересланная история');
  const er = m.external_reply;
  if (er && !ours(er.chat || (er.origin && er.origin.chat))) out.push('цитата из другого чата');
  if (m.reply_markup) out.push('кнопки');
  if (m.via_bot) out.push('сообщение через бота @' + (m.via_bot.username || ''));
  if (m.contact) out.push('контакт');
  const nm = norm(fullName(m.from || {}));
  if (/t\s*\.\s*me|https?:|www\.|@[a-z0-9_]{4,}/i.test(nm)) out.push('ссылка в имени');
  return out;
}

async function reportTo(env) { try { return JSON.parse(await kvGet(env, 'mod_report_to') || '[]'); } catch (e) { return []; } }

async function report(env, o) {
  const to = await reportTo(env);
  if (!to.length) return;
  const head = o.action === 'ban' ? '🚫 Забанил' : o.action === 'ban_channel' ? '🚫 Забанил канал' : o.action === 'fail' ? '⚠️ Не смог удалить' : '🗑 Удалил сообщение';
  const text = `🛡 Антиспам · ${o.title || 'чат'}\n${head}: ${o.who}\nПричина: ${o.reason}` + (o.text ? `\n\nТекст: «${o.text.slice(0, 300)}»` : '');
  const kb = o.action === 'ban' ? [[{ text: '↩️ Разбанить', callback_data: `unban:${o.chatId}:${o.uid}` }]]
    : o.action === 'ban_channel' ? [[{ text: '↩️ Разбанить канал', callback_data: `unbanc:${o.chatId}:${o.uid}` }]]
    : [[{ text: '🚫 Забанить', callback_data: `ban:${o.chatId}:${o.uid}` }, { text: '✅ Это не спам', callback_data: `trust:${o.chatId}:${o.uid}` }]];
  for (const id of to) await tg(env, 'sendMessage', { chat_id: id, text, reply_markup: { inline_keyboard: kb }, link_preview_options: { is_disabled: true } });
}

async function modLog(env, chatId, u, action, reason, text) {
  await run(env, 'INSERT INTO mod_log (ts, chat_id, uid, username, name, action, reason, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    now(), chatId, u.id || 0, String(u.username || '').slice(0, 64), fullName(u).slice(0, 64), action, String(reason).slice(0, 200), String(text || '').slice(0, 500));
}

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

async function cleanupNotes(env, chatId) {
  if (!env.DB) return;
  try {
    await schema(env);
    const r = await env.DB.prepare('SELECT msg_id FROM mod_notes WHERE chat_id = ? AND del_at <= ? LIMIT 5').bind(chatId, now()).all();
    for (const x of r.results || []) {
      await tg(env, 'deleteMessage', { chat_id: chatId, message_id: x.msg_id });
      await run(env, 'DELETE FROM mod_notes WHERE chat_id = ? AND msg_id = ?', chatId, x.msg_id);
    }
  } catch (e) {}
}

async function notice(env, ctx, m) {
  if (env.NOTICE === 'off') return;
  const body = { chat_id: m.chat.id, text: 'Сообщение удалено: новые участники чата пока не могут отправлять ссылки, упоминания и пересылки. Напишите пару обычных комментариев — ограничение снимется само.' };
  if (m.message_thread_id) body.reply_parameters = { message_id: m.message_thread_id, allow_sending_without_reply: true };
  const r = await tg(env, 'sendMessage', body);
  if (!r.ok || !r.result) return;
  const id = r.result.message_id;
  const ttl = env.NOTE_TTL != null ? Number(env.NOTE_TTL) : 25;
  await run(env, 'INSERT OR REPLACE INTO mod_notes (chat_id, msg_id, del_at) VALUES (?, ?, ?)', m.chat.id, id, now() + 60);
  const job = sleep(ttl).then(() => tg(env, 'deleteMessage', { chat_id: m.chat.id, message_id: id }))
    .then(() => run(env, 'DELETE FROM mod_notes WHERE chat_id = ? AND msg_id = ?', m.chat.id, id)).catch(() => {});
  if (ctx && ctx.waitUntil) ctx.waitUntil(job);
}

// удалить сообщение, при необходимости забанить, записать и сообщить админам
async function punish(env, ctx, m, u, rec, o) {
  const chatId = m.chat.id;
  const text = String(m.text || m.caption || '');
  const del = await tg(env, 'deleteMessage', { chat_id: chatId, message_id: m.message_id });
  let strikes = (rec.strike_ts && now() - rec.strike_ts < STRIKE_DAYS * 86400 ? rec.strikes || 0 : 0) + 1;
  let ban = o.ban || (o.strike && strikes >= 2);
  let banned = false;
  if (ban) banned = !!(await tg(env, 'banChatMember', { chat_id: chatId, user_id: u.id, revoke_messages: true })).ok;
  await run(env, 'UPDATE mod_users SET strikes = ?, strike_ts = ? WHERE chat_id = ? AND uid = ?', strikes, now(), chatId, u.id);
  const reason = o.reason + (ban && !o.ban ? ' (второе нарушение за неделю)' : '') + (!del.ok ? ' — у бота нет права удалять сообщения' : '') + (ban && !banned ? ' — забанить не вышло, нет права блокировать' : '');
  const action = banned ? 'ban' : del.ok ? 'delete' : 'fail';
  await modLog(env, chatId, u, action, reason, text);
  if (o.notice && del.ok && !banned) await notice(env, ctx, m);
  await report(env, { action, chatId, uid: u.id, who: whoLine(u), reason, text, title: m.chat.title });
}

async function onJoin(env, m, g) {
  const chatId = m.chat.id;
  const adder = m.from || {};
  for (const u of m.new_chat_members || []) {
    if (u.id === botId(env)) continue;
    if (u.is_bot) { // чужие боты, которых добавил не админ
      if (!g.admins.includes(adder.id)) {
        const b = await tg(env, 'banChatMember', { chat_id: chatId, user_id: u.id });
        await modLog(env, chatId, u, b.ok ? 'ban' : 'fail', 'бота добавил не админ', '');
        await report(env, { action: b.ok ? 'ban' : 'fail', chatId, uid: u.id, who: whoLine(u), reason: 'бота добавил не админ', title: m.chat.title });
      }
      continue;
    }
    const rec = await userRec(env, chatId, u);
    const nm = norm(fullName(u));
    const db = await dbCheck(env, chatId, u, rec);
    const hard = hits(HARD, nm, toCyr(nm));
    const reason = db ? 'есть в базе спамеров ' + db : hard.length ? 'реклама в имени: «' + hard[0] + '»' : '';
    if (!reason) continue;
    const b = await tg(env, 'banChatMember', { chat_id: chatId, user_id: u.id, revoke_messages: true });
    await modLog(env, chatId, u, b.ok ? 'ban' : 'fail', 'при входе: ' + reason, '');
    await report(env, { action: b.ok ? 'ban' : 'fail', chatId, uid: u.id, who: whoLine(u), reason: 'при входе: ' + reason + (b.ok ? '' : ' — нет права блокировать'), title: m.chat.title });
  }
}

async function moderate(env, ctx, m, edited) {
  const chatId = m.chat.id;
  await cleanupNotes(env, chatId);

  // «вступил / вышел» — убираем из чата, вступивших проверяем
  if (m.new_chat_members || m.left_chat_member) {
    await tg(env, 'deleteMessage', { chat_id: chatId, message_id: m.message_id });
    if (m.new_chat_members) { const g0 = await groupInfo(env, chatId); if (g0.ok) await onJoin(env, m, g0); }
    return;
  }
  if (m.is_automatic_forward) return;
  const g = await groupInfo(env, chatId);
  if (!g.ok) return; // не знаем, кто админ (бот не админ чата?) — лучше ничего не трогать

  // от имени канала или группы
  if (m.sender_chat) {
    const sc = m.sender_chat;
    const own = String(env.CHANNEL || DEF_CHANNEL).replace(/^@/, '').toLowerCase();
    if (sc.id === chatId || (g.linked && sc.id === g.linked) || String(sc.username || '').toLowerCase() === own) return;
    const del = await tg(env, 'deleteMessage', { chat_id: chatId, message_id: m.message_id });
    const b = await tg(env, 'banChatSenderChat', { chat_id: chatId, sender_chat_id: sc.id });
    const who = `${sc.title || 'канал'}${sc.username ? ' @' + sc.username : ''} (id ${sc.id})`;
    const action = b.ok ? 'ban_channel' : del.ok ? 'delete' : 'fail';
    const text = String(m.text || m.caption || '');
    await modLog(env, chatId, { id: sc.id, username: sc.username, first_name: sc.title }, action, 'сообщение от имени чужого канала', text);
    await report(env, { action, chatId, uid: sc.id, who, reason: 'сообщение от имени чужого канала', text, title: m.chat.title });
    return;
  }

  const u = m.from;
  if (!u || u.id === 777000 || u.id === botId(env) || g.admins.includes(u.id)) return;
  const rec = await userRec(env, chatId, u);
  const text = String(m.text || m.caption || '');
  const t1 = norm(text), t2 = toCyr(t1);
  const hard = hits(HARD, t1, t2);

  if ((rec.ok || 0) >= TRUST_AFTER) { // свой человек: удаляем только явный спам и не баним
    if (hard.length) return punish(env, ctx, m, u, rec, { ban: false, reason: 'стоп-слова: «' + hard[0] + '»' });
    if (!edited) await run(env, 'UPDATE mod_users SET ok = ok + 1 WHERE chat_id = ? AND uid = ?', chatId, u.id);
    return;
  }

  // новичок
  const db = await dbCheck(env, chatId, u, rec);
  if (db) return punish(env, ctx, m, u, rec, { ban: true, reason: 'есть в базе спамеров ' + db });
  if (hard.length) return punish(env, ctx, m, u, rec, { ban: true, reason: 'стоп-слова: «' + hard[0] + '»' });
  const n1 = norm(fullName(u)), n2 = toCyr(n1);
  const nameHard = hits(HARD, n1, n2);
  if (nameHard.length) return punish(env, ctx, m, u, rec, { ban: true, reason: 'реклама в имени: «' + nameHard[0] + '»' });
  const soft = [...hits(SOFT, t1, t2), ...hits(SOFT, n1, n2).map((x) => 'имя: ' + x)];
  const sig = await signals(env, m, chatId, text, g);
  const score = soft.length + (sig.length ? 2 : 0);
  if (score >= 2) {
    const why = [...sig, ...soft.map((x) => '«' + x + '»')].join(', ');
    return punish(env, ctx, m, u, rec, { ban: score >= 4, strike: true, notice: soft.length === 0, reason: 'новый участник: ' + why });
  }
  if (!edited) await run(env, 'UPDATE mod_users SET ok = ok + 1 WHERE chat_id = ? AND uid = ?', chatId, u.id);
}

// кнопки в отчёте админу
async function modCallback(env, cq, act, chatId, id) {
  const who = cq.from || {};
  const member = await tg(env, 'getChatMember', { chat_id: chatId, user_id: who.id });
  if (!member.ok || !isAdminStatus(member.result)) {
    return tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'Это могут только админы чата.', show_alert: true });
  }
  let r = { ok: true }, done = '';
  if (act === 'ban') { r = await tg(env, 'banChatMember', { chat_id: chatId, user_id: id, revoke_messages: true }); done = '🚫 Забанен'; }
  if (act === 'unban') { r = await tg(env, 'unbanChatMember', { chat_id: chatId, user_id: id, only_if_banned: true }); done = '↩️ Разбанен'; }
  if (act === 'unbanc') { r = await tg(env, 'unbanChatSenderChat', { chat_id: chatId, sender_chat_id: id }); done = '↩️ Канал разбанен'; }
  if (act === 'trust') done = '✅ Отмечен как свой';
  if (r.ok && (act === 'unban' || act === 'trust')) {
    await run(env, 'INSERT INTO mod_users (chat_id, uid, first_ts, last_ts, ok) VALUES (?, ?, ?, ?, ?) ON CONFLICT(chat_id, uid) DO UPDATE SET ok = MAX(ok, excluded.ok), strikes = 0, strike_ts = 0',
      chatId, id, now(), now(), TRUST_AFTER);
  }
  await modLog(env, chatId, { id }, act + '_manual', 'кнопка в отчёте, нажал ' + (who.username ? '@' + who.username : who.id), '');
  await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: r.ok ? 'Готово' : 'Не получилось: ' + (r.description || ''), show_alert: !r.ok });
  if (r.ok && cq.message) {
    await tg(env, 'editMessageText', { chat_id: cq.message.chat.id, message_id: cq.message.message_id, text: (cq.message.text || '') + `\n\n${done} — ${who.first_name || ''}`.trimEnd(), link_preview_options: { is_disabled: true } });
  }
}

async function modStats(env, days) {
  await schema(env);
  const since = days > 0 ? now() - days * 86400 : 0;
  const q = (sql, ...b) => env.DB.prepare(sql).bind(...b);
  const [byAction, last] = await env.DB.batch([
    q('SELECT action, COUNT(*) AS n FROM mod_log WHERE ts >= ? GROUP BY action ORDER BY n DESC', since),
    q('SELECT ts, uid, username, name, action, reason, text FROM mod_log WHERE ts >= ? ORDER BY id DESC LIMIT 30', since),
  ]);
  return { days, by_action: byAction.results || [], last: last.results || [] };
}

// /antispam в личке: включить отчёты, показать сводку
async function antispamCmd(env, chatId, user, text) {
  const group = env.GROUP_ID || DEF_GROUP;
  const me = await tg(env, 'getChatMember', { chat_id: group, user_id: user.id });
  if (!me.ok || !isAdminStatus(me.result)) return tg(env, 'sendMessage', { chat_id: chatId, text: 'Эта команда — для администраторов чата Artur product.' });
  let to = await reportTo(env);
  if (/\boff\b|выкл/i.test(text)) {
    to = to.filter((x) => x !== chatId);
    await kvSet(env, 'mod_report_to', JSON.stringify(to));
    return tg(env, 'sendMessage', { chat_id: chatId, text: 'Отчёты антиспама выключены. Включить снова: /antispam' });
  }
  if (!to.includes(chatId)) { to.push(chatId); await kvSet(env, 'mod_report_to', JSON.stringify(to)); }
  const bot = await tg(env, 'getChatMember', { chat_id: group, user_id: botId(env) });
  const b = bot.ok ? bot.result : {};
  const rights = b.status === 'creator' || (b.status === 'administrator' && b.can_delete_messages && b.can_restrict_members);
  let s = { by_action: [] };
  if (env.DB) { try { s = await modStats(env, 7); } catch (e) {} }
  const n = (a) => (s.by_action.find((x) => x.action === a) || {}).n || 0;
  const lines = [
    '🛡 Антиспам включён. Отчёт о каждом удалении и бане будет приходить сюда, с кнопками «Разбанить» / «Забанить» / «Это не спам».',
    '',
    `За 7 дней: удалено сообщений — ${n('delete')}, забанено — ${n('ban') + n('ban_channel')}.`,
    rights ? '✅ Права бота в чате в порядке.' : '⚠️ Боту не хватает прав в чате: нужны «Удаление сообщений» и «Блокировка пользователей». Дайте их в настройках администраторов чата.',
    '',
    'Выключить отчёты: /antispam off',
  ];
  return tg(env, 'sendMessage', { chat_id: chatId, text: lines.join('\n') });
}

async function onUpdate(env, u, ctx) {
  // 1) копия поста канала в чате обсуждения — запоминаем номер треда для кнопки комментариев
  const gm = u.message;
  if (gm && gm.is_automatic_forward) {
    const fo = gm.forward_origin || {};
    const postId = fo.message_id || gm.forward_from_message_id;
    if (postId && env.DB) {
      try {
        await schema(env);
        await env.DB.prepare('INSERT INTO threads (post_id, thread_id, ts) VALUES (?, ?, ?) ON CONFLICT(post_id) DO UPDATE SET thread_id = excluded.thread_id, ts = excluded.ts')
          .bind(postId, gm.message_id, now()).run();
      } catch (e) {}
    }
    return;
  }

  // 2) нажатия на кнопки
  const cq = u.callback_query;
  if (cq) {
    const chatId = cq.message && cq.message.chat && cq.message.chat.id;
    const [act, src, extra] = String(cq.data || '').split(':');
    if ((act === 'guide' || act === 'check') && chatId) return handleGuide(env, chatId, cq.from || {}, src || 'bot', cq.id);
    if (['ban', 'unban', 'unbanc', 'trust'].includes(act) && src && extra) return modCallback(env, cq, act, Number(src), Number(extra));
    return tg(env, 'answerCallbackQuery', { callback_query_id: cq.id });
  }

  // 3) антиспам в чате обсуждения (новые сообщения и правки)
  const any = u.message || u.edited_message;
  if (any && any.chat && (any.chat.type === 'supergroup' || any.chat.type === 'group')) {
    if (String(any.chat.id) === String(env.GROUP_ID || DEF_GROUP) && env.ANTISPAM !== 'off') await moderate(env, ctx, any, !u.message);
    return;
  }

  // 4) личные сообщения боту
  const m = u.message;
  if (!m || !m.chat || m.chat.type !== 'private') return;
  const user = m.from || {};
  const text = String(m.text || '').trim();
  if (/^\/antispam(@\w+)?(\s|$)/i.test(text)) return antispamCmd(env, m.chat.id, user, text);
  if (!env.GUIDE_URL) { // гайд ещё не подключён (нет GUIDE_URL) — просто приветствие без кнопки гайда
    if (text.startsWith('/start')) await log(env, user, 'start', text.split(/\s+/)[1] || '');
    return tg(env, 'sendMessage', { chat_id: m.chat.id, text: TXT.helloNoGuide, reply_markup: kbNoGuide });
  }
  if (text.startsWith('/start')) {
    const payload = text.split(/\s+/)[1] || '';
    if (payload.toLowerCase().startsWith('guide')) return handleGuide(env, m.chat.id, user, payload.slice(0, 40));
    await log(env, user, 'start', payload);
    return tg(env, 'sendMessage', { chat_id: m.chat.id, text: TXT.hello, reply_markup: kbStart });
  }
  if (/товар/i.test(text) || /гайд/i.test(text)) return handleGuide(env, m.chat.id, user, 'word');
  return tg(env, 'sendMessage', { chat_id: m.chat.id, text: TXT.help, reply_markup: kbStart });
}

async function stats(env, days) {
  await schema(env);
  const since = days > 0 ? now() - days * 86400 : 0;
  const q = (sql, ...b) => env.DB.prepare(sql).bind(...b);
  const [byType, bySrc, people] = await env.DB.batch([
    q('SELECT type, COUNT(*) AS n, COUNT(DISTINCT uid) AS people FROM bot_events WHERE ts >= ? GROUP BY type ORDER BY n DESC', since),
    q('SELECT src, COUNT(DISTINCT uid) AS people FROM bot_events WHERE ts >= ? AND type = \'guide_sent\' GROUP BY src ORDER BY people DESC', since),
    q('SELECT COUNT(DISTINCT uid) AS requested, (SELECT COUNT(DISTINCT uid) FROM bot_events WHERE ts >= ? AND type = \'guide_sent\') AS got, (SELECT COUNT(DISTINCT uid) FROM bot_events WHERE ts >= ? AND type = \'guide_nosub\') AS asked_to_subscribe FROM bot_events WHERE ts >= ? AND type IN (\'guide_request\', \'guide_check\')', since, since, since),
  ]);
  return { days, people: (people.results || [])[0] || {}, by_type: byType.results || [], sent_by_source: bySrc.results || [] };
}

// ключ, которым Telegram подписывает вебхук: WEBHOOK_SECRET, а если его нет — выводится из токена бота
async function hookSecret(env) {
  if (env.WEBHOOK_SECRET) return env.WEBHOOK_SECRET;
  if (!env.BOT_TOKEN) return '';
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('artur-bot-webhook:' + env.BOT_TOKEN));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, '') || '/';

    if (p === '/health' || p === '/') return json({ ok: true, service: 'artur-bot' });
    const secret = await hookSecret(env);

    if (p === '/tg/webhook' && req.method === 'POST') {
      if (!secret || req.headers.get('x-telegram-bot-api-secret-token') !== secret) return json({ ok: false }, 403);
      let u = {};
      try { u = await req.json(); } catch (e) { return json({ ok: true }); }
      try { await onUpdate(env, u, ctx); } catch (e) { console.log('update error', e && e.message); }
      return json({ ok: true }); // Telegram всегда получает 200, иначе будет повторять
    }

    const keyOk = !!env.WEBHOOK_SECRET && url.searchParams.get('key') === env.WEBHOOK_SECRET;

    if (p === '/tg/setup') {
      if (!secret) return json({ ok: false, error: 'BOT_TOKEN не задан' }, 500);
      const hook = `${url.origin}/tg/webhook`;
      const set = await tg(env, 'setWebhook', { url: hook, secret_token: secret, allowed_updates: ['message', 'edited_message', 'callback_query'], drop_pending_updates: false });
      const me = await tg(env, 'getMe', {});
      const member = me.ok ? await tg(env, 'getChatMember', { chat_id: env.CHANNEL || DEF_CHANNEL, user_id: me.result.id }) : {};
      const group = env.GROUP_ID || DEF_GROUP;
      const gm = me.ok ? await tg(env, 'getChatMember', { chat_id: group, user_id: me.result.id }) : {};
      const gr = gm.ok ? gm.result : {};
      await tg(env, 'setMyCommands', { commands: [{ command: 'start', description: 'Гайд и База товаров' }] });
      return json({
        ok: !!set.ok, webhook: hook, telegram: set.description || '',
        bot: me.ok ? '@' + me.result.username : null,
        bot_in_channel: member.ok ? member.result.status : (member.description || 'unknown'),
        guide_url: env.GUIDE_URL || 'НЕ ЗАДАН',
        antispam: env.ANTISPAM === 'off' ? 'выключен (ANTISPAM=off)' : 'включён',
        group,
        bot_in_group: gm.ok ? gr.status : (gm.description || 'unknown'),
        can_delete_messages: gr.status === 'creator' || !!gr.can_delete_messages,
        can_ban_users: gr.status === 'creator' || !!gr.can_restrict_members,
      });
    }

    if (p === '/tg/stats') {
      if (!keyOk) return json({ ok: false, error: 'wrong key' }, 403);
      if (!env.DB) return json({ ok: false, error: 'no DB binding' }, 500);
      const days = parseInt(url.searchParams.get('days') || '0', 10) || 0;
      return json({ ok: true, ...(await stats(env, days)) });
    }

    if (p === '/tg/mod') {
      if (!keyOk) return json({ ok: false, error: 'wrong key' }, 403);
      if (!env.DB) return json({ ok: false, error: 'no DB binding' }, 500);
      const days = parseInt(url.searchParams.get('days') || '7', 10) || 0;
      return json({ ok: true, ...(await modStats(env, days)) });
    }

    if (p === '/tg/thread') {
      const post = parseInt(url.searchParams.get('post') || '0', 10);
      if (!post || !env.DB) return json({ ok: false }, 400);
      await schema(env);
      const r = await env.DB.prepare('SELECT thread_id FROM threads WHERE post_id = ?').bind(post).first();
      return json({ ok: true, thread: r ? r.thread_id : null });
    }

    return json({ ok: false, error: 'not found' }, 404);
  },
};
