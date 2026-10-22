const vm = require('vm');
const fs = require('fs');
const path = require('path');

// Load game.js source
const gamePath = path.join(__dirname, 'game.js');
const code = fs.readFileSync(gamePath, 'utf8');

// Minimal DOM/localStorage mocks
function mkEl(id) {
  const el = {
    id: id || null,
    children: [],
    style: {},
    dataset: {},
    classList: { add: () => {}, remove: () => {}, contains: () => false, toggle: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    appendChild: () => {},
    querySelector: (sel) => mkEl(sel),
    querySelectorAll: (sel) => [mkEl(sel)],
    innerHTML: '',
    textContent: '',
    value: '0'
  };
  return el;
}

const storage = {};
const sandbox = {
  console,
  setTimeout,
  setInterval,
  clearInterval,
  Date,
  Math,
  window: {
    localStorage: {
      getItem: (k) => (k in storage ? storage[k] : null),
      setItem: (k, v) => { storage[k] = String(v); },
      removeItem: (k) => { delete storage[k]; }
    },
    addEventListener: (ev, cb) => {
      // store listeners so tests can invoke them after script execution
      if (!this._listeners) this._listeners = [];
      this._listeners.push({ ev, cb });
    },
  },

  localStorage: {
    getItem: (k) => (k in storage ? storage[k] : null),
    setItem: (k, v) => { storage[k] = String(v); },
    removeItem: (k) => { delete storage[k]; }
  },
  document: {
    _els: {},
    getElementById(id) {
      if (!this._els[id]) this._els[id] = mkEl(id);
      return this._els[id];
    },
    querySelector(q) {
      // simple mapping for selectors used in game.js
      if (q === '#recruitTable tbody' || q === '#garrisonTable tbody' || q === '#upgradeTable tbody') {
        return mkEl(q);
      }
      return mkEl(q);
    },
    querySelectorAll: (sel) => [mkEl(sel)],
    createElement: (tag) => mkEl(tag),
  },
  navigator: { userAgent: 'node' }
};

// Create context and run game.js
const context = vm.createContext(sandbox);
vm.runInContext(code, context);
// Bootstrap a known default village state for deterministic tests
vm.runInContext("state.villages = createDefaultVillages();", context);
// Run initialize inside the VM if present
try {
  vm.runInContext("typeof initialize === 'function' && initialize()", context);
} catch (e) {
  // ignore runtime errors during init for this harness
}

const now = Date.now();
const before = vm.runInContext("(state.villages['W1'] && state.villages['W1'].garrison && state.villages['W1'].garrison['archer']) || 0", context);
console.log('Before garrison W1 archer:', before);

// Push a finished recruit queue item (2 archers) inside VM
vm.runInContext(`(function(){
  const now = ${now};
  const v = state.villages['W1'];
  v.recruitQueue = v.recruitQueue || [];
  v.recruitQueue.push({ unitId: 'archer', name: 'Włócznik', count: 2, trainedUnits:0, remainingUnits:2, cost:40, unitDurationSeconds:1, startTime: now-5000, endTime: now-1000 });
  // persist
  saveVillageData();
})();`, context);

// Process queues
vm.runInContext('processRecruitQueues()', context);

const after = vm.runInContext("(state.villages['W1'] && state.villages['W1'].garrison && state.villages['W1'].garrison['archer']) || 0", context);
console.log('After processing garrison W1 archer:', after);

const qlen = vm.runInContext("(state.villages['W1'] && state.villages['W1'].recruitQueue) ? state.villages['W1'].recruitQueue.length : 0", context);
console.log('Recruit queue length W1:', qlen);
const hasSaved = vm.runInContext("!!window.localStorage.getItem('warlord-villages')", context);
console.log('Saved village data present in localStorage?', !!hasSaved);

// Regression test: a saved garrison should survive reload/load
vm.runInContext(`(function(){
  const saved = {
    villages: {
      W1: {
        id: 'W1',
        label: 'Wioska 1',
        type: 'main',
        parent: null,
        owner: null,
        color: null,
        garrison: { archer: 3, shield: 2, axe: 0, scout: 0, cavalry: 0, ram: 0, lord: 0 },
        buildings: [],
        buildQueue: [],
        recruitQueue: []
      }
    },
    gold: 1234,
    currentPlayerIndex: 0,
    currentVillageId: 'W1',
    viewMode: 'village'
  };
  window.localStorage.setItem('warlord-villages', JSON.stringify(saved));
  loadVillageData();
})();`, context);

const preservedArcher = vm.runInContext("(state.villages['W1'] && state.villages['W1'].garrison && state.villages['W1'].garrison['archer']) || 0", context);
console.log('Preserved garrison after reload:', preservedArcher);

if (preservedArcher !== 3) {
  console.error('Regression test failed: saved garrison should be preserved.');
  process.exit(1);
}

process.exit(0);
