// Self-injecting site footer — same one-shared-file pattern as layout-editor.js/fingerprint.js.
// This is the "public zone" contact surface: only the support e-mail is shown here, never the
// postal address (that only appears as plain text inside regulamin.html / polityka-prywatnosci.html).
(function () {
    'use strict';

    function injectStyles() {
        const style = document.createElement('style');
        style.textContent = [
            '.wol-site-footer { max-width: 1000px; width: calc(100% - 40px); box-sizing: border-box; margin: 40px auto 0; padding: 22px 20px 16px;',
            '  text-align: center; font-family: "Segoe UI", sans-serif; font-size: 13px; color: #cbd5e1;',
            '  background: linear-gradient(180deg, rgba(18, 27, 48, 0.92), rgba(10, 16, 33, 0.94));',
            '  border: 1px solid rgba(212, 175, 55, 0.32); border-radius: 12px;',
            '  box-shadow: inset 0 0 0 1px rgba(240, 215, 140, 0.1); }',
            '.wol-site-footer a { color: #e8c766; text-decoration: none; margin: 0 10px; }',
            '.wol-site-footer a:hover { color: #f0d78c; }',
            '.wol-site-footer .wol-footer-sep { color: rgba(148,163,184,0.4); }',
            '.wol-site-footer .wol-footer-contact { margin-top: 6px; }'
        ].join('\n');
        document.head.appendChild(style);
    }

    function init() {
        injectStyles();
        const footer = document.createElement('div');
        footer.className = 'wol-site-footer layout-editor-ignore';
        footer.innerHTML =
            '<div>' +
            '<a href="regulamin.html" data-i18n="footer.terms">Regulamin</a><span class="wol-footer-sep">•</span>' +
            '<a href="polityka-prywatnosci.html" data-i18n="footer.privacy">Polityka Prywatności</a><span class="wol-footer-sep">•</span>' +
            '<a href="zasady-turnieju.html" data-i18n="footer.tournamentRules">Zasady Turnieju</a><span class="wol-footer-sep">•</span>' +
            '<a href="zasady-mini-turniej.html" data-i18n="footer.miniTournamentRules">Zasady Mini-Turniejów</a>' +
            '</div>' +
            '<div class="wol-footer-contact"><span data-i18n="footer.contact">Kontakt</span>: <a href="mailto:support@waroflords.pl">support@waroflords.pl</a></div>' +
            '<div>&copy; ' + new Date().getFullYear() + ' War of Lords</div>';
        document.body.appendChild(footer);
        // Tlumaczenia (i18n.js) - stopka powstaje dynamicznie, wiec tlumaczymy ja po wstawieniu.
        if (window.i18n) window.i18n.apply(footer);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
