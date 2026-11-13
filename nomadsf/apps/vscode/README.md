# NomadSF for VS Code

**A Salesforce workbench next to your code.** NomadSF Studio opens in an editor tab for the Salesforce DX project you have open: Execute Apex, SOQL, code with a compare against your repository, Apex tests with coverage, debug logs, metadata and org compare — plus data backup, restore, migration and lifecycle jobs. It works on its own: the Studio ships with the extension, uses the orgs you already logged in to with the Salesforce CLI, and logs in to new ones itself, so the CLI is optional.

![NomadSF Studio: hubs, and two side by side](https://faridmasjedi.github.io/plugin-fm/media/tour.gif)

[Website](https://faridmasjedi.github.io/plugin-fm/) · [Guide](https://faridmasjedi.github.io/plugin-fm/guide.html) · [Releases](https://github.com/faridmasjedi/plugin-fm/releases) · [Report a problem](https://github.com/faridmasjedi/plugin-fm/issues)

## Features

- **NomadSF in the status bar.** Click **NomadSF** in the status bar to open the Studio in an editor tab. Nothing else to install or start.
- **Your orgs, no CLI needed**: the orgs logged in to with the Salesforce CLI on this computer show up by alias; **NomadSF: Log in to an org** (or Studio → Settings) logs in to a new one in your browser and saves it where the CLI keeps it, so both see it.
- **Every Studio tool**, grouped into hubs, with tools side by side and **Search** (top right, or <kbd>⌘K</kbd>) to jump to a tool or to what you want to do:

  | Hub                  | Tools                                                                                                                                                                                                                   |
  | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | **Develop**          | Code (with dependencies) · Execute Apex · Apex tests · Debug logs · Jobs · Save order · Flows · Events · REST Explorer                                                                                                  |
  | **Data**             | Query · Record (with the related tree: copy or save as Excel) · Import / Update / Delete · Lookup · Schema · Field usage · Backup · Lifecycle                                                                           |
  | **Access**           | Users · Access sets · Groups & queues · Object access · Compare                                                                                                                                                         |
  | **Security**         | Dashboard · Timeline (everything that happened) · Event logs · Who can see a record, object, field or class, and why · Integration check (why an integration fails) · Sharing (as a tree) · Org health · Logins & audit |
  | **Org**              | Company · Limits · Licenses · Connected apps · Apps & credentials · Metadata · Deployments                                                                                                                              |
  | **Compare & Deploy** | Org ↔ Org (metadata, access, apps, copy records) · Project & git (Project, Branch ↔ Org, Branch ↔ Branch) · Org ↔ File (Open a file, Check a manifest, Compare with CSV) · Sandbox refresh                              |

- **From the editor** (select text, right-click):
  - **Show all data of the selected record Id** — the record inspector for an Id in your code or logs.
  - **Run the selected SOQL in Studio** — the query from your Apex or a `.soql` file, with a filterable table.
- **Works like the browser**: ⌘C / ⌘V and right-click Cut · Copy · Paste, links (Salesforce pages open logged in), downloads with VS Code's Save dialog, backup folders with VS Code's folder picker, and every approval inside the page.
- **Ids you can copy**: one click selects an Id in any table, **⧉** copies it, **↗** opens it in Salesforce, **ⓘ** shows all its fields.
- **A guide for every tool**: the **?** on each pane (or **NomadSF: Open the guide**) opens its section, with a short recording.

![Query with a filterable table](https://faridmasjedi.github.io/plugin-fm/media/query.gif)

## What's in each hub

- **Develop**: run anonymous Apex with its log; open, compile and save code, compared with your project; run Apex tests and see coverage line by line; debug logs; what runs when a record is saved, in order; flows to tidy (old versions, old API versions, waiting and failed interviews); scheduled and background jobs, and stop them.
- **Data**: SOQL with help, autocomplete, names for Ids and Excel-ready CSV; every field of a record and its related records; import, update, upsert and delete from CSV; look up a CSV column; an object's fields, relationships and record types; how full each field is and who can see it; backups to a folder (incremental, scheduled, encrypted) and restore; lifecycle jobs with approval.
- **Access**: everything a user has, with a snapshot or a workbook to restore them elsewhere; access sets — profiles, permission sets, groups and custom permissions: what each allows (edit custom ones), who has it, assign it; groups and queues; who can use an object or a field, by user, profile, permission set or group; compare two users, profiles, permission sets or groups.
- **Security**: a dashboard, a timeline of everything that happened, event logs, who can see a record and why, sharing as a tree, org health, logins and audit trail.
- **Org**: company, limits, licenses (and who holds one without using it: freeze, deactivate, free it), connected apps and OAuth usage, metadata retrieve and package.xml, deployments with their failures and quick deploy.
- **Compare & Deploy**: everything between two places — two orgs (compare metadata and deploy the differences, compare access and apps, copy records keeping every link), the org and your project (compare, retrieve, deploy), a branch and an org, two branches (package.xml and destructiveChanges.xml), the org and a file (a user snapshot, a workbook, a CSV, a package.xml), and a sandbox refresh: save what it replaces before, compare and put it back after.
- **Every tool says what you are missing**: when your user lacks a permission a tool needs, the tool says so at the top, with the permission's name.

## Requirements

- Nothing but VS Code 1.95 or later. Orgs logged in to with the Salesforce CLI show up by themselves; without the CLI, log in with **NomadSF: Log in to an org**.

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
| **NomadSF: Show all data of the selected record Id** | The record inspector for the selection (also in the editor's right-click menu) |
| **NomadSF: Run the selected SOQL in Studio**         | Query the selection (also in the editor's right-click menu)                    |
| **NomadSF: Open the guide (how to use each tool)**   | The guide on the website, a section and a recording per tool                   |

## Safety and privacy

- NomadSF runs on your computer and talks to Salesforce with the CLI's login; the access token stays in the extension and never reaches the Studio page, which may only call Salesforce's `/services/` APIs.
- Every change — saving code, editing records, validating and deploying, deleting, restoring or copying data, changing permissions — asks you to type the org name first, in every org; running Apex or tests, debug logging and Log in as ask too. Production orgs are shown in red.
- Backups go to a folder you choose, optionally encrypted with your passphrase.
- AI is optional and uses the provider you connect yourself; it only fills editors or shows text.

## Versions

The VS Code extension, the browser extension and the `sf fm` plugin share one version number: each [release](https://github.com/faridmasjedi/plugin-fm/releases) ships all three.

## License

Apache-2.0. NomadSF is an independent project, not affiliated with Salesforce.
