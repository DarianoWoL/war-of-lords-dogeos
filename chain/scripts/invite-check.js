// Dostep tylko z linku: bez klucza 403, z kluczem ciasteczko i dostep, robots.txt blokuje indeksowanie.
const BASE = 'http://127.0.0.1:3101', TOKEN = process.env.INVITE_TOKEN || 'test-invite-key';
let failed = 0;
const ok = (c, m) => { console.log(c ? '  OK  ' : ' FAIL ', m); if (!c) failed++; };
(async () => {
  let r = await fetch(BASE + '/index.html');
  ok(r.status === 403 && /Invite only/.test(await r.text()), 'no key: the page answers "Invite only" (403)');
  r = await fetch(BASE + '/api/chain/config');
  ok(r.status === 403, 'no key: the API is closed too');
  r = await fetch(BASE + '/index.html?invite=wrong');
  ok(r.status === 403, 'wrong key: still closed');
  r = await fetch(BASE + '/login.html?invite=' + TOKEN, { redirect: 'manual' });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  ok(r.status === 302 && /wol_invite=/.test(cookie) && r.headers.get('location') === '/login.html', 'right key: cookie is set and the key disappears from the address');
  r = await fetch(BASE + '/login.html', { headers: { cookie } });
  ok(r.status === 200, 'with the cookie: the page opens');
  r = await fetch(BASE + '/api/chain/config', { headers: { cookie } });
  ok(r.status === 200, 'with the cookie: the API works');
  r = await fetch(BASE + '/robots.txt');
  ok(/Disallow: \//.test(await r.text()), 'robots.txt disallows indexing');
  console.log(failed ? `\n${failed} FAILED` : '\nINVITE CHECK PASSED');
  process.exit(failed ? 1 : 0);
})();
