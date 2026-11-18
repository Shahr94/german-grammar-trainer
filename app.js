// Grammatik-Trainer: exercises from data/exercises.json, scheduled with FSRS (ts-fsrs).
// One FSRS card per question. Per-rule results are logged separately for the weak-spot view.
import { fsrs, generatorParameters, createEmptyCard, Rating } from './vendor/ts-fsrs.mjs';

const STORE_KEY = 'grammatik-trainer.v1';
const LEARN_AHEAD_MIN = 20; // when nothing is due, show learning cards due within this window
const STATE_REVIEW = 2;

const TYPES = {
  dynamic_cloze: 'Fill in the gaps',
  micro_translation: 'Translate / rewrite',
  syntax_sorting: 'Build the sentence',
  error_correction: 'Find the mistake',
};
const RATINGS = [
  { value: Rating.Again, name: 'Again', cls: 'again', key: '1' },
  { value: Rating.Hard, name: 'Hard', cls: 'hard', key: '2' },
  { value: Rating.Good, name: 'Good', cls: 'good', key: '3' },
  { value: Rating.Easy, name: 'Easy', cls: 'easy', key: '4' },
];

let exercises = [];
let warnings = [];
let ruleLabels = {};
let store;
let scheduler;
let session = null;
let current = null; // { q, phase: 'answer' | 'rate', check, result, suggested }
let lastFocused = null;

const app = document.getElementById('app');
const meta = document.getElementById('topbar-meta');

/* ---------- tiny DOM helper ---------- */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
// replaceChildren/append that skip null/false like h() does
const put = (parent, ...kids) => parent.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
const add = (parent, ...kids) => parent.append(...kids.flat(Infinity).filter((k) => k != null && k !== false));
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function md(s = '') {
  return escapeHtml(s.replace(/\s*\[cite:[^\]]*\]/g, ''))
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/-&gt;/g, '→');
}
const ruleName = (r) => ruleLabels[r] || r.replace(/_/g, ' ');
const today = () => new Date().toLocaleDateString('sv-SE');

/* ---------- answer checking ---------- */
const norm = (s) => s.normalize('NFC').replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim().replace(/[.,!?;:]+$/, '').trim();
const stripPunct = (s) => s.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
// returns 'exact', 'case' (right except capitalisation) or false
function matchAnswer(input, answers) {
  const a = norm(input);
  if (!a) return false;
  for (const ans of answers.filter(Boolean)) {
    const b = norm(ans);
    if (a === b) return 'exact';
    if (a.toLowerCase() === b.toLowerCase()) return 'case';
  }
  return false;
}

/* ---------- storage ---------- */
function defaultStore() {
  return { version: 1, cards: {}, logs: [], newByDay: {}, settings: { newPerDay: 10, retention: 0.9 } };
}
function loadStore() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && s.cards) return { ...defaultStore(), ...s, settings: { ...defaultStore().settings, ...s.settings } };
  } catch { /* ignore */ }
  return defaultStore();
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); }
  catch (e) { console.warn('Could not save progress', e); }
}
function makeScheduler() {
  scheduler = fsrs(generatorParameters({ enable_fuzz: true, request_retention: Number(store.settings.retention) }));
}

/* ---------- content validation ---------- */
function validate(list) {
  const w = [];
  const ids = new Set();
  list.forEach((q, i) => {
    const id = q.question_id || `#${i}`;
    if (!q.question_id) w.push(`Item ${i} has no question_id.`);
    else if (ids.has(q.question_id)) w.push(`${id}: duplicate question_id.`);
    ids.add(q.question_id);
    if (!TYPES[q.type]) { w.push(`${id}: unknown type "${q.type}" (skipped).`); return; }
    const c = q.content || {};
    if (q.type === 'dynamic_cloze') {
      const inSentence = (c.base_sentence?.match(/\{\d+\}/g) || []).sort().join();
      const defined = (c.interactions || []).map((x) => x.placeholder_id).sort().join();
      if (inSentence !== defined) w.push(`${id}: placeholders in sentence (${inSentence}) don't match interactions (${defined}).`);
    } else if (q.type === 'syntax_sorting') {
      if ([...c.shuffled_chunks].sort().join('|') !== [...c.correct_order].sort().join('|')) w.push(`${id}: shuffled_chunks and correct_order contain different chunks.`);
    } else if (q.type === 'error_correction') {
      if (findSpan(c.flawed_sentence.split(/\s+/), c.target_error) < 0) w.push(`${id}: target_error "${c.target_error}" not found in sentence.`);
    } else if (q.type === 'micro_translation') {
      if (!c.surrounding_context?.includes('[ ... ]')) w.push(`${id}: surrounding_context has no "[ ... ]" slot.`);
    }
  });
  return w;
}
function findSpan(tokens, target) {
  const t = target.split(/\s+/).map(stripPunct).join(' ').toLowerCase();
  const n = target.split(/\s+/).length;
  for (let i = 0; i + n <= tokens.length; i++) {
    if (tokens.slice(i, i + n).map(stripPunct).join(' ').toLowerCase() === t) return i;
  }
  return -1;
}

/* ---------- scheduling ---------- */
const cardOf = (q) => store.cards[q.question_id];
const dueTime = (q) => new Date(cardOf(q).due).getTime();
const newToday = () => store.newByDay[today()] || 0;
const newLeft = () => Math.max(0, Number(store.settings.newPerDay) - newToday());
const unseen = () => exercises.filter((q) => !cardOf(q));
const dueNow = (now = Date.now()) => exercises.filter((q) => cardOf(q) && dueTime(q) <= now).sort((a, b) => dueTime(a) - dueTime(b));

function pickNext(excludeId) {
  const now = Date.now();
  const ok = (q) => q.question_id !== excludeId;
  const due = dueNow(now).filter(ok);
  if (due.length) return due[0];
  if (newLeft() > 0) { const u = unseen().filter(ok); if (u.length) return u[0]; }
  const ahead = now + LEARN_AHEAD_MIN * 60000;
  const soon = exercises
    .filter((q) => ok(q) && cardOf(q) && cardOf(q).state !== STATE_REVIEW && dueTime(q) <= ahead)
    .sort((a, b) => dueTime(a) - dueTime(b));
  return soon[0] || null;
}
function formatInterval(ms) {
  const m = ms / 60000;
  if (m < 60) return `${Math.max(1, Math.round(m))} min`;
  const hrs = m / 60;
  if (hrs < 24) return `${Math.round(hrs)} h`;
  const d = hrs / 24;
  if (d < 30) return `${Math.round(d)} d`;
  if (d < 365) return `${(d / 30).toFixed(1).replace(/\.0$/, '')} mo`;
  return `${(d / 365).toFixed(1).replace(/\.0$/, '')} y`;
}

/* ---------- home ---------- */
function renderHome() {
  session = null; current = null;
  meta.textContent = '';
  const now = Date.now();
  const due = dueNow(now).length;
  const fresh = Math.min(newLeft(), unseen().length);
  const seen = exercises.filter(cardOf).length;
  const reviewsToday = store.logs.filter((l) => new Date(l.t).toLocaleDateString('sv-SE') === today()).length;
  const upcoming = exercises.filter(cardOf).map(dueTime).filter((t) => t > now).sort((a, b) => a - b)[0];
  const canStart = due + fresh > 0 || pickNext(null);

  put(app, 
    h('section', { class: 'card' },
      h('h1', {}, 'Guten Tag!'),
      h('p', { class: 'muted' }, `${exercises.length} exercises · scheduled with FSRS (target retention ${Math.round(store.settings.retention * 100)}%)`),
      h('div', { class: 'stats' },
        stat(due, 'due now'), stat(fresh, 'new today'), stat(`${seen}/${exercises.length}`, 'started'), stat(reviewsToday, 'reviews today')),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary big', onclick: startSession, disabled: !canStart }, canStart ? `Start session (${due + fresh})` : 'All done for now'),
        !canStart && upcoming ? h('span', { class: 'muted' }, `Next review in ${formatInterval(upcoming - now)}`) : null,
        !canStart && !upcoming && unseen().length ? h('span', { class: 'muted' }, 'Daily new limit reached. Raise it in settings to learn more today.') : null),
    ),
    renderRuleTable(),
    warnings.length ? h('section', { class: 'card' },
      h('details', {}, h('summary', {}, `Content check: ${warnings.length} issue(s)`),
        h('ul', { class: 'warnings' }, warnings.map((w) => h('li', {}, w))))) : null,
    renderSettings(),
  );
}
const stat = (v, label) => h('div', { class: 'stat' }, h('b', {}, v), h('span', {}, label));

function renderRuleTable() {
  const now = new Date();
  const rules = new Map();
  for (const q of exercises) for (const r of q.target_rules || []) {
    if (!rules.has(r)) rules.set(r, { r, qs: [], attempts: [] });
    rules.get(r).qs.push(q);
  }
  for (const log of store.logs) for (const [r, ok] of Object.entries(log.rules || {})) rules.get(r)?.attempts.push(ok);
  const rows = [...rules.values()].map((x) => {
    const seenCards = x.qs.map(cardOf).filter(Boolean);
    const recall = seenCards.length ? seenCards.reduce((s, c) => s + scheduler.get_retrievability(c, now, false), 0) / seenCards.length : null;
    const recent = x.attempts.slice(-10);
    return { ...x, seen: seenCards.length, recall, acc: recent.length ? recent.filter(Boolean).length / recent.length : null, recentN: recent.length };
  }).sort((a, b) => (a.recall ?? 2) - (b.recall ?? 2) || b.qs.length - a.qs.length);

  return h('section', { class: 'card' },
    h('h2', {}, 'Grammar rules'),
    h('p', { class: 'muted small' }, 'Weakest first. Recall is FSRS’s estimate that you would answer right now; accuracy covers your last 10 attempts on that rule.'),
    h('div', { style: 'overflow-x:auto' },
      h('table', { class: 'rules' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Rule'), h('th', {}, 'Recall'), h('th', { class: 'num' }, 'Accuracy'), h('th', { class: 'num' }, 'Started'))),
        h('tbody', {}, rows.map((x) => h('tr', {},
          h('td', {}, ruleName(x.r)),
          h('td', {}, x.recall == null ? h('span', { class: 'muted' }, '–')
            : h('div', { class: `meter ${x.recall < 0.6 ? 'low' : x.recall < 0.85 ? 'mid' : ''}`, title: `${Math.round(x.recall * 100)}%` },
              h('i', { style: `width:${Math.round(x.recall * 100)}%` }))),
          h('td', { class: 'num' }, x.acc == null ? '–' : `${Math.round(x.acc * 100)}% (${x.recentN})`),
          h('td', { class: 'num' }, `${x.seen}/${x.qs.length}`),
        ))))));
}

function renderSettings() {
  const fileInput = h('input', { type: 'file', accept: 'application/json', style: 'display:none', onchange: importProgress });
  return h('section', { class: 'card settings' },
    h('details', {}, h('summary', {}, 'Settings & backup'),
      h('label', {}, 'New exercises per day',
        h('input', { type: 'number', min: 0, max: 200, value: store.settings.newPerDay,
          onchange: (e) => { store.settings.newPerDay = Math.max(0, Number(e.target.value) || 0); save(); renderHome(); } })),
      h('label', {}, 'Target retention',
        h('select', { onchange: (e) => { store.settings.retention = Number(e.target.value); save(); makeScheduler(); renderHome(); } },
          [0.8, 0.85, 0.9, 0.95].map((v) => h('option', { value: v, selected: Number(store.settings.retention) === v }, `${Math.round(v * 100)}%`)))),
      h('p', { class: 'muted small' }, 'Progress is saved in this browser only. Export a backup now and then, and import it to move to another device.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: exportProgress }, 'Export progress'),
        h('button', { class: 'btn', onclick: () => fileInput.click() }, 'Import progress'), fileInput,
        h('button', { class: 'btn', onclick: () => {
          if (confirm('Delete all progress? This cannot be undone.')) { store = defaultStore(); save(); makeScheduler(); renderHome(); }
        } }, 'Reset progress'))));
}
function exportProgress() {
  const blob = new Blob([JSON.stringify(store, null, 2)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `grammatik-progress-${today()}.json` });
  document.add(body, a); a.click(); a.remove();
}
async function importProgress(e) {
  try {
    const data = JSON.parse(await e.target.files[0].text());
    if (!data || typeof data.cards !== 'object') throw new Error('not a progress file');
    store = { ...defaultStore(), ...data, settings: { ...defaultStore().settings, ...data.settings } };
    save(); makeScheduler(); renderHome();
  } catch (err) { alert(`Import failed: ${err.message}`); }
}

/* ---------- session ---------- */
function startSession() {
  session = { done: 0, correct: 0, lastId: null };
  nextQuestion();
}
function nextQuestion() {
  const q = pickNext(session.lastId) || pickNext(null);
  if (!q) return renderDone();
  renderQuestion(q);
}
function updateMeta() {
  if (!session) return;
  const left = dueNow().length + Math.min(newLeft(), unseen().length);
  meta.textContent = `${session.done} done · ${left} left`;
}
function renderDone() {
  current = null;
  meta.textContent = '';
  put(app, h('section', { class: 'card' },
    h('h1', {}, 'Fertig! 🎉'),
    h('p', {}, `You did ${session.done} exercise(s) and got ${session.correct} right.`),
    h('button', { class: 'btn primary', onclick: renderHome }, 'Back to overview')));
}

const RENDERERS = { dynamic_cloze: renderCloze, micro_translation: renderTranslation, syntax_sorting: renderSorting, error_correction: renderErrorCorrection };

function renderQuestion(q) {
  updateMeta();
  const body = h('div');
  const feedback = h('div');
  const ex = RENDERERS[q.type](q, body);
  const checkBtn = h('button', { class: 'btn primary', onclick: () => doCheck() }, 'Check');
  current = { q, phase: 'answer', ex };

  function doCheck() {
    if (current.phase !== 'answer' || !ex.ready()) return;
    const result = ex.check();
    current.result = result;
    current.phase = 'rate';
    checkBtn.remove();
    keys.remove();
    feedback.replaceChildren(renderFeedback(q, result));
    feedback.querySelector('.rate.suggested')?.focus();
  }
  current.doCheck = doCheck;

  const card = cardOf(q);
  const keys = ex.typing ? umlautKeys() : h('span');
  put(app, h('section', { class: 'card' },
    h('div', { class: 'ex-head' },
      h('div', {}, h('span', { class: 'tag type' }, TYPES[q.type]), (q.target_rules || []).map((r) => h('span', { class: 'tag' }, ruleName(r)))),
      h('span', { class: 'muted small' }, `${q.difficulty_level || ''} · ${card ? 'review' : 'new'}`)),
    body, keys,
    h('div', { class: 'row' }, checkBtn),
    feedback));
  ex.focus?.();
}

function renderFeedback(q, result) {
  const verdict = result.correct
    ? (result.near ? h('div', { class: 'verdict near' }, '✓ Correct', result.hintUsed ? ' (with hint)' : '', result.caseOnly ? ' – check capitalisation' : '')
      : h('div', { class: 'verdict ok' }, '✓ Correct'))
    : h('div', { class: 'verdict bad' }, '✗ Not quite');
  const suggested = !result.correct ? Rating.Again : result.near ? Rating.Hard : Rating.Good;
  current.suggested = suggested;
  const now = new Date();
  const preview = scheduler.repeat(cardOf(q) || createEmptyCard(now), now);

  return h('div', { class: 'feedback' },
    verdict,
    result.solution ? h('div', { class: 'solution' }, result.solution) : null,
    q.content.translation ? h('p', { class: 'translation' }, q.content.translation) : null,
    q.explanation_markdown ? h('div', { class: 'explanation', html: md(q.explanation_markdown) }) : null,
    h('p', { class: 'muted small' }, 'How well did you know it? The suggestion is highlighted; pick another if the check got it wrong.'),
    h('div', { class: 'ratings' }, RATINGS.map((r) => h('button', {
      class: `rate ${r.cls}${r.value === suggested ? ' suggested' : ''}`,
      onclick: () => rate(q, r.value, result),
    }, h('b', {}, r.name), h('small', {}, formatInterval(new Date(preview[r.value].card.due) - now)), ' ', h('kbd', {}, r.key)))));
}

function rate(q, rating, result) {
  if (!current || current.phase !== 'rate') return;
  current.phase = 'done';
  const id = q.question_id;
  const now = new Date();
  let card = store.cards[id];
  if (!card) {
    card = createEmptyCard(now);
    store.newByDay[today()] = newToday() + 1;
  }
  store.cards[id] = scheduler.next(card, now, rating).card;
  store.logs.push({ id, t: now.toISOString(), rating, correct: result.correct, rules: result.perRule });
  save();
  session.done++;
  if (result.correct) session.correct++;
  session.lastId = id;
  nextQuestion();
}

/* ---------- exercise types ---------- */
function textWithBreaks(str) {
  return str.split(' | ').flatMap((part, i) => (i ? [h('br'), part] : [part]));
}
function autoGrow(inp) {
  const fit = () => { inp.style.width = `${Math.max(5, (inp.value || inp.placeholder).length + 2)}ch`; };
  inp.addEventListener('input', fit);
  fit();
  return fit;
}
function textInput(extra = {}) {
  const inp = h('input', { class: 'blank', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', ...extra });
  inp.addEventListener('focus', () => { lastFocused = inp; });
  return inp;
}
function umlautKeys() {
  return h('div', { class: 'keys', 'aria-label': 'Special characters' }, ['ä', 'ö', 'ü', 'ß', 'Ä', 'Ö', 'Ü'].map((ch) => h('button', {
    type: 'button', tabindex: -1,
    onmousedown: (e) => e.preventDefault(),
    onclick: () => {
      const inp = lastFocused && document.contains(lastFocused) && !lastFocused.disabled ? lastFocused : null;
      if (!inp) return;
      const s = inp.selectionStart ?? inp.value.length, e = inp.selectionEnd ?? s;
      inp.value = inp.value.slice(0, s) + ch + inp.value.slice(e);
      inp.setSelectionRange(s + 1, s + 1);
      inp.dispatchEvent(new Event('input'));
      inp.focus();
    },
  }, ch)));
}
function rulesFor(q, perRule, overall) {
  for (const r of q.target_rules || []) if (!(r in perRule)) perRule[r] = overall;
  return perRule;
}

function renderCloze(q, body) {
  const c = q.content;
  const byPh = new Map(c.interactions.map((it) => [it.placeholder_id, it]));
  const blanks = [];
  let hintUsed = false;
  const parts = c.base_sentence.split(/(\{\d+\})/).map((p) => {
    const it = byPh.get(p);
    if (!it) return textWithBreaks(p);
    const inp = textInput({ 'aria-label': `Gap ${p}` });
    const fit = autoGrow(inp);
    const hintBtn = it.hint ? h('button', { class: 'hint-btn', type: 'button', title: 'Show hint', onclick: () => {
      inp.placeholder = it.hint; fit(); hintUsed = true; hintBtn.disabled = true; inp.focus();
    } }, '?') : null;
    blanks.push({ inp, it });
    return h('span', { class: 'blank-wrap' }, inp, hintBtn);
  });
  add(body, h('p', { class: 'instruction' }, 'Fill in the gaps. Tap ? for a hint.'), h('p', { class: 'sentence' }, parts));
  return {
    typing: true,
    focus: () => blanks[0]?.inp.focus(),
    ready: () => true,
    check() {
      let all = true, caseOnly = false;
      const perRule = {};
      for (const { inp, it } of blanks) {
        const m = matchAnswer(inp.value, [it.correct_answer, ...(it.accepted_answers || [])]);
        if (m === 'case') caseOnly = true;
        all = all && !!m;
        if (it.rule_trigger) perRule[it.rule_trigger] = (perRule[it.rule_trigger] ?? true) && !!m;
        inp.disabled = true;
        inp.classList.add(m ? 'ok' : 'bad');
        if (!inp.value) inp.value = '—';
        if (m !== 'exact') inp.parentElement.after(h('span', { class: 'fix' }, it.correct_answer));
      }
      return { correct: all, near: hintUsed || caseOnly, hintUsed, caseOnly, perRule: rulesFor(q, perRule, all) };
    },
  };
}

function renderTranslation(q, body) {
  const c = q.content;
  const inp = textInput({ class: 'blank wide', 'aria-label': 'Your answer', placeholder: 'Type your answer…' });
  const [before, after] = c.surrounding_context.includes('[ ... ]') ? c.surrounding_context.split('[ ... ]') : [c.surrounding_context, ''];
  const showContext = (before + after).replace(/[\s.!?]/g, '').length > 0;
  add(body, 
    h('p', { class: 'prompt' }, c.native_prompt),
    showContext ? h('p', { class: 'sentence' }, before, h('span', { class: 'muted' }, '[ … ]'), after) : null,
    inp);
  return {
    typing: true,
    focus: () => inp.focus(),
    ready: () => true,
    check() {
      const m = matchAnswer(inp.value, [c.correct_translation, ...(c.accepted_translations || [])]);
      inp.disabled = true;
      inp.classList.add(m ? 'ok' : 'bad');
      const full = h('span', {}, before, h('mark', {}, c.correct_translation), after);
      return {
        correct: !!m, near: m === 'case', caseOnly: m === 'case',
        solution: m === 'exact' ? null : h('div', {}, h('span', { class: 'muted' }, 'Answer: '), full),
        perRule: rulesFor(q, {}, !!m),
      };
    },
  };
}

function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function renderSorting(q, body) {
  const c = q.content;
  let pool = c.shuffled_chunks.map((t, i) => ({ t, i }));
  for (let n = 0; n < 5; n++) { pool = shuffled(pool); if (pool.map((x) => x.t).join() !== c.correct_order.join()) break; }
  const answer = [];
  let locked = false;
  const zone = h('div', { class: 'zone', 'aria-label': 'Your sentence' });
  const poolEl = h('div', { class: 'pool' });
  const draw = () => {
    zone.replaceChildren(...(answer.length ? answer.map((x, k) => h('button', { class: 'chip', disabled: locked, onclick: () => { answer.splice(k, 1); pool.push(x); draw(); } }, x.t))
      : [h('span', { class: 'muted small' }, 'Tap the pieces below in the right order.')]));
    poolEl.replaceChildren(...pool.map((x, k) => h('button', { class: 'chip', disabled: locked, onclick: () => { pool.splice(k, 1); answer.push(x); draw(); } }, x.t)));
  };
  draw();
  add(body, h('p', { class: 'instruction' }, 'Build the sentence.'), zone, poolEl);
  return {
    typing: false,
    ready: () => pool.length === 0,
    check() {
      locked = true; draw();
      const ok = answer.every((x, k) => x.t === c.correct_order[k]);
      [...zone.children].forEach((el, k) => el.classList.add(answer[k].t === c.correct_order[k] ? 'ok' : 'bad'));
      return {
        correct: ok, near: false,
        solution: ok ? null : h('div', {}, h('span', { class: 'muted' }, 'Correct: '), h('mark', {}, c.correct_order.join(' '))),
        perRule: rulesFor(q, {}, ok),
      };
    },
  };
}

function renderErrorCorrection(q, body) {
  const c = q.content;
  const tokens = c.flawed_sentence.split(/\s+/);
  const selected = new Set();
  const tokenEls = tokens.map((t, i) => h('button', { class: 'token', type: 'button', onclick: (e) => {
    selected.has(i) ? selected.delete(i) : selected.add(i);
    e.currentTarget.classList.toggle('sel');
  } }, t));
  const inp = textInput({ class: 'blank wide', 'aria-label': 'Correction', placeholder: 'Type the correct form…' });
  add(body, 
    h('p', { class: 'instruction' }, 'Tap the wrong word(s), then type the correct form.'),
    h('p', { class: 'tokens' }, tokenEls.flatMap((el, i) => (i ? [' ', el] : [el]))),
    inp);
  return {
    typing: true,
    ready: () => true,
    check() {
      const start = findSpan(tokens, c.target_error);
      const n = c.target_error.split(/\s+/).length;
      const actual = new Set(start < 0 ? [] : Array.from({ length: n }, (_, k) => start + k));
      const spotOk = selected.size === actual.size && [...selected].every((i) => actual.has(i));
      const m = matchAnswer(inp.value, [c.correct_replacement, ...(c.accepted_replacements || [])]);
      tokenEls.forEach((el, i) => { el.disabled = true; if (actual.has(i)) el.classList.add('actual'); });
      inp.disabled = true;
      inp.classList.add(m ? 'ok' : 'bad');
      const last = tokens[start + n - 1] || '';
      const trailing = last.slice(stripPunct(last).length + last.indexOf(stripPunct(last)));
      const fixed = start < 0 ? null : h('span', {},
        tokens.slice(0, start).join(' '), start ? ' ' : '', h('mark', {}, c.correct_replacement), trailing,
        start + n < tokens.length ? ' ' : '', tokens.slice(start + n).join(' '));
      const correct = spotOk && !!m;
      return {
        correct, near: correct && m === 'case', caseOnly: m === 'case',
        solution: h('div', {},
          !spotOk ? h('div', { class: 'muted' }, 'The mistake is highlighted in red above.') : null,
          fixed ? h('div', {}, h('span', { class: 'muted' }, 'Corrected: '), fixed) : null),
        perRule: rulesFor(q, {}, correct),
      };
    },
  };
}

/* ---------- keyboard ---------- */
document.addEventListener('keydown', (e) => {
  if (!current) return;
  if (current.phase === 'answer' && e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
    e.preventDefault();
    current.doCheck();
  } else if (current.phase === 'rate') {
    const r = RATINGS.find((x) => x.key === e.key);
    if (r) { e.preventDefault(); rate(current.q, r.value, current.result); }
    else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); rate(current.q, current.suggested, current.result); }
  }
});
document.getElementById('home-link').addEventListener('click', renderHome);

/* ---------- boot ---------- */
async function boot() {
  store = loadStore();
  makeScheduler();
  try {
    const res = await fetch('data/exercises.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = await res.json();
    warnings = validate(list);
    exercises = list.filter((q) => q.question_id && TYPES[q.type]);
    ruleLabels = await fetch('data/rules.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  } catch (err) {
    put(app, h('section', { class: 'card' },
      h('h2', {}, 'Could not load exercises'),
      h('p', {}, `data/exercises.json failed to load (${err.message}).`),
      h('p', { class: 'muted' }, 'If you opened index.html by double-clicking, run a local server instead, e.g. "python3 -m http.server" in this folder, then open http://localhost:8000.')));
    return;
  }
  renderHome();
}
boot();
