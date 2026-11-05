// Sir Doge - animated helper mascot (drawn as SVG; made with Noah AI for War of Lords Arena, adapted).
// Mounts on <html> (not <body>, which the game pages scale) and exposes window.DogeMascot:
// say(text), hide(), show(), onNext(callback), remove().
(function () {
  if (window.DogeMascot) return;
  function mount() {
    if (document.getElementById('doge-mascot')) return;
    var root = document.createElement('div');
    root.id = 'doge-mascot';
    root.className = 'dm-hidden';
    root.innerHTML = "\n    <style>\n      #doge-mascot {\n        --dm-outline: #4a2c00;\n        --dm-fur: #f3a935;\n        --dm-cream: #fff3d6;\n        --dm-tunic: #2f6fd6;\n        --dm-tunic-dark: #1f4fa3;\n        --dm-gold: #f5c542;\n        --dm-bubble: #fffdf2;\n        --dm-btn: #fff6d6;\n        --dm-btn-shadow: #c98400;\n        /* Remove these 4 lines to place the mascot inline instead of fixed */\n        position: fixed;\n        left: 12px;\n        bottom: 62px;\n        z-index: 9999;\n        display: flex;\n        align-items: flex-end;\n        gap: 6px;\n        font-family: 'Fredoka', 'Baloo 2', 'Nunito', 'Trebuchet MS', system-ui, sans-serif;\n        pointer-events: none;\n      }\n      #doge-mascot * { box-sizing: border-box; }\n      #doge-mascot .dm-svg {\n        width: 170px;\n        height: auto;\n        flex-shrink: 0;\n        overflow: visible;\n        cursor: pointer;\n        pointer-events: auto;\n        filter: drop-shadow(0 4px 0 rgba(74, 44, 0, 0.15));\n      }\n\n      /* ---------- Figure animations ---------- */\n      #doge-mascot .dm-figure { transform-origin: 120px 262px; animation: dm-breathe 2.6s ease-in-out infinite; }\n      #doge-mascot .dm-tail { transform-origin: 160px 206px; animation: dm-wag 0.7s ease-in-out infinite; }\n      #doge-mascot.talking .dm-tail { animation-duration: 0.35s; }\n      #doge-mascot .dm-eyes { transform-origin: 120px 98px; animation: dm-blink 4.2s infinite; }\n      #doge-mascot .dm-head { transform-origin: 120px 150px; }\n      #doge-mascot.talking .dm-head { animation: dm-nod 0.55s ease-in-out infinite alternate; }\n      #doge-mascot .dm-arm { transform-origin: 138px 200px; }\n      #doge-mascot.waving .dm-arm { animation: dm-wave 1.8s ease-in-out; }\n      #doge-mascot .dm-mouth-open { opacity: 0; transform-origin: 120px 121px; }\n      #doge-mascot.talking .dm-mouth-open { opacity: 1; animation: dm-talk 0.2s ease-in-out infinite alternate; }\n      #doge-mascot.talking .dm-mouth-closed { opacity: 0; }\n\n      @keyframes dm-breathe {\n        0%, 100% { transform: translateY(0) scale(1, 1); }\n        50% { transform: translateY(-4px) scale(1.012, 0.99); }\n      }\n      @keyframes dm-wag {\n        0%, 100% { transform: rotate(-9deg); }\n        50% { transform: rotate(11deg); }\n      }\n      @keyframes dm-blink {\n        0%, 92%, 100% { transform: scaleY(1); }\n        95% { transform: scaleY(0.1); }\n      }\n      @keyframes dm-nod {\n        from { transform: rotate(-2.5deg); }\n        to { transform: rotate(2.5deg); }\n      }\n      @keyframes dm-talk {\n        from { transform: scaleY(0.25); }\n        to { transform: scaleY(1); }\n      }\n      @keyframes dm-wave {\n        0% { transform: rotate(0deg); }\n        18% { transform: rotate(-150deg); }\n        32% { transform: rotate(-120deg); }\n        46% { transform: rotate(-150deg); }\n        60% { transform: rotate(-120deg); }\n        76% { transform: rotate(-145deg); }\n        100% { transform: rotate(0deg); }\n      }\n\n      /* ---------- Speech bubble ---------- */\n      #doge-mascot .dm-bubble {\n        position: relative;\n        margin-bottom: 104px;\n        margin-left: 12px;\n        width: max-content;\n        max-width: min(300px, calc(100vw - 210px));\n        min-width: 170px;\n        padding: 12px 14px 10px;\n        background: var(--dm-bubble);\n        border: 3px solid var(--dm-outline);\n        border-radius: 20px;\n        box-shadow: 0 4px 0 var(--dm-btn-shadow);\n        color: var(--dm-outline);\n        pointer-events: auto;\n        transform-origin: left bottom;\n        transition: opacity 0.2s ease, transform 0.2s ease, visibility 0.2s;\n      }\n      #doge-mascot.dm-hidden .dm-svg { width: 110px; }\n      #doge-mascot.dm-gone { display: none !important; }\n      #doge-mascot.dm-hidden .dm-bubble {\n        opacity: 0;\n        visibility: hidden;\n        transform: scale(0.85) translateY(6px);\n        pointer-events: none;\n      }\n      #doge-mascot .dm-bubble::before,\n      #doge-mascot .dm-bubble::after {\n        content: '';\n        position: absolute;\n        border-style: solid;\n        width: 0;\n        height: 0;\n      }\n      #doge-mascot .dm-bubble::before {\n        left: -19px;\n        bottom: 18px;\n        border-width: 10px 16px 10px 0;\n        border-color: transparent var(--dm-outline) transparent transparent;\n      }\n      #doge-mascot .dm-bubble::after {\n        left: -14px;\n        bottom: 21px;\n        border-width: 7px 12px 7px 0;\n        border-color: transparent var(--dm-bubble) transparent transparent;\n      }\n      #doge-mascot .dm-text {\n        margin: 0;\n        min-height: 2.6em;\n        font-size: 15px;\n        font-weight: 500;\n        line-height: 1.35;\n        white-space: pre-wrap;\n        overflow-wrap: anywhere;\n      }\n      #doge-mascot .dm-actions {\n        display: flex;\n        justify-content: flex-end;\n        gap: 6px;\n        margin-top: 8px;\n      }\n      #doge-mascot .dm-btn {\n        font: inherit;\n        font-size: 12px;\n        font-weight: 700;\n        letter-spacing: 0.04em;\n        padding: 3px 12px;\n        color: var(--dm-outline);\n        background: var(--dm-btn);\n        border: 2px solid var(--dm-outline);\n        border-radius: 9999px;\n        box-shadow: 0 2px 0 var(--dm-btn-shadow);\n        cursor: pointer;\n        transition: transform 0.15s ease, box-shadow 0.15s ease, background-color 0.15s ease;\n      }\n      #doge-mascot .dm-btn:hover { background: #ffffff; transform: translateY(-2px); box-shadow: 0 4px 0 var(--dm-btn-shadow); }\n      #doge-mascot .dm-btn:active { transform: translateY(1px); box-shadow: 0 1px 0 var(--dm-btn-shadow); }\n      #doge-mascot .dm-btn:focus-visible { outline: 3px solid var(--dm-tunic); outline-offset: 2px; }\n      #doge-mascot .dm-sr {\n        position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;\n        overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;\n      }\n\n      @media (max-width: 480px) {\n        #doge-mascot .dm-svg { width: 120px; }\n        #doge-mascot .dm-bubble {\n          margin-bottom: 76px;\n          min-width: 0;\n          max-width: calc(100vw - 160px);\n          padding: 10px 11px 8px;\n        }\n        #doge-mascot .dm-text { font-size: 14px; }\n      }\n      @media (prefers-reduced-motion: reduce) {\n        #doge-mascot *, #doge-mascot .dm-figure { animation: none !important; transition: none !important; }\n      }\n    </style>\n\n    <svg class=\"dm-svg\" viewBox=\"0 0 240 280\" role=\"img\" aria-label=\"Doge knight mascot\" xmlns=\"http://www.w3.org/2000/svg\">\n      <ellipse cx=\"120\" cy=\"266\" rx=\"78\" ry=\"9\" fill=\"#4a2c00\" opacity=\"0.18\" />\n      <g class=\"dm-figure\" stroke=\"#4a2c00\" stroke-width=\"4\" stroke-linejoin=\"round\" stroke-linecap=\"round\">\n        <!-- Curly tail -->\n        <g class=\"dm-tail\">\n          <path d=\"M156 214 C192 216 216 190 208 160 C202 136 172 134 167 156 C164 171 180 178 189 168 C188 188 174 198 154 198 Z\" fill=\"#f3a935\" />\n          <path d=\"M175 150 C186 144 198 150 200 160 C192 156 182 156 175 150 Z\" fill=\"#fff3d6\" stroke-width=\"3\" />\n        </g>\n\n        <!-- Haunches and back feet -->\n        <ellipse cx=\"80\" cy=\"236\" rx=\"26\" ry=\"23\" fill=\"#f3a935\" />\n        <ellipse cx=\"160\" cy=\"236\" rx=\"26\" ry=\"23\" fill=\"#f3a935\" />\n        <ellipse cx=\"66\" cy=\"257\" rx=\"19\" ry=\"9\" fill=\"#fff3d6\" />\n        <ellipse cx=\"174\" cy=\"257\" rx=\"19\" ry=\"9\" fill=\"#fff3d6\" />\n\n        <!-- Torso and cream chest -->\n        <path d=\"M84 250 C72 214 80 168 120 162 C160 168 168 214 156 250 Z\" fill=\"#f3a935\" />\n        <ellipse cx=\"120\" cy=\"184\" rx=\"24\" ry=\"17\" fill=\"#fff3d6\" stroke=\"none\" />\n\n        <!-- Knight tunic -->\n        <path d=\"M84 182 Q98 172 108 174 L120 198 L132 174 Q142 172 156 182 L162 234 Q120 248 78 234 Z\" fill=\"#2f6fd6\" />\n        <path d=\"M100 200 L104 236 M140 200 L136 236\" stroke=\"#1f4fa3\" stroke-width=\"3\" fill=\"none\" />\n        <path d=\"M108 175 L120 198 L132 175\" stroke=\"#f5c542\" stroke-width=\"4\" fill=\"none\" />\n        <path d=\"M80 233 Q120 247 160 233\" stroke=\"#f5c542\" stroke-width=\"5\" fill=\"none\" />\n        <circle cx=\"120\" cy=\"216\" r=\"9\" fill=\"#f5c542\" stroke-width=\"3\" />\n        <path d=\"M120 210 L122 214.5 L126.5 215 L123 218 L124 222.5 L120 220 L116 222.5 L117 218 L113.5 215 L118 214.5 Z\" fill=\"#fff3d6\" stroke-width=\"1.5\" />\n\n        <!-- Left front leg (static) -->\n        <g>\n          <rect x=\"92\" y=\"198\" width=\"20\" height=\"62\" rx=\"10\" fill=\"#f3a935\" />\n          <ellipse cx=\"102\" cy=\"258\" rx=\"14\" ry=\"8\" fill=\"#fff3d6\" />\n          <rect x=\"89\" y=\"192\" width=\"26\" height=\"18\" rx=\"8\" fill=\"#2f6fd6\" />\n          <path d=\"M91 209 L113 209\" stroke=\"#f5c542\" stroke-width=\"3\" />\n        </g>\n\n        <ellipse cx=\"120\" cy=\"158\" rx=\"30\" ry=\"15\" fill=\"#f3a935\" stroke=\"none\" />\n\n        <!-- Head -->\n        <g class=\"dm-head\">\n          <path d=\"M70 84 L76 30 L110 62 Z\" fill=\"#f3a935\" />\n          <path d=\"M80 70 L82 44 L100 62 Z\" fill=\"#ffc9a6\" stroke-width=\"3\" />\n          <path d=\"M170 84 L164 30 L130 62 Z\" fill=\"#f3a935\" />\n          <path d=\"M160 70 L158 44 L140 62 Z\" fill=\"#ffc9a6\" stroke-width=\"3\" />\n          <ellipse cx=\"120\" cy=\"105\" rx=\"54\" ry=\"47\" fill=\"#f3a935\" />\n          <path d=\"M78 116 C84 98 104 102 120 108 C136 102 156 98 162 116 C160 140 140 151 120 151 C100 151 80 140 78 116 Z\" fill=\"#fff3d6\" stroke=\"none\" />\n          <ellipse cx=\"120\" cy=\"105\" rx=\"54\" ry=\"47\" fill=\"none\" />\n          <ellipse cx=\"98\" cy=\"82\" rx=\"7\" ry=\"4\" fill=\"#fff3d6\" stroke=\"none\" />\n          <ellipse cx=\"142\" cy=\"82\" rx=\"7\" ry=\"4\" fill=\"#fff3d6\" stroke=\"none\" />\n\n          <g class=\"dm-eyes\" stroke=\"none\">\n            <ellipse cx=\"100\" cy=\"98\" rx=\"6.5\" ry=\"8.5\" fill=\"#4a2c00\" />\n            <circle cx=\"102.5\" cy=\"94.5\" r=\"2.4\" fill=\"#ffffff\" />\n            <ellipse cx=\"140\" cy=\"98\" rx=\"6.5\" ry=\"8.5\" fill=\"#4a2c00\" />\n            <circle cx=\"142.5\" cy=\"94.5\" r=\"2.4\" fill=\"#ffffff\" />\n          </g>\n          <ellipse cx=\"86\" cy=\"117\" rx=\"8\" ry=\"5\" fill=\"#ff8a7a\" opacity=\"0.45\" stroke=\"none\" />\n          <ellipse cx=\"154\" cy=\"117\" rx=\"8\" ry=\"5\" fill=\"#ff8a7a\" opacity=\"0.45\" stroke=\"none\" />\n\n          <ellipse cx=\"120\" cy=\"112\" rx=\"8.5\" ry=\"6\" fill=\"#4a2c00\" stroke-width=\"2\" />\n          <ellipse cx=\"117.5\" cy=\"110\" rx=\"2.6\" ry=\"1.6\" fill=\"#ffffff\" stroke=\"none\" opacity=\"0.8\" />\n          <path class=\"dm-mouth-closed\" d=\"M108 121 Q114 128 120 121 Q126 128 132 121\" fill=\"none\" stroke-width=\"3\" />\n          <g class=\"dm-mouth-open\">\n            <path d=\"M109 120 Q120 120 131 120 Q130 140 120 140 Q110 140 109 120 Z\" fill=\"#8a2a1a\" stroke-width=\"3\" />\n            <path d=\"M113 133 Q120 126 127 133 Q125 139 120 139 Q115 139 113 133 Z\" fill=\"#ff8fa0\" stroke=\"none\" />\n          </g>\n\n          <!-- Tiny crown -->\n          <g transform=\"rotate(-8 120 56)\">\n            <path d=\"M102 66 L97 42 L109 53 L120 36 L131 53 L143 42 L138 66 Z\" fill=\"#f5c542\" stroke-width=\"3.5\" />\n            <path d=\"M102 66 L138 66\" stroke-width=\"3.5\" />\n            <circle cx=\"120\" cy=\"56\" r=\"3.6\" fill=\"#e2453c\" stroke-width=\"2\" />\n            <circle cx=\"108\" cy=\"60\" r=\"2.6\" fill=\"#2f6fd6\" stroke-width=\"2\" />\n            <circle cx=\"132\" cy=\"60\" r=\"2.6\" fill=\"#2f6fd6\" stroke-width=\"2\" />\n          </g>\n        </g>\n\n        <!-- Right front leg (waves) -->\n        <g class=\"dm-arm\">\n          <rect x=\"128\" y=\"198\" width=\"20\" height=\"62\" rx=\"10\" fill=\"#f3a935\" />\n          <ellipse cx=\"138\" cy=\"258\" rx=\"14\" ry=\"8\" fill=\"#fff3d6\" />\n          <path d=\"M133 256 L133 262 M143 256 L143 262\" stroke-width=\"2.5\" />\n          <rect x=\"125\" y=\"192\" width=\"26\" height=\"18\" rx=\"8\" fill=\"#2f6fd6\" />\n          <path d=\"M127 209 L149 209\" stroke=\"#f5c542\" stroke-width=\"3\" />\n        </g>\n      </g>\n    </svg>\n\n    <div class=\"dm-bubble\" aria-hidden=\"true\">\n      <p class=\"dm-text\" aria-hidden=\"true\"></p>\n      <span class=\"dm-sr\" aria-live=\"polite\"></span>\n      <div class=\"dm-actions\">\n        <button type=\"button\" class=\"dm-btn dm-next\">Next</button>\n        <button type=\"button\" class=\"dm-btn dm-hide\">Hide</button>\n      </div>\n    </div>\n\n    ";
    document.documentElement.appendChild(root);
    (function () {
      (function () {
        var root = document.getElementById('doge-mascot');
        if (!root || window.DogeMascot) return;

        var svg = root.querySelector('.dm-svg');
        var arm = root.querySelector('.dm-arm');
        var bubble = root.querySelector('.dm-bubble');
        var textEl = root.querySelector('.dm-text');
        var srEl = root.querySelector('.dm-sr');
        var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        var chars = [];
        var full = '';
        var index = 0;
        var timer = null;
        var typing = false;
        var listeners = [];

        function stopTyping() {
          clearTimeout(timer);
          timer = null;
          typing = false;
          root.classList.remove('talking');
        }

        function finishTyping() {
          stopTyping();
          textEl.textContent = full;
        }

        function tick() {
          index += 1;
          textEl.textContent = chars.slice(0, index).join('');
          if (index >= chars.length) {
            finishTyping();
            return;
          }
          var last = chars[index - 1];
          timer = setTimeout(tick, /[.,!?]/.test(last) ? 170 : 28);
        }

        function wave() {
          if (reduceMotion) return;
          root.classList.remove('waving');
          void svg.getBoundingClientRect(); // restart the animation
          root.classList.add('waving');
        }

        arm.addEventListener('animationend', function () {
          root.classList.remove('waving');
        });

        function show() {
          root.classList.remove('dm-hidden');
          bubble.removeAttribute('aria-hidden');
        }

        function hide() {
          stopTyping();
          textEl.textContent = full;
          root.classList.add('dm-hidden');
          bubble.setAttribute('aria-hidden', 'true');
        }

        function say(text) {
          full = text == null ? '' : String(text);
          chars = Array.from(full);
          stopTyping();
          show();
          srEl.textContent = full;
          wave();
          if (reduceMotion || chars.length === 0) {
            textEl.textContent = full;
            return;
          }
          index = 0;
          textEl.textContent = '';
          typing = true;
          root.classList.add('talking');
          timer = setTimeout(tick, 150);
        }

        function onNext(callback) {
          if (typeof callback !== 'function') return function () {};
          listeners.push(callback);
          return function () {
            listeners = listeners.filter(function (fn) { return fn !== callback; });
          };
        }

        root.querySelector('.dm-next').addEventListener('click', function () {
          // First click while typing just reveals the full text
          if (typing) {
            finishTyping();
            return;
          }
          listeners.slice().forEach(function (fn) {
            try { fn(); } catch (err) { console.error('[DogeMascot] onNext callback failed', err); }
          });
        });

        root.querySelector('.dm-hide').addEventListener('click', hide);

        svg.addEventListener('click', function () {
          if (root.classList.contains('dm-hidden') && full) {
            show();
            wave();
          } else {
            wave();
          }
        });

        window.DogeMascot = { say: say, hide: hide, show: show, onNext: onNext };
      })();
    })();
    if (window.DogeMascot) window.DogeMascot.remove = function () { root.classList.add('dm-gone'); };
    document.dispatchEvent(new Event('dogemascot:ready'));
  }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
})();
