# NomadSF for VS Code

**A Salesforce workbench next to your code.** NomadSF Studio opens in an editor tab for the Salesforce DX project you have open: Execute Apex, SOQL, code with a compare against your repository, Apex tests with coverage, debug logs, metadata and org compare — plus data backup, restore, migration and lifecycle jobs. It uses the orgs you already logged in to with the Salesforce CLI.

![NomadSF Studio: hubs, and two side by side](https://faridmasjedi.github.io/plugin-fm/media/hubs.gif)

[Website](https://faridmasjedi.github.io/plugin-fm/) · [Guide](https://faridmasjedi.github.io/plugin-fm/guide.html) · [Releases](https://github.com/faridmasjedi/plugin-fm/releases) · [Report a problem](https://github.com/faridmasjedi/plugin-fm/issues)

## Features

- **NomadSF in the status bar.** Opening a Salesforce DX project starts NomadSF for that workspace (or switches a running one to it); click **NomadSF** in the status bar to open the Studio in an editor tab.
- **Every Studio tool**, grouped into hubs, with tools side by side and <kbd>⌘K</kbd> to jump:

  | Hub                 | Tools                                                                     |
  | ------------------- | ------------------------------------------------------------------------- |
  | **Develop**         | Execute Apex · Code · Apex tests with coverage · Debug Logs               |
  | **Data**            | Query · Record · Import / Update / Delete · Lookup · Field usage          |
  | **Data protection** | Backup and restore · Migrate between orgs · Lifecycle jobs with approval  |
  | **Release**         | Project (your repository vs the org) · Metadata · Org compare · E2E tests |
  | **Org**             | Users & access · Limits · Events · REST Explorer · Activity               |

- **From the editor** (select text, right-click):
  - **Show all data of the selected record Id** — the record inspector for an Id in your code or logs.
  - **Run the selected SOQL in Studio** — the query from your Apex or a `.soql` file, with a filterable table.
- **The NomadSF app** too: release runs and approvals, orgs, runbooks and AI settings.
- **Remote windows and Codespaces**: the port is forwarded for you.
- **Works like the browser**: copy and paste, links (Salesforce pages open logged in, through the CLI), downloads with VS Code's Save dialog, and backup folders chosen with VS Code's folder picker.

![Query with a filterable table](https://faridmasjedi.github.io/plugin-fm/media/query.gif)

## Requirements

- The [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) with the NomadSF plugin:

  ```bash
  sf plugins install https://github.com/faridmasjedi/plugin-fm
  ```

- Orgs logged in to with the CLI, for example `sf org login web --alias my-sandbox`.
- A Salesforce DX project (a folder with `sfdx-project.json`).

Prefer not to install the CLI? The **browser extension** offers the same Studio with your browser's Salesforce login — see the [download page](https://faridmasjedi.github.io/plugin-fm/#download).

## Getting started

1. Install the extension: download `nomadsf-vscode.vsix` from the [latest release](https://github.com/faridmasjedi/plugin-fm/releases/latest), then **Extensions → … → Install from VSIX…**.
2. Open your Salesforce DX project. NomadSF starts in the background.
3. Click **NomadSF** in the status bar, or run **NomadSF: Open Studio** from the Command Palette (<kbd>⇧⌘P</kbd>).

## Commands

| Command                                              | What it does                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| **NomadSF: Open Studio**                             | The Studio in an editor tab                                                    |
| **NomadSF: Open Studio page…**                       | Pick a tool (Query, Backup, Org compare…) and open it                          |
| **NomadSF: Open the app (runs, orgs, runbooks, AI)** | Release runs, approvals, orgs, runbooks, AI settings                           |
| **NomadSF: Show all data of the selected record Id** | The record inspector for the selection (also in the editor's right-click menu) |
| **NomadSF: Run the selected SOQL in Studio**         | Query the selection (also in the editor's right-click menu)                    |
| **NomadSF: Stop the local app**                      | Stops NomadSF for this workspace                                               |

## Settings

| Setting             | Default | Description                                                     |
| ------------------- | ------- | --------------------------------------------------------------- |
| `nomadsf.port`      | `7007`  | Port of the local NomadSF app.                                  |
| `nomadsf.sfCommand` | `sf`    | The Salesforce CLI command (with the NomadSF plugin installed). |
| `nomadsf.autoStart` | `true`  | Start NomadSF for this workspace when it is not running.        |

## Safety and privacy

- NomadSF runs on your computer and talks to Salesforce with the CLI's login; the access token stays in the local app and never reaches the Studio page.
- Every change — saving code, editing records, deploying, deleting, restoring or copying data — asks you to type the org name first; production orgs are shown in red.
- Backups go to a folder you choose, optionally encrypted with your passphrase.
- AI is optional and uses the provider you connect yourself; it only fills editors or shows text.

## Versions

The VS Code extension, the browser extension and the `sf fm` plugin share one version number: each [release](https://github.com/faridmasjedi/plugin-fm/releases) ships all three.

## License

Apache-2.0. NomadSF is an independent project, not affiliated with Salesforce.
