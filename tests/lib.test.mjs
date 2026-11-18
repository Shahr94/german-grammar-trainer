import test from 'node:test';
import assert from 'node:assert/strict';
import { matches, findSpan, buildUnits, mergeStores, normalizeStore, defaultStore, validateLesson, usableQuestions } from '../lib.js';

test('answers ignore case, punctuation, hyphens and ß/ss', () => {
  assert.ok(matches('ist', ['Ist']));
  assert.ok(matches('lässt sich alles lernen?', ['Lässt sich alles lernen']));
  assert.ok(matches('Ein Antiviren-Programm muss installiert werden.', ['Ein Anti-Viren-Programm muss installiert werden']));
  assert.ok(matches('abgeschlossen  werden', ['abgeschlossen werden']));
  assert.ok(matches('liesse', ['ließe']));
  assert.ok(!matches('lasst', ['lässt']), 'umlaut is grammar, not spelling');
  assert.ok(!matches('', ['x']));
  assert.ok(matches('erklärlich', ['erklärbar', 'erklärlich']));
});

test('findSpan finds multi-word errors with punctuation', () => {
  assert.equal(findSpan('der Erfolg lässt sich nicht garantiert, denn'.split(' '), 'garantiert'), 5);
  assert.equal(findSpan('ist nicht leicht zu auswechseln.'.split(' '), 'zu auswechseln'), 3);
  assert.equal(findSpan('a b c'.split(' '), 'x'), -1);
});

const q = (id, rules) => ({ key: `L/${id}`, lesson: 'L', target_rules: rules });
test('rules with 5+ questions share one card; others get one per question', () => {
  const qs = [q(1, ['a']), q(2, ['b']), q(3, ['a', 'x']), q(4, ['a']), q(5, ['a']), q(6, ['a']), q(7, ['x', 'a'])];
  const units = buildUnits(qs, 5);
  assert.deepEqual(units.map((u) => u.key), ['r:a', 'q:L/2', 'q:L/7']);
  assert.equal(units[0].questions.length, 5);
});

test('merging two devices keeps the newest card and all logs', () => {
  const a = defaultStore(), b = defaultStore();
  a.cards['q:x'] = { last_review: '2026-01-01T00:00:00Z', due: 'A' };
  b.cards['q:x'] = { last_review: '2026-01-02T00:00:00Z', due: 'B' };
  a.cards['q:only-a'] = { last_review: '2026-01-01T00:00:00Z' };
  a.logs = [{ t: '2026-01-01T00:00:00Z', q: 'x' }];
  b.logs = [{ t: '2026-01-02T00:00:00Z', q: 'x' }, { t: '2026-01-01T00:00:00Z', q: 'x' }];
  a.newByDay = { d: 3 }; b.newByDay = { d: 5 };
  a.settings.newPerDay = 20; a.settingsUpdatedAt = 10;
  b.settings.newPerDay = 7; b.settingsUpdatedAt = 5;
  const m = mergeStores(a, b);
  assert.equal(m.cards['q:x'].due, 'B');
  assert.ok(m.cards['q:only-a']);
  assert.equal(m.logs.length, 2);
  assert.equal(m.newByDay.d, 5);
  assert.equal(m.settings.newPerDay, 20);
  assert.deepEqual(mergeStores(m, m), m, 'merging is stable');
});

test('v1 progress is migrated to lesson-scoped keys', () => {
  const s = normalizeStore({ cards: { ex1_1: { due: 'x' } }, logs: [{ id: 'ex1_1', t: 't' }] });
  assert.equal(s.version, 2);
  assert.ok(s.cards['q:passiv-ersatz/ex1_1']);
});

test('validation flags broken items and skips them', () => {
  const list = [
    { question_id: 'a', type: 'dynamic_cloze', target_rules: ['r'], content: { base_sentence: 'x {1} {2}', interactions: [{ placeholder_id: '{1}', correct_answer: 'y' }] } },
    { question_id: 'b', type: 'weird', target_rules: ['r'], content: {} },
    { question_id: 'c', type: 'error_correction', target_rules: ['r'], content: {} },
  ];
  const w = validateLesson(list, 'L');
  assert.equal(w.length, 3);
  assert.deepEqual(usableQuestions(list, 'L').map((x) => x.key), ['L/a']);
});
