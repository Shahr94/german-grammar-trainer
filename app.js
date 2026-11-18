// Grammatik-Trainer: lessons from data/lessons.json, scheduled with FSRS (ts-fsrs), synced via a private GitHub Gist.
import { fsrs, generatorParameters, createEmptyCard, Rating } from './vendor/ts-fsrs.mjs';
import {
  TYPES, RULE_CARD_MIN, MAX_LOGS, matches, stripPunct, findSpan, validateLesson, usableQuestions,
  buildUnits, defaultStore, normalizeStore, mergeStores,
} from './lib.js';

const STORE_KEY = 'grammatik-trainer.v1';
const SYNC_KEY = 'grammatik-trainer.sync';
const GIST_FILE = 'grammatik-trainer-progress.json';
const LEARN_AHEAD_MIN = 20; // when nothing is due, show learning cards due within this window
const STATE_REVIEW = 2;
const RATINGS = [
  { value: Rating.Again, name: 'Again', cls: 'again', key: '1' },
  { value: Rating.Hard, name: 'Hard', cls: 'hard', key: '2' },
  { value: Rating.Good, name: 'Good', cls: 'good', key: '3' },
  { value: Rating.Easy, name: 'Easy', cls: 'easy', key: '4' },
];

let lessons = [];      // [{ id, title, count }]
let questions = [];    // all usable questions, in content order
let units = [];        // scheduling units (see lib.buildUnits)
let warnings = [];
let ruleLabels = {};
let store;
let scheduler;
let session = null;    // { mode: 'review' | 'practice', done, correct, lastQ, queue?, rule? }
let current = null;    // { q, unit, phase, result, suggested, doCheck }
let view = 'home';
let lastFocused = null;
const openPanels = new Set(); // which <details> panels stay open across re-renders

const app = document.getElementById('app');
const meta = document.getElementById('topbar-meta');
const syncBadge = document.getElementById('sync-badge');

/* ---------- DOM helpers ---------- */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  add(el, children);
  return el;
}
const clean = (kids) => kids.flat(Infinity).filter((k) => k != null && k !== false)
  .map((k) => (k instanceof Node ? k : document.createTextNode(String(k))));
const put = (parent, ...kids) => parent.replaceChildren(...clean(kids));
const add = (parent, ...kids) => parent.append(...clean(kids));
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const md = (s = '') => escapeHtml(s.replace(/\s*\[cite:[^\]]*\]/g, ''))
  .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  .replace(/\*(.+?)\*/g, '<em>$1</em>')
  .replace(/-&gt;/g, '→');
const ruleName = (r) => ruleLabels[r] || r.replace(/_/g, ' ');
const today = () => new Date().toLocaleDateString('sv-SE');
const textWithBreaks = (str = '') => str.split(' | ').flatMap((part, i) => (i ? [h('br'), part] : [part]));

/* ---------- storage ---------- */
function loadStore() {
  try { return normalizeStore(JSON.parse(localStorage.getItem(STORE_KEY))); } catch { return defaultStore(); }
}
function save({ sync = true } = {}) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) { console.warn('Could not save progress', e); }
  if (sync) scheduleSync();
}
function changeSettings(patch) {
  store.settings = { ...store.settings, ...patch };
  store.settingsUpdatedAt = Date.now();
  save();
  makeScheduler();
}
function makeScheduler() {
  scheduler = fsrs(generatorParameters({ enable_fuzz: true, request_retention: Number(store.settings.retention) }));
}

/* ---------- scheduling ---------- */
const enabled = (q) => !store.settings.disabledLessons.includes(q.lesson);
const activeQs = (u) => u.questions.filter(enabled);
const activeUnits = () => units.filter((u) => activeQs(u).length);
const cardOf = (u) => store.cards[u.key];
const dueTime = (u) => new Date(cardOf(u).due).getTime();
const newToday = () => store.newByDay[today()] || 0;
const newLeft = () => Math.max(0, Number(store.settings.newPerDay) - newToday());
const unseenUnits = () => activeUnits().filter((u) => !cardOf(u));
const dueUnits = (now = Date.now()) => activeUnits().filter((u) => cardOf(u) && dueTime(u) <= now).sort((a, b) => dueTime(a) - dueTime(b));

function pickUnit(excludeKey) {
  const now = Date.now();
  const ok = (u) => u.key !== excludeKey;
  const due = dueUnits(now).filter(ok);
  if (due.length) return due[0];
  if (newLeft() > 0) { const u = unseenUnits().filter(ok); if (u.length) return u[0]; }
  const ahead = now + LEARN_AHEAD_MIN * 60000;
  return activeUnits().filter((u) => ok(u) && cardOf(u) && cardOf(u).state !== STATE_REVIEW && dueTime(u) <= ahead)
    .sort((a, b) => dueTime(a) - dueTime(b))[0] || null;
}
// For a rule card: the question seen least recently (random among ties), avoiding an immediate repeat.
function pickQuestion(unit, avoidKey) {
  let qs = activeQs(unit);
  if (qs.length > 1) qs = qs.filter((q) => q.key !== avoidKey);
  const shown = (q) => store.lastShown[q.key] || 0;
  const min = Math.min(...qs.map(shown));
  const pool = qs.filter((q) => shown(q) === min);
  return pool[Math.floor(Math.random() * pool.length)];
}
// A question's card: its own, or its rule's.
const unitOfQuestion = (q) => units.find((u) => u.questions.includes(q));

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
  view = 'home'; session = null; current = null;
  meta.textContent = '';
  const now = Date.now();
  const due = dueUnits(now).length;
  const fresh = Math.min(newLeft(), unseenUnits().length);
  const started = activeUnits().filter(cardOf).length;
  const reviewsToday = store.logs.filter((l) => !l.practice && new Date(l.t).toLocaleDateString('sv-SE') === today()).length;
  const upcoming = activeUnits().filter(cardOf).map(dueTime).filter((t) => t > now).sort((a, b) => a - b)[0];
  const canStart = !!pickUnit(null);

  put(app,
    h('section', { class: 'card' },
      h('h1', {}, 'Guten Tag!'),
      h('p', { class: 'muted' }, `${questions.filter(enabled).length} exercises · ${activeUnits().length} FSRS cards · target retention ${Math.round(store.settings.retention * 100)}%`),
      h('div', { class: 'stats' },
        stat(due, 'due now'), stat(fresh, 'new today'), stat(`${started}/${activeUnits().length}`, 'cards started'), stat(reviewsToday, 'reviews today')),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary big', onclick: startReview, disabled: !canStart }, canStart ? `Start review (${due + fresh})` : 'All done for now'),
        !canStart && upcoming ? h('span', { class: 'muted' }, `Next review in ${formatInterval(upcoming - now)}`) : null,
        !canStart && unseenUnits().length ? h('span', { class: 'muted small' }, 'Daily new limit reached – raise it in Settings to learn more today, or practise a rule below.') : null)),
    renderLessons(),
    renderRuleTable(),
    warnings.length ? h('section', { class: 'card' },
      h('details', {}, h('summary', {}, `Content check: ${warnings.length} issue(s)`),
        h('ul', { class: 'warnings' }, warnings.map((w) => h('li', {}, w))))) : null,
    renderSettings());
}
const stat = (v, label) => h('div', { class: 'stat' }, h('b', {}, v), h('span', {}, label));

function renderLessons() {
  if (lessons.length < 2) return null;
  return h('section', { class: 'card' },
    h('h2', {}, 'Lessons'),
    h('p', { class: 'muted small' }, 'Switched-off lessons are left out of reviews and new cards. Their progress is kept.'),
    lessons.map((l) => h('label', { class: 'lesson' },
      h('input', { type: 'checkbox', checked: !store.settings.disabledLessons.includes(l.id), onchange: (e) => {
        const off = new Set(store.settings.disabledLessons);
        e.target.checked ? off.delete(l.id) : off.add(l.id);
        changeSettings({ disabledLessons: [...off] });
        renderHome();
      } }),
      h('span', {}, l.title), h('span', { class: 'muted small' }, `${l.count} exercises`))));
}

function renderRuleTable() {
  const now = new Date();
  const rules = new Map();
  for (const q of questions.filter(enabled)) for (const r of q.target_rules) {
    if (!rules.has(r)) rules.set(r, { r, qs: [], attempts: [] });
    rules.get(r).qs.push(q);
  }
  for (const log of store.logs) for (const [r, ok] of Object.entries(log.rules || {})) rules.get(r)?.attempts.push(ok);
  const rows = [...rules.values()].map((x) => {
    const us = [...new Set(x.qs.map(unitOfQuestion))].filter(cardOf);
    const recall = us.length ? us.reduce((s, u) => s + scheduler.get_retrievability(cardOf(u), now, false), 0) / us.length : null;
    const recent = x.attempts.slice(-10);
    return {
      ...x, recall, ruleCard: units.some((u) => u.key === `r:${x.r}`),
      seen: x.qs.filter((q) => store.lastShown[q.key]).length,
      acc: recent.length ? recent.filter(Boolean).length / recent.length : null, recentN: recent.length,
    };
  }).sort((a, b) => (a.recall ?? 2) - (b.recall ?? 2) || b.qs.length - a.qs.length);

  return h('section', { class: 'card' },
    h('h2', {}, 'Grammar rules'),
    h('p', { class: 'muted small' }, `Weakest first. Recall = FSRS’s estimate you’d get it right now. Accuracy = your last 10 attempts. Rules marked ● have ${RULE_CARD_MIN}+ exercises and share one card: each review shows a different sentence. “Practise” runs through all of a rule’s exercises without changing the schedule.`),
    h('div', { style: 'overflow-x:auto' },
      h('table', { class: 'rules' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Rule'), h('th', {}, 'Recall'), h('th', { class: 'num' }, 'Accuracy'), h('th', { class: 'num' }, 'Seen'), h('th', {}))),
        h('tbody', {}, rows.map((x) => h('tr', {},
          h('td', {}, x.ruleCard ? h('span', { class: 'dot', title: 'One shared card for this rule' }, '● ') : null, ruleName(x.r)),
          h('td', {}, x.recall == null ? h('span', { class: 'muted' }, '–')
            : h('div', { class: `meter ${x.recall < 0.6 ? 'low' : x.recall < 0.85 ? 'mid' : ''}`, title: `${Math.round(x.recall * 100)}%` },
              h('i', { style: `width:${Math.round(x.recall * 100)}%` }))),
          h('td', { class: 'num' }, x.acc == null ? '–' : `${Math.round(x.acc * 100)}% (${x.recentN})`),
          h('td', { class: 'num' }, `${x.seen}/${x.qs.length}`),
          h('td', { class: 'num' }, h('button', { class: 'btn tiny', onclick: () => startPractice(x.r) }, 'Practise'))))))));
}

function renderSettings() {
  const fileInput = h('input', { type: 'file', accept: 'application/json', style: 'display:none', onchange: importProgress });
  return h('section', { class: 'card settings' },
    panel('sync', 'Sync between devices', renderSyncSettings()),
    panel('settings', 'Settings & backup',
      h('label', {}, 'New cards per day',
        h('input', { type: 'number', min: 0, max: 200, value: store.settings.newPerDay,
          onchange: (e) => { changeSettings({ newPerDay: Math.max(0, Number(e.target.value) || 0) }); renderHome(); } })),
      h('label', {}, 'Target retention',
        h('select', { onchange: (e) => { changeSettings({ retention: Number(e.target.value) }); renderHome(); } },
          [0.8, 0.85, 0.9, 0.95].map((v) => h('option', { value: v, selected: Number(store.settings.retention) === v }, `${Math.round(v * 100)}%`)))),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: exportProgress }, 'Export progress'),
        h('button', { class: 'btn', onclick: () => fileInput.click() }, 'Import progress'), fileInput,
        h('button', { class: 'btn', onclick: () => {
          if (confirm('Delete all progress on this device? (With sync on, other devices will bring it back – disconnect sync first to wipe it everywhere.)')) {
            store = defaultStore(); save({ sync: false }); makeScheduler(); renderHome();
          }
        } }, 'Reset progress'))));
}
function panel(id, title, ...content) {
  return h('details', { open: openPanels.has(id), ontoggle: (e) => { e.target.open ? openPanels.add(id) : openPanels.delete(id); } },
    h('summary', {}, title), content);
}
function exportProgress() {
  const blob = new Blob([JSON.stringify(store, null, 2)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `grammatik-progress-${today()}.json` });
  document.body.append(a); a.click(); a.remove();
}
async function importProgress(e) {
  try {
    const data = JSON.parse(await e.target.files[0].text());
    if (!data || typeof data.cards !== 'object') throw new Error('not a progress file');
    store = mergeStores(store, data);
    save(); makeScheduler(); renderHome();
  } catch (err) { alert(`Import failed: ${err.message}`); }
}

/* ---------- sessions ---------- */
function startReview() {
  session = { mode: 'review', done: 0, correct: 0, lastQ: null, lastUnit: null };
  nextQuestion();
}
function startPractice(rule) {
  const qs = questions.filter((q) => enabled(q) && q.target_rules.includes(rule));
  session = { mode: 'practice', rule, done: 0, correct: 0, queue: shuffled(qs), total: qs.length };
  nextQuestion();
}
function nextQuestion() {
  view = 'session';
  if (session.mode === 'practice') {
    const q = session.queue.shift();
    return q ? renderQuestion(q, null) : renderDone();
  }
  const unit = pickUnit(session.lastUnit) || pickUnit(null);
  if (!unit) return renderDone();
  renderQuestion(pickQuestion(unit, session.lastQ), unit);
}
function updateMeta() {
  if (!session) return;
  if (session.mode === 'practice') meta.textContent = `Practice · ${session.done}/${session.total}`;
  else meta.textContent = `${session.done} done · ${dueUnits().length + Math.min(newLeft(), unseenUnits().length)} left`;
}
function renderDone() {
  current = null; view = 'done';
  meta.textContent = '';
  put(app, h('section', { class: 'card' },
    h('h1', {}, 'Fertig! 🎉'),
    h('p', {}, `You did ${session.done} exercise(s) and got ${session.correct} right.`),
    h('button', { class: 'btn primary', onclick: renderHome }, 'Back to overview')));
  syncNow();
}

const RENDERERS = { dynamic_cloze: renderCloze, micro_translation: renderTranslation, syntax_sorting: renderSorting, error_correction: renderErrorCorrection };

function renderQuestion(q, unit) {
  updateMeta();
  const body = h('div');
  const feedback = h('div');
  const ex = RENDERERS[q.type](q, body);
  const checkBtn = h('button', { class: 'btn primary', onclick: () => doCheck() }, 'Check');
  const keys = ex.typing ? umlautKeys() : null;
  current = { q, unit, phase: 'answer' };

  function doCheck() {
    if (current.phase !== 'answer' || !ex.ready()) return;
    const result = ex.check();
    current.result = result;
    current.phase = session.mode === 'practice' ? 'next' : 'rate';
    checkBtn.remove();
    keys?.remove();
    put(feedback, renderFeedback(q, unit, result));
    feedback.querySelector('.rate.suggested, .next-btn')?.focus();
  }
  current.doCheck = doCheck;

  const label = session.mode === 'practice' ? `practice: ${ruleName(session.rule)}`
    : !cardOf(unit) ? 'new' : unit.kind === 'rule' ? 'review (rule card)' : 'review';
  put(app, h('section', { class: 'card' },
    h('div', { class: 'ex-head' },
      h('div', {}, h('span', { class: 'tag type' }, TYPES[q.type]), q.target_rules.map((r) => h('span', { class: 'tag' }, ruleName(r)))),
      h('span', { class: 'muted small' }, [q.difficulty_level, label].filter(Boolean).join(' · '))),
    body, keys,
    h('div', { class: 'row' }, checkBtn, h('button', { class: 'btn ghost', onclick: () => { syncNow(); renderHome(); } }, 'Exit')),
    feedback));
  ex.focus?.();
}

function renderFeedback(q, unit, result) {
  const verdict = result.correct
    ? h('div', { class: `verdict ${result.hintUsed ? 'near' : 'ok'}` }, '✓ Correct', result.hintUsed ? ' (with hint)' : '')
    : h('div', { class: 'verdict bad' }, '✗ Not quite');
  const common = [
    verdict,
    result.solution ? h('div', { class: 'solution' }, result.solution) : null,
    q.content.translation ? h('p', { class: 'translation' }, textWithBreaks(q.content.translation)) : null,
    q.explanation_markdown ? h('div', { class: 'explanation', html: md(q.explanation_markdown) }) : null,
  ];
  if (session.mode === 'practice') {
    return h('div', { class: 'feedback' }, common,
      h('button', { class: 'btn primary next-btn', onclick: () => finishPractice(q, result) }, session.queue.length ? 'Next' : 'Finish'));
  }
  const suggested = !result.correct ? Rating.Again : result.hintUsed ? Rating.Hard : Rating.Good;
  current.suggested = suggested;
  const now = new Date();
  const preview = scheduler.repeat(startingCard(unit, now), now);
  return h('div', { class: 'feedback' }, common,
    h('p', { class: 'muted small' }, 'How well did you know it? The suggestion is highlighted – pick another if the check got it wrong.'),
    h('div', { class: 'ratings' }, RATINGS.map((r) => h('button', {
      class: `rate ${r.cls}${r.value === suggested ? ' suggested' : ''}`,
      onclick: () => rate(q, unit, r.value, result),
    }, h('b', {}, r.name), h('small', {}, formatInterval(new Date(preview[r.value].card.due) - now)), ' ', h('kbd', {}, r.key)))));
}

// A new rule card continues from the newest per-question card of that rule, if one exists
// (happens when added lessons push a rule over the threshold).
function startingCard(unit, now) {
  if (cardOf(unit)) return cardOf(unit);
  if (unit.kind === 'rule') {
    const old = unit.questions.map((q) => store.cards[`q:${q.key}`]).filter(Boolean)
      .sort((a, b) => new Date(b.last_review || 0) - new Date(a.last_review || 0))[0];
    if (old) return old;
  }
  return createEmptyCard(now);
}

function logResult(q, unit, rating, result, practice) {
  const now = new Date();
  store.lastShown[q.key] = now.getTime();
  store.logs.push({ t: now.toISOString(), q: q.key, unit: unit?.key ?? null, rating: rating ?? null, correct: result.correct, rules: result.perRule, ...(practice ? { practice: true } : {}) });
  if (store.logs.length > MAX_LOGS) store.logs.splice(0, store.logs.length - MAX_LOGS);
  session.done++;
  if (result.correct) session.correct++;
  session.lastQ = q.key;
}
function rate(q, unit, rating, result) {
  if (!current || current.phase !== 'rate') return;
  current.phase = 'done';
  const now = new Date();
  if (!cardOf(unit)) store.newByDay[today()] = newToday() + 1;
  store.cards[unit.key] = scheduler.next(startingCard(unit, now), now, rating).card;
  logResult(q, unit, rating, result, false);
  session.lastUnit = unit.key;
  save();
  nextQuestion();
}
function finishPractice(q, result) {
  if (!current || current.phase !== 'next') return;
  current.phase = 'done';
  logResult(q, null, null, result, true);
  save();
  nextQuestion();
}

/* ---------- exercise types ---------- */
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
const allRules = (q, ok) => Object.fromEntries(q.target_rules.map((r) => [r, ok]));
function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
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
      let all = true;
      const perRule = {};
      for (const { inp, it } of blanks) {
        const ok = matches(inp.value, [it.correct_answer, ...(it.accepted_answers || [])]);
        all = all && ok;
        if (it.rule_trigger) perRule[it.rule_trigger] = (perRule[it.rule_trigger] ?? true) && ok;
        inp.disabled = true;
        inp.classList.add(ok ? 'ok' : 'bad');
        if (!inp.value) inp.value = '—';
        if (!ok) inp.parentElement.after(h('span', { class: 'fix' }, it.correct_answer));
      }
      // Gaps carry their own rule; target_rules no gap tests are context, not scored.
      if (!Object.keys(perRule).length) Object.assign(perRule, allRules(q, all));
      return { correct: all, hintUsed, perRule };
    },
  };
}

function renderTranslation(q, body) {
  const c = q.content;
  const inp = textInput({ class: 'blank wide', 'aria-label': 'Your answer', placeholder: 'Type your answer…' });
  const [before, after = ''] = c.surrounding_context.includes('[ ... ]') ? c.surrounding_context.split('[ ... ]') : [c.surrounding_context, ''];
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
      const ok = matches(inp.value, [c.correct_translation, ...(c.accepted_translations || [])]);
      inp.disabled = true;
      inp.classList.add(ok ? 'ok' : 'bad');
      return {
        correct: ok,
        solution: h('div', {}, h('span', { class: 'muted' }, ok ? 'Model answer: ' : 'Answer: '), before, h('mark', {}, c.correct_translation), after),
        perRule: allRules(q, ok),
      };
    },
  };
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
    put(zone, answer.length ? answer.map((x, k) => h('button', { class: 'chip', disabled: locked, onclick: () => { answer.splice(k, 1); pool.push(x); draw(); } }, x.t))
      : h('span', { class: 'muted small' }, 'Tap the pieces below in the right order.'));
    put(poolEl, pool.map((x, k) => h('button', { class: 'chip', disabled: locked, onclick: () => { pool.splice(k, 1); answer.push(x); draw(); } }, x.t)));
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
        correct: ok,
        solution: ok ? null : h('div', {}, h('span', { class: 'muted' }, 'Correct: '), h('mark', {}, c.correct_order.join(' '))),
        perRule: allRules(q, ok),
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
      const n = c.target_error.trim().split(/\s+/).length;
      const actual = new Set(start < 0 ? [] : Array.from({ length: n }, (_, k) => start + k));
      const spotOk = selected.size === actual.size && [...selected].every((i) => actual.has(i));
      const fixOk = matches(inp.value, [c.correct_replacement, ...(c.accepted_replacements || [])]);
      tokenEls.forEach((el, i) => { el.disabled = true; if (actual.has(i)) el.classList.add('actual'); });
      inp.disabled = true;
      inp.classList.add(fixOk ? 'ok' : 'bad');
      const last = tokens[start + n - 1] || '';
      const core = stripPunct(last);
      const trailing = last.slice(last.indexOf(core) + core.length);
      const fixed = start < 0 ? null : h('span', {},
        tokens.slice(0, start).join(' '), start ? ' ' : '', h('mark', {}, c.correct_replacement), trailing,
        start + n < tokens.length ? ' ' : '', tokens.slice(start + n).join(' '));
      const correct = spotOk && fixOk;
      return {
        correct,
        solution: h('div', {},
          !spotOk ? h('div', { class: 'muted' }, 'The mistake is highlighted in red above.') : null,
          fixed ? h('div', {}, h('span', { class: 'muted' }, 'Corrected: '), fixed) : null),
        perRule: allRules(q, correct),
      };
    },
  };
}

/* ---------- sync via a private GitHub Gist ---------- */
let syncState = loadSyncState();
let syncTimer = null;
let syncing = false;
let syncAgain = false;
let syncStatus = { text: '', error: false };

function loadSyncState() {
  try { return JSON.parse(localStorage.getItem(SYNC_KEY)) || {}; } catch { return {}; }
}
function saveSyncState() {
  try { localStorage.setItem(SYNC_KEY, JSON.stringify(syncState)); } catch { /* ignore */ }
}
function setSyncStatus(text, error = false) {
  syncStatus = { text, error };
  syncBadge.textContent = !syncState.token ? '' : error ? '⚠ not synced' : syncing ? '⟳ syncing' : '✓ synced';
  syncBadge.className = `sync-badge${error ? ' error' : ''}`;
  syncBadge.title = text;
  const el = document.getElementById('sync-status');
  if (el) { el.textContent = text; el.className = error ? 'sync-error' : 'muted small'; }
}
async function gh(path, opts = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${syncState.token}`, Accept: 'application/vnd.github+json', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  if (!res.ok) {
    const err = new Error(res.status === 401 ? 'token invalid or expired' : res.status === 403 ? 'token lacks the "gist" permission' : `GitHub error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}
async function findOrCreateGist() {
  if (syncState.gistId) return syncState.gistId;
  for (let page = 1; page <= 10; page++) {
    const list = await gh(`/gists?per_page=100&page=${page}`);
    const found = list.find((g) => g.files && g.files[GIST_FILE]);
    if (found) { syncState.gistId = found.id; saveSyncState(); return found.id; }
    if (list.length < 100) break;
  }
  const created = await gh('/gists', { method: 'POST', body: JSON.stringify({
    description: 'Grammatik-Trainer progress (written by the app – do not edit)', public: false,
    files: { [GIST_FILE]: { content: JSON.stringify(store) } },
  }) });
  syncState.gistId = created.id; saveSyncState();
  return created.id;
}
async function readGist(id) {
  const g = await gh(`/gists/${id}`);
  const f = g.files?.[GIST_FILE];
  if (!f) return null;
  const text = f.truncated ? await (await fetch(f.raw_url)).text() : f.content;
  return JSON.parse(text);
}
async function syncNow() {
  if (!syncState.token) return;
  clearTimeout(syncTimer);
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  setSyncStatus('Syncing…');
  try {
    const id = await findOrCreateGist();
    let remote;
    try { remote = await readGist(id); } catch (e) {
      if (e.status === 404) { syncState.gistId = null; saveSyncState(); syncing = false; return syncNow(); }
      throw e;
    }
    const remoteText = JSON.stringify(remote);
    const merged = remote ? mergeStores(store, remote) : store;
    const changedLocally = JSON.stringify(merged) !== JSON.stringify(store);
    store = merged;
    save({ sync: false });
    if (JSON.stringify(store) !== remoteText) {
      await gh(`/gists/${id}`, { method: 'PATCH', body: JSON.stringify({ files: { [GIST_FILE]: { content: JSON.stringify(store) } } }) });
    }
    syncing = false;
    setSyncStatus(`Last synced ${new Date().toLocaleTimeString()}`);
    if (changedLocally && view === 'home') { makeScheduler(); renderHome(); }
  } catch (e) {
    syncing = false;
    setSyncStatus(`Sync failed: ${e.message}`, true);
  }
  if (syncAgain) { syncAgain = false; syncNow(); }
}
function scheduleSync() {
  if (!syncState.token) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, 4000);
}
function renderSyncSettings() {
  if (syncState.token) {
    return h('div', {},
      h('p', {}, 'This device syncs with your private GitHub Gist. Progress from your other devices is merged in automatically – no reviews are lost.'),
      h('p', { id: 'sync-status', class: syncStatus.error ? 'sync-error' : 'muted small' }, syncStatus.text || 'Not synced yet.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: syncNow }, 'Sync now'),
        h('button', { class: 'btn', onclick: () => {
          if (!confirm('Stop syncing on this device? Your progress stays on this device and in the Gist.')) return;
          syncState = {}; saveSyncState(); setSyncStatus(''); renderHome();
        } }, 'Disconnect this device')));
  }
  const tokenInput = h('input', { type: 'password', placeholder: 'Paste token (starts with ghp_)', autocomplete: 'off', class: 'token-input' });
  return h('div', {},
    h('p', {}, 'Free sync for phone + laptop: progress is stored in a private Gist on your GitHub account. Do this once on each device:'),
    h('ol', { class: 'small' },
      h('li', {}, h('a', { href: 'https://github.com/settings/tokens/new?scopes=gist&description=Grammatik-Trainer%20sync', target: '_blank', rel: 'noopener' }, 'Create a GitHub token'),
        ' – only the “gist” box is ticked. Set Expiration to “No expiration” (or remember to renew it). Click “Generate token” and copy it.'),
      h('li', {}, 'Paste it here and press Connect. Use the same token on your other device.')),
    h('p', { class: 'muted small' }, 'The token can only read and write your gists – not your repositories or account. It is stored only in this browser.'),
    h('div', { class: 'row' }, tokenInput,
      h('button', { class: 'btn primary', onclick: async () => {
        const token = tokenInput.value.trim();
        if (!token) return;
        syncState = { token }; saveSyncState();
        await syncNow();
        if (syncStatus.error) { const msg = syncStatus.text; syncState = {}; saveSyncState(); alert(msg); setSyncStatus(''); }
        else { makeScheduler(); renderHome(); }
      } }, 'Connect')));
}
document.addEventListener('visibilitychange', () => { if (syncState.token) syncNow(); });

/* ---------- keyboard ---------- */
document.addEventListener('keydown', (e) => {
  if (!current) return;
  const onButton = e.target instanceof HTMLButtonElement;
  if (current.phase === 'answer' && e.key === 'Enter' && !onButton) {
    e.preventDefault(); current.doCheck();
  } else if (current.phase === 'rate') {
    const r = RATINGS.find((x) => x.key === e.key);
    if (r) { e.preventDefault(); rate(current.q, current.unit, r.value, current.result); }
    else if (e.key === 'Enter' && !onButton) { e.preventDefault(); rate(current.q, current.unit, current.suggested, current.result); }
  } else if (current.phase === 'next' && e.key === 'Enter' && !onButton) {
    e.preventDefault(); finishPractice(current.q, current.result);
  }
});
document.getElementById('home-link').addEventListener('click', () => { syncNow(); renderHome(); });

/* ---------- boot ---------- */
async function loadJson(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  try { return await res.json(); } catch (e) { throw new Error(`${path} is not valid JSON (${e.message})`); }
}
async function boot() {
  store = loadStore();
  makeScheduler();
  let manifest;
  try { manifest = await loadJson('data/lessons.json'); } catch (err) {
    put(app, h('section', { class: 'card' },
      h('h2', {}, 'Could not load lessons'),
      h('p', {}, err.message),
      h('p', { class: 'muted' }, 'If you opened index.html by double-clicking, start a local server instead ("python3 -m http.server" in this folder) and open http://localhost:8000.')));
    return;
  }
  for (const l of manifest) {
    try {
      const list = await loadJson(`data/${l.file}`);
      warnings.push(...validateLesson(list, l.id));
      const qs = usableQuestions(list, l.id);
      questions.push(...qs);
      lessons.push({ id: l.id, title: l.title || l.id, count: qs.length });
    } catch (err) { warnings.push(`Lesson "${l.id}" could not be loaded: ${err.message}`); }
  }
  units = buildUnits(questions);
  ruleLabels = await loadJson('data/rules.json').catch(() => ({}));
  renderHome();
  if (syncState.token) syncNow();
}
boot();
