# NomadSF Studio

A Salesforce developer workbench in the spirit of the Developer Console and Salesforce Inspector Reloaded. One UI, several places to run it:

| Where                                            | How it reaches Salesforce                                                                  | Status  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------ | ------- |
| **NomadSF app** — `sf fm dashboard` → **Studio** | through the local server with the Salesforce CLI's login; the token never reaches the page | ✅      |
| **Browser extension** (Chrome, Edge)             | the browser's own Salesforce session (`sid` cookie of the org you are on) — no CLI needed  | ✅      |
| **VS Code extension**                            | webview, CLI login through the extension host                                              | planned |
| **Desktop app** (Electron)                       | CLI login through the main process                                                         | planned |

## Features

- **Settings** — **Org**: in the extension, every org you are logged in to in this browser (its own Salesforce login: no CLI, nothing stored), with name, type (production, developer, sandbox, scratch) and whether the login still works; **Use** switches the Studio, **Log in to … ↗** opens the Salesforce login to add one (it appears when you come back). The header becomes an org dropdown when there are several. In the app: the Salesforce CLI's orgs. **Project**: choose the Salesforce project once and every page uses it: the NomadSF app's own project (in the app), a folder on this computer (read-only, nothing uploaded) or any GitHub repository and branch. In the extension, also **Use the NomadSF CLI app on this computer** (off by default, so the extension never contacts it) and its port.
- **Project** — a dashboard of the chosen project (with **Change** to go to Settings), in two tabs. **Overview**: components, package directories, manifests, API version and branch; click a type for its components or **Add all to package**; click a manifest to load it into Metadata. **Compare with the org**: tick the metadata types (or All) and compare them in one table (in both / only in org / only in project; components of installed packages and other namespaces are left out). Tick rows, then:
  - **Restore into project** (only in org): retrieves them into the project on this computer (needs the NomadSF CLI app).
  - **Download zip** of what is in the org.
  - **Delete from org** (only in org): a destructive deploy run from the browser, so it works in the extension too.
  - **Deploy to org** (in the project): `sf project deploy start` through the CLI app.
  - Delete and Deploy choose the tests (no tests in sandboxes only, specific classes, all local, all in org) and **Validate only** (on by default); a successful validation offers **Quick deploy**. Component and test failures are listed; everything asks for the org name and goes to Activity.
- **Execute Anonymous** — Monaco editor with Apex highlighting and snippets (`debug`, `query`, `for`, `try`, `limits`), log level presets, run all (⌘/Ctrl+Enter) or the selection (⌘/Ctrl+Shift+Enter), compile errors marked on the line, history of the last 20 snippets.
- **Code** — the Developer Console editor for every kind of source code the Tooling API can edit: Apex classes, triggers, Visualforce pages and components, LWC and Aura bundles (filterable lists; Monaco with Apex / JavaScript / HTML / CSS / XML colouring). **Check** compiles without saving; **Save** compiles and saves Apex and Visualforce (MetadataContainer, like the Developer Console) with problems marked on the line; LWC and Aura files save one by one (unsaved files marked •). **New …** creates any of them from a starter template (a trigger asks for its object; an LWC gets its .js and .html, Aura its .cmp and controller). Every create and save asks for the org name and goes to Activity. In production Salesforce only accepts Apex and Visualforce through a deployment, so their Save and New are off there (Developer Edition orgs allow them). Configuration metadata (flows, objects, layouts…) is XML, not code: use the Metadata page for it.
- **Apex tests** — finds the org's test classes, runs the selected ones or all local tests (asynchronously, with progress), failures first with message and stack trace. **Code coverage**: org-wide percentage against the 75 % production rule, every class and trigger by coverage, and the source with covered lines green and uncovered red.
- **Debug Logs** — turn debug logging on for yourself for 30 min / 1 h (trace flag with a `NomadSF` debug level, extended if one is active), list logs (only mine / everyone, auto-refresh), open, download, delete.
- **Log viewer** — Debug messages, every event (filter by type), governor limits with usage bars, raw log; SOQL / DML / error counts.
- **Query** — SOQL editor with autocomplete of objects (after `FROM`) and fields of the main object (also with subqueries), Tooling API, deleted & archived rows, up to 50,000 rows, "All fields", history, **saved queries** (named; click to load, × to delete; Export / Import as `nomadsf-queries.json`, or **From project** to load the team's file from the repository root); results in a sortable table with per-column filters (`=exact`, `!not`, `>10`, `<5`), record links, Copy / CSV / JSON.
- **Record** — Salesforce Inspector's "Show all data": paste an Id, a record URL or a username; every field with label, API name, type and value; filter, only filled fields, follow lookups, recent records. **Edit** changes fields inline (picklists and checkboxes as such); only changed fields are saved, after you type the org name. Users: **Log in as this user**. Every Id in a result table has an ⓘ that opens it here, and the extension popup offers **Show all data of this record** on a record page.
- **Field usage** — choose the object (custom fields only, or all); click a field for two tabs. **Usage**: count its filled values and see which components use it (custom fields). **Access**: every profile, permission set and permission set group with Read & edit / Read only / No access; click a tile to list that level and filter by kind (repeated names show their licence). **Count all** counts every field in the list.
- **Events** — listen to Platform Events, Change Data Capture (all changes or per object) and PushTopics live, new events only or replaying the last 72 hours; payload of each event; publish a platform event from JSON (asks for the org name). In the app the stream goes through the local app (which keeps Salesforce's streaming cookie); in the extension it uses the browser session.
- **Org limits** — every limit of `/limits` with used, max and a usage bar, most used first.
- **REST Explorer** — any `/services/` call (`vXX.X` = latest version) with formatted JSON, timing and API usage; links in the answer are clickable. POST / PATCH / PUT / DELETE ask for the org name and go to Activity.
- **Names for Ids** (Query, off by default) — tick it to add name columns next to Id columns SOQL cannot follow, e.g. `LoginHistory.UserId → Name` and `→ Username`, or a polymorphic `WhoId → Name`. Read-only: one extra query per 200 different Ids (at most 20,000 per result); the names are shown and exported with loaded rows, not in Bulk API exports.
- **Data (Bulk API 2.0)** — two tabs. **From a CSV file**: upload, edit the rows in a grid, check which columns Salesforce accepts, then insert / update / upsert / delete / hard delete only the ticked rows. **From a query**: load records with SOQL (with Id, up to 10,000), edit cells in place (formula, system and related fields are locked 🔒), **Update** sends only the changed fields of the changed records (a cleared cell empties the field), **Undo changes**, tick rows to **Delete** them; plus delete every record a query returns. Export lives on the Query page.
- **Lookup** — "VLOOKUP against Salesforce": upload a CSV, pick a column, and look its values up in any object. Ids are recognised by their prefix (e.g. ProfileId → Profile); other values are matched on a field you choose (User by Username, Contact by Email, an External Id…). Pick the fields to bring back (or all), plus related fields such as `UserLicense.Name`. You get your file back with `Column → Field` columns and a Found column (yes / no / several), and the records found; both export to CSV. Read-only, 200 values per query, the number of API calls shown before running (asks above 50). CSV only for now (Excel: Save as CSV).
- **Users & access** — five tabs. **Login history** (1–180 days, with usernames) and **Setup audit trail** (7–180 days). **Permission sets & groups**: see assignees, remove selected, assign by usernames, profile, role or public group, with an optional expiry. **Object, field & system permissions**: pick a profile, permission set or group and see its object access (read, create, edit, delete, view all, modify all), field access (per object) and user & system permissions (granted only, or all). **Users**: find a user by name, username, email or Id, then edit any field inline (typed org name), **Freeze / Unfreeze**, **Activate / Deactivate** and **Log in as**.
- **Metadata** — every metadata type of the org; list components (folder types such as reports and dashboards folder by folder), build a package that mixes types, then **Download zip** (Metadata API retrieve), **package.xml** (download / copy), or in the app **Retrieve into project** (`sf project retrieve start`).
- **Local app (extension)** — when `sf fm dashboard` runs on this machine, the extension also shows its CLI orgs and AI settings, plus E2E tests and the ✦ AI buttons; without it they are hidden. Release runs, runbooks and the repository stay in the NomadSF release app (`sf fm dashboard`). Port configurable (default 7007).
- **Tests** — Playwright scenarios of the project, run through the local app (`sf fm e2e run`), last results and the HTML report.
- **AI help** (✦, with the AI connected on the local app's AI page; keys stay in the app):
  - **Query → Write SOQL** from a plain-English question, using the org's own objects and the fields of the objects you mention.
  - **Explain with AI** on any debug log (errors, limits, likely fix; long logs are cut down to the telling lines first).
  - **Explain failures with AI** for failed Apex tests.
  - In the app: **Explain with AI** on a failed pipeline stage, and **Draft release notes** on Repository (commits and changed files since the last deployment tag).
  - Every answer shows the provider, the model and how much was sent.
- **Activity** — every export and change made with the Studio, kept in this browser.
- **Access hints** — errors that usually mean the user lacks access (insufficient access, an object or field the user cannot see, API not enabled, feature off) get a plain-language line; empty results (queries, login history, audit trail, permissions, field access) say the user may not be able to see the records.
- **Safety** — production orgs (including Dev Hubs) are shown in red, and running Apex or turning on logging there asks first. Every data or access change asks you to type the org name, in any org.

## Run it

```bash
# From the plugin repository
yarn build:studio              # builds nomadsf/ and copies the Studio into dashboard/studio
sf fm dashboard --open         # NomadSF → Studio ↗  (http://127.0.0.1:7007/studio/)
```

### Browser extension

```bash
cd nomadsf && yarn install && yarn build
```

- Chrome / Edge → `chrome://extensions` → Developer mode → **Load unpacked** → `nomadsf/apps/extension/dist`.
- Open any Salesforce page (Lightning, Setup, Classic) and click the NomadSF icon, or the small **N** tab on the right edge of the page (Alt+Shift+N).
- `nomadsf/apps/extension/nomadsf-extension-<version>.zip` is the package for the Chrome Web Store / Edge Add-ons. Every GitHub release has it attached.

The extension asks for `cookies`, access to `127.0.0.1` / `localhost` (the local NomadSF app) and to Salesforce domains only (`*.salesforce.com`, `*.force.com`, `*.salesforce-setup.com`, `*.cloudforce.com`, `*.site.com`). It reads the `sid` cookie of the org you are on and calls the Salesforce API with it, like Salesforce Inspector does. Nothing is sent anywhere else.

### VS Code

`nomadsf-vscode.vsix` (from a release or the `extension-latest` pre-release; or `yarn --cwd nomadsf/apps/vscode package`): **Extensions → … → Install from VSIX**. Needs the Salesforce CLI with plugin-fm.

- Opening a Salesforce DX project starts the local app for that workspace (or switches a running one to it), and **NomadSF** in the status bar opens the Studio in an editor tab. Everything of the app and the Studio is there: runs and approvals, orgs, runbooks, AI, and every Studio page.
- Commands (⇧⌘P → NomadSF): _Open the app_, _Open Studio_, _Open Studio page…_, _Stop the local app_. In the editor (right-click on a selection): **Show all data of the selected record Id** and **Run the selected SOQL in Studio**.
- Settings: `nomadsf.port` (7007), `nomadsf.sfCommand` (`sf`), `nomadsf.autoStart`. Works in remote windows and Codespaces (the port is forwarded).

### Desktop app

`nomadsf/apps/desktop` (Electron, kept out of the yarn workspaces so normal installs do not download Electron):

```bash
cd nomadsf/apps/desktop && npm install
npm start          # choose a Salesforce project folder; the app opens in its own window
npm run dist       # installers: dmg / zip (macOS), NSIS (Windows), AppImage (Linux)
```

It starts `sf fm dashboard` for the project on a free port, finds `sf` through your login shell's PATH (also when started from the Dock), remembers the last project (**File → Open Salesforce project…**, ⌘O to switch), and has **Go → Runs / Studio / Orgs / AI**. Only the local app opens inside the window; sign-ins and Salesforce links open in your browser. Quitting stops the local app.

## Develop

```
nomadsf/
  packages/core       Salesforce client (fetch + transports), SOAP execute anonymous, query, logs, trace flags, log parser
  packages/ui         Studio (React, Vite, Monaco bundled locally — no CDN, required for MV3)
  apps/extension      popup, background service worker, floating button, manifest + icons + store zip
```

```bash
yarn test        # core unit tests (vitest)
yarn typecheck
yarn --cwd packages/ui dev   # Studio with hot reload; /api is proxied to a running `sf fm dashboard`
```

The core talks to Salesforce through a **transport**: `proxyTransport` (NomadSF app: the local server adds the token), `fetchTransport` (extension: session id). VS Code and the desktop app will add their own transport, so the core and the UI stay the same everywhere.
