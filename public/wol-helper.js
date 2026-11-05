// Sir Doge helper (Doge look only).
// - game.html: step-by-step tutorial that follows what the player has actually done, then rotating tips.
// - index.html: short help for guests (how to sign in and start a game).
// Needs /doge-mascot.js (window.DogeMascot). On game.html it reads the game's own globals (state, getCurrentPlayer).
(function () {
  'use strict';
  if (document.documentElement.getAttribute('data-theme') !== 'doge') return;
  var OFF_KEY = 'wolHelperOff';
  function helperOff() { try { return localStorage.getItem(OFF_KEY) === '1'; } catch (e) { return false; } }

  function whenMascot(fn) {
    if (window.DogeMascot) return fn(window.DogeMascot);
    document.addEventListener('dogemascot:ready', function () { if (window.DogeMascot) fn(window.DogeMascot); }, { once: true });
  }

  var isGame = /game\.html$/.test(location.pathname);
  var isHome = /(^\/$|index\.html$)/.test(location.pathname);
  if (!isGame && !isHome) return;
  if (helperOff()) return;

  // ------------------------------------------------------------------ game tutorial
  function gameTutorial(M) {
    var TIPS = [
      'Points come from your buildings and from every enemy unit you defeat.',
      'Bots never take prizes - beat their score and the DOGE prize is yours!',
      'Shieldbearers are great against infantry, Spearmen against cavalry. Mix them for defence.',
      'Axemen and Cavalry hit hard. Use them for attacks, not for defence.',
      'Send a Scout first to see what is waiting in an enemy village.',
      'Rams knock down the enemy wall before your army fights.',
      'Every Lord attack lowers a village’s loyalty. At 0 the village becomes yours!',
      'Keep the Gold Mine growing - gold is what wins long rounds.',
      'A red Reports button means a battle report just arrived.',
      'The top 3 players of the round win DOGE prizes, paid by the smart contract.'
    ];

    function me() { try { return getCurrentPlayer(); } catch (e) { return null; } }
    function myVillages() {
      var p = me(); if (!p || !state || !state.villages) return [];
      return Object.keys(state.villages).map(function (k) { return state.villages[k]; }).filter(function (v) { return v && v.owner === p.name; });
    }
    function maxLevel(id) {
      return myVillages().reduce(function (best, v) {
        var b = (v.buildings || []).find(function (x) { return x.id === id; });
        return Math.max(best, b ? Number(b.level) || 0 : 0);
      }, 0);
    }
    function units(ids) {
      return myVillages().reduce(function (sum, v) {
        return sum + ids.reduce(function (s, id) { return s + (Number((v.garrison || {})[id]) || 0); }, 0);
      }, 0);
    }
    function sentAttack() {
      var p = me(); if (!p) return false;
      return (state.reports || []).some(function (r) { return r && r.attackerName === p.name; }) ||
        (state.attacks || []).some(function (a) { return a && (a.attackerName === p.name || a.ownerName === p.name); });
    }
    function hasLord() {
      return myVillages().some(function (v) { return (Number((v.garrison || {}).lord) || 0) > 0 || (v.lordQueue || []).length > 0; }) ||
        (state.attacks || []).some(function (a) { var p = me(); return p && a && (a.attackerName === p.name) && (a.units || []).some(function (u) { return u.unitId === 'lord'; }); });
    }

    var STEPS = [
      { done: function () { return maxLevel('goldMine') >= 3; }, text: 'Woof! I’m Sir Doge. First, open Buildings and upgrade the Gold Mine to level 3. More gold per second means everything gets built faster!' },
      { done: function () { return maxLevel('tavern') >= 2; }, text: 'Much gold! Now upgrade the Tavern to level 2. It raises your population, so you have room for an army.' },
      { done: function () { return maxLevel('barracks') >= 2; }, text: 'Next, upgrade the Barracks to level 2. Your units will train faster.' },
      { done: function () { return units(['shield', 'archer']) >= 30; }, text: 'The bots will attack you soon! Recruit about 30 defenders: Shieldbearers and Spearmen.' },
      { done: function () { return maxLevel('wall') >= 3; }, text: 'Raise the Defensive Wall to level 3. Your defenders fight much better behind it.' },
      { done: function () { return myVillages().length >= 2; }, text: 'Rich lord! Free villages next to yours have a yellow "Buy" tag on the map. Click one and buy it for 4,000 gold - more villages = more gold and more points.' },
      { done: sentAttack, text: 'Time to fight! Click an enemy village on the map and send Axemen. Send a Scout first if you want to see their army.' },
      { done: function () { return maxLevel('townHall') >= 10; }, text: 'To capture villages you need a Lord. Step 1: upgrade the Town Hall to level 10.' },
      { done: function () { return maxLevel('castle') >= 5; }, text: 'Step 2: build the Castle up to level 5. It unlocks the Lord.' },
      { done: hasLord, text: 'Step 3: recruit a Lord in the Recruitment panel. Send him with your army - every hit lowers the village’s loyalty, and at 0 it becomes yours!' }
    ];

    var skipped = {};
    var shownStep = -1, tipIndex = 0, tipTimer = null, mode = 'steps', lastSaidAt = 0;
    function currentStep() {
      for (var i = 0; i < STEPS.length; i++) if (!skipped[i] && !STEPS[i].done()) return i;
      return -1;
    }
    function sayTip() { M.say('Tip: ' + TIPS[tipIndex % TIPS.length]); tipIndex++; lastSaidAt = Date.now(); }
    function startTips() {
      if (mode === 'tips') return;
      mode = 'tips';
      M.say('Wow, you finished all my lessons! Such strategy. I’ll share a tip now and then.');
      lastSaidAt = Date.now();
      tipTimer = setInterval(function () { if (!document.getElementById('doge-mascot').classList.contains('dm-hidden')) sayTip(); }, 15000);
    }
    M.onNext(function () {
      if (mode === 'tips') { sayTip(); return; }
      if (shownStep >= 0) skipped[shownStep] = true;
      shownStep = -2; // force the next check to speak
      check();
    });

    function check() {
      if (typeof state === 'undefined' || !me()) return;
      if (state.roundStatus === 'finished') { if (tipTimer) clearInterval(tipTimer); M.remove(); return; }
      if (mode === 'tips') return;
      var step = currentStep();
      if (step === -1) { startTips(); return; }
      if (step !== shownStep) {
        var praise = shownStep >= 0 && !skipped[shownStep] ? 'Good job! ' : '';
        shownStep = step;
        M.say(praise + STEPS[step].text);
        lastSaidAt = Date.now();
      }
    }
    setTimeout(function () { check(); setInterval(check, 2000); }, 2500);
  }

  // ------------------------------------------------------------------ home page help
  function homeHelp(M) {
    var token = null;
    try { token = localStorage.getItem('authToken') || localStorage.getItem('token'); } catch (e) { /* ignore */ }
    var LINES = token ? [
      'Welcome back, lord! Open Mini-Tournaments, pick a room and press Join to start a round.',
      'No other players online? In the waiting room press "Fill the remaining places with bots" - bots never take prizes.',
      'Won a prize? The gold "Claim" button at the top right sends the DOGE straight to your wallet.'
    ] : [
      'Woof! I’m Sir Doge. Press "Connect wallet" at the top right to sign in - e-mail, Google or a wallet, no password needed.',
      'Your DogeOS wallet is your account. Pick a player name and you are ready for battle!',
      'Then open Mini-Tournaments, pick a room and press Join. Bots can fill the empty seats.',
      'Tip: War of Lords plays best on a computer.'
    ];
    var i = 0;
    M.onNext(function () { i = (i + 1) % LINES.length; M.say(LINES[i]); });
    setTimeout(function () { M.say(LINES[0]); }, 1200);
  }

  whenMascot(function (M) { if (isGame) gameTutorial(M); else homeHelp(M); });
})();
