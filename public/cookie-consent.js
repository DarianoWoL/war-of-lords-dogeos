// Self-injecting cookie/analytics notice banner, following the same pattern as layout-editor.js /
// fingerprint.js (one shared file, included via a single <script> tag per page). Consent choice is
// stored client-side only (localStorage) — there is no logged-out "account" to attach it to, and
// the site currently has no analytics/marketing cookies beyond what's covered below, so this never
// needs to round-trip to the server the way the registration/purchase checkboxes do.
(function () {
    'use strict';

    const STORAGE_KEY = 'wolCookieConsent'; // { necessary: true, analytics: bool, at: ISOString }

    function getConsent() {
        try {
            return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
        } catch (e) {
            return null;
        }
    }

    function saveConsent(analytics) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                necessary: true,
                analytics: !!analytics,
                at: new Date().toISOString()
            }));
        } catch (e) { /* localStorage unavailable — nothing to persist, banner will just re-show next visit */ }
    }

    function injectStyles() {
        const style = document.createElement('style');
        style.textContent = [
            '.wol-cookie-banner { position: fixed; left: 0; right: 0; bottom: 0; z-index: 9998;',
            '  display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 14px;',
            '  padding: 14px 20px; background: linear-gradient(180deg, rgba(15,23,42,0.97), rgba(10,16,33,0.99));',
            '  border-top: 1px solid rgba(212, 175, 55, 0.4); box-shadow: 0 -6px 20px rgba(0,0,0,0.4);',
            '  color: #e2e8f0; font-family: "Segoe UI", sans-serif; font-size: 14px; }',
            '.wol-cookie-banner p { margin: 0; max-width: 640px; line-height: 1.5; }',
            '.wol-cookie-banner a { color: #e8c766; text-decoration: underline; }',
            '.wol-cookie-actions { display: flex; gap: 10px; flex-wrap: wrap; }',
            '.wol-cookie-btn { border: none; border-radius: 8px; padding: 9px 18px; font-weight: bold;',
            '  font-size: 13px; cursor: pointer; transition: filter 0.15s; }',
            '.wol-cookie-btn:hover { filter: brightness(1.1); }',
            '.wol-cookie-btn-accept { background: #d4af37; color: #1c1408; }',
            '.wol-cookie-btn-settings { background: rgba(255,255,255,0.08); color: #f8fafc; border: 1px solid rgba(212,175,55,0.35); }',
            '.wol-cookie-modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 9999;',
            '  display: flex; align-items: center; justify-content: center; padding: 20px; }',
            '.wol-cookie-modal { background: linear-gradient(180deg, rgba(18,27,48,0.98), rgba(10,16,33,0.99));',
            '  border: 1px solid rgba(212,175,55,0.4); border-radius: 16px; padding: 28px; max-width: 460px;',
            '  width: 100%; color: #e2e8f0; font-family: "Segoe UI", sans-serif; }',
            '.wol-cookie-modal h3 { margin: 0 0 14px; color: #e8c766; }',
            '.wol-cookie-row { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 14px; }',
            '.wol-cookie-row input { margin-top: 3px; accent-color: #d4af37; }',
            '.wol-cookie-row label { font-size: 14px; line-height: 1.4; }',
            '.wol-cookie-row .wol-cookie-tag { display:block; font-weight:bold; color:#f0d78c; margin-bottom:2px; }',
            '.wol-cookie-modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 6px; }'
        ].join('\n');
        document.head.appendChild(style);
    }

    function buildBanner(onAccept, onSettings) {
        const bar = document.createElement('div');
        bar.className = 'wol-cookie-banner';
        bar.innerHTML =
            '<p data-i18n-html="cookies.text">Ta strona używa plików cookies niezbędnych do działania serwisu oraz (za Twoją zgodą) analitycznych. ' +
            'Szczegóły znajdziesz w <a href="polityka-prywatnosci.html#cookies">Polityce Prywatności</a>.</p>' +
            '<div class="wol-cookie-actions">' +
            '<button type="button" class="wol-cookie-btn wol-cookie-btn-settings" id="wolCookieSettingsBtn" data-i18n="cookies.settings">Ustawienia</button>' +
            '<button type="button" class="wol-cookie-btn wol-cookie-btn-accept" id="wolCookieAcceptBtn" data-i18n="cookies.accept">Akceptuję</button>' +
            '</div>';
        document.body.appendChild(bar);
        if (window.i18n) window.i18n.apply(bar);
        bar.querySelector('#wolCookieAcceptBtn').addEventListener('click', onAccept);
        bar.querySelector('#wolCookieSettingsBtn').addEventListener('click', onSettings);
        return bar;
    }

    function buildSettingsModal(onSave, onClose) {
        const backdrop = document.createElement('div');
        backdrop.className = 'wol-cookie-modal-backdrop';
        backdrop.innerHTML =
            '<div class="wol-cookie-modal">' +
            '<h3 data-i18n="cookies.title">Ustawienia plików cookies</h3>' +
            '<div class="wol-cookie-row">' +
            '<input type="checkbox" checked disabled id="wolCookieNecessary">' +
            '<label for="wolCookieNecessary" data-i18n-html="cookies.necessary"><span class="wol-cookie-tag">Niezbędne</span>Wymagane do logowania i działania gry (zawsze aktywne).</label>' +
            '</div>' +
            '<div class="wol-cookie-row">' +
            '<input type="checkbox" id="wolCookieAnalytics">' +
            '<label for="wolCookieAnalytics" data-i18n-html="cookies.analytics"><span class="wol-cookie-tag">Analityczne</span>Pomagają nam rozumieć, jak gracze korzystają z serwisu.</label>' +
            '</div>' +
            '<div class="wol-cookie-modal-actions">' +
            '<button type="button" class="wol-cookie-btn wol-cookie-btn-settings" id="wolCookieCancelBtn" data-i18n="common.cancel">Anuluj</button>' +
            '<button type="button" class="wol-cookie-btn wol-cookie-btn-accept" id="wolCookieSaveBtn" data-i18n="cookies.save">Zapisz wybór</button>' +
            '</div>' +
            '</div>';
        document.body.appendChild(backdrop);
        if (window.i18n) window.i18n.apply(backdrop);
        backdrop.querySelector('#wolCookieSaveBtn').addEventListener('click', () => {
            const analytics = backdrop.querySelector('#wolCookieAnalytics').checked;
            onSave(analytics);
        });
        backdrop.querySelector('#wolCookieCancelBtn').addEventListener('click', onClose);
        backdrop.addEventListener('click', (e) => { if (e.target === backdrop) onClose(); });
        return backdrop;
    }

    function init() {
        if (getConsent()) return; // already decided on this device
        injectStyles();

        const banner = buildBanner(
            () => { saveConsent(true); banner.remove(); },
            () => {
                const modal = buildSettingsModal(
                    (analytics) => { saveConsent(analytics); modal.remove(); banner.remove(); },
                    () => modal.remove()
                );
            }
        );
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
