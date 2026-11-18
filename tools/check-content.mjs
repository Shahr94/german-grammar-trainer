// Validate every lesson listed in data/lessons.json:  node tools/check-content.mjs
import { readFileSync, existsSync } from 'node:fs';
import { validateLesson, usableQuestions, buildUnits } from '../lib.js';

const root = new URL('../data/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('lessons.json', root), 'utf8'));
const rules = JSON.parse(readFileSync(new URL('rules.json', root), 'utf8'));
let problems = 0;
const all = [];
const ids = new Set();
for (const l of manifest) {
  if (ids.has(l.id)) { console.log(`✗ duplicate lesson id "${l.id}"`); problems++; }
  ids.add(l.id);
  const path = new URL(l.file, root);
  if (!existsSync(path)) { console.log(`✗ ${l.id}: file data/${l.file} not found`); problems++; continue; }
  let list;
  try { list = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { console.log(`✗ ${l.id}: invalid JSON – ${e.message}`); problems++; continue; }
  const w = validateLesson(list, l.id);
  w.forEach((x) => console.log(`✗ ${x}`));
  problems += w.length;
  const qs = usableQuestions(list, l.id);
  all.push(...qs);
  console.log(`${w.length ? '!' : '✓'} ${l.id}: ${qs.length} exercises`);
}
const missing = [...new Set(all.flatMap((q) => [...q.target_rules, ...(q.content.interactions || []).map((i) => i.rule_trigger)]))].filter((r) => r && !rules[r]);
if (missing.length) console.log(`ℹ rules without a display name in data/rules.json (shown by id): ${missing.join(', ')}`);
const units = buildUnits(all);
console.log(`→ ${all.length} exercises, ${units.length} FSRS cards (${units.filter((u) => u.kind === 'rule').map((u) => `${u.rule}×${u.questions.length}`).join(', ') || 'no rule cards'})`);
process.exit(problems ? 1 : 0);
