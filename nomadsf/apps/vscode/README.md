# NomadSF for VS Code

**A Salesforce workbench next to your code.** NomadSF Studio opens in an editor tab for the Salesforce DX project you have open: Execute Apex, SOQL, code with a compare against your repository, Apex tests with coverage, debug logs, metadata and org compare — plus data backup, restore, migration and lifecycle jobs. It works on its own: the Studio ships with the extension, uses the orgs you already logged in to with the Salesforce CLI, and logs in to new ones itself, so the CLI is optional.

![NomadSF Studio: hubs, and two side by side](https://faridmasjedi.github.io/plugin-fm/media/hubs.gif)

[Website](https://faridmasjedi.github.io/plugin-fm/) · [Guide](https://faridmasjedi.github.io/plugin-fm/guide.html) · [Releases](https://github.com/faridmasjedi/plugin-fm/releases) · [Report a problem](https://github.com/faridmasjedi/plugin-fm/issues)

## Features

- **NomadSF in the status bar.** Click **NomadSF** in the status bar to open the Studio in an editor tab. Nothing else to install or start.
- **Your orgs, no CLI needed**: the orgs logged in to with the Salesforce CLI on this computer show up by alias; **NomadSF: Log in to an org** (or Studio → Settings) logs in to a new one in your browser and saves it where the CLI keeps it, so both see it.
- **Every Studio tool**, grouped into hubs, with tools side by side and <kbd>⌘K</kbd> to jump:

  | Hub                 | Tools                                                                                                                                            |
  | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
  | **Develop**         | Code (with dependencies) · Execute Apex · Apex tests · Debug logs · Jobs · Automation · Events · REST Explorer                                   |
  | **Data**            | Query · Record (with the related tree: copy or save as Excel) · Import / Update / Delete · Compare with CSV · Lookup · Schema · Field usage      |
  | **Release**         | Project · Metadata · Deployments                                                                                                                 |
  | **Access**          | Users · Permission sets · Permissions · Custom permissions · Groups & queues · Assigned users · Object access · Overview · Compare · Your access |
  | **Org**             | Company · Org health · Limits · Connected apps · Logins & audit · Activity                                                                       |
  | **Data protection** | Backup and restore · Lifecycle jobs with approval                                                                                                |
  | **Org to org**      | Migrate · Org compare · Access · Connected apps — for one pair of orgs, A → B                                                                    |

- **From the editor** (select text, right-click):
  - **Show all data of the selected record Id** — the record inspector for an Id in your code or logs.
  - **Run the selected SOQL in Studio** — the query from your Apex or a `.soql` file, with a filterable table.
- **Works like the browser**: ⌘C / ⌘V and right-click Cut · Copy · Paste, links (Salesforce pages open logged in), downloads with VS Code's Save dialog, backup folders with VS Code's folder picker, and every approval inside the page.
- **Ids you can copy**: one click selects an Id in any table, **⧉** copies it, **↗** opens it in Salesforce, **ⓘ** shows all its fields.
- **A guide for every tool**: the **?** on each pane (or **NomadSF: Open the guide**) opens its section, with a short recording.
- **The NomadSF app** too, when the `sf fm` plugin is installed: release runs and approvals, runbooks and AI settings (**NomadSF: Open the app**; in remote windows and Codespaces the port is forwarded for you).

![Query with a filterable table](https://faridmasjedi.github.io/plugin-fm/media/query.gif)

## What's in each hub

- **Develop**: run anonymous Apex with its log; open, compile and save code, compared with your project; run Apex tests and see coverage line by line; debug logs; what runs when a record is saved, in order (flows, triggers, validation, duplicate, assignment and workflow rules); scheduled and background jobs, and stop them.
- **Data**: SOQL with names for Ids and Excel-ready CSV; every field of a record and its field history; import, update, upsert and delete from CSV; look up a CSV column in Salesforce; an object's fields, relationships and record types; how full each field is and who can see it.
- **Data protection**: backups to a folder (incremental, scheduled every N hours / days / weeks / months, encrypted) and restore; lifecycle jobs with approval.
- **Release**: compare your project with the org and deploy, restore or delete; build a `package.xml` and a `destructiveChanges.xml`; recent deployments with their failures, and quick deploy.
- **Org to org**: choose two orgs once (A → B) for every tool of the hub: compare their metadata and deploy the differences; migrate records keeping every link; find a user in both orgs; compare users (matched by username, with or without a sandbox suffix), profiles, permission sets and groups, or all of them side by side, and copy A's access into B; who has a permission set or profile in both; connected apps, their settings and who may use them.
- **Access**: everything a user has (permission sets and groups, system permissions and what grants them, groups and queues, licenses, OAuth apps, logins); assign and remove permission sets; what a profile, permission set or group allows, and edit custom ones (and which permission sets a group holds); the assigned users of a permission set, group, license, profile, role or queue; compare two users side by side (details, profile, permission sets and groups with everything each allows, groups & queues, role and sharing, OAuth apps, logins), or two profiles, permission sets or groups; every user with what they have and their powerful permissions; who can use an object or a field, and through what; login history and setup audit trail; and what your own user may do in this org.
- **Every tool says what you are missing**: when your user lacks a permission a tool needs (for example View Setup and Configuration, or Author Apex to save code), the tool says so at the top, with the permission's name.
- **Org**: connected apps and OAuth usage; org health (risky permissions, inactive users, unused access, licenses); limits; events; REST; activity.

## Requirements

- Nothing but VS Code 1.95 or later. Orgs logged in to with the Salesforce CLI show up by themselves; without the CLI, log in with **NomadSF: Log in to an org**.
- **NomadSF: Open the app** (release runs, runbooks, AI) needs the NomadSF plugin for the Salesforce CLI, which is not published yet. Everything else works without it.

Prefer the browser? The **browser extension** offers the same Studio with your browser's Salesforce login — see the [download page](https://faridmasjedi.github.io/plugin-fm/#download).

## Getting started

1. Install the extension: download `nomadsf-vscode.vsix` from the [latest release](https://github.com/faridmasjedi/plugin-fm/releases/latest), then **Extensions → … → Install from VSIX…**.
2. Click **NomadSF** in the status bar, or run **NomadSF: Open Studio** from the Command Palette (<kbd>⇧⌘P</kbd>).
3. No org yet? Run **NomadSF: Log in to an org**, or use **Settings → Org** in the Studio.

## Keeping it up to date

The Studio ships with the extension: install a newer `nomadsf-vscode.vsix` to update it.

## Commands

| Command                                              | What it does                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| **NomadSF: Open Studio**                             | The Studio in an editor tab                                                    |
| **NomadSF: Log in to an org**                        | Log in to a production, developer or sandbox org in your browser               |
| **NomadSF: Open Studio page…**                       | Pick a tool (Query, Backup, Org compare…) and open it                          |
| **NomadSF: Open the app**                            | Release runs, approvals, runbooks, AI settings (needs the `sf fm` plugin)      |
| **NomadSF: Show all data of the selected record Id** | The record inspector for the selection (also in the editor's right-click menu) |
| **NomadSF: Run the selected SOQL in Studio**         | Query the selection (also in the editor's right-click menu)                    |
| **NomadSF: Open the guide (how to use each tool)**   | The guide on the website, a section and a recording per tool                   |
| **NomadSF: Stop the local app**                      | Stops the local app this window started                                        |

## Settings

These are for **NomadSF: Open the app** only; the Studio needs none.

| Setting             | Default | Description                                                     |
| ------------------- | ------- | --------------------------------------------------------------- |
| `nomadsf.port`      | `7007`  | Port of the local NomadSF app.                                  |
| `nomadsf.sfCommand` | `sf`    | The Salesforce CLI command (with the NomadSF plugin installed). |
| `nomadsf.autoStart` | `true`  | Start NomadSF for this workspace when it is not running.        |

## Safety and privacy

- NomadSF runs on your computer and talks to Salesforce with the CLI's login; the access token stays in the extension and never reaches the Studio page, which may only call Salesforce's `/services/` APIs.
- Every change — saving code, editing records, validating and deploying, deleting, restoring or copying data, changing permissions — asks you to type the org name first, in every org; running Apex or tests, debug logging and Log in as ask too. Production orgs are shown in red.
- Backups go to a folder you choose, optionally encrypted with your passphrase.
- AI is optional and uses the provider you connect yourself; it only fills editors or shows text.

## Versions

The VS Code extension, the browser extension and the `sf fm` plugin share one version number: each [release](https://github.com/faridmasjedi/plugin-fm/releases) ships all three.

## License

Apache-2.0. NomadSF is an independent project, not affiliated with Salesforce.
