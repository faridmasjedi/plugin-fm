# NomadQA

Testing for Salesforce, as a browser extension (Chrome and Edge). A separate product from NomadSF: its own folder,
its own build, its own releases. It shares no code with NomadSF and needs **no packages** — plain JavaScript modules
that the browser loads as they are.

## Test data (first version)

- **Plan**: objects and how many, and what goes under each (10 accounts, 3 contacts and 2 opportunities each…). Parents
  are made first and every link is filled in.
- **Parents too**: choose a top-level object and NomadQA lists the objects it can go under (its lookups, required ones
  first); one click adds that parent above it, so those records are made too.
- **Field rules**: Auto (from the field's type and name: companies, people, e-mails, phones, cities, dates, amounts,
  valid picklist values), Leave empty, a fixed value, one of a list, a weighted list (`Gold 20%, Silver 80%`), a
  pattern (`INV-{0000}`, `{parent.Name}`), a range, days from today, or records found by a query. E-mails and websites
  always use `example.com`.
- **Check without saving**: the records are tried in the org inside one Apex transaction that is rolled back —
  validation rules, required fields, triggers and flows run, nothing stays. What would fail is listed with
  Salesforce's own message; leave those out or change the rules.
- **Use it**: create in the org (after typing its name), CSV files per object, an `@IsTest` test data factory class,
  or a recipe to make the same kind of data again.
- **Pattern rule with random added**: a field's Pattern (e.g. `Nomad`) can be the whole value, or — with “with random
  added” ticked — come first with a made-up value after it (`Nomad Oakline Logistics`), so test records are easy to find.
- **Find & clone**: find records (words in the name, or a condition), pick them, add objects under them, choose how
  many copies, and a pattern for their names — they become a preview like a plan's, so Check, Create, batches and Delete work the same. Cloning into
  another org leaves out fields it lacks and links to records of the first org.
- **Batches**: every record NomadQA created, by run, saved while it is made (Stop keeps what was made); the button at
  the top goes back to the running one. Show records per object (filters, columns, CSV/JSON), count what is still
  there and delete a batch (children first).
- **Log**: the bar at the bottom lists every action with Salesforce's own reasons for records that were not made.

## Tests

Steps name things the way a person sees them — buttons by what they say, fields by their label — never CSS or ids,
so they survive Salesforce's releases. One step engine (`extension/core/engine.js`) runs them in the browser and in
headless Chrome alike.

- **Inspector** (Alt + Shift + I on any Salesforce page): what you point at — your own LWC and its folder in the
  project, a packaged component, the field's API name, the Aura component, the record.
- **Recorder**: do it once in Salesforce; clicks, typing, list choices and lookups become steps. **+ Check** on the
  page's bar, then a message or a value, adds a check. Passwords are never recorded.
- **Tests**: edit steps, run them in a tab of the org, see each step pass or fail; download the test file.
  Steps: open, click, fill, pick, lookup, check, wait, press, expect (text, message, field, title, address), data
  (make records from a Test data recipe — `{{a-1}}` is then its Id, `{{a-1.Name}}` a value; deleted after the test)
  and query (a SOQL that must find the right number of rows).
- **Runs**: every run with its steps, and a JUnit file.
- **Agent**: say what to test; your own AI (Settings) writes the steps, NomadQA checks every step, you review and run.
  Only your sentence and the org's object names are sent to the AI.
- **Automation switch** (Test data): the org's own bypass — a hierarchy custom setting or a custom permission named
  like “bypass” — found, with which validation rules and triggers check it, turned on for you only while creating,
  then put back exactly as it was. NomadQA never changes automation itself.

### Headless (CI)

```sh
node nomadqa/runner/run.mjs nomadqa/examples/new-contact.nomadqa.json --org my-sandbox --out reports
```

Node 22 and Chrome; nothing to install. `--org` asks the Salesforce CLI for a one-time login link (or give one with
`--login-url` / `NOMADQA_LOGIN_URL`). Writes a JUnit report and a screenshot of a failed step; exits 1 when a test
fails. `--headed` shows the browser.

## Try it

1. `chrome://extensions` (or `edge://extensions`) › Developer mode › **Load unpacked** › choose
   `nomadqa/extension`.
2. Log in to a Salesforce org in the same browser, then click the NomadQA button in the toolbar.

NomadQA uses the browser's own Salesforce session (like Salesforce Inspector). Nothing is sent anywhere but to your
org, and every change asks you to type the org's name first.

## Develop

```sh
cd nomadqa
npm test            # node's own test runner
npm run icons       # draws extension/icons/*.png
npm run pack        # nomadqa-extension.zip (the system zip tool)
```

- `extension/core/` — Salesforce client, fake values, plans, the Apex check, create and delete, the step engine,
  steps and the test runner, the Agent, the automation switch.
- `extension/content/page.js` — the Inspector and the Recorder on Salesforce pages.
- `extension/app.js`, `views/`, `app.css` — the screens.
- `runner/run.mjs` — the headless runner (Chrome DevTools Protocol over Node's own WebSocket).
- `examples/` — a test to start from.
