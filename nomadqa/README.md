# NomadQA

Testing for Salesforce, as a browser extension (Chrome and Edge). A separate product from NomadSF: its own folder,
its own build, its own releases. It shares no code with NomadSF and needs **no packages** — plain JavaScript modules
that the browser loads as they are.

## Test data (first version)

- **Plan**: objects and how many, and what goes under each (10 accounts, 3 contacts and 2 opportunities each…). Parents
  are made first and every link is filled in.
- **Records above**: next to “Records under”, “Records above” lists the objects a top-level object can go under (its
  lookups, required ones first); add one and those parent records are made too.
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
  project, a packaged component, the field's API name, the Aura component, the record. Click to pin it: **Copy**
  path / field / tag, and **Add to a test** — check its value, type into it, click it, check this text shows, start on
  this page. **Add and click it** also does the click, so you follow a link (a related record, a tab) and go on
  picking there. While the Inspector is on, a list at the bottom left shows the steps picked so far: change (✎ —
  every box of the step, as in Tests: its kind, then type and choose, how to compare, Optional…), move or remove them, **+ Find a record** (by name or a condition: adds “find it” and “open it” and opens it now), and
  **Open in Tests** to make the test. A button that opens a list (App Launcher, a list view's menu, the gear) has
  **Click, then type and choose…**: one step that clicks it, types in its list and picks an item, the list staying
  open. The panel's **Details** tab shows everything about the element — its components, the tab and section it
  sits in, its parent, its path, its attributes and place — each with a copy button. **Search and choose…** on a search bar, a list's search or a lookup (or
  Salesforce's search button): what to type and what to choose, added — and done on the page with **Add and do it**.
  The panel says what the thing is (a field, a button, Salesforce search…) and what each step does in the test; it
  copies only what helps (a field's API name, your component and its folder, what it says, a record Id). It opens
  next to what you point at, never over it; the list (and the Recorder's bar) moves to the other side (⇆) or
  wherever you drag it.
- **Setup and your personal settings**: their pages (profiles, permission sets, users…) work like any other — the Inspector, the Recorder and
  the steps reach into the frame Setup draws them in. Setup is **read-only** for NomadQA: steps open pages, search
  and check there; a click on Save, Edit, Delete, New… or a tick is refused with a clear message. The Inspector page lists every org you are logged in to with its open tabs;
  **Open and inspect** for an org without one.
- **Recorder**: do it once in Salesforce; clicks, typing, list choices, lookups and searches (typed, then a
  suggestion chosen or Enter) become steps; a click on a button that opens a list and the item chosen in it
  (App Launcher → Sales, the gear → Setup) become one step. It goes on when the page loads again (another app)
  and in a tab the page opens (Setup from the gear). A test run follows that tab too. **+ Check** on the
  page's bar, then a message or a value, adds a check. Passwords are never recorded.
- **Tests**: edit steps, run them in a tab of the org, see each step pass or fail; download the test file.
  Steps: open, click, fill, pick, lookup, check, wait, press; **search** (type in Salesforce's search at the top, a
  list's search, a lookup or any box, then choose a suggestion — or press Enter; what is not suggested, like a case
  number, is found on the results page); **expect** — text, a message, a field, the title, the
  address, text NOT shown, a button or link shown / NOT shown (permissions) — compared by contains, is, is not,
  starts with, is empty, is filled in, more than, less than, or matches (a pattern); **remember** a field's value as
  `{{name}}` for later steps; **query** (a read-only SOQL that must find the right number of rows; **save** the first
  row as `{{found}}` / `{{found.Name}}` to open it or use its values); **data** (records from a Test data recipe —
  `{{a-1}}`, `{{a-1.Name}}`; deleted after the test); **screenshot**. Any step can be **optional**: reported, but
  the test goes on. A click that opens another page waits for it.
  **Groups of steps**: tick steps (the box by their number), **Group them** — one step with a name ("Open the Sales
  app") that runs its steps one after the other, folds open and closed, and fails with the step inside it that
  failed. **⧉** copies a step or a group (also onto the clipboard, as JSON); **Paste** puts it in any test, or in a
  group. **Ungroup** gives the steps back.
  **When a test fails**: the step, why, what was **expected** and what the page had (**got**), Salesforce's messages,
  the page's address and a small picture of it (JPEG, about 100 KB, only for a failed step; Chrome asks once, from
  the failure box, for leave to take it). **Report**: one HTML page for people — every step with its time, and the
  reasons — for a passed run too; for a group run, one page for all its tests. Runs keeps the pictures of the
  newest 20 runs that have one.
  More checks: **how many** buttons (the record's own actions), tabs, fields, sections, related lists or rows — on
  the page or in one part of it ("Check there are 2 buttons"); **where a field is** (its section, row and column:
  column 1 is the left); the **record type**; the **page layout** of who is logged in. A field can be given by its
  label or its API name (`Title`, `Contact.Title`, `MobilePhone`).
  **Log in** (the login page; the username and password come from Settings › Logins, never from the test file) and
  **Log in as a user** (Salesforce's Login-As, for an admin; it needs “Administrators Can Log in as Any User”) —
  test what another user sees; at the end you are yourself again.
  **Groups**: give tests a group (Smoke, Regression…) from the list of groups there are, or **+ New group**, then
  **Run all** — one JUnit report and one HTML report for the group, and for each test that failed, its step and why.
  **✕** in the list deletes a test. One at a
  time (one tab), or 2–8 at a time, each in a window of its own; tests that log in as someone else still run alone,
  after the others (a login is the whole browser's).
  **Step by step on the page** (or **Fix it on the page** after a failed run: the steps before it run first): the
  test's steps show on the Salesforce page; ▶ runs one, ▶▶ to the end, click a step to go to it, change, move or
  remove steps, point at the page to add one before the current step, then **Save to the test**.
  **Just click** in the list on the page lets the page work as usual (menus, tabs) without picking.
- **Runs**: every run with its steps (and why it failed); download the **test** as it ran, its **Report**, its
  **JUnit** report, or one for the whole group. A JUnit report NomadQA wrote carries its steps: **Upload** it in Tests to run it again.
- **Refresh** on every screen opens it again, cleared (what was typed or shown goes; saved plans and tests stay),
  and reads the org and what NomadQA keeps again.
- **Agent**: say what to test; your own AI (Settings) writes the steps, NomadQA checks every step, you review and run.
  Only your sentence and the org's object names are sent to the AI.
- **Automation switch** (Test data): the org's own bypass — a hierarchy custom setting or a custom permission named
  like “bypass” — found, with which validation rules and triggers check it, turned on for you only while creating,
  then put back exactly as it was. NomadQA never changes automation itself.

### Headless (CI)

```sh
node nomadqa/runner/run.mjs nomadqa/examples/new-contact.nomadqa.json --org my-sandbox --out reports
node nomadqa/runner/run.mjs tests/nomadqa --group Smoke --parallel 2 --org my-sandbox
```

Node 22 and Chrome; nothing to install. Give test files, group files, or a folder (every `*.nomadqa.json` and
`*.nomadqa-group.json` in it); `--group` runs one group's tests. `--org` asks the Salesforce CLI for a one-time login
link; without the CLI (CI), `--auth-url` or `SF_AUTH_URL` takes the org's SFDX auth URL (`sf org display --verbose`,
kept in a secret), or give a link with `--login-url` / `NOMADQA_LOGIN_URL`. Writes `report.html` (for people: why
each test failed, with a picture of the page), `summary.md`, a JUnit report per test and per group, and a small
picture of each failed step; exits 1 when a test fails.

**GitHub Actions**: copy [examples/github-workflow.yml](examples/github-workflow.yml) to
`.github/workflows/nomadqa.yml` and add the secret `SF_AUTH_URL`. Engineers run every test (or one group, from
**Run workflow**) on each pull request; the summary and every failure's reason show on the run's page, and the report
is kept for 7 days. `--headed` shows the browser. It takes test files, group files and NomadQA's JUnit reports. `--parallel 4`
runs 4 tests at a time, each in a browser context of its own (its own cookies, so tests that log in run side by side
too). **Log in** steps
take their usernames and passwords from `--logins logins.json` (or `NOMADQA_LOGINS`, the same JSON):
`{ "sales-user": { "url": "https://test.salesforce.com", "username": "…", "password": "…" } }`.

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
