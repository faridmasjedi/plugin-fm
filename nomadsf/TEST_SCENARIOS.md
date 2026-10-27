# Test scenarios: standalone VS Code extension and browser extension

Manual checks for the change that lets the VS Code extension run NomadSF Studio on its own (no Salesforce CLI, no `sf fm` plugin, no local app). The browser extension and the CLI app share the Studio code (`packages/ui`), so they get a regression pass too.

Tick each box as you go. **Use a sandbox, scratch or developer org for anything that changes data**, and keep production orgs read-only.

## Get the builds

From the PR branch:

```bash
git fetch origin && git checkout feat/vscode-standalone
yarn --cwd nomadsf install --frozen-lockfile
yarn --cwd nomadsf build                    # Studio, browser extension, VS Code extension
yarn --cwd nomadsf/apps/vscode package      # VS Code package
```

| Build                         | Where                                          | Install                                                                        |
| ----------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------ |
| VS Code extension             | `nomadsf/apps/vscode/nomadsf-vscode.vsix`      | Extensions → **…** → **Install from VSIX…**, then reload the window            |
| Browser extension (unpacked)  | `nomadsf/apps/extension/dist`                  | `chrome://extensions` → Developer mode → **Load unpacked** → choose the folder |
| Browser extension (store zip) | `nomadsf/apps/extension/nomadsf-extension.zip` | Unzip, then **Load unpacked** on the unzipped folder                           |

Remove any older NomadSF VS Code extension first (Extensions → NomadSF → Uninstall), so the new one is the one that runs.

## A. VS Code on a Mac without the Salesforce CLI

The main case: nothing installed but VS Code and the extension.

- [ ] **A1. Opens without the CLI.** Make sure `sf` is not installed (`which sf` prints nothing). Open any folder, click **NomadSF** in the status bar.
      _Expected:_ the Studio opens in an editor tab. No "Starting NomadSF…" notification, no error about `sf` or port 7007.
- [ ] **A2. No orgs yet.** With no CLI logins on this Mac, the Studio shows **"No orgs yet. Log in to one in Settings."**
- [ ] **A3. Log in from the Command Palette.** Run **NomadSF: Log in to an org** → **Production or developer org** → type an alias (e.g. `dev1`).
      _Expected:_ the browser opens Salesforce's login page; after you log in and allow access, the page says **Authentication Successful**, and VS Code shows **"NomadSF: logged in as <username>."**
- [ ] **A4. The new org appears.** Click back into the Studio tab (or **Settings → Org → Refresh**).
      _Expected:_ the org shows in the header picker as `dev1`, with your name and org name; the pill says **Production** or **Sandbox** correctly.
- [ ] **A5. Log in to a sandbox from the Studio.** Settings → Org → **Log in to a sandbox ↗**, give an alias.
      _Expected:_ the same flow on `test.salesforce.com`; the sandbox joins the list.
- [ ] **A6. Cancel a login.** Start **Log in to an org**, then press Esc at the alias box.
      _Expected:_ nothing happens, no error.
- [ ] **A7. Logins persist.** Quit VS Code fully (⌘Q), open it again, open the Studio.
      _Expected:_ both orgs are still there and the Studio reconnects to the last org used.
- [ ] **A8. Login files are the CLI's.** (Optional, if you install the CLI later.) `sf org list`
      _Expected:_ the orgs logged in to from VS Code are listed with the same aliases.

## B. VS Code on a Mac with the Salesforce CLI (no `sf fm` plugin needed)

- [ ] **B1. CLI orgs show up.** With orgs from `sf org login web`, open the Studio.
      _Expected:_ every CLI org is listed by alias (as in `sf org list`), with Dev Hub / Scratch / Sandbox / Production.
- [ ] **B2. Works without the plugin.** `sf plugins` does not list `@salesforce/plugin-fm`, and the Studio still works.
- [ ] **B3. Expired org.** An expired scratch org or revoked login shows **⚠ Session expired: log in again** in Settings → Org, with **Log in again ↗**.
      _Expected:_ **Log in again** goes straight to the browser (no alias question) and the org works afterwards.
- [ ] **B4. Switch orgs.** Pick another org in the header.
      _Expected:_ the name, user and Production/Sandbox pill change; tools use the new org.

## C. Studio tools in VS Code

Read-only checks first; the change checks need a non-production org.

- [ ] **C1. Query.** Data → Query: `SELECT Id, Name FROM Account LIMIT 5` → Run.
      _Expected:_ rows in the table; **CSV** download opens VS Code's Save dialog and saves the file.
- [ ] **C2. Record.** Open a record Id from the query (ⓘ).
      _Expected:_ all fields and the field history.
- [ ] **C3. Execute Apex.** Develop → Execute Apex: `System.debug('hello');` → Run (⌘↵).
      _Expected:_ an approval dialog (typed in production), then the log with `hello`.
- [ ] **C4. Code editor.** In Execute Apex, type `Integer abc = 1;` and then `ab` on the next line.
      _Expected:_ word suggestions (`abc`) appear, with no lag and no console warning about web workers.
- [ ] **C5. Debug logs.** Develop → Debug Logs lists logs and opens one.
- [ ] **C6. Metadata and Code.** Release → Metadata lists types; Develop → Code opens an Apex class.
- [ ] **C7. Schema and Limits.** Data → Schema describes Account; Org → Limits shows the org's limits.
- [ ] **C8. Files.** A record with a file (ContentVersion): download the file.
      _Expected:_ the Save dialog; the file opens correctly (binary content intact).
- [ ] **C9. Streaming.** Org → Events: subscribe to a platform event or PushTopic in a sandbox and publish one.
      _Expected:_ the event arrives.
- [ ] **C10. A change (sandbox).** Data → Import / Update / Delete, or edit a field on a record.
      _Expected:_ you type the org name to confirm, and the change is saved.
- [ ] **C11. Backups.** Data protection → Backup: **Choose folder**.
      _Expected:_ VS Code's folder picker; a backup writes files into that folder.
- [ ] **C12. Org to org.** Org to org → Org compare with two orgs.
      _Expected:_ both orgs connect and the comparison runs.
- [ ] **C13. Not shown in VS Code.** The **Activity** page and **Retrieve into the project** (Metadata) belong to the CLI app.
      _Expected:_ they are hidden or show nothing, with no errors.

## D. Links, clipboard and editor commands in VS Code

- [ ] **D1. Salesforce links open logged in.** On a record, click **↗ Open in Salesforce** (or any Salesforce link in the Studio).
      _Expected:_ the default browser opens **the right page**, already logged in (no login page).
- [ ] **D2. Links with a query string.** Open a Salesforce page whose address has `?…&…` (e.g. a report link or Setup page from the Studio).
      _Expected:_ the browser lands on the exact page, not on the home page.
- [ ] **D3. Other links.** The **?** guide link opens the website in the default browser.
- [ ] **D4. Copy and paste.** Select text in a table → ⌘C → paste in a VS Code file. Copy text in VS Code → ⌘V into the Query editor and into a plain field.
      _Expected:_ the text pastes **once** (not twice) in both directions.
- [ ] **D5. Right-click.** Right-click in the Query editor → Cut / Copy / Paste.
      _Expected:_ VS Code's menu, and each action works once.
- [ ] **D6. Undo and select all.** In a plain field, ⌘A then ⌘Z.
      _Expected:_ select all, then undo, as in a browser.
- [ ] **D7. Inspect the selected Id.** In a file, select an 18-character record Id → right-click → **Show all data of the selected record Id**.
      _Expected:_ the Studio opens on that record.
- [ ] **D8. Run the selected SOQL.** Select `SELECT Id FROM User LIMIT 3` in a file → right-click → **Run the selected SOQL in Studio**.
      _Expected:_ the Query page with that query filled in.
- [ ] **D9. Open Studio page.** **NomadSF: Open Studio page…** → Limits.
      _Expected:_ the Studio opens on Limits.
- [ ] **D10. Settings survive closing the tab.** Save a query, pick an org, close the NomadSF tab, reopen it.
      _Expected:_ the saved query, the chosen org and the layout are still there.

## E. "Open the app" in VS Code (needs the `sf fm` plugin)

- [ ] **E1. Without the plugin.** **NomadSF: Open the app** on a Mac without `sf`.
      _Expected:_ a clear error in a notification (with **Show output**), and the Studio keeps working.
- [ ] **E2. With the plugin.** In a Salesforce DX project with the plugin installed: **NomadSF: Open the app**.
      _Expected:_ the local app (runs, runbooks, AI) opens in the tab as before; **NomadSF: Stop the local app** stops it.
- [ ] **E3. Back to the Studio.** After E2, click **NomadSF** in the status bar.
      _Expected:_ the built-in Studio again (not the app's).

## F. Browser extension (regression)

The shared Studio code changed (how it detects where it runs, the code editor's worker, and the page address), so check:

- [ ] **F1. Loads.** Load unpacked; no errors on `chrome://extensions`.
- [ ] **F2. Opens from a Salesforce tab.** On a logged-in Salesforce tab, click the extension → open the Studio.
      _Expected:_ that org is chosen; other orgs logged in to in this browser are listed in Settings → Org.
- [ ] **F3. Code editor.** Execute Apex and Query: the editor shows, colours code, and suggests words while typing.
      _Expected:_ no errors in DevTools (right-click → Inspect → Console) about workers or the Content Security Policy.
- [ ] **F4. Page address.** Switch tools: the address ends with `#apex`, `#query`… Reload the tab.
      _Expected:_ the same tool and org come back.
- [ ] **F5. Popup shortcuts.** On a record page, the popup's inspector opens the Studio on that record (`#record=…`).
- [ ] **F6. A query and a download.** Run a query and download the CSV.
- [ ] **F7. Optional local app.** Settings → **Use the NomadSF CLI app** on/off behaves as before.

## G. The CLI app's Studio (regression, if the plugin is installed)

- [ ] **G1.** `sf fm dashboard` → open the Studio from the app.
      _Expected:_ CLI orgs listed; queries run; switching tools updates `#…` in the address; **← NomadSF** returns to the app.
- [ ] **G2.** Salesforce links open logged in (through `sf org open`).

## Notes for the results

When something fails, note the scenario number, the macOS and VS Code versions, and:

- VS Code: **View → Output → NomadSF**, and **Developer: Open Webview Developer Tools** (Console tab) while the Studio tab is focused.
- Browser: the console of the Studio tab (right-click → Inspect).
