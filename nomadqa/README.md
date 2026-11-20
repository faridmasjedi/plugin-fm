# NomadQA

Testing for Salesforce, as a browser extension (Chrome and Edge). A separate product from NomadSF: its own folder,
its own build, its own releases. It shares no code with NomadSF and needs **no packages** — plain JavaScript modules
that the browser loads as they are.

## Test data (first version)

- **Plan**: objects and how many, and what goes under each (10 accounts, 3 contacts and 2 opportunities each…). Parents
  are made first and every link is filled in.
- **Field rules**: Auto (from the field's type and name: companies, people, e-mails, phones, cities, dates, amounts,
  valid picklist values), Leave empty, a fixed value, one of a list, a weighted list (`Gold 20%, Silver 80%`), a
  pattern (`INV-{0000}`, `{parent.Name}`), a range, days from today, or records found by a query. E-mails and websites
  always use `example.com`.
- **Check without saving**: the records are tried in the org inside one Apex transaction that is rolled back —
  validation rules, required fields, triggers and flows run, nothing stays. What would fail is listed with
  Salesforce's own message; leave those out or change the rules.
- **Use it**: create in the org (after typing its name), CSV files per object, an `@IsTest` test data factory class,
  or a recipe to make the same kind of data again.
- **Batches**: every record NomadQA created, by run; count what is still there and delete a batch (children first).

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

- `extension/core/` — Salesforce client, fake values, plans, the Apex check, create and delete.
- `extension/app.js`, `app.css` — the screens.
