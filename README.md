# Grammatik-Trainer

A personal German grammar trainer. Reviews are scheduled with FSRS (the vendored [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs) library), and progress syncs between devices through a private GitHub Gist.

## Run it locally

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000. Double-clicking `index.html` does not work, because the browser blocks loading the JSON files.

## Adding a lesson

1. Save the exercises as `data/lessons/<name>.json`, in the same format as `passiv-ersatz.json`.
2. Add a line for it to `data/lessons.json`:
   `{ "id": "<name>", "title": "Readable title", "file": "lessons/<name>.json" }`
3. Optionally, add display names for new rule ids to `data/rules.json`.
4. Check the content:
   ```bash
   node tools/check-content.mjs
   ```

Question ids only need to be unique within their own file, because progress is stored as `<lesson id>/<question_id>`. Don't rename a lesson id once you've practised it, or its progress will no longer match.

Optional fields for other correct answers: `accepted_answers` (on a cloze gap), `accepted_translations` and `accepted_replacements`.

## How scheduling works

- **Cards:** a rule that is the first `target_rule` of 5 or more exercises gets one shared FSRS card. Each review shows a different sentence for it, the least recently seen one. Smaller rules get one card per exercise. If added lessons push a rule over 5, its new shared card starts from that rule's existing progress.
- **Checking:** capitalisation, punctuation, hyphens, spacing and ß/ss are ignored. Letters are not, because umlauts and endings are grammar (*lässt*/*lasst*).
- **Rating:** the app suggests Again if the answer is wrong, Hard if you used a hint, and Good otherwise. You can override it. Keys 1–4 pick a rating; Enter accepts the suggestion.
- **Practise:** the Practise button on each rule runs through all of that rule's exercises without changing the schedule.
- **Lessons:** you can switch whole lessons off on the home page.

## Sync

Open Settings → Sync between devices and paste a GitHub token that has only the `gist` scope. Use the same token on each device. Progress is stored in a private gist called `grammatik-trainer-progress.json` and merged on every sync: the newest review of each card wins, and no review history is lost.

## Tests

```bash
node --test tests/lib.test.mjs
```

```bash
node tools/check-content.mjs
```
