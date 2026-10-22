// Shared "digital content purchase consent" modal — self-injecting, same pattern as
// layout-editor.js/fingerprint.js. Any flow in the shop that hands the player a digital resource
// (currently just tournament tickets) should route through window.WoLPurchaseConsent.confirm(...)
// BEFORE calling the actual purchase API, so the required checkbox is always shown and the
// resulting choice can be sent along with the purchase request for server-side logging.
//
// IMPORTANT: window.confirm()/alert() are stubbed to no-ops on the shop pages (see
// sklep-bilety.html), so this deliberately does NOT use either — it's a real DOM modal.
//
// Real-money purchases go through HotPay (see POST /api/payments/tickets/create and
// /api/payments/mini-tickets/create in src/server.js) — this modal only handles the consent
// checkbox shown before the player is redirected there (or before an instant VPLN debit).
(function () {
    'use strict';

    function injectStyles() {
        if (document.getElementById('wolPurchaseConsentStyles')) return;
        const style = document.createElement('style');
        style.id = 'wolPurchaseConsentStyles';
        style.textContent = [
            '.wol-pc-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.65); z-index: 9999;',
            '  display: flex; align-items: center; justify-content: center; padding: 20px; }',
            '.wol-pc-modal { background: linear-gradient(180deg, rgba(18,27,48,0.98), rgba(10,16,33,0.99));',
            '  border: 1px solid rgba(212,175,55,0.45); border-radius: 16px; padding: 28px; max-width: 440px;',
            '  width: 100%; color: #e2e8f0; font-family: "Segoe UI", sans-serif;',
            '  box-shadow: 0 20px 60px rgba(0,0,0,0.5); }',
            '.wol-pc-modal h3 { margin: 0 0 6px; color: #e8c766; text-transform: uppercase; letter-spacing: 0.03em; }',
            '.wol-pc-summary { background: rgba(212,175,55,0.08); border: 1px solid rgba(212,175,55,0.25);',
            '  border-radius: 10px; padding: 14px 16px; margin: 14px 0; }',
            '.wol-pc-summary .wol-pc-item { color: #f8fafc; font-weight: bold; font-size: 15px; }',
            '.wol-pc-summary .wol-pc-price { color: #34d399; font-weight: bold; font-size: 18px; margin-top: 4px; }',
            '.wol-pc-row { display: flex; align-items: flex-start; gap: 10px; margin: 16px 0; }',
            '.wol-pc-row input { margin-top: 3px; accent-color: #d4af37; }',
            '.wol-pc-row label { font-size: 13px; line-height: 1.5; color: #cbd5e1; }',
            '.wol-pc-error { color: #f87171; font-size: 13px; margin: -8px 0 12px; display: none; }',
            '.wol-pc-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 6px; }',
            '.wol-pc-btn { border: none; border-radius: 8px; padding: 10px 20px; font-weight: bold;',
            '  font-size: 13px; cursor: pointer; }',
            '.wol-pc-btn-cancel { background: rgba(255,255,255,0.08); color: #f8fafc; border: 1px solid rgba(212,175,55,0.3); }',
            '.wol-pc-btn-confirm { background: #d4af37; color: #1c1408; }',
            '.wol-pc-btn-confirm:disabled { opacity: 0.5; cursor: not-allowed; }'
        ].join('\n');
        document.head.appendChild(style);
    }

    // opts: { itemLabel: '1 bilet turniejowy', priceLabel: '10 zł brutto' }
    // Resolves to true (accepted) or false (cancelled) — never rejects.
    function confirmPurchase(opts) {
        injectStyles();
        // Tlumaczenia (i18n.js) - gdy strona ich nie laduje, zostaje tekst polski.
        const tr = (key, fallback, params) => (window.i18n ? window.i18n.t(key, params, fallback) : fallback.replace(/\{(\w+)\}/g, (m, k) => (params && k in params ? params[k] : m)));
        const itemLabel = (opts && opts.itemLabel) || tr('shop.consent.defaultItem', 'Zasoby cyfrowe');
        const priceLabel = (opts && opts.priceLabel) || '—';

        return new Promise((resolve) => {
            const backdrop = document.createElement('div');
            backdrop.className = 'wol-pc-backdrop';
            backdrop.innerHTML =
                '<div class="wol-pc-modal">' +
                '<h3>' + tr('shop.consent.title', 'Potwierdź zakup') + '</h3>' +
                '<div class="wol-pc-summary">' +
                '<div class="wol-pc-item">' + itemLabel + '</div>' +
                '<div class="wol-pc-price">' + tr('shop.consent.price', 'Cena: {price}', { price: priceLabel }) + '</div>' +
                '</div>' +
                '<div class="wol-pc-row">' +
                '<input type="checkbox" id="wolPcConsentCheck">' +
                '<label for="wolPcConsentCheck">' + tr('shop.consent.text', 'Wyrażam zgodę na rozpoczęcie świadczenia usługi przed upływem ' +
                'terminu do odstąpienia od umowy i przyjmuję do wiadomości utratę prawa do odstąpienia od umowy ' +
                'z momentem przyznania cyfrowych zasobów w grze.') + '</label>' +
                '</div>' +
                '<div class="wol-pc-error" id="wolPcError">' + tr('shop.consent.error', 'Zaznacz zgodę, aby kontynuować zakup.') + '</div>' +
                '<div class="wol-pc-actions">' +
                '<button type="button" class="wol-pc-btn wol-pc-btn-cancel" id="wolPcCancelBtn">' + tr('common.cancel', 'Anuluj') + '</button>' +
                '<button type="button" class="wol-pc-btn wol-pc-btn-confirm" id="wolPcConfirmBtn">' + tr('shop.consent.confirm', 'Potwierdź zakup') + '</button>' +
                '</div>' +
                '</div>';
            document.body.appendChild(backdrop);

            const checkbox = backdrop.querySelector('#wolPcConsentCheck');
            const errorEl = backdrop.querySelector('#wolPcError');
            const confirmBtn = backdrop.querySelector('#wolPcConfirmBtn');

            function close(result) {
                backdrop.remove();
                resolve(result);
            }

            confirmBtn.addEventListener('click', () => {
                if (!checkbox.checked) {
                    errorEl.style.display = 'block';
                    return;
                }
                close(true);
            });
            backdrop.querySelector('#wolPcCancelBtn').addEventListener('click', () => close(false));
            backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(false); });
            checkbox.addEventListener('change', () => { if (checkbox.checked) errorEl.style.display = 'none'; });
        });
    }

    window.WoLPurchaseConsent = { confirm: confirmPurchase };
})();
