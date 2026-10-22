// Dostep tylko z linku: gdy ustawione jest INVITE_TOKEN, serwis odpowiada tylko osobom, ktore weszly z linkiem zawierajacym
// ?invite=<token> (zapisujemy ciasteczko na 30 dni). Reszta dostaje komunikat "Invite only". Wersja demo dla jury i organizatorow.
const crypto = require('crypto');

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function inviteGate(token) {
  if (!token) return (req, res, next) => next();
  return (req, res, next) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    if (req.path === '/robots.txt') return res.type('text/plain').send('User-agent: *\nDisallow: /\n');
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    if (req.query && typeof req.query.invite === 'string' && safeEqual(req.query.invite, token)) {
      res.setHeader('Set-Cookie', `wol_invite=${encodeURIComponent(token)}; Path=/; Max-Age=${30 * 24 * 3600}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
      const url = new URL(req.originalUrl, 'http://x');
      url.searchParams.delete('invite');
      return res.redirect(302, url.pathname + (url.search || ''));
    }
    const cookie = parseCookies(req.headers.cookie).wol_invite;
    if (cookie && safeEqual(cookie, token)) return next();
    if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Invite only.' });
    res.status(403).type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Invite only</title><body style="margin:0;background:#0b1020;color:#e2e8f0;font-family:Segoe UI,system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center;padding:20px"><div><h1 style="color:#e8c766;margin:0 0 8px">War of Lords</h1><p style="color:#94a3b8;margin:0">This demo is invite only. Please open the link you received from the organizer.</p></div></body>');
  };
}

module.exports = inviteGate;
