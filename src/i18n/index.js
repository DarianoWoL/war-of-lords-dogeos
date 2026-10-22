// Tlumaczenie komunikatow serwera wg jezyka gracza (ciasteczko wol_lang ustawiane przez public/i18n.js).
// Dziala w jednym miejscu: odpowiedzi API (pola error/message) i zdarzenia socket.io z bledami.
// Bez ciasteczka zostaje polski - dokladnie tak jak przed wprowadzeniem tlumaczen.
const entries = require('./serverMessages');

const DEFAULT_LANG = 'pl';
const LANGS = ['pl', 'en'];

const exact = new Map();
const templates = [];
for (const [raw, en, pl] of entries) {
  if (/\{\d\}/.test(raw)) {
    // {0}, {1}... = zmienna czesc (liczba, czas, nazwa) - dopasowujemy wyrazeniem regularnym.
    const source = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{(\d)\\\}/g, '(.+?)');
    templates.push({ re: new RegExp(`^${source}$`), en, pl });
  } else {
    exact.set(raw, { en, pl });
  }
}

function translate(text, lang) {
  if (typeof text !== 'string' || !LANGS.includes(lang)) return text;
  const hit = exact.get(text);
  if (hit) return hit[lang];
  for (const t of templates) {
    const m = text.match(t.re);
    if (m) return t[lang].replace(/\{(\d)\}/g, (_, i) => m[Number(i) + 1] ?? '');
  }
  return text;
}

function langFromCookie(cookieHeader) {
  const m = /(?:^|;\s*)wol_lang=(en|pl)\b/.exec(cookieHeader || '');
  return m ? m[1] : DEFAULT_LANG;
}

// Odpowiedzi JSON: tlumaczy pola error i message (inne pola, np. kody w "reason", zostaja bez zmian).
function translateBody(body, lang) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  let out = body;
  for (const key of ['error', 'message']) {
    if (typeof body[key] === 'string') {
      const translated = translate(body[key], lang);
      if (translated !== body[key]) {
        if (out === body) out = { ...body };
        out[key] = translated;
      }
    }
  }
  return out;
}

function expressMiddleware(req, res, next) {
  req.lang = langFromCookie(req.headers.cookie);
  const json = res.json.bind(res);
  res.json = (body) => json(translateBody(body, req.lang));
  next();
}

// Socket.io: bledy wysylane konkretnemu graczowi (socket.emit('error' | 'game:error', ...)).
function attachToSocket(socket) {
  const lang = langFromCookie(socket.handshake && socket.handshake.headers && socket.handshake.headers.cookie);
  socket.lang = lang;
  const emit = socket.emit.bind(socket);
  socket.emit = (event, ...args) => {
    if (args.length && /error/i.test(event)) {
      if (typeof args[0] === 'string') args[0] = translate(args[0], lang);
      else args[0] = translateBody(args[0], lang);
    }
    return emit(event, ...args);
  };
  // Odpowiedzi na komendy (callback "ack", np. game:recruitUnit -> { ok: false, error: '...' }).
  const on = socket.on.bind(socket);
  socket.on = (event, handler) => on(event, (...args) => {
    const last = args.length - 1;
    if (last >= 0 && typeof args[last] === 'function') {
      const ack = args[last];
      args[last] = (body, ...rest) => ack(translateBody(body, lang), ...rest);
    }
    return handler(...args);
  });
}

module.exports = { translate, langFromCookie, expressMiddleware, attachToSocket, LANGS, DEFAULT_LANG };
