// Runtime wrapper logic against mock LMS APIs.  Run: node tests/test_wrapper.js
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'scormkit', 'wrapper.js'), 'utf8');

function mockApi(ver, init = {}) {
  const data = Object.assign({}, init), calls = [];
  const rec = (n, f) => (...a) => { calls.push([n, ...a]); return f(...a); };
  const api = ver === '2004'
    ? { Initialize: rec('Initialize', () => 'true'), GetValue: rec('GetValue', k => data[k] ?? ''),
        SetValue: rec('SetValue', (k, v) => { data[k] = v; return 'true'; }),
        Commit: rec('Commit', () => 'true'), Terminate: rec('Terminate', () => 'true') }
    : { LMSInitialize: rec('LMSInitialize', () => 'true'), LMSGetValue: rec('LMSGetValue', k => data[k] ?? ''),
        LMSSetValue: rec('LMSSetValue', (k, v) => { data[k] = v; return 'true'; }),
        LMSCommit: rec('LMSCommit', () => 'true'), LMSFinish: rec('LMSFinish', () => 'true') };
  return { api, data, calls };
}

function load(ver, init, extra = {}) {
  const m = mockApi(ver, init), listeners = {};
  const parent = { [ver === '2004' ? 'API_1484_11' : 'API']: m.api };
  parent.parent = parent;
  const win = Object.assign({ parent, addEventListener: (e, f) => { (listeners[e] = listeners[e] || []).push(f); } }, extra);
  vm.runInNewContext(SRC, { window: win, JSON });
  return { win, m, fire: e => (listeners[e] || []).forEach(f => f()) };
}

const tests = {
  '2004: init sets incomplete; save writes bookmark + progress'() {
    const { win, m } = load('2004');
    assert.strictEqual(m.data['cmi.completion_status'], 'incomplete');
    win.scormSave(2, 2, false, 5);
    assert.strictEqual(m.data['cmi.location'], '2');
    assert.strictEqual(m.data['cmi.progress_measure'], '0.5000');
    assert.strictEqual(m.data['cmi.score.scaled'], '0.5000');
    assert.strictEqual(m.data['cmi.exit'], 'suspend');
    assert.deepStrictEqual(JSON.parse(m.data['cmi.suspend_data']), { cur: 2, max: 2, quiz: false });
  },
  '2004: complete then unload terminates exactly once'() {
    const { win, m, fire } = load('2004');
    win.scormFinishReturn(); fire('pagehide'); fire('unload');
    assert.strictEqual(m.data['cmi.completion_status'], 'completed');
    assert.strictEqual(Number(m.data['cmi.progress_measure']), 1);
    assert.strictEqual(m.calls.filter(c => c[0] === 'Terminate').length, 1);
    const i = m.calls.findIndex(c => c[0] === 'Terminate');
    assert.ok(m.calls.slice(0, i).some(c => c[0] === 'Commit'), 'Commit before Terminate');
  },
  '1.2: progress goes to score.raw; resume bookmark read back'() {
    const { win, m } = load('1.2', { 'cmi.core.lesson_status': 'not attempted' });
    assert.strictEqual(m.data['cmi.core.lesson_status'], 'incomplete');
    win.scormSave(3, 3, true, 4);
    assert.strictEqual(m.data['cmi.core.score.raw'], '100');
    assert.strictEqual(m.data['cmi.core.lesson_location'], '3');
    const again = load('1.2', m.data);
    assert.deepStrictEqual(again.win.scormGetBookmark(), { cur: 3, max: 3, quiz: true });
  },
  '1.2: passed status is never downgraded (kit wrapper bug)'() {
    const { win, m } = load('1.2', { 'cmi.core.lesson_status': 'passed' });
    win.scormSave(1, 1, false, 4);
    assert.strictEqual(m.data['cmi.core.lesson_status'], 'passed');
    win.scormComplete();
    assert.strictEqual(m.data['cmi.core.lesson_status'], 'passed');
  },
  'scored: progress does not overwrite a real score'() {
    const { win, m } = load('2004', {}, { SCORM_SCORED: true });
    win.scormSetScore(8, 0, 10, 7);
    win.scormSave(1, 1, false, 4);
    assert.strictEqual(m.data['cmi.score.raw'], '8');
    assert.strictEqual(m.data['cmi.score.scaled'], '0.8000');
    assert.strictEqual(m.data['cmi.success_status'], 'passed');
    assert.strictEqual(m.data['cmi.progress_measure'], '0.3333');
  },
  'scored 1.2: failing score sets failed'() {
    const { win, m } = load('1.2', {}, { SCORM_SCORED: true });
    win.scormSetScore(40, 0, 100, 80);
    assert.strictEqual(m.data['cmi.core.lesson_status'], 'failed');
  },
  'no LMS: every call is a safe no-op'() {
    const win = { addEventListener() {} };
    win.parent = win;
    vm.runInNewContext(SRC, { window: win, JSON });
    win.scormSave(1, 1, false, 3); win.scormComplete(); win.scormFinishReturn();
    assert.strictEqual(win.scormGetBookmark(), null);
    assert.strictEqual(win.scormVersion(), null);
  },
  'cross-origin parent does not stop the opener search'() {
    const m = mockApi('1.2');
    const blocked = new Proxy({}, { get() { throw new Error('SecurityError'); } });
    const win = { addEventListener() {}, opener: { API: m.api } };
    win.parent = blocked;
    vm.runInNewContext(SRC, { window: win, JSON });
    assert.strictEqual(win.scormVersion(), '1.2');
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try { fn(); console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + e.message); }
}
console.log(`\n${Object.keys(tests).length - failed}/${Object.keys(tests).length} passed`);
process.exit(failed ? 1 : 0);
