# Notes for Claude Code

- Owner's standing instruction: **always fix problems you encounter** (code or content), then report what you fixed.
- Answer checking: spelling and punctuation must not matter. Ignore case, punctuation, hyphens, spacing and ß/ss. Do not ignore letters, since umlauts and endings are the grammar being tested.
- The owner keeps adding lessons as JSON in the existing format. When given a new one:
  1. Save it as `data/lessons/<name>.json` and register it in `data/lessons.json`.
  2. Add labels for new rule ids to `data/rules.json`.
  3. Review the German. Fix wrong items, add `accepted_answers` for valid alternatives, and fix rule tags that don't match what a gap tests.
  4. Run `node tools/check-content.mjs` and `node --test tests/lib.test.mjs`.
- Never rename an existing lesson id or question_id, because progress is keyed by them.
- Static site with no build step. It is deployed to GitHub Pages from `main` (repository root).
