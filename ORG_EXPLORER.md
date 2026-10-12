# Org explorer and Playwright scenarios

The **Org explorer** page of NomadSF (`sf fm dashboard`) works directly against any org authorized in your Salesforce CLI, in the spirit of Salesforce Inspector. It uses the CLI's own login and stores no credentials. Choose the org at the top of the page; production and Dev Hub orgs are marked.

## Query

- Browse objects and their fields; click a field to insert it, **All fields** writes a `SELECT` with every field (binary fields left out), **Count** writes `SELECT COUNT()`.
- Options: **Tooling API**, **Include deleted & archived** (`queryAll`), **Max rows** (2,000 / 10,000 / 50,000; pages are fetched automatically).
- Run with ⌘/Ctrl+Enter. The last 25 queries are kept in **History**.
- **Bulk export** runs the query with Bulk API 2.0 and gives you a CSV (any size, deleted rows optional).

Results appear in a table: click a header to sort, filter across all columns or per column (`=exact`, `!not`, `>10`, `<5`), record IDs open the record in Salesforce, lookups become columns like `Owner.Name`, subqueries show their record count. **Copy** (paste into a spreadsheet), **CSV** and **JSON** export what is currently filtered.

## Data (Bulk API 2.0)

- **Import / update / upsert / delete / hard delete** from a CSV file (upsert takes an external ID field). Failures are shown in the table and downloadable as CSV.
- **Delete records matching a query**: count first, then delete (or hard delete) everything the query returns.

## Users & access

- **Login history** (1–180 days) with usernames, and the **Setup audit trail** (7–180 days), both as filterable, downloadable tables.
- **Permission sets and permission set groups**: see who has one, **remove** selected assignments, or **assign** it to users found by usernames, profile, role or public group (direct members), with an optional expiration date. Users who already have it are skipped.

## Metadata

List any metadata type in the org (Metadata API), select components, and **retrieve** them into the local project (`sf project retrieve start`).

## Safety

- Every change (import, update, delete, permission change) asks you to **type the org name** to confirm; the server checks it too.
- Every change and retrieve is written to `.fm/org-activity.log` and shown on the **Activity** tab.
- Exports (`.fm/exports`) and test reports (`.fm/e2e`) get their own `.gitignore` so org data is never committed.
- The app only listens on 127.0.0.1 and refuses cross-site requests.

## Playwright scenarios

```bash
sf fm e2e init                               # playwright.config.ts, tests/e2e/fixtures.ts, tests/e2e/smoke.spec.ts
npm install --save-dev @playwright/test && npx playwright install chromium
sf fm e2e run --target-org uat               # all scenarios
sf fm e2e run --target-org uat --grep Case --headed
```

Tests log in through the org's frontdoor URL (as `sf org open` does): the fixture in `tests/e2e/fixtures.ts` opens `SF_FRONTDOOR_URL`, so scenarios never contain passwords. `SF_INSTANCE_URL` is the base URL. Results go to `.fm/e2e/results.json` and an HTML report with traces and screenshots of failures (`.fm/e2e/report`, also on the Tests tab). Set `PW_CHANNEL=chrome` to use the installed Chrome.

In a pipeline:

```yaml
- id: e2e
  uses: e2e
  with: { target-org: uat, grep: Smoke }
```

The **Tests** tab of the Org explorer runs the scenarios against the selected org and shows the last results.
