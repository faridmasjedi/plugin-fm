# NomadSF Studio

A Salesforce developer workbench in the spirit of the Developer Console and Salesforce Inspector Reloaded. One UI, several places to run it:

| Where                                            | How it reaches Salesforce                                                                  | Status  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------ | ------- |
| **NomadSF app** — `sf fm dashboard` → **Studio** | through the local server with the Salesforce CLI's login; the token never reaches the page | ✅      |
| **Browser extension** (Chrome, Edge)             | the browser's own Salesforce session (`sid` cookie of the org you are on) — no CLI needed  | ✅      |
| **VS Code extension**                            | webview, CLI login through the extension host                                              | planned |
| **Desktop app** (Electron)                       | CLI login through the main process                                                         | planned |

## Features

- **Execute Anonymous** — Monaco editor with Apex highlighting and snippets (`debug`, `query`, `for`, `try`, `limits`), log level presets, run all (⌘/Ctrl+Enter) or the selection (⌘/Ctrl+Shift+Enter), compile errors marked on the line, history of the last 20 snippets.
- **Debug Logs** — turn debug logging on for yourself for 30 min / 1 h (trace flag with a `NomadSF` debug level, extended if one is active), list logs (only mine / everyone, auto-refresh), open, download, delete.
- **Log viewer** — Debug messages, every event (filter by type), governor limits with usage bars, raw log; SOQL / DML / error counts.
- **Query** — SOQL editor with autocomplete of objects (after `FROM`) and fields of the main object (also with subqueries), Tooling API, deleted & archived rows, up to 50,000 rows, "All fields", history; results in a sortable table with per-column filters (`=exact`, `!not`, `>10`, `<5`), record links, Copy / CSV / JSON.
- **Data (Bulk API 2.0)** — export any query to CSV (incl. deleted & archived) with a preview table; insert / update / upsert / delete / hard delete from a CSV file with a preview, success and failure CSVs; delete every record a query returns (count first).
- **Users & access** — login history (1–180 days) with usernames, setup audit trail, permission sets and permission set groups: see assignees, remove selected, assign to users found by usernames, profile, role or public group, with an optional expiry.
- **Activity** — every export and change made with the Studio, kept in this browser.
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

The extension asks for `cookies` and access to Salesforce domains only (`*.salesforce.com`, `*.force.com`, `*.salesforce-setup.com`, `*.cloudforce.com`, `*.site.com`). It reads the `sid` cookie of the org you are on and calls the Salesforce API with it, like Salesforce Inspector does. Nothing is sent anywhere else.

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
