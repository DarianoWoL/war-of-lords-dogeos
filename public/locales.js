// Slownik tlumaczen War of Lords. Kazdy tekst: klucz: ['English', 'Polski'] - obie wersje obok siebie.
// {nazwa} = miejsce na wartosc wstawiana przez i18n.t(key, { nazwa }).
// Brakujacy klucz -> tekst angielski -> oryginalny tekst z HTML (nic sie nie psuje).
// Slownik widoku gry jest osobno: game-locales.js.
(function () {
    'use strict';
    const L = (window.WOL_LOCALES = window.WOL_LOCALES || { en: {}, pl: {} });

    // Rozklada { klucz: [en, pl] } (takze zagniezdzone) na WOL_LOCALES.en.sekcja i WOL_LOCALES.pl.sekcja.
    function section(name, entries) {
        const split = (obj, i) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, Array.isArray(v) ? v[i] : split(v, i)]));
        L.en[name] = Object.assign(L.en[name] || {}, split(entries, 0));
        L.pl[name] = Object.assign(L.pl[name] || {}, split(entries, 1));
    }
    window.WOL_LOCALES_SECTION = section;

    section('lang', {
        name: ['English', 'Polski'],
        switchTo: ['Polski', 'English'],
    });

    section('nav', {
        home: ['Home', 'Główna'],
        rooms: ['Battle Rooms', 'Pokoje Bitewne'],
        tournaments: ['Tournaments', 'Turnieje'],
        shop: ['Shop', 'Sklep'],
        ranking: ['Overall Ranking', 'Ranking Ogólny'],
        profile: ['Profile', 'Profil'],
        rules: ['Rules', 'Zasady'],
    });

    section('footer', {
        terms: ['Terms of Service', 'Regulamin'],
        privacy: ['Privacy Policy', 'Polityka Prywatności'],
        tournamentRules: ['Tournament Rules', 'Zasady Turnieju'],
        miniTournamentRules: ['Mini-Tournament Rules', 'Zasady Mini-Turniejów'],
        contact: ['Contact', 'Kontakt'],
    });

    section('common', {
        send: ['Send', 'Wyślij'],
        save: ['Save', 'Zapisz'],
        cancel: ['Cancel', 'Anuluj'],
        close: ['Close', 'Zamknij'],
        back: ['Back', 'Wróć'],
        loading: ['Loading...', 'Ładowanie...'],
        yes: ['Yes', 'Tak'],
        no: ['No', 'Nie'],
        networkError: ['Network error: ', 'Błąd sieciowy: '],
        error: ['Error', 'Błąd'],
        ok: ['OK', 'OK'],
    });

    section('home', {
        adminPanel: ['👑 ADMIN PANEL', '👑 PANEL ADMINISTRATORA'],
        ongoingGame: ['⚠️ You have a battle in progress!', '⚠️ Masz trwającą rozgrywkę!'],
        resumeBattle: ['Return to battle', 'Wróć do bitwy'],
        seeRanking: ['See ranking', 'Zobacz Ranking'],
        welcome: ['Welcome, {name}!', 'Witaj, {name}!'],
    });

    section('cookies', {
        text: [
            'This site uses cookies that are necessary for it to work and (with your consent) analytics cookies. '
                + 'See the <a href="polityka-prywatnosci.html#cookies">Privacy Policy</a> for details.',
            'Ta strona używa plików cookies niezbędnych do działania serwisu oraz (za Twoją zgodą) analitycznych. '
                + 'Szczegóły znajdziesz w <a href="polityka-prywatnosci.html#cookies">Polityce Prywatności</a>.',
        ],
        settings: ['Settings', 'Ustawienia'],
        accept: ['Accept', 'Akceptuję'],
        title: ['Cookie settings', 'Ustawienia plików cookies'],
        necessary: [
            '<span class="wol-cookie-tag">Necessary</span>Required for logging in and for the game to work (always active).',
            '<span class="wol-cookie-tag">Niezbędne</span>Wymagane do logowania i działania gry (zawsze aktywne).',
        ],
        analytics: [
            '<span class="wol-cookie-tag">Analytics</span>Help us understand how players use the site.',
            '<span class="wol-cookie-tag">Analityczne</span>Pomagają nam rozumieć, jak gracze korzystają z serwisu.',
        ],
        save: ['Save my choice', 'Zapisz wybór'],
    });

    section('shop', {
        pageTitle: ['War of Lords - Shop', 'War of Lords - Sklep'],
        ticketsPageTitle: ['War of Lords - Tournament tickets', 'War of Lords - Bilety turniejowe'],
        tournamentTickets: ['Tournament tickets', 'Bilety turniejowe'],
        ticketsBlurb: ['Paid with your DOGE balance (final price) — buy 1 to 5 at once.', 'Płatność saldem DOGE (cena ostateczna) — kup od 1 do 5 naraz.'],
        open: ['Open', 'Otwórz'],
        commander: ['Commander: {name}', 'Dowódca: {name}'],
        commanderLoading: ['Commander: Loading...', 'Dowódca: Wczytywanie...'],
        defaultNick: ['Commander', 'Dowódca'],
        ticketsCount: ['Tournament tickets: {n}', 'Bilety turniejowe: {n}'],
        ticketsLoading: ['Tournament tickets: Loading...', 'Bilety turniejowe: Wczytywanie...'],
        balance: ['DOGE balance: {n}', 'Saldo DOGE: {n}'],
        balanceLoading: ['DOGE balance: Loading...', 'Saldo DOGE: Wczytywanie...'],
        wallet: ['🪙 Wallet: top up / withdraw', '🪙 Portfel: wpłata / wypłata'],
        hasMiniTicket: ['🏅 You have an unused Mini-Tournament Ticket', '🏅 Posiadasz niewykorzystany Bilet do Mini-Turnieju'],
        noMiniTicket: ['🏅 No Mini-Tournament Ticket', '🏅 Brak Biletu do Mini-Turnieju'],
        shopDisabled: ['⛔ The shop has been temporarily closed by the administrator. Purchases are unavailable.', '⛔ Sklep jest tymczasowo wyłączony przez administratora. Zakupy są niedostępne.'],
        loading: ['Loading...', 'Wczytywanie...'],
        buyPln: ['BUY FOR PLN', 'KUP ZA PLN'],
        buyVpln: ['BUY FOR DOGE', 'KUP ZA DOGE'],
        or: ['or', 'lub'],
        vplnNote: ['Paid from your DOGE balance', 'Płatność z Twojego salda DOGE'],
        notEnoughVpln: ['Not enough DOGE (you have {have}, you need {need}) — top up in your Wallet', 'Za mało DOGE (masz {have}, potrzeba {need}) — doładuj w Portfelu'],
        price: ['{price} DOGE', '{price} DOGE'],
        priceTotal: ['{price} DOGE (total cost)', '{price} DOGE (całkowity koszt)'],
        poolAvailable: ['Available pool: {remaining} / {total}', 'Dostępna pula: {remaining} / {total}'],
        alreadyOwned: ['Already owned', 'Już posiadasz'],
        payStartError: ['Error while starting the payment.', 'Błąd podczas rozpoczynania płatności.'],
        purchaseError: ['Error during the purchase.', 'Błąd podczas zakupu.'],
        mini: {
            title: ['🏅 Mini-Tournament', '🏅 Mini-Turniej'],
            limitNote: ['Max 1 unused ticket on your account at a time — using/refunding has no limit, only the purchase counts.', 'Max 1 niewykorzystany bilet na koncie naraz — wykorzystanie/zwrot nie mają żadnego limitu, liczy się tylko sam zakup.'],
            checkRules: [
                'Before you buy, read the <a href="zasady-mini-turniej.html" style="color:#e8c766;">Mini-Tournament Rules</a> and the <a href="regulamin.html" style="color:#e8c766;">Terms of Service</a>.',
                'Zanim kupisz, sprawdź <a href="zasady-mini-turniej.html" style="color:#e8c766;">Zasady Mini-Turniejów</a> i <a href="regulamin.html" style="color:#e8c766;">Regulamin</a>.',
            ],
            noneAvailable: ['🔒 No Mini-Tournaments are available right now. Come back once the administrators open a new room.', '🔒 Brak aktualnie dostępnych Mini-Turniejów. Wróć, gdy administracja utworzy nowy pokój.'],
            poolExhausted: ['🎫 This month’s pool of Mini-Tournament Tickets has run out. Come back at the start of next month.', '🎫 Miesięczna pula Biletów do Mini-Turnieju się wyczerpała. Wróć na początku kolejnego miesiąca.'],
            held: [
                '✅ You already have an unused Mini-Tournament Ticket — you can join right away on the <a href="/mini-tournaments" style="color:#34d399;">Mini-Tournaments</a> page.',
                '✅ Masz już niewykorzystany Bilet do Mini-Turnieju — możesz od razu dołączyć na stronie <a href="/mini-tournaments" style="color:#34d399;">Mini-Turnieje</a>.',
            ],
            ticket: ['1 Mini-Tournament Ticket', '1 Bilet do Mini-Turnieju'],
            item: ['Mini-Tournament Ticket', 'Bilet do Mini-Turnieju'],
            itemVpln: ['Mini-Tournament Ticket (paid with DOGE balance)', 'Bilet do Mini-Turnieju (zapłata saldem DOGE)'],
            boughtVpln: ['Mini-Tournament Ticket bought with your DOGE balance!', 'Bilet do Mini-Turnieju zakupiony za saldo DOGE!'],
        },
        monthly: {
            title: ['🎟️ Monthly Tournament', '🎟️ Turniej Miesięczny'],
            blurb: ['Paid with your DOGE balance (final price) — 1 ticket per player per calendar month.', 'Płatność saldem DOGE (cena ostateczna) — 1 bilet na gracza w miesiącu kalendarzowym.'],
            checkRules: [
                'Before you buy, read the <a href="zasady-turnieju.html" style="color:#e8c766;">Tournament Rules</a> and the <a href="regulamin.html" style="color:#e8c766;">Terms of Service</a>.',
                'Zanim kupisz, sprawdź <a href="zasady-turnieju.html" style="color:#e8c766;">Zasady Turnieju</a> i <a href="regulamin.html" style="color:#e8c766;">Regulamin</a>.',
            ],
            poolLoading: ['Monthly pool: loading...', 'Pula miesięczna: wczytywanie...'],
            poolLeft: ['Monthly pool: {remaining} / {total} tickets left', 'Pula miesięczna: pozostało {remaining} / {total} biletów'],
            noneScheduled: ['🔒 No Monthly Tournament is scheduled right now. Come back once the administrators announce a new edition.', '🔒 Brak aktualnie zaplanowanego Turnieju Miesięcznego. Wróć, gdy administracja ogłosi nową edycję.'],
            poolExhausted: ['🎫 This month’s pool of tournament tickets has run out. Come back at the start of next month.', '🎫 Pula biletów turniejowych na ten miesiąc się wyczerpała. Wróć na początku kolejnego miesiąca.'],
            salesPaused: ['⛔ Tournament ticket sales are temporarily paused by the administrators.', '⛔ Sprzedaż biletów turniejowych jest tymczasowo wstrzymana przez administrację.'],
            monthlyLimit: ['🎫 You have already used your limit of 1 tournament ticket this month. The limit resets on the 1st of the next month.', '🎫 Wykorzystałeś już swój limit 1 biletu turniejowego w tym miesiącu. Limit odnawia się 1. dnia kolejnego miesiąca.'],
            ticket: ['1 Tournament Ticket', '1 Bilet Turniejowy'],
            itemOne: ['1 tournament ticket', '1 bilet turniejowy'],
            itemMany: ['{n} tournament tickets', '{n} bilety turniejowe'],
            itemVpln: ['1 tournament ticket (paid with DOGE balance)', '1 bilet turniejowy (zapłata saldem DOGE)'],
            boughtVpln: ['Tournament Ticket bought with your DOGE balance!', 'Bilet Turniejowy zakupiony za saldo DOGE!'],
            closed: ['Registration for this edition is currently closed.', 'Zapisy do tej edycji są obecnie zamknięte.'],
            noTournament: ['No tournament is currently scheduled.', 'Brak aktualnie zaplanowanego turnieju.'],
            closedShort: ['Registration closed', 'Zapisy zamknięte'],
            noTournamentShort: ['No tournament', 'Brak turnieju'],
        },
        payments: {
            title: ['🪙 Payments in DOGE', '🪙 Płatności w DOGE'],
            intro: [
                'All purchases are paid from your virtual <strong>DOGE</strong> balance — no external payment operator.',
                'Wszystkie zakupy opłacasz wirtualnym saldem <strong>DOGE</strong> — bez zewnętrznego operatora płatności.',
            ],
            deposit: [
                '<strong>Top up</strong> — send DOGE to the game wallet address shown in your <a href="portfel.html" style="color:#e8c766;">Wallet</a> and report the transaction; your balance grows once it is verified on-chain.',
                '<strong>Doładowanie</strong> — wyślij DOGE na adres portfela gry podany w <a href="portfel.html" style="color:#e8c766;">Portfelu</a> i zgłoś transakcję; saldo rośnie po jej weryfikacji w sieci.',
            ],
            withdraw: [
                '<strong>Withdrawal</strong> — prizes and unused balance can be withdrawn to your own DOGE address (on-chain, after verification).',
                '<strong>Wypłata</strong> — nagrody i niewykorzystane saldo wypłacisz na własny adres DOGE (on-chain, po weryfikacji).',
            ],
        },
        consent: {
            title: ['Confirm purchase', 'Potwierdź zakup'],
            price: ['Price: {price}', 'Cena: {price}'],
            text: [
                'I consent to the service starting before the withdrawal period ends and I acknowledge that I lose the right to withdraw from the contract once the digital resources are granted in the game.',
                'Wyrażam zgodę na rozpoczęcie świadczenia usługi przed upływem terminu do odstąpienia od umowy i przyjmuję do wiadomości utratę prawa do odstąpienia od umowy z momentem przyznania cyfrowych zasobów w grze.',
            ],
            error: ['Tick the consent box to continue with the purchase.', 'Zaznacz zgodę, aby kontynuować zakup.'],
            confirm: ['Confirm purchase', 'Potwierdź zakup'],
            defaultItem: ['Digital resources', 'Zasoby cyfrowe'],
        },
    });

    section('tour', {
        pageTitle: ['War of Lords - Tournaments', 'War of Lords - Turnieje'],
        tabQual: ['Qualifiers', 'Kwalifikacje'],
        tabSemi: ['Semi-final', 'Półfinał'],
        tabFinal: ['Final', 'Finał'],
        loadingTitle: ['Loading tournaments...', 'Ładowanie turniejów...'],
        loadingText: ['Please wait, fetching data from the server.', 'Proszę czekać, pobieram dane z serwera.'],
        loading: ['Loading...', 'Wczytywanie...'],
        mmr: {
            title: ['🏅 Monthly Free Ranking', '🏅 Miesięczny Ranking Darmowy'],
            text: [
                'Points are calculated with the same algorithm as in the Qualifiers (villages + kills while attacking + battles overall) from the 1st of the month — only from <strong>regular rounds</strong> (Battle Rooms) with at least 8 players; tournament rounds do not count here. The TOP 5 of this list get a <strong>Wild Card to the Semi-final</strong> at the end of the month — a free promotion without qualifying rounds.',
                'Punkty liczone tym samym algorytmem co w Kwalifikacjach (wioski + zabójstwa w ataku + starcia ogółem) od 1. dnia miesiąca — tylko ze <strong>zwykłych rund</strong> (Pokoje Bitewne) z udziałem min. 8 graczy, rundy turniejowe się tu nie liczą. TOP 5 z tej listy dostaje <strong>Dziką Kartę do Półfinału</strong> na koniec miesiąca — darmowy awans bez rund kwalifikacyjnych.',
            ],
            poolHint: ['🎫 Tickets in the pool: {remaining} / {total}', '🎫 Bilety w puli: {remaining} / {total}'],
            empty: ['No ranking data yet.', 'Brak danych rankingowych na ten moment.'],
            wildcardTitle: ['Guaranteed Wild Card to the Semi-final', 'Gwarantowana Dzika Karta do Półfinału'],
            wildcard: ['🎫 Wild Card', '🎫 Dzika Karta'],
            loadError: ['Could not load the ranking.', 'Nie udało się pobrać rankingu.'],
        },
        qual: {
            title: ['🎟️ Qualification ranking', '🎟️ Ranking kwalifikacyjny'],
            text: [
                'One tournament ticket = 4 qualifying rounds. The sum of points you score in all your <strong>tournament</strong> rounds counts towards this ranking — the TOP 35 after the qualifiers advance to the semi-finals. Full rules and scoring: <a href="zasady-turnieju.html">Tournament Rules</a>',
                'Jeden bilet turniejowy = 4 rundy kwalifikacyjne. Suma punktów zdobytych w grze ze wszystkich Twoich rund <strong>turniejowych</strong> liczy się do tego rankingu — TOP 35 po zakończeniu kwalifikacji awansuje do półfinałów. Pełne zasady i punktacja: <a href="zasady-turnieju.html">Zasady Turnieju</a>',
            ],
            directPass: ['🎖️ Direct promotion (monthly ranking)', '🎖️ Bezpośredni awans (ranking miesięczny)'],
            empty: ['No data yet — play a qualifying round to appear here.', 'Brak danych — zagraj rundę kwalifikacyjną, żeby się tu pojawić.'],
            loadError: ['Could not load the qualification ranking.', 'Nie udało się pobrać rankingu kwalifikacyjnego.'],
        },
        semi: {
            title12: ['🏅 Semi-final 1 and 2', '🏅 Półfinał 1 i 2'],
            title34: ['🏅 Semi-final 3 and 4', '🏅 Półfinał 3 i 4'],
            text: ['Who is playing and the current score (village points) in these two rooms.', 'Kto gra i aktualny wynik (punkty wioski) w tych dwóch pokojach.'],
            defaultName: ['Semi-final', 'Półfinał'],
            live: [' 🔴 live', ' 🔴 na żywo'],
            finished: [' ✅ finished', ' ✅ zakończony'],
            waiting: [' ⏳ waiting', ' ⏳ oczekuje'],
            noPlayers: ['No players registered.', 'Brak zapisanych graczy.'],
            points: ['{n} pts', '{n} pkt'],
        },
        final: {
            title: ['👑 Final ranking', '👑 Ranking finałowy'],
            text: ['The Final score is counted in village points — the same as in a regular round.', 'Wynik w Finale liczony jest wg punktów wioski — tak samo jak w zwykłej rundzie.'],
        },
        card: {
            badgeFinal: ['👑 Final', '👑 Finał'],
            badgeSemi: ['🏅 Semi-final', '🏅 Półfinał'],
            badgeTournament: ['🏆 Tournament', '🏆 Turniej'],
            defaultName: ['Tournament', 'Turniej'],
            statusPaused: ['Status: Paused', 'Status: Zapauzowany'],
            statusOpen: ['Status: Open', 'Status: Dostępny'],
            perMatch: ['{n} players per match', '{n} graczy na mecz'],
            duration: ['Round length: {n} min', 'Czas trwania rundy: {n} min'],
            ticketRequired: ['🎫 Requires a tournament ticket (taken when the round starts)', '🎫 Wymaga biletu turniejowego (zabierany przy starcie rundy)'],
            registered: ['Registered players: <span style="color:#fbbf24; font-weight:bold;">{n} / {max}</span>', 'Zapisani gracze: <span style="color:#fbbf24; font-weight:bold;">{n} / {max}</span>'],
            inactiveFinal: ['⏸️ Not active yet — opens once the finalists are decided', '⏸️ Jeszcze nieaktywny — otwiera się po wyłonieniu finalistów'],
            inactiveSemi: ['⏸️ Not active yet — opens after the qualifiers', '⏸️ Jeszcze nieaktywny — otwiera się po kwalifikacjach'],
            paused: ['⏸️ The tournament is paused', '⏸️ Turniej jest zapauzowany'],
            full: ['🔒 FULL', '🔒 KOMPLET'],
            waitingFull: ['🔒 Waiting for a full line-up', '🔒 Czeka na pełny skład'],
            btnInactive: ['Inactive', 'Nieaktywny'],
            btnPaused: ['Paused', 'Zapauzowany'],
            btnFull: ['Full', 'Pełny'],
            btnJoin: ['Join the tournament', 'Dołącz do turnieju'],
            resume: ['Resume', 'Wznów'],
            pause: ['Pause', 'Pauza'],
            edit: ['Edit', 'Edytuj'],
            remove: ['Delete', 'Usuń'],
            none: [
                '<div class="room-card"><div class="room-info"><h3>No active tournaments</h3><div class="room-meta-text">Check back soon — the administrators regularly organise new tournament rounds.</div></div></div>',
                '<div class="room-card"><div class="room-info"><h3>Brak aktywnych turniejów</h3><div class="room-meta-text">Sprawdź ponownie wkrótce — administracja regularnie organizuje nowe rundy turniejowe.</div></div></div>',
            ],
        },
        err: {
            list: ['Could not load the list of tournaments.', 'Nie udało się pobrać listy turniejów.'],
            listTitle: ['Error loading tournaments', 'Błąd ładowania turniejów'],
            semiRooms: ['Could not load the semi-final rooms.', 'Nie udało się pobrać pokoi półfinałowych.'],
            roomsTitle: ['Error loading rooms', 'Błąd ładowania pokoi'],
            finalRoom: ['Could not load the final room.', 'Nie udało się pobrać pokoju finałowego.'],
            roomTitle: ['Error loading the room', 'Błąd ładowania pokoju'],
            badRoomId: ['Invalid room ID.', 'Nieprawidłowy identyfikator pokoju.'],
            join: ['Could not join the tournament.', 'Nie udało się dołączyć do turnieju.'],
            results: ['Could not load the results.', 'Nie udało się pobrać wyników.'],
            resultsLoad: ['Error loading the results.', 'Błąd ładowania wyników.'],
            rankingLoad: ['Error loading the ranking.', 'Błąd ładowania rankingu.'],
            save: ['Could not save the changes.', 'Nie udało się zapisać zmian.'],
            toggle: ['Could not change the tournament state.', 'Nie udało się zmienić stanu turnieju.'],
            remove: ['Could not delete the tournament.', 'Nie udało się usunąć turnieju.'],
        },
        updated: ['The tournament has been updated.', 'Turniej został zaktualizowany.'],
        removed: ['The tournament has been deleted.', 'Turniej został usunięty.'],
        timeLeft: ['Time left: {time}', 'Pozostało: {time}'],
        active: {
            text: ['⚠️ You have a battle in progress!', '⚠️ Masz trwającą rozgrywkę!'],
            resume: ['Return to battle', 'Wróć do bitwy'],
            leave: ['Leave the game', 'Opuść rozgrywkę'],
        },
        edit: {
            title: ['Edit tournament', 'Edytuj Turniej'],
            name: ['Tournament name', 'Nazwa turnieju'],
            maxPlayers: ['Maximum number of players', 'Maksymalna liczba graczy'],
            duration: ['Round length (minutes)', 'Długość rundy (minuty)'],
            eco: ['Economy modifier', 'Modyfikator Ekonomii'],
            military: ['Military modifier', 'Modyfikator Wojska'],
            allowBots: ['Allow players to add bots in the lobby themselves', 'Pozwól graczom samodzielnie dodawać boty w poczekalni'],
            save: ['Save changes', 'Zapisz zmiany'],
        },
    });

    section('wallet', {
        pageTitle: ['War of Lords - DOGE Wallet', 'War of Lords - Portfel DOGE'],
        title: ['🪙 DOGE Wallet', '🪙 Portfel DOGE'],
        balance: ['Your balance', 'Twoje saldo'],
        balanceValue: ['{n} DOGE', '{n} DOGE'],
        virtualNote: ['Virtual game balance — prizes, purchases, deposits and withdrawals.', 'Wirtualne saldo gry — nagrody, zakupy, wpłaty i wypłaty.'],
        toShop: ['Go to shop', 'Przejdź do sklepu'],
        depositTitle: ['⬇️ Deposit DOGE', '⬇️ Wpłata DOGE'],
        depositIntro: [
            'Send DOGE to the game wallet address below. Then paste the transaction hash (TXID) and the amount — your balance is credited once the transaction is verified on-chain.',
            'Wyślij DOGE na poniższy adres portfela gry. Potem wklej hash transakcji (TXID) i kwotę — saldo zostanie zasilone po weryfikacji transakcji w sieci.',
        ],
        depositAddress: ['Game wallet address (Dogecoin network only)', 'Adres portfela gry (tylko sieć Dogecoin)'],
        depositUnavailable: ['Deposits are temporarily unavailable — the game wallet address has not been set yet.', 'Wpłaty są chwilowo niedostępne — adres portfela gry nie został jeszcze ustawiony.'],
        qrAlt: ['QR code of the game wallet address', 'Kod QR adresu portfela gry'],
        copy: ['Copy address', 'Kopiuj adres'],
        copied: ['Copied!', 'Skopiowano!'],
        txHash: ['Transaction hash (TXID)', 'Hash transakcji (TXID)'],
        txHashPh: ['64 characters 0-9, a-f', '64 znaki 0-9, a-f'],
        amount: ['Amount (DOGE)', 'Kwota (DOGE)'],
        reportDeposit: ['Report deposit', 'Zgłoś wpłatę'],
        depositReported: ['Deposit reported — your balance will be credited after verification.', 'Wpłata zgłoszona — saldo zostanie zasilone po weryfikacji.'],
        withdrawTitle: ['⬆️ Withdraw DOGE', '⬆️ Wypłata DOGE'],
        withdrawIntro: [
            'Withdraw your balance to your private Dogecoin address. The amount is reserved from your balance right away; the withdrawal is sent <strong>on-chain after verification</strong> by the administrator.',
            'Wypłać saldo na swój prywatny adres Dogecoin. Kwota zostaje od razu zarezerwowana z salda, a wypłata jest realizowana <strong>on-chain po weryfikacji</strong> przez administratora.',
        ],
        minWithdrawal: ['Minimum withdrawal: {n} DOGE', 'Minimalna kwota wypłaty: {n} DOGE'],
        address: ['Your DOGE address (starts with D)', 'Twój adres DOGE (zaczyna się od D)'],
        ageAdult: ['I declare that I am of legal age.', 'Oświadczam, że jestem osobą pełnoletnią.'],
        ageGuardian: ['I am the legal guardian of an underage User and consent to this withdrawal to the given address.', 'Jestem opiekunem prawnym niepełnoletniego Użytkownika i wyrażam zgodę na wypłatę na wskazany adres.'],
        taxAck: ['I understand the withdrawal is paid in full (gross) and I settle this income in my own tax return myself.', 'Rozumiem, że wypłata następuje w pełnej kwocie brutto i samodzielnie rozliczam ten przychód w swoim zeznaniu podatkowym.'],
        withdrawBtn: ['Request withdrawal', 'Zleć wypłatę'],
        withdrawRequested: ['Withdrawal requested — it will be sent on-chain after verification.', 'Wypłata zlecona — zostanie wysłana on-chain po weryfikacji.'],
        badAddress: ['Invalid DOGE address — it must start with "D" and have 34 characters (letters and digits, without 0, O, I, l).', 'Nieprawidłowy adres DOGE — musi zaczynać się od „D” i mieć 34 znaki (litery i cyfry, bez 0, O, I, l).'],
        badHash: ['Invalid transaction hash — 64 characters 0-9, a-f.', 'Nieprawidłowy hash transakcji — 64 znaki 0-9, a-f.'],
        badAmount: ['Enter a valid amount.', 'Podaj poprawną kwotę.'],
        belowMin: ['The minimum withdrawal is {n} DOGE.', 'Minimalna kwota wypłaty to {n} DOGE.'],
        notEnough: ['Not enough DOGE (you have {n}).', 'Za mało DOGE (masz {n}).'],
        ageRequired: ['Choose whether you are of legal age or have your guardian’s consent.', 'Zaznacz, czy jesteś pełnoletni/a, czy wypłata odbywa się za zgodą opiekuna prawnego.'],
        taxRequired: ['Confirm that you will settle this income yourself.', 'Potwierdź, że samodzielnie rozliczysz ten przychód.'],
        history: ['Transaction history', 'Historia transakcji'],
        noHistory: ['No deposits or withdrawals yet.', 'Brak wpłat i wypłat.'],
        deposit: ['Deposit', 'Wpłata'],
        withdrawal: ['Withdrawal', 'Wypłata'],
        pending: ['pending verification', 'czeka na weryfikację'],
        completed: ['completed', 'zrealizowana'],
        failed: ['rejected', 'odrzucona'],
        note: ['Reason: {text}', 'Powód: {text}'],
        viewTx: ['view transaction', 'zobacz transakcję'],
        to: ['to {address}', 'na {address}'],
    });

    // Regulamin i Polityka Prywatnosci - tresc tylko po polsku (do aktualizacji pod DOGE), w EN informacja.
    section('legal', {
        termsTitle: ['War of Lords - Terms of Service', 'War of Lords - Regulamin Serwisu'],
        termsH1: ['War of Lords Terms of Service', 'Regulamin Serwisu War of Lords'],
        privacyTitle: ['War of Lords - Privacy Policy', 'War of Lords - Polityka Prywatności'],
        privacyH1: ['War of Lords Privacy Policy', 'Polityka Prywatności War of Lords'],
        polishOnly: [
            'This document is currently available in Polish only. It is being updated for DOGE payments — the English version will be published together with the updated text. Questions: support@waroflords.pl',
            '',
        ],
    });

    section('auth', {
        pageTitle: ['War of Lords - Log in', 'War of Lords - Logowanie'],
        subtitle: ['Log in to play', 'Zaloguj się do gry'],
        username: ['Username', 'Nazwa użytkownika'],
        usernamePh: ['Enter your username', 'Wpisz swoją nazwę'],
        password: ['Password', 'Hasło'],
        passwordPh: ['Enter your password', 'Wpisz hasło'],
        remember: ['Remember me', 'Zapamiętaj mnie'],
        login: ['Log in', 'Zaloguj się'],
        regUsername: ['Username (3–16 characters, max 2 spaces)', 'Nazwa użytkownika (3-16 znaków, max 2 spacje)'],
        regUsernamePh: ['Choose a username', 'Wybierz nazwę użytkownika'],
        email: ['E-mail address', 'Adres e-mail'],
        emailPh: ['your@email.com', 'twoj@email.pl'],
        regPassword: ['Password (6–20 characters)', 'Hasło (6-20 znaków)'],
        regPasswordPh: ['Choose a password', 'Wybierz hasło'],
        repeatPassword: ['Repeat password', 'Powtórz hasło'],
        referral: ['Referral code (optional)', 'Kod polecający (opcjonalnie)'],
        referralPh: ['Paste a code if someone referred you', 'Wklej kod, jeśli ktoś Cię polecił'],
        terms: [
            'I confirm that I have read and accept the <a href="regulamin.html" target="_blank">Terms of Service</a> '
                + 'and the <a href="polityka-prywatnosci.html" target="_blank">Privacy Policy</a>.',
            'Oświadczam, że zapoznałem się i akceptuję <a href="regulamin.html" target="_blank">Regulamin Serwisu</a> '
                + 'oraz <a href="polityka-prywatnosci.html" target="_blank">Politykę Prywatności</a>.',
        ],
        marketing: [
            'I want to receive the newsletter and promotional offers by e-mail (optional, you can withdraw consent at any time).',
            'Chcę otrzymywać newsletter oraz informacje o promocjach drogą e-mailową (opcjonalnie, zgodę można wycofać w każdej chwili).',
        ],
        createAccount: ['Create account', 'Utwórz konto'],
        forgot: ['Forgot your password?', 'Zapomniałeś hasła?'],
        homeLink: ['Home page', 'Strona główna'],
        noAccount: ['Don\'t have an account?', 'Nie masz konta?'],
        createNew: ['Create a new account', 'Utwórz nowe konto'],
        haveAccount: ['Already have an account?', 'Masz już konto?'],
        err: {
            enterLogin: ['Enter your username or e-mail', 'Wpisz nazwę użytkownika lub email'],
            enterPassword: ['Enter your password', 'Wpisz hasło'],
            login: ['Login failed', 'Błąd logowania'],
            register: ['Registration failed', 'Błąd rejestracji'],
            usernameMin: ['The username must be at least 3 characters long', 'Nazwa użytkownika musi mieć co najmniej 3 znaki'],
            usernameMax: ['The username can be at most 16 characters long', 'Nazwa użytkownika może mieć maksymalnie 16 znaków'],
            usernameSpaces: ['The username can contain at most 2 spaces', 'Nazwa użytkownika może zawierać maksymalnie 2 spacje'],
            email: ['Enter a valid e-mail address', 'Podaj prawidłowy adres e-mail'],
            passwordMin: ['The password must be at least 6 characters long', 'Hasło musi mieć co najmniej 6 znaków'],
            passwordMax: ['The password can be at most 20 characters long', 'Hasło może mieć maksymalnie 20 znaków'],
            passwordMismatch: ['The passwords do not match', 'Hasła nie są identyczne'],
            terms: [
                'You must accept the Terms of Service and the Privacy Policy to create an account.',
                'Musisz zaakceptować Regulamin i Politykę Prywatności, aby założyć konto.',
            ],
        },
        loginOk: ['Logged in! Redirecting...', 'Logowanie udane! Przekierowuję...'],
        registerOk: ['Account created! Redirecting...', 'Konto utworzone! Przekierowuję...'],
        resetSoon: ['Password reset - coming soon', 'Funkcja resetowania hasła - wkrótce dostępna'],
    });
})();
