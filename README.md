# Grammatik-Trainer

A personal German grammar trainer. Exercises live in `data/exercises.json`, and review timing uses FSRS (via the vendored [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs) library in `vendor/`).

## Run it

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000. Opening `index.html` directly does not work, because the browser blocks loading the JSON file.

## How scheduling works

- Each question is one FSRS card. New cards are introduced in file order, up to the daily limit set in Settings.
- After you check an answer, the app suggests a rating: **Again** if wrong, **Hard** if you used a hint or only the capitalisation was wrong, **Good** otherwise. You can pick any rating, for example to override a strict check. Keys 1–4 pick a rating; Enter accepts the suggestion.
- Every answer is also logged per rule (`rule_trigger` for each gap, `target_rules` otherwise). The overview uses this to show weak rules.
- Progress is stored in the browser's localStorage. Use Settings → Export to back it up.

## Content format

Supported `type`s: `dynamic_cloze`, `micro_translation`, `syntax_sorting`, `error_correction`.

Optional fields for alternative correct answers:

| type | field |
|---|---|
| dynamic_cloze | `interactions[].accepted_answers: []` |
| micro_translation | `content.accepted_translations: []` |
| error_correction | `content.accepted_replacements: []` |

Rule display names live in `data/rules.json`. Rules missing from that file are shown by their id. `[cite: …]` markers in explanations are hidden. The overview has a "Content check" section that flags broken items, such as placeholders that don't match their interactions.
