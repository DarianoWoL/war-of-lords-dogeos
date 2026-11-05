// Tlumaczenia interfejsu War of Lords (EN / PL) - bez przeladowania strony.
// Wymaga wczesniej zaladowanego /locales.js (slownik w window.WOL_LOCALES).
//
// Uzycie w HTML:
//   <a data-i18n="nav.home">Główna</a>                     -> tekst elementu
//   <input data-i18n-attr="placeholder:common.send">       -> atrybuty (kilka: "title:a.b;placeholder:c.d")
//   <p data-i18n-html="cookies.text">...<a>...</a></p>     -> tekst z HTML (tylko ze slownika!)
// Uzycie w JS:
//   i18n.t('home.welcome', { name: 'Dariano' })            -> 'Welcome, Dariano!'
//   i18n.tText('Wioska przejęta!')                         -> tlumaczy gotowy tekst (dane gry / strona) na biezacy jezyk
// Jezyk oryginalu strony: <html data-source-lang="en"> (domyslnie "pl"). Slowniki WOL_TEXTS / WOL_BLOCKS
// maja zawsze postac [polski, english] i dzialaja w obie strony.
//   i18n.setLang('pl')                                     -> przelacza i odswieza cala strone (bez przeladowania)
//   document.addEventListener('wol:langchange', (e) => ...) -> wlasne teksty generowane w JS
(function () {
    'use strict';

    const STORAGE_KEY = 'wol_lang';
    const DEFAULT_LANG = 'en';
    const LANGS = ['en', 'pl'];

    // Nawigacja ma te same identyfikatory na wszystkich stronach - tlumaczymy ja bez zmian w HTML.
    const AUTO_IDS = {
        navHome: 'nav.home',
        navRooms: 'nav.rooms',
        navTournaments: 'nav.tournaments',
        navShop: 'nav.shop',
        navRanking: 'nav.ranking',
        navProfile: 'nav.profile',
        navRules: 'nav.rules',
    };

    // Kazdy nowy gosc widzi strone po angielsku (decyzja wlasciciela, 2026-10-06) - bez wykrywania
    // kraju czy jezyka przegladarki. Wybor z przelacznika EN | PL jest zapamietywany i ma pierwszenstwo.
    function readLang() {
        // Contest build: English only. The EN | PL switcher is hidden and any saved Polish choice is ignored.
        return DEFAULT_LANG;
    }

    // Serwer tlumaczy swoje komunikaty (bledy, walidacja) wg ciasteczka wol_lang - tylko jezyk, nic wiecej.
    function syncCookie() {
        document.cookie = 'wol_lang=' + lang + '; path=/; max-age=31536000; SameSite=Lax';
    }

    let lang = readLang();
    syncCookie();

    // Jezyk, w ktorym napisany jest kod HTML/JS strony (tlumaczymy tylko, gdy gracz wybral inny).
    const SOURCE_LANG = document.documentElement.getAttribute('data-source-lang') === 'en' ? 'en' : 'pl';
    // Regulamin/Polityka: tresc tylko po polsku - atrybut lang zostaje zgodny z trescia.
    const CONTENT_LANG = document.documentElement.getAttribute('data-content-lang');

    function lookup(dict, key) {
        return key.split('.').reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), dict);
    }

    // t(key, params, fallback): tekst w biezacym jezyku -> po angielsku -> fallback (np. oryginal z HTML) -> klucz.
    function t(key, params, fallback) {
        const locales = window.WOL_LOCALES || {};
        let text = lookup(locales[lang], key);
        if (typeof text !== 'string') text = lookup(locales[DEFAULT_LANG], key);
        if (typeof text !== 'string') text = fallback !== undefined ? fallback : key;
        if (params) text = text.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
        return text;
    }

    // Oryginalny tekst z HTML (po polsku) zapamietujemy jako zapasowy, gdy brakuje tlumaczenia.
    function original(el, slot) {
        const attr = 'data-i18n-orig-' + slot;
        if (!el.hasAttribute(attr)) el.setAttribute(attr, slot === 'text' ? el.textContent : (el.getAttribute(slot) || ''));
        return el.getAttribute(attr);
    }

    function apply(root) {
        for (const [id, key] of Object.entries(AUTO_IDS)) {
            const el = document.getElementById(id);
            if (el && !el.hasAttribute('data-i18n')) el.setAttribute('data-i18n', key);
        }
        translateIn(root || document);
        if (!root) autoApply();
        if (!CONTENT_LANG) document.documentElement.lang = lang;
        updateSwitcher();
    }

    function translateIn(scope) {
        scope.querySelectorAll('[data-i18n]').forEach((el) => {
            // Skrypt strony zmienil juz ten tekst (np. "Wczytywanie..." -> wynik) - nie nadpisujemy go.
            const last = el.getAttribute('data-i18n-last');
            if (last !== null && el.textContent !== last) {
                el.removeAttribute('data-i18n');
                return;
            }
            const text = t(el.getAttribute('data-i18n'), null, original(el, 'text'));
            el.textContent = text;
            el.setAttribute('data-i18n-last', text);
        });
        // Tekst z odnosnikami/pogrubieniem - HTML pochodzi wylacznie z naszego slownika (locales.js),
        // nigdy z danych od graczy.
        scope.querySelectorAll('[data-i18n-html]').forEach((el) => {
            if (!el.hasAttribute('data-i18n-orig-html')) el.setAttribute('data-i18n-orig-html', el.innerHTML);
            el.innerHTML = t(el.getAttribute('data-i18n-html'), null, el.getAttribute('data-i18n-orig-html'));
        });
        scope.querySelectorAll('[data-i18n-attr]').forEach((el) => {
            el.getAttribute('data-i18n-attr').split(';').forEach((pair) => {
                const [attr, key] = pair.split(':').map((s) => s.trim());
                if (attr && key) el.setAttribute(attr, t(key, null, original(el, attr)));
            });
        });
    }

    function setLang(next) {
        if (!LANGS.includes(next) || next === lang) return;
        lang = next;
        try { localStorage.setItem(STORAGE_KEY, lang); } catch (e) { /* bez zapisu - tylko ta wizyta */ }
        syncCookie();
        apply();
        document.dispatchEvent(new CustomEvent('wol:langchange', { detail: { lang } }));
    }

    // Maly przelacznik EN | PL w rogu ekranu (nie rusza ukladu stron - nawigacja ma stale pozycje).
    let switcher = null;
    function createSwitcher() {
        const style = document.createElement('style');
        style.textContent = [
            '.wol-lang { position: fixed; top: 100px; right: 16px; z-index: 9999; display: flex; gap: 2px;',
            '  font: 600 12px "Segoe UI", sans-serif; background: rgba(10,16,33,0.85);',
            '  border: 1px solid rgba(212,175,55,0.45); border-radius: 8px; padding: 3px; }',
            '.wol-lang button { all: unset; cursor: pointer; padding: 4px 9px; border-radius: 6px; color: #cbd5e1; }',
            '.wol-lang button:hover { color: #f0d78c; }',
            '.wol-lang button.active { background: #d4af37; color: #0f172a; }',
        ].join('\n');
        document.head.appendChild(style);
        switcher = document.createElement('div');
        switcher.className = 'wol-lang layout-editor-ignore';
        switcher.setAttribute('role', 'group');
        switcher.setAttribute('aria-label', 'Language / Język');
        LANGS.forEach((code) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = code.toUpperCase();
            b.dataset.lang = code;
            b.addEventListener('click', () => setLang(code));
            switcher.appendChild(b);
        });
        document.body.appendChild(switcher);
    }

    function updateSwitcher() {
        if (!switcher) return;
        switcher.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.lang === lang));
    }

    // tText: tlumaczenie gotowego tekstu na biezacy jezyk - np. raport z serwera zapisany po polsku
    // ("Lojalność obniżona o 20 (do 60%)") albo tekst strony napisanej po angielsku. Lista wzorcow:
    // window.WOL_TEXTS = [[polski, english], ...], {0}, {1} = zmienna czesc. Dziala w obie strony
    // (PL -> EN i EN -> PL); tekst juz w biezacym jezyku albo nieznany zostaje bez zmian.
    function patternOf(text) {
        const source = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{(\d)\\\}/g, '(.+?)');
        return new RegExp('^' + source + '$');
    }
    let textIndex = null;
    function buildTextIndex() {
        const make = () => ({ exact: new Map(), patterns: [] });
        const index = { en: make(), pl: make(), size: (window.WOL_TEXTS || []).length };
        // index.en: polski -> angielski, index.pl: angielski -> polski. Przy powtorkach wygrywa
        // pozniejszy wpis (slownik strony jest ladowany po wspolnych).
        for (const [pl, en] of window.WOL_TEXTS || []) {
            for (const [target, from, to] of [['en', pl, en], ['pl', en, pl]]) {
                if (/\{\d\}/.test(from)) index[target].patterns.push({ re: patternOf(from), from, to });
                else index[target].exact.set(from, to);
            }
        }
        // Najpierw najbardziej konkretne wzorce (najwiecej stalego tekstu), np. "Wioska przejęta! (-{0}...)"
        // przed ogolnym "Wioska {0}".
        const fixedLength = (p) => p.from.replace(/\{\d\}/g, '').length;
        index.en.patterns.sort((a, b) => fixedLength(b) - fixedLength(a));
        index.pl.patterns.sort((a, b) => fixedLength(b) - fixedLength(a));
        textIndex = index;
    }
    function tText(text) {
        if (typeof text !== 'string' || !text) return text;
        if (!textIndex || textIndex.size !== (window.WOL_TEXTS || []).length) buildTextIndex();
        const index = textIndex[lang];
        if (index.exact.has(text)) return index.exact.get(text);
        for (const p of index.patterns) {
            const m = text.match(p.re);
            if (m) return p.to.replace(/\{(\d)\}/g, (_, i) => tText(m[Number(i) + 1]));
        }
        return text;
    }

    // --- Tryb fraz (strony z plikiem /texts/<strona>.js) ---------------------------------------------
    // Zamiast oznaczac kazdy element kluczem, strona laduje liste [polski, english] (WOL_TEXTS, z {0}
    // dla zmiennych czesci) i tutaj tlumaczymy kazdy pasujacy tekst w dokumencie - takze wstawiany
    // pozniej przez skrypty strony. Akapity z odnosnikami/pogrubieniem: WOL_BLOCKS = [[caly tekst
    // akapitu po polsku, angielski HTML]] - HTML pochodzi wylacznie z naszych plikow tlumaczen.
    // Po powrocie do PL przywracamy oryginaly. Elementy z data-i18n-skip (np. czat, nicki) pomijamy.
    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'NOSCRIPT', 'CODE', 'PRE']);
    const AUTO_ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
    const MANAGED = '[data-i18n],[data-i18n-html],[data-i18n-skip],.wol-lang';
    const trackedText = new Set();   // wezly tekstowe przetlumaczone przez tryb fraz
    const origText = new WeakMap();
    const trackedAttrs = new Set();  // elementy z przetlumaczonymi atrybutami
    const origAttrs = new WeakMap();
    const trackedBlocks = new Set(); // akapity podmienione w calosci
    let blockIndex = null;

    function autoEnabled() {
        return !!window.WOL_AUTO_TEXTS;
    }

    function norm(text) {
        return text.replace(/\s+/g, ' ').trim();
    }

    // WOL_BLOCKS = [[polski tekst akapitu, angielski HTML, polski HTML]]. Strona z oryginalem PL:
    // klucz = polski tekst -> angielski HTML. Strona z oryginalem EN: klucz = tekst angielskiego HTML
    // -> polski HTML. Wpisy z {0}, {1}... (np. liczby wstawiane przez skrypt) dopasowujemy wzorcem;
    // wartosci wstawiamy do HTML jako zwykly tekst (escapowany).
    function htmlToText(html) {
        const box = document.createElement('div');
        box.innerHTML = html;
        return box.textContent;
    }
    function buildBlockIndex() {
        blockIndex = { map: new Map(), patterns: [], size: (window.WOL_BLOCKS || []).length };
        for (const [pl, en, plHtml] of window.WOL_BLOCKS || []) {
            const fromPl = SOURCE_LANG === 'pl';
            if (!fromPl && !plHtml) continue;
            const key = norm(fromPl ? pl : htmlToText(en));
            const html = fromPl ? en : plHtml;
            if (/\{\d\}/.test(key)) blockIndex.patterns.push({ re: patternOf(key), html });
            else blockIndex.map.set(key, html);
        }
    }

    function escapeHtml(text) {
        return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function lookupBlock(text) {
        if (blockIndex.map.has(text)) return blockIndex.map.get(text);
        for (const p of blockIndex.patterns) {
            const m = text.match(p.re);
            if (m) return p.html.replace(/\{(\d)\}/g, (_, i) => escapeHtml(tText(m[Number(i) + 1])));
        }
        return undefined;
    }

    function isSkipped(el) {
        for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
            if (SKIP_TAGS.has(node.tagName) || node.isContentEditable) return true;
            if (node.matches(MANAGED)) return true;
        }
        return false;
    }

    function translateTextNode(node) {
        const parent = node.parentElement;
        if (!parent || isSkipped(parent)) return;
        const source = origText.has(node) ? origText.get(node) : node.nodeValue;
        if (!source || !/[A-Za-zÀ-ž]/.test(source)) return;
        if (lang === SOURCE_LANG) {
            if (origText.has(node) && node.nodeValue !== source) node.nodeValue = source;
            return;
        }
        const key = norm(source);
        const translated = tText(key);
        if (translated === key) return;
        const lead = source.match(/^\s*/)[0];
        const trail = source.match(/\s*$/)[0];
        if (!origText.has(node)) {
            origText.set(node, source);
            trackedText.add(node);
        }
        node.nodeValue = lead + translated + trail;
    }

    function translateAttrs(el) {
        const attrs = AUTO_ATTRS.filter((a) => el.hasAttribute(a));
        if (el.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(el.type) && el.hasAttribute('value')) attrs.push('value');
        // textarea: tresc pomijamy (wpisuje ja gracz), ale placeholder/title tlumaczymy.
        if (!attrs.length || isSkipped(el.tagName === 'TEXTAREA' ? el.parentElement : el)) return;
        let orig = origAttrs.get(el);
        for (const attr of attrs) {
            const source = orig && attr in orig ? orig[attr] : el.getAttribute(attr);
            const translated = lang === SOURCE_LANG ? source : tText(norm(source));
            if (translated === norm(source) && !(orig && attr in orig)) continue;
            if (!orig) {
                orig = {};
                origAttrs.set(el, orig);
                trackedAttrs.add(el);
            }
            if (!(attr in orig)) orig[attr] = source;
            if (el.getAttribute(attr) !== translated) el.setAttribute(attr, translated);
        }
    }

    // Akapit z odnosnikami/pogrubieniem - porownujemy caly tekst (odporne na roznice w zapisie HTML).
    function translateBlock(el) {
        if (lang === SOURCE_LANG || !el.firstElementChild || el.childElementCount > 40 || el.__wolOrigHtml !== undefined) return false;
        if (!blockIndex || blockIndex.size !== (window.WOL_BLOCKS || []).length) buildBlockIndex();
        if (!blockIndex.map.size && !blockIndex.patterns.length) return false;
        const html = lookupBlock(norm(el.textContent));
        if (html === undefined || isSkipped(el)) return false;
        el.__wolOrigHtml = el.innerHTML;
        trackedBlocks.add(el);
        el.innerHTML = html;
        return true;
    }

    function autoTranslate(root) {
        if (!autoEnabled() || !root) return;
        if (root.nodeType === 3) {
            const parent = root.parentElement;
            if (parent && translateBlock(parent)) return;
            translateTextNode(root);
            return;
        }
        if (root.nodeType !== 1 && root.nodeType !== 9) return;
        const start = root.nodeType === 9 ? root.documentElement : root;
        if (start.nodeType === 1) {
            if (translateBlock(start)) return;
            translateAttrs(start);
        }
        const walker = document.createTreeWalker(start, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                if (node.nodeType === 1 && (SKIP_TAGS.has(node.tagName) || node.matches(MANAGED))) {
                    if (node.tagName === 'TEXTAREA') translateAttrs(node);
                    return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_ACCEPT;
            },
        });
        const texts = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (node.nodeType === 3) texts.push(node);
            else if (!translateBlock(node)) translateAttrs(node);
        }
        texts.forEach((node) => { if (node.isConnected) translateTextNode(node); });
    }

    // Zmiana jezyka: przywracamy oryginaly (jezyk zrodla strony) albo tlumaczymy od nowa.
    function autoApply() {
        if (!autoEnabled()) return;
        for (const el of trackedBlocks) {
            if (!el.isConnected) { trackedBlocks.delete(el); continue; }
            if (lang === SOURCE_LANG) {
                el.innerHTML = el.__wolOrigHtml;
                delete el.__wolOrigHtml;
                trackedBlocks.delete(el);
            }
        }
        for (const node of trackedText) {
            if (!node.isConnected) trackedText.delete(node);
        }
        for (const el of trackedAttrs) {
            if (!el.isConnected) trackedAttrs.delete(el);
        }
        if (lang === SOURCE_LANG) {
            trackedText.forEach(translateTextNode);
            trackedAttrs.forEach(translateAttrs);
        } else {
            autoTranslate(document);
        }
    }

    // Komunikaty z okienek (alert/confirm/prompt) - tlumaczone na biezacy jezyk jak reszta tekstow.
    ['alert', 'confirm', 'prompt'].forEach((name) => {
        const native = window[name];
        if (typeof native !== 'function') return;
        window[name] = function (message, ...rest) {
            return native.call(window, typeof message === 'string' ? tText(message) : message, ...rest);
        };
    });

    window.i18n = { t, tText, setLang, getLang: () => lang, apply, langs: LANGS.slice(), sourceLang: SOURCE_LANG };
    if (!CONTENT_LANG) document.documentElement.lang = lang;

    // Tlumaczymy elementy juz w chwili, gdy przegladarka je wczytuje - zanim skrypt strony zdazy
    // wpisac w nie wlasne dane (np. "Dowodca: Dariano"), ktorych pozniej nie wolno nadpisac.
    // Ten sam mechanizm tlumaczy oznaczone elementy dodane pozniej (okna, banery).
    const SELECTOR = '[data-i18n],[data-i18n-attr],[data-i18n-html]';
    const AUTO_SELECTOR = Object.keys(AUTO_IDS).map((id) => '#' + id).join(',');
    if (window.MutationObserver) {
        new MutationObserver((mutations) => {
            const auto = autoEnabled() && lang !== SOURCE_LANG;
            for (const m of mutations) {
                // Skrypt podmienil zawartosc akapitu - moze to byc caly akapit ze slownika (WOL_BLOCKS).
                if (auto && m.target.nodeType === 1 && m.target.isConnected && translateBlock(m.target)) continue;
                for (const node of m.addedNodes) {
                    if (auto && node.isConnected) autoTranslate(node);
                    if (node.nodeType !== 1) continue;
                    if (node.matches(SELECTOR) || node.matches(AUTO_SELECTOR) || node.querySelector(SELECTOR)) applyNode(node);
                }
            }
        }).observe(document.documentElement, { childList: true, subtree: true });
    }

    // Tlumaczenie pojedynczego elementu z potomkami (bez przelacznika i atrybutu lang).
    function applyNode(node) {
        const id = node.id;
        if (id && AUTO_IDS[id] && !node.hasAttribute('data-i18n')) node.setAttribute('data-i18n', AUTO_IDS[id]);
        const wrapper = { querySelectorAll: (sel) => [node, ...node.querySelectorAll(sel)].filter((el) => el.matches(sel)) };
        translateIn(wrapper);
    }

    function init() {
        apply();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
