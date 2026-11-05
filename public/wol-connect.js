// Wspolna obsluga "Connect wallet" dla stron gry (login.html, dogeos.html).
// Z DOGEOS_CLIENT_ID serwer wlacza okno DogeOS Connect Kit (logowanie przez X / e-mail / portfel DogeOS).
// Bez niego dziala portfel przegladarkowy (EIP-6963 / window.ethereum).
(function () {
  var cfg = null, sdkPromise = null, injected = [];

  function api(method, path, body, token) {
    return fetch(path, { method: method, headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}), body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); });
  }

  function config() {
    if (cfg) return Promise.resolve(cfg);
    return api('GET', '/api/chain/config').then(function (c) { cfg = c; return c; });
  }

  function discover() {
    window.addEventListener('eip6963:announceProvider', function (ev) {
      if (!injected.some(function (d) { return d.info.uuid === ev.detail.info.uuid; })) injected.push(ev.detail);
    });
    window.dispatchEvent(new Event('eip6963:requestProvider'));
  }
  discover();

  function injectedProvider() {
    if (injected.length) return injected[0].provider;
    return window.ethereum || null;
  }

  function loadSdk() {
    if (sdkPromise) return sdkPromise;
    sdkPromise = config().then(function (c) {
      if (!c.clientId) return false;
      return new Promise(function (resolve) {
        var link = document.createElement('link');
        link.rel = 'stylesheet'; link.href = '/vendor/dogeos-connect.css';
        document.head.appendChild(link);
        var s = document.createElement('script');
        s.src = '/vendor/dogeos-connect.js';
        s.onload = function () { try { keepWalletIframeOutOfBody(c.clientId); window.WolWallet.init({ clientId: c.clientId }); hardenWalletIframe(); resolve(true); } catch (e) { console.error(e); resolve(false); } };
        s.onerror = function () { resolve(false); };
        document.head.appendChild(s);
      });
    });
    return sdkPromise;
  }

  // Strony gry skaluja cala strone przez body { transform: scale(...) } (page-scale.js). Element position:fixed wewnatrz takiego
  // body jest liczony wzgledem body, a nie okna - okno portfela (ramka na cala strone) wyskakiwalo wiec "w dol", z bialymi brzegami,
  // i trzeba bylo przewijac. Dlatego ramke portfela (id = client ID) wstawiamy bezposrednio do <html>.
  function keepWalletIframeOutOfBody(clientId) {
    if (document.__wolBodyPatched) return;
    document.__wolBodyPatched = true;
    var original = document.body.appendChild.bind(document.body);
    document.body.appendChild = function (node) {
      if (node && ((node.tagName === 'IFRAME' && node.id === clientId) || node.id === 'wol-wallet-root')) return document.documentElement.appendChild(node);
      return original(node);
    };
    // Safety net (other insertion methods, e.g. on phones where the page is scaled down to ~20%): whenever the
    // wallet UI root shows up inside <body>, move it to <html> so it keeps its real size.
    function moveRoot() {
      var r = document.getElementById('wol-wallet-root');
      if (r && r.parentNode === document.body) document.documentElement.appendChild(r);
    }
    new MutationObserver(moveRoot).observe(document.body, { childList: true });
    moveRoot();
    var st = document.createElement('style');
    st.textContent = '#wol-wallet-root{position:relative;z-index:2147483000}';
    document.head.appendChild(st);
  }

  // Okno portfela DogeOS to ramka (iframe) na calej stronie. Pilnujemy, zeby zawsze lezala NAD naszymi okienkami,
  // i zamykamy ja sami, gdy gra potwierdzi wynik (portfel bywa, ze po zatwierdzeniu zostaje bialy z kolkiem).
  function findWalletIframe() { return document.querySelector('iframe[allow*="publickey-credentials"]'); }
  function enforceWalletZ(f) {
    if (f.__wolHard) return;
    f.__wolHard = true;
    new MutationObserver(function () {
      var w = f.style.width;
      if (w && w !== '0px' && w !== '0' && f.style.zIndex !== '2147483000') f.style.zIndex = '2147483000';
    }).observe(f, { attributes: true, attributeFilter: ['style'] });
  }
  function hardenWalletIframe() {
    var f = findWalletIframe();
    if (f) enforceWalletZ(f);
    new MutationObserver(function () { var g = findWalletIframe(); if (g) enforceWalletZ(g); }).observe(document.documentElement, { childList: true, subtree: true });
  }
  function closeWalletPopup() {
    var f = findWalletIframe();
    if (f) { f.style.width = '0'; f.style.height = '0'; }
  }
  function errorText(e, fallback) {
    var t = fallback;
    if (e) {
      if (typeof e === 'string') t = e;
      else if (e.shortMessage || e.message) t = e.shortMessage || e.message;
      else { try { t = JSON.stringify(e).slice(0, 160); } catch (x) { /* keep fallback */ } }
    }
    // Wolna siec testowa (timeout przy pytaniu o nonce / wezel RPC) - to nie jest blad gracza.
    if (/timeout|took too long|failed to get nonce|failed to fetch|network error|\b50[234]\b/i.test(String(t))) {
      return 'The DogeOS testnet is responding slowly right now. Please wait a moment and try again. (If a payment already went through, it still counts - check your balance first.)';
    }
    // Poprzednie zapytanie do portfela wciaz wisi (np. nieukonczone okno zatwierdzenia).
    if (/another|pending|already.*(request|open)/i.test(String(t)) && /wallet|request|pending/i.test(String(t))) {
      return 'Your wallet still has an earlier request open. Refresh the page (Ctrl+F5) and try again. (' + String(t).slice(0, 80) + ')';
    }
    return t;
  }

  // Slad krokow (do pokazania w oknie przy bledzie i do konsoli) - pomaga ustalic, na ktorym etapie cos sie zawiesilo.
  var traceLog = [];
  function trace(msg) {
    traceLog.push(new Date().toLocaleTimeString() + ' ' + msg);
    if (traceLog.length > 30) traceLog.shift();
    try { console.log('[WolConnect]', msg); } catch (e) { /* ignore */ }
  }
  window.__wolTrace = traceLog;

  // Portfel z DogeOS Connect Kit wymaga najpierw "polaczenia" z ta strona (eth_requestAccounts), inaczej pierwsze
  // zapytanie o transakcje konczy sie tylko oknem "polacz" i nigdy nie dochodzi do zatwierdzenia przelewu.
  function prepareSdkProvider(w, ui) {
    if (w.kind !== 'dogeos-sdk') return Promise.resolve();
    function waitProvider(tries) {
      var p = w.provider();
      if (p) return Promise.resolve(p);
      if (tries <= 0) return Promise.reject(new Error('The wallet is not ready yet. Refresh the page and try again.'));
      return new Promise(function (r) { setTimeout(r, 500); }).then(function () { return waitProvider(tries - 1); });
    }
    return waitProvider(20).then(function (p) {
      trace('provider ready, checking accounts');
      return Promise.resolve(p.request({ method: 'eth_accounts' })).catch(function () { return []; }).then(function (accts) {
        if (accts && accts.length) { trace('already connected: ' + accts[0]); return; }
        ui.step('Approve the connection in your wallet window…', true);
        trace('requesting accounts (connect popup)');
        return Promise.resolve(p.request({ method: 'eth_requestAccounts' })).then(function (a) { trace('accounts granted: ' + (a && a[0])); });
      });
    });
  }

  // Zwraca { address, signMessage(msg), provider (EIP-1193), kind }
  function connect() {
    return loadSdk().then(function (hasSdk) {
      if (hasSdk) return connectSdk();
      return connectInjected();
    });
  }

  function connectSdk() {
    return new Promise(function (resolve, reject) {
      var W = window.WolWallet, done = false;
      function finish(st) {
        if (done) return; done = true; unsub && unsub();
        resolve({
          kind: 'dogeos-sdk', address: st.address,
          signMessage: function (m) { return W.signMessage(m); },
          provider: function () { return W.provider(); },
          disconnect: function () { return W.disconnect(); }
        });
      }
      var unsub = null;
      unsub = W.subscribe(function (st) { if (st.isConnected && st.address) finish(st); });
      if (!done) W.open();
    });
  }

  function connectInjected() {
    var eth = injectedProvider();
    if (!eth) return Promise.reject(new Error('No wallet found. Install your DogeOS wallet (MyDoge or an EVM wallet) and reload the page.'));
    return eth.request({ method: 'eth_requestAccounts' }).then(function (accounts) {
      var address = accounts[0];
      return {
        kind: 'injected', address: address,
        signMessage: function (m) {
          var hex = '0x' + Array.from(new TextEncoder().encode(m)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
          return eth.request({ method: 'personal_sign', params: [hex, address] });
        },
        provider: function () { return eth; },
        disconnect: function () { return Promise.resolve(); }
      };
    });
  }

  // Logowanie portfelem: podpis wyzwania serwera -> token gry (konto powstaje przy pierwszym wejsciu).
  function loginWithWallet() {
    return connect().then(function (w) {
      return api('POST', '/api/chain/auth/challenge', { address: w.address }).then(function (ch) {
        return w.signMessage(ch.message).then(function (signature) {
          return api('POST', '/api/chain/auth/login', { address: w.address, signature: signature });
        });
      }).then(function (res) {
        try {
          localStorage.setItem('token', res.token);
          localStorage.setItem('authToken', res.token);
          localStorage.setItem('username', res.username);
          localStorage.setItem('wolWalletConnected', '1');
        } catch (e) { /* ignore */ }
        return res;
      });
    });
  }

  // Okno "wpisz nazwe gracza" (nie da sie go zamknac, dopoki gracz nie wybierze nazwy).
  function promptUsername() {
    return new Promise(function (resolve) {
      var token = localStorage.getItem('authToken') || localStorage.getItem('token');
      var wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(5,8,18,.88);display:flex;align-items:center;justify-content:center;padding:16px;font-family:Segoe UI,system-ui,sans-serif';
      wrap.innerHTML = '<div style="background:#0f172a;border:1px solid rgba(212,175,55,.55);border-radius:12px;padding:26px;max-width:380px;width:100%;color:#f8fafc;text-align:center;box-shadow:0 12px 40px rgba(0,0,0,.6)">' +
        '<h2 style="margin:0 0 8px;color:#e8c766;font-size:22px">Choose your player name</h2>' +
        '<p style="margin:0 0 14px;color:#94a3b8;font-size:14px">This is the name other players will see. 3-16 characters.</p>' +
        '<input id="wolNameInput" type="text" maxlength="16" autocomplete="off" placeholder="Player name" style="width:100%;box-sizing:border-box;padding:12px;font-size:17px;border-radius:8px;border:1px solid #334155;background:#0b1220;color:#f8fafc;text-align:center">' +
        '<div id="wolNameErr" style="min-height:20px;margin:8px 0;color:#f87171;font-size:14px"></div>' +
        '<button id="wolNameBtn" type="button" style="width:100%;padding:13px;font-size:17px;font-weight:800;border:0;border-radius:8px;background:linear-gradient(#e8c766,#b8932f);color:#1a1405;cursor:pointer">Save name</button></div>';
      document.documentElement.appendChild(wrap);
      var input = wrap.querySelector('#wolNameInput'), err = wrap.querySelector('#wolNameErr'), btn = wrap.querySelector('#wolNameBtn');
      input.focus();
      function submit() {
        btn.disabled = true; err.textContent = '';
        api('POST', '/api/chain/profile/username', { username: input.value }, token).then(function (r) {
          try { localStorage.setItem('username', r.username); } catch (e) { /* ignore */ }
          wrap.remove(); resolve(r.username);
        }).catch(function (e) { btn.disabled = false; err.textContent = e.message; });
      }
      btn.addEventListener('click', submit);
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
    });
  }

  // Na stronach gry: jesli konto z portfela nie ma jeszcze wlasnej nazwy - zapytaj.
  function ensureUsername() {
    var token = localStorage.getItem('authToken') || localStorage.getItem('token');
    if (!token) return Promise.resolve();
    return api('GET', '/api/chain/me', null, token).then(function (me) { return me.needsUsername ? promptUsername() : null; }).catch(function () { return null; });
  }

  // ---------------------------------------------------------------- kupno biletu jednym klikniecie
  var ethersPromise = null;
  function loadEthers() {
    if (window.ethers) return Promise.resolve();
    if (ethersPromise) return ethersPromise;
    ethersPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = '/vendor/ethers.umd.min.js';
      s.onload = resolve; s.onerror = function () { reject(new Error('Could not load the wallet library.')); };
      document.head.appendChild(s);
    });
    return ethersPromise;
  }

  function progress(title) {
    if (!document.getElementById('wolSpinStyle')) {
      var st = document.createElement('style'); st.id = 'wolSpinStyle';
      st.textContent = '@keyframes wolspin{to{transform:rotate(360deg)}}';
      document.head.appendChild(st);
    }
    var wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:99998;background:rgba(5,8,18,.85);display:flex;align-items:center;justify-content:center;padding:16px;font-family:Segoe UI,system-ui,sans-serif';
    wrap.innerHTML = '<div style="background:#0f172a;border:1px solid rgba(212,175,55,.55);border-radius:12px;padding:26px;max-width:400px;width:100%;color:#f8fafc;text-align:center;box-shadow:0 12px 40px rgba(0,0,0,.6)">' +
      '<h2 style="margin:0 0 14px;color:#e8c766;font-size:21px"></h2>' +
      '<div class="wolSpin" style="width:34px;height:34px;margin:0 auto 14px;border:4px solid #334155;border-top-color:#e8c766;border-radius:50%;animation:wolspin 1s linear infinite"></div>' +
      '<div class="wolMsg" style="min-height:42px;font-size:15px;color:#cbd5e1;white-space:pre-wrap;word-break:break-word"></div>' +
      '<button type="button" class="wolBtn" style="margin-top:16px;padding:11px 22px;font-size:15px;font-weight:700;border-radius:8px;border:1px solid #475569;background:#1e293b;color:#e2e8f0;cursor:pointer">Cancel</button></div>';
    document.documentElement.appendChild(wrap);
    wrap.querySelector('h2').textContent = title;
    var msg = wrap.querySelector('.wolMsg'), spin = wrap.querySelector('.wolSpin'), btn = wrap.querySelector('.wolBtn');
    var cancelled = false, onCancel = null;
    var card = wrap.firstChild;
    btn.addEventListener('click', function () { cancelled = true; wrap.remove(); if (onCancel) onCancel(); });
    function setPassive(on) {
      // Gdy trzeba kliknac cos w oknie portfela (logowanie, podpis, potwierdzenie), nasza nakladka nie moze go zaslaniac:
      // chowamy tlo i przenosimy male okienko w prawy dolny rog (klikniecia przechodza "przez" nakladke).
      wrap.style.background = on ? 'transparent' : 'rgba(5,8,18,.85)';
      wrap.style.pointerEvents = on ? 'none' : 'auto';
      wrap.style.alignItems = on ? 'flex-end' : 'center';
      wrap.style.justifyContent = on ? 'flex-end' : 'center';
      card.style.maxWidth = on ? '300px' : '400px';
      card.style.padding = on ? '14px' : '26px';
      card.style.pointerEvents = 'auto';
      spin.style.display = 'block';
    }
    return {
      step: function (t, passive) { setPassive(!!passive); msg.textContent = t; },
      error: function (t) { setPassive(false); spin.style.display = 'none'; msg.style.color = '#f87171'; msg.textContent = t; btn.textContent = 'Close'; },
      success: function (t, label, fn, link) {
        setPassive(false); spin.style.display = 'none'; msg.style.color = '#34d399'; msg.textContent = t;
        if (link && link.href) {
          var a = document.createElement('a');
          a.href = link.href; a.target = '_blank'; a.rel = 'noopener';
          a.textContent = link.text;
          a.style.cssText = 'display:block;margin-top:10px;color:#e8c766;font-size:14px;font-weight:700;text-decoration:underline';
          msg.appendChild(a);
        }
        btn.textContent = label || 'Close'; btn.style.background = 'linear-gradient(#e8c766,#b8932f)'; btn.style.color = '#1a1405'; btn.style.border = '0';
        btn.onclick = function () { wrap.remove(); if (fn) fn(); };
      },
      close: function () { wrap.remove(); },
      get cancelled() { return cancelled; },
      race: function (promise) { return Promise.race([promise, new Promise(function (_, rej) { onCancel = function () { rej(new Error('Cancelled.')); }; })]); }
    };
  }

  // Odpytuje serwer co 2 s, az warunek bedzie spelniony (max ok. 90 s).
  function pollUntil(ui, token, cond, timeoutMessage) {
    return new Promise(function (resolve, reject) {
      var tries = 0;
      (function poll() {
        if (ui.cancelled) return reject(new Error('Cancelled.'));
        if (++tries > 45) return reject(new Error(timeoutMessage));
        setTimeout(function () {
          api('GET', '/api/chain/me', null, token).then(function (m) { if (cond(m)) resolve(); else poll(); }).catch(poll);
        }, 2000);
      })();
    });
  }

  // Czeka na efekt wyslanej transakcji. Serwer sprawdza stan gry (bilet / nagroda), a gdy portfel zwroci hash,
  // dodatkowo pytamy siec o jego los - zeby przy problemie pokazac prawdziwy powod zamiast kreconego kolka.
  var lastTxHash = null;
  function explorerLink(address) {
    var base = (cfg && cfg.network && cfg.network.explorer) || 'https://blockscout.testnet.dogeos.com';
    if (lastTxHash) return { href: base + '/tx/' + lastTxHash, text: 'View the transaction on the DogeOS explorer \u2197' };
    if (address) return { href: base + '/address/' + address, text: 'View your wallet on the DogeOS explorer \u2197' };
    return null;
  }
  function watchSend(ui, token, send, cond, sentText, timeoutText, endpoint, resolveOnReceipt) {
    var walletAnswer = null, hash = null;
    lastTxHash = null;
    var tx = Promise.resolve(send).then(function (res) {
      walletAnswer = res;
      var h = typeof res === 'string' ? res : (res && (res.hash || res.txHash || res.transactionHash)) || null;
      if (h && /^0x[0-9a-fA-F]{64}$/.test(h)) { hash = h; lastTxHash = h; }
      ui.step(sentText + (hash ? ' (' + hash.slice(0, 10) + '…)' : ''));
      return new Promise(function () {}); // sukces rozstrzyga pytanie o stan na serwerze
    });
    var watch = new Promise(function (resolve, reject) {
      var tries = 0;
      (function poll() {
        if (ui.cancelled) return reject(new Error('Cancelled.'));
        if (++tries > 60) {
          var why = hash ? ' Transaction ' + hash + ' was not seen by the network.'
            : (walletAnswer !== null ? ' The wallet answered: ' + JSON.stringify(walletAnswer).slice(0, 80) + ' (no transaction hash).' : '');
          return reject(new Error(timeoutText + why));
        }
        setTimeout(function () {
          var checks = [api('GET', endpoint || '/api/chain/me', null, token).then(cond)];
          if (hash) checks.push(api('GET', '/api/chain/tx/' + hash, null, token).then(function (t) { if (t.found && t.status === 'failed') throw new Error('The transaction was mined but failed on-chain (' + hash.slice(0, 12) + '…). Nothing was paid.'); return !!(resolveOnReceipt && t.found && t.status === 'success'); }));
          Promise.all(checks.map(function (c) { return c.catch(function (e) { if (e && /failed on-chain/.test(e.message)) throw e; return false; }); }))
            .then(function (r) { if (r[0] || r[1]) resolve(); else poll(); }, reject);
        }, 2500);
      })();
    });
    return Promise.race([tx, watch]);
  }

  var TICKET_ABI = ['function buyTicket(uint8 kind, uint256 price, uint256 nonce, uint256 deadline, bytes sig)'];
  var shortAddr = function (a) { return a ? a.slice(0, 6) + '…' + a.slice(-4) : ''; };

  // Kupno biletu w jednym kliknieciu: polaczenie portfela, (jednorazowe) powiazanie z kontem, platnosc, czekanie na bilet.
  // kind: 'mini' | 'monthly'. Zwraca Promise<boolean> (true = bilet przyznany).
  function buyTicket(kind) {
    var token = localStorage.getItem('authToken') || localStorage.getItem('token');
    if (!token) { window.location.href = '/login.html'; return Promise.resolve(false); }
    var ui = progress(kind === 'mini' ? 'Mini-Tournament ticket' : 'Monthly Tournament ticket');
    var wallet, me, chainCfg;
    ui.step('Preparing…');
    return ui.race(Promise.all([config(), loadEthers()]).then(function (r) {
      chainCfg = r[0];
      ui.step('Connecting your wallet…', true);
      return ui.race(connect());
    }).then(function (w) {
      wallet = w;
      trace('wallet connected: ' + w.address + ' (' + w.kind + ')');
      ui.step('Checking your account…');
      return Promise.all([api('GET', '/api/chain/me', null, token), ui.race(prepareSdkProvider(w, ui))]).then(function (r) { return r[0]; });
    }).then(function (m) {
      me = m;
      if (me.walletAddress && me.walletAddress.toLowerCase() !== wallet.address.toLowerCase()) {
        throw new Error('This game account is linked to wallet ' + shortAddr(me.walletAddress) + ', but ' + shortAddr(wallet.address) + ' is connected. Connect the linked wallet.');
      }
      if (me.walletAddress) return null;
      ui.step('Linking your wallet to the game account… sign the message.', true);
      return api('POST', '/api/chain/wallet/challenge', { address: wallet.address }, token).then(function (ch) {
        return wallet.signMessage(ch.message).then(function (signature) { return api('POST', '/api/chain/wallet/link', { signature: signature }, token); });
      });
    }).then(function () {
      ui.step('Getting your ticket offer…');
      return api('POST', '/api/chain/tickets/voucher', { kind: kind }, token);
    }).then(function (v) {
      ui.step('Confirm the payment of ' + (+v.priceDoge).toLocaleString('en-US', { maximumFractionDigits: 4 }) + ' DOGE in your wallet…', true);
      var iface = new ethers.Interface(TICKET_ABI);
      var data = iface.encodeFunctionData('buyTicket', [v.kind, v.price, v.nonce, v.deadline, v.sig]);
      var before = kind === 'mini' ? (me.hasMiniTicket ? 1 : 0) : (me.tournamentTickets || 0);
      // Portfel czasem nie zwraca nic po zatwierdzeniu - dlatego rownolegle sprawdzamy serwer (bilet pojawia sie sam po wplacie).
      trace('sending buyTicket'); var send = Promise.resolve(wallet.provider().request({ method: 'eth_sendTransaction', params: [{ from: wallet.address, to: chainCfg.contract, data: data, value: '0x' + BigInt(v.price).toString(16) }] }));
      return ui.race(watchSend(ui, token, send, function (m) { return (kind === 'mini' ? (m.hasMiniTicket ? 1 : 0) : (m.tournamentTickets || 0)) > before; }, 'Payment sent. Waiting for the network to confirm…', 'The payment was not confirmed in time.'));
    }).then(function () {
      return new Promise(function (resolve) { closeWalletPopup(); ui.success('Ticket ready! Good luck.', 'Continue', function () { resolve(true); }, explorerLink(wallet && wallet.address)); });
    })).catch(function (e) {
      if (!ui.cancelled) {
        var text = errorText(e, 'Something went wrong.');
        if (e && (e.code === 4001 || /user (rejected|denied|cancel)/i.test(text))) text = 'You cancelled the payment.';
        trace('error: ' + text);
        ui.error(text + '\n\nDetails: ' + traceLog.slice(-4).join(' | '));
      }
      return false;
    });
  }

  // Gdy serwer odmawia wejscia, bo gracz ma jeszcze aktywna rozgrywke: okno z wyborem
  // "Return to battle" / "Leave the game" (po opuszczeniu zwraca true i mozna ponowic wejscie).
  function isActiveGameError(message) { return /w trakcie innej rozgrywki|already in (a|another) (game|round)/i.test(String(message || '')); }

  function handleActiveGame() {
    var token = localStorage.getItem('authToken') || localStorage.getItem('token');
    var headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
    return fetch('/api/game/state', { headers: headers }).then(function (r) { return r.ok ? r.json() : null; }).then(function (data) {
      var roundId = data && data.state && data.state.status !== 'finished' ? data.state.roundId : null;
      return new Promise(function (resolve) {
        var wrap = document.createElement('div');
        wrap.style.cssText = 'position:fixed;inset:0;z-index:99998;background:rgba(5,8,18,.85);display:flex;align-items:center;justify-content:center;padding:16px;font-family:Segoe UI,system-ui,sans-serif';
        wrap.innerHTML = '<div style="background:#0f172a;border:1px solid rgba(212,175,55,.55);border-radius:12px;padding:26px;max-width:400px;width:100%;color:#f8fafc;text-align:center;box-shadow:0 12px 40px rgba(0,0,0,.6)">' +
          '<h2 style="margin:0 0 10px;color:#e8c766;font-size:21px">You have a game in progress</h2>' +
          '<p style="margin:0 0 18px;color:#cbd5e1;font-size:15px;line-height:1.45">You can be in one game at a time. Go back to it, or leave it to join a new one.</p>' +
          '<button type="button" class="wolBack" style="width:100%;margin-bottom:10px;padding:12px;font-size:16px;font-weight:800;border:0;border-radius:8px;background:linear-gradient(#e8c766,#b8932f);color:#1a1405;cursor:pointer">Return to battle</button>' +
          '<button type="button" class="wolLeave" style="width:100%;margin-bottom:10px;padding:12px;font-size:16px;font-weight:700;border-radius:8px;border:1px solid #7f1d1d;background:#3b1212;color:#fecaca;cursor:pointer">Leave the game and continue</button>' +
          '<button type="button" class="wolNo" style="width:100%;padding:9px;font-size:14px;border-radius:8px;border:1px solid #475569;background:transparent;color:#94a3b8;cursor:pointer">Cancel</button>' +
          '<div class="wolErr" style="min-height:18px;margin-top:8px;color:#f87171;font-size:13px"></div></div>';
        document.documentElement.appendChild(wrap);
        var leave = wrap.querySelector('.wolLeave'), back = wrap.querySelector('.wolBack'), err = wrap.querySelector('.wolErr');
        if (!roundId) back.style.display = 'none';
        back.onclick = function () { window.location.href = '/game.html?roundId=' + roundId; };
        wrap.querySelector('.wolNo').onclick = function () { wrap.remove(); resolve(false); };
        leave.onclick = function () {
          leave.disabled = true; err.textContent = '';
          if (!roundId) { wrap.remove(); return resolve(true); }
          fetch('/api/rounds/' + roundId + '/forfeit', { method: 'POST', headers: headers }).then(function (r) {
            return r.json().catch(function () { return {}; }).then(function (j) {
              if (!r.ok) { leave.disabled = false; err.textContent = j.error || 'Could not leave the game.'; return; }
              wrap.remove(); resolve(true);
            });
          }).catch(function (e) { leave.disabled = false; err.textContent = e.message; });
        };
      });
    });
  }

  // ---------------------------------------------------------------- wplata DOGE z portfela (panel admina): do puli nagrod albo na konto serwera (gaz)
  var FUND_ABI = ['function fund() payable'];

  function simplePay(title, amountDoge, buildTx, field, successText) {
    var token = localStorage.getItem('authToken') || localStorage.getItem('token');
    var amount = Number(String(amountDoge).replace(',', '.'));
    if (!(amount > 0)) return Promise.resolve(false);
    var ui = progress(title);
    var wallet, chainCfg, stats0;
    ui.step('Preparing…');
    return ui.race(Promise.all([config(), loadEthers(), api('GET', '/api/chain/stats')]).then(function (r) {
      chainCfg = r[0]; stats0 = r[2];
      ui.step('Connecting your wallet…', true);
      return ui.race(connect());
    }).then(function (w) {
      wallet = w;
      return ui.race(prepareSdkProvider(w, ui));
    }).then(function () {
      var value = ethers.parseEther(String(amount));
      var tx = buildTx(chainCfg, stats0, value);
      ui.step('Confirm sending ' + amount + ' DOGE in your wallet…', true);
      var send = Promise.resolve(wallet.provider().request({ method: 'eth_sendTransaction', params: [{ from: wallet.address, to: tx.to, data: tx.data || '0x', value: '0x' + value.toString(16) }] }));
      var before = Number(stats0[field]);
      return ui.race(watchSend(ui, token, send, function (d) { return Number(d[field]) >= before + amount - 0.001; }, 'Sent. Waiting for the network to confirm…', 'The transfer was not confirmed in time.', '/api/chain/stats', true));
    }).then(function () {
      return new Promise(function (resolve) { closeWalletPopup(); ui.success(successText, 'Done', function () { resolve(true); }, explorerLink(wallet && wallet.address)); });
    })).catch(function (e) {
      if (!ui.cancelled) {
        var text = errorText(e, 'Something went wrong.');
        if (e && (e.code === 4001 || /user (rejected|denied|cancel)/i.test(text))) text = 'You cancelled the transfer.';
        trace('error: ' + text);
        ui.error(text + '\n\nDetails: ' + traceLog.slice(-4).join(' | '));
      }
      return false;
    });
  }
  function fundPool(amount) {
    return simplePay('Deposit to the prize pool', amount, function (cfg) { return { to: cfg.contract, data: new ethers.Interface(FUND_ABI).encodeFunctionData('fund', []) }; }, 'prizePool', 'The prize pool has been topped up.');
  }
  function topUpServer(amount) {
    return simplePay('Top up the server account (gas)', amount, function (cfg, st) { return { to: st.oracle, data: '0x' }; }, 'oracleBalance', 'The server account has been topped up.');
  }

  // ---------------------------------------------------------------- zaklad jednym kliknieciem (stala stawka z kontraktu)
  var BET_ABI = ['function placeBet(bytes32 marketId, bytes32 outcome, uint256 amount, uint256 nonce, uint256 deadline, bytes sig)'];

  function placeBet(marketId, outcome, playerName) {
    var token = localStorage.getItem('authToken') || localStorage.getItem('token');
    if (!token) { window.location.href = '/login.html'; return Promise.resolve(false); }
    var ui = progress('Bet on ' + (playerName || 'player'));
    var wallet, me, chainCfg;
    ui.step('Preparing…');
    return ui.race(Promise.all([config(), loadEthers()]).then(function (r) {
      chainCfg = r[0];
      ui.step('Connecting your wallet…', true);
      return ui.race(connect());
    }).then(function (w) {
      wallet = w;
      trace('wallet connected: ' + w.address + ' (' + w.kind + ')');
      ui.step('Checking your account…');
      return Promise.all([api('GET', '/api/chain/me', null, token), ui.race(prepareSdkProvider(w, ui))]).then(function (r) { return r[0]; });
    }).then(function (m) {
      me = m;
      if (me.walletAddress && me.walletAddress.toLowerCase() !== wallet.address.toLowerCase()) {
        throw new Error('This game account is linked to wallet ' + shortAddr(me.walletAddress) + ', but ' + shortAddr(wallet.address) + ' is connected. Connect the linked wallet.');
      }
      if (me.walletAddress) return null;
      ui.step('Linking your wallet to the game account… sign the message.', true);
      return api('POST', '/api/chain/wallet/challenge', { address: wallet.address }, token).then(function (ch) {
        return wallet.signMessage(ch.message).then(function (signature) { return api('POST', '/api/chain/wallet/link', { signature: signature }, token); });
      });
    }).then(function () {
      ui.step('Placing your bet…');
      return api('POST', '/api/chain/bets/voucher', { marketId: marketId, outcome: outcome }, token);
    }).then(function (v) {
      ui.step('Confirm the bet of ' + (+v.amountDoge).toLocaleString('en-US', { maximumFractionDigits: 4 }) + ' DOGE in your wallet…', true);
      var data = new ethers.Interface(BET_ABI).encodeFunctionData('placeBet', [v.marketId, v.outcome, v.amount, v.nonce, v.deadline, v.sig]);
      trace('sending placeBet');
      var send = Promise.resolve(wallet.provider().request({ method: 'eth_sendTransaction', params: [{ from: wallet.address, to: chainCfg.contract, data: data, value: '0x' + BigInt(v.amount).toString(16) }] }));
      return ui.race(watchSend(ui, token, send, function (d) { return (d.bets || []).some(function (b) { return b.marketId === marketId; }); }, 'Bet sent. Waiting for the network to confirm…', 'The bet was not confirmed in time.', '/api/chain/me/bets'));
    }).then(function () {
      return new Promise(function (resolve) { closeWalletPopup(); ui.success('Your bet is placed. Good luck!', 'Done', function () { resolve(true); }); });
    })).catch(function (e) {
      if (!ui.cancelled) {
        var text = errorText(e, 'Something went wrong.');
        if (e && (e.code === 4001 || /user (rejected|denied|cancel)/i.test(text))) text = 'You cancelled the bet.';
        trace('error: ' + text);
        ui.error(text + '\n\nDetails: ' + traceLog.slice(-4).join(' | '));
      }
      return false;
    });
  }

  // ---------------------------------------------------------------- odbior nagrody (claim) jednym kliknieciem
  var CLAIM_ABI = ['function claim()', 'function claimAll(bytes32[] marketIds, bytes32[] outcomes)'];

  function claimPrize() {
    var token = localStorage.getItem('authToken') || localStorage.getItem('token');
    if (!token) { window.location.href = '/login.html'; return Promise.resolve(false); }
    var ui = progress('Claim your prize');
    var wallet, me, chainCfg, legacy;
    ui.step('Preparing…');
    return ui.race(Promise.all([config(), loadEthers()]).then(function (r) {
      chainCfg = r[0];
      return api('GET', '/api/chain/me', null, token);
    }).then(function (m) {
      me = m;
      if (!me.walletAddress) throw new Error('No wallet is linked to this account.');
      if (!(Number(me.claimable) > 0)) throw new Error('There is no prize to claim right now.');
      ui.step('Connecting your wallet…', true);
      return ui.race(connect());
    }).then(function (w) {
      wallet = w;
      trace('wallet connected: ' + w.address + ' (' + w.kind + ')');
      return ui.race(prepareSdkProvider(w, ui));
    }).then(function () {
      if (me.walletAddress.toLowerCase() !== wallet.address.toLowerCase()) {
        throw new Error('Your prize belongs to wallet ' + shortAddr(me.walletAddress) + ', but ' + shortAddr(wallet.address) + ' is connected. Connect the linked wallet.');
      }
      // Najpierw nagrody ze starego kontraktu (jesli sa), potem z obecnego - kazdy odbior to osobna transakcja.
      legacy = Number(me.legacyClaimable) > 0 && me.legacyContract;
      var target = legacy ? me.legacyContract : chainCfg.contract;
      ui.step('Confirm the transaction in your wallet to receive ' + (+(legacy ? (me.legacyItems || [{ amount: me.legacyClaimable }])[0].amount : me.claimable)).toLocaleString('en-US', { maximumFractionDigits: 4 }) + ' DOGE' + (legacy ? ' (from the previous contract)' : '') + '…', true);
      var claimIface = new ethers.Interface(CLAIM_ABI), items = legacy ? [] : (me.claimItems || []);
      var data = items.length ? claimIface.encodeFunctionData('claimAll', [items.map(function (i) { return i.marketId; }), items.map(function (i) { return i.outcome; })]) : claimIface.encodeFunctionData('claim', []);
      trace('sending claim'); var send = Promise.resolve(wallet.provider().request({ method: 'eth_sendTransaction', params: [{ from: wallet.address, to: target, data: data, value: '0x0' }] }));
      return ui.race(watchSend(ui, token, send, function (m) { return legacy ? (m.legacyItems || []).every(function (i) { return i.address.toLowerCase() !== String(target).toLowerCase() || !(Number(i.amount) > 0); }) : !(Number(m.claimable) > 0); }, 'Sent. Waiting for the network to confirm…', 'The prize transaction was not confirmed in time.'));
    }).then(function () {
      return new Promise(function (resolve) { closeWalletPopup(); try { window.dispatchEvent(new Event('wol:claimed')); } catch (e) { /* ignore */ } ui.success(legacy ? 'Prize received. If more is waiting, press Claim again.' : 'Prize received in your wallet!', 'Done', function () { resolve(true); }, explorerLink(wallet && wallet.address)); });
    })).catch(function (e) {
      if (!ui.cancelled) {
        var text = errorText(e, 'Something went wrong.');
        if (e && (e.code === 4001 || /user (rejected|denied|cancel)/i.test(text))) text = 'You cancelled the transaction.';
        trace('error: ' + text);
        ui.error(text + '\n\nDetails: ' + traceLog.slice(-4).join(' | '));
      }
      return false;
    });
  }

  // Panel portfela w prawym gornym rogu (dla zalogowanych): zielona kropka + skrocony adres, a gdy jest nagroda -
  // zloty przycisk "Claim X DOGE". Po kliknieciu adresu rozwija sie menu (adres, saldo, DogeOS, wylogowanie).
  function mountWalletWidget() {
    var token = null;
    try { token = localStorage.getItem('authToken') || localStorage.getItem('token'); } catch (e) { /* ignore */ }
    if (!token || /\/(login|poczekalnia|game)\.html$/.test(location.pathname)) return;
    var box = null, menu = null, last = null;
    var fmt = function (v, d) { return (+v).toLocaleString('en-US', { maximumFractionDigits: d == null ? 4 : d }); };

    function build() {
      box = document.createElement('div');
      box.id = 'wolWalletWidget';
      box.style.cssText = 'position:fixed;top:41.22px;right:111px;z-index:9998;display:flex;gap:8px;align-items:center;font-family:Segoe UI,system-ui,sans-serif;max-width:calc(100vw - 24px);flex-wrap:wrap;justify-content:flex-end';
      box.innerHTML =
        '<button type="button" class="wolClaim" style="display:none;padding:9px 16px;font-size:15px;font-weight:800;border:0;border-radius:8px;background:linear-gradient(#e8c766,#b8932f);color:#1a1405;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.55)"></button>' +
        '<button type="button" class="wolPill" style="display:flex;align-items:center;gap:8px;padding:8px 14px;font-size:14px;font-weight:700;border-radius:8px;border:1px solid rgba(212,175,55,.6);background:rgba(10,16,33,.92);color:#f8fafc;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.55)"><span style="width:9px;height:9px;border-radius:50%;background:#34d399;box-shadow:0 0 6px #34d399"></span><span class="wolPillText"></span><span style="color:#94a3b8;font-size:11px">▾</span></button>' +
        '<div class="wolMenu" style="display:none;position:absolute;top:46px;right:0;min-width:250px;padding:14px;border-radius:10px;background:#0f172a;border:1px solid rgba(212,175,55,.55);box-shadow:0 10px 30px rgba(0,0,0,.65);color:#e2e8f0;font-size:14px;text-align:left"></div>';
      document.body.appendChild(box);
      menu = box.querySelector('.wolMenu');
      box.querySelector('.wolClaim').addEventListener('click', function () { claimPrize().then(check); });
      box.querySelector('.wolPill').addEventListener('click', function (e) { e.stopPropagation(); menu.style.display = menu.style.display === 'none' ? 'block' : 'none'; });
      document.addEventListener('click', function (e) { if (menu && !box.contains(e.target)) menu.style.display = 'none'; });
    }

    function render(m) {
      last = m;
      if (!box) build();
      var addr = m.walletAddress;
      box.querySelector('.wolPillText').textContent = addr ? m.username + ' · ' + addr.slice(0, 6) + '…' + addr.slice(-4) : m.username + ' · no wallet';
      var claim = box.querySelector('.wolClaim'), amount = Number(m.claimable) || 0;
      claim.style.display = amount > 0 ? 'block' : 'none';
      claim.textContent = '🏆 Claim ' + fmt(amount) + ' DOGE';
      menu.innerHTML =
        '<div style="font-weight:800;color:#e8c766;margin-bottom:8px">' + String(m.username).replace(/[<>&]/g, '') + '</div>' +
        (addr ? '<div style="color:#94a3b8;font-size:12px">Wallet connected</div><div style="font-family:Consolas,monospace;font-size:12px;word-break:break-all;margin:2px 0 6px">' + addr + '</div>' +
          '<button type="button" class="wolCopy" style="padding:5px 10px;font-size:12px;border-radius:6px;border:1px solid #475569;background:#1e293b;color:#e2e8f0;cursor:pointer">Copy address</button>' +
          '<div style="margin-top:10px">Balance: <b>' + (m.walletBalance != null ? fmt(m.walletBalance, 2) + ' DOGE' : '-') + '</b></div>' +
          '<div>To claim: <b style="color:' + (amount > 0 ? '#e8c766' : '#e2e8f0') + '">' + fmt(amount) + ' DOGE</b></div>'
          : '<div style="color:#94a3b8">No wallet linked to this account yet.</div>') +
        '<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap"><a href="/dogeos.html" style="padding:7px 12px;border-radius:6px;background:#1e293b;border:1px solid #475569;color:#e2e8f0;text-decoration:none;font-size:13px;font-weight:600">DogeOS</a>' +
        '<button type="button" class="wolLogout" style="padding:7px 12px;border-radius:6px;border:1px solid #7f1d1d;background:#3b1212;color:#fecaca;cursor:pointer;font-size:13px;font-weight:600">Log out</button></div>';
      var copy = menu.querySelector('.wolCopy');
      if (copy) copy.addEventListener('click', function () {
        var done = function () { copy.textContent = 'Copied!'; setTimeout(function () { copy.textContent = 'Copy address'; }, 1500); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(addr).then(done, function () { copy.textContent = addr; });
        else copy.textContent = addr;
      });
      menu.querySelector('.wolLogout').addEventListener('click', function () {
        try { ['authToken', 'token', 'username', 'wolWalletConnected'].forEach(function (k) { localStorage.removeItem(k); }); } catch (e) { /* ignore */ }
        window.location.href = '/login.html';
      });
    }

    function check() {
      return api('GET', '/api/chain/me', null, token).then(render).catch(function () { /* wylaczone / brak sieci */ });
    }
    check();
    setInterval(check, 30000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountWalletWidget); else mountWalletWidget();

  window.WolConnect = { keepWalletIframeOutOfBody: keepWalletIframeOutOfBody, fundPool: fundPool, topUpServer: topUpServer, placeBet: placeBet, hardenWalletIframe: hardenWalletIframe, closeWalletPopup: closeWalletPopup, claimPrize: claimPrize, handleActiveGame: handleActiveGame, isActiveGameError: isActiveGameError, buyTicket: buyTicket, promptUsername: promptUsername, ensureUsername: ensureUsername, config: config, connect: connect, loginWithWallet: loginWithWallet, injectedProvider: injectedProvider, api: api };
})();
