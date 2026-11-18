// Pure logic shared by the app and the tests (no DOM, no network).

export const TYPES = {
  dynamic_cloze: 'Fill in the gaps',
  micro_translation: 'Translate / rewrite',
  syntax_sorting: 'Build the sentence',
  error_correction: 'Find the mistake',
};

// A rule with at least this many questions (as their first target_rule) gets ONE FSRS card,
// and each review picks a different question for it. Smaller rules: one card per question.
export const RULE_CARD_MIN = 5;
export const MAX_LOGS = 20000;

/* ---------- answer checking ---------- */
// Capitalisation, punctuation, hyphens, spacing and ß/ss don't count.
export function canon(s = '') {
  return String(s).normalize('NFC').toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[-‐‑–—]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
export function matches(input, answers) {
  const a = canon(input);
  return a !== '' && answers.filter(Boolean).some((ans) => canon(ans) === a);
}
export const stripPunct = (s) => s.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
export function findSpan(tokens, target) {
  const words = target.trim().split(/\s+/);
  const t = canon(words.join(' '));
  for (let i = 0; i + words.length <= tokens.length; i++) {
    if (canon(tokens.slice(i, i + words.length).join(' ')) === t) return i;
  }
  return -1;
}

/* ---------- content ---------- */
export function validateLesson(list, lessonId) {
  const w = [];
  if (!Array.isArray(list)) return [`${lessonId}: file is not a JSON array.`];
  const ids = new Set();
  list.forEach((q, i) => {
    const id = `${lessonId}/${q?.question_id || `#${i}`}`;
    if (!q?.question_id) { w.push(`${id}: missing question_id (skipped).`); return; }
    if (ids.has(q.question_id)) w.push(`${id}: duplicate question_id in this lesson (later one skipped).`);
    ids.add(q.question_id);
    if (!TYPES[q.type]) { w.push(`${id}: unknown type "${q.type}" (skipped).`); return; }
    if (!Array.isArray(q.target_rules) || !q.target_rules.length) w.push(`${id}: no target_rules.`);
    const c = q.content || {};
    try {
      if (q.type === 'dynamic_cloze') {
        const inSentence = (c.base_sentence.match(/\{\d+\}/g) || []).sort().join();
        const defined = c.interactions.map((x) => x.placeholder_id).sort().join();
        if (inSentence !== defined) w.push(`${id}: gaps in sentence (${inSentence}) don't match interactions (${defined}).`);
        c.interactions.forEach((x) => { if (!x.correct_answer) w.push(`${id}: gap ${x.placeholder_id} has no correct_answer.`); });
      } else if (q.type === 'syntax_sorting') {
        if ([...c.shuffled_chunks].sort().join('|') !== [...c.correct_order].sort().join('|')) w.push(`${id}: shuffled_chunks and correct_order contain different pieces.`);
      } else if (q.type === 'error_correction') {
        if (findSpan(c.flawed_sentence.split(/\s+/), c.target_error) < 0) w.push(`${id}: target_error "${c.target_error}" not found in flawed_sentence.`);
        if (!c.correct_replacement) w.push(`${id}: no correct_replacement.`);
      } else if (q.type === 'micro_translation') {
        if (!c.correct_translation) w.push(`${id}: no correct_translation.`);
        if (!String(c.surrounding_context || '').includes('[ ... ]')) w.push(`${id}: surrounding_context has no "[ ... ]" slot.`);
      }
    } catch (e) {
      w.push(`${id}: malformed content (${e.message}) – skipped.`);
      q.__broken = true;
    }
  });
  return w;
}
export function usableQuestions(list, lessonId) {
  const seen = new Set();
  return (Array.isArray(list) ? list : []).filter((q) => {
    if (!q?.question_id || !TYPES[q.type] || q.__broken || seen.has(q.question_id)) return false;
    seen.add(q.question_id);
    return true;
  }).map((q) => ({ ...q, key: `${lessonId}/${q.question_id}`, lesson: lessonId, target_rules: q.target_rules || [] }));
}

// Scheduling units: 'r:<rule>' for big rules, 'q:<lesson>/<id>' otherwise. Order follows the content order.
export function buildUnits(questions, min = RULE_CARD_MIN) {
  const groups = new Map();
  questions.forEach((q, i) => {
    const p = q.target_rules[0] || '';
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p).push({ q, i });
  });
  const units = [];
  for (const [rule, items] of groups) {
    if (rule && items.length >= min) units.push({ key: `r:${rule}`, kind: 'rule', rule, questions: items.map((x) => x.q), order: items[0].i });
    else for (const { q, i } of items) units.push({ key: `q:${q.key}`, kind: 'q', rule: q.target_rules[0], questions: [q], order: i });
  }
  return units.sort((a, b) => a.order - b.order);
}

/* ---------- progress store ---------- */
export function defaultStore() {
  return {
    version: 2, cards: {}, logs: [], newByDay: {}, lastShown: {},
    settings: { newPerDay: 10, retention: 0.9, disabledLessons: [] }, settingsUpdatedAt: 0,
  };
}
export function normalizeStore(s, legacyLessonId = 'passiv-ersatz') {
  const d = defaultStore();
  if (!s || typeof s !== 'object' || typeof s.cards !== 'object') return d;
  if (!s.version || s.version < 2) { // v1: cards keyed by bare question_id
    const cards = {};
    for (const [k, c] of Object.entries(s.cards)) cards[`q:${legacyLessonId}/${k}`] = c;
    const logs = (s.logs || []).map((l) => ({ ...l, unit: `q:${legacyLessonId}/${l.id}`, q: `${legacyLessonId}/${l.id}` }));
    s = { ...s, version: 2, cards, logs };
  }
  return { ...d, ...s, settings: { ...d.settings, ...(s.settings || {}) } };
}
const reviewTime = (c) => (c?.last_review ? new Date(c.last_review).getTime() : 0);
// Combine progress from two devices without losing reviews from either.
export function mergeStores(a, b) {
  a = normalizeStore(a); b = normalizeStore(b);
  const out = defaultStore();
  for (const k of new Set([...Object.keys(a.cards), ...Object.keys(b.cards)])) {
    const ca = a.cards[k], cb = b.cards[k];
    out.cards[k] = !cb ? ca : !ca ? cb : (reviewTime(cb) > reviewTime(ca) ? cb : ca);
  }
  const logs = new Map();
  for (const l of [...a.logs, ...b.logs]) logs.set(`${l.t}|${l.q}`, l);
  out.logs = [...logs.values()].sort((x, y) => (x.t < y.t ? -1 : x.t > y.t ? 1 : 0)).slice(-MAX_LOGS);
  for (const src of [a, b]) {
    for (const [d, n] of Object.entries(src.newByDay)) out.newByDay[d] = Math.max(out.newByDay[d] || 0, n);
    for (const [k, t] of Object.entries(src.lastShown)) out.lastShown[k] = Math.max(out.lastShown[k] || 0, t);
  }
  const newer = (b.settingsUpdatedAt || 0) > (a.settingsUpdatedAt || 0) ? b : a;
  out.settings = { ...newer.settings };
  out.settingsUpdatedAt = Math.max(a.settingsUpdatedAt || 0, b.settingsUpdatedAt || 0);
  return out;
}
