# Run NomadQA tests anywhere

NomadQA tests also run without the extension, with no one watching. You can run them on a build server, in your CI
(GitHub Actions, GitLab, Jenkins, Azure DevOps, Bitbucket…), or on your own computer. It is **one command**. You
add it to your pipeline your own way; NomadQA does not ship a pipeline file.

## What you need

- **Node 22** or newer, and **Chrome** (or Chromium). GitHub's Ubuntu machines have both; on others, add them to the
  machine or its image. Nothing else to install.
- The **`nomadqa` folder** in your repository: the command runs `nomadqa/runner/run.mjs`, and it uses
  `nomadqa/extension/core`.
- **Your tests** in the repository, for example in `tests/nomadqa/`. In NomadQA, **Tests › Download** saves a test as
  `*.nomadqa.json`; a group's download saves `*.nomadqa-group.json`.

## Log in to the org

Choose one:

| Where it runs                          | How it logs in                                                                                                                                        |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Your computer, with the Salesforce CLI | `--org my-sandbox` (a CLI alias)                                                                                                                      |
| CI, without the CLI                    | `SF_AUTH_URL`: the org's SFDX auth URL, kept in your CI's secrets. Get it with `sf org display --verbose --json -o my-sandbox` (`result.sfdxAuthUrl`) |
| Anywhere, for one run                  | `--login-url` (or `NOMADQA_LOGIN_URL`): a one-time login link, from `sf org open --url-only`                                                          |

Use a sandbox or a test org. The session stays in the browser and in memory. Nothing is saved but the reports.

Tests with **Log in** steps (as another user) need those users' passwords. Put them in `--logins logins.json`, or in
the secret `NOMADQA_LOGINS` (the same JSON):

```json
{ "sales-user": { "url": "https://test.salesforce.com", "username": "ann@acme.com.uat", "password": "…" } }
```

## Run

```sh
# every test in a folder
node nomadqa/runner/run.mjs tests/nomadqa

# one group, 2 tests at a time, reports in a folder of your choice
node nomadqa/runner/run.mjs tests/nomadqa --group Smoke --parallel 2 --out nomadqa-reports

# one test, on your computer, watching the browser
node nomadqa/runner/run.mjs tests/nomadqa/new-contact.nomadqa.json --org my-sandbox --headed
```

| Option                               | What it does                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| files or folders                     | Test files, group files, NomadQA's JUnit reports, or folders (every `*.nomadqa.json` and `*.nomadqa-group.json` in them) |
| `--group Smoke` (or `NOMADQA_GROUP`) | Only that group's tests                                                                                                  |
| `--parallel 4`                       | 4 tests at a time, each with its own cookies                                                                             |
| `--out folder`                       | Where the reports go (default `nomadqa-reports`)                                                                         |
| `--headed`                           | Shows the browser                                                                                                        |
| `--chrome path`                      | A Chrome that is not in the usual place                                                                                  |

The command **exits 0** when every test passed, **1** when a test failed, and **2** when it could not run (no tests,
or no login). Your pipeline uses that to pass or fail the build.

## Find the reports

Everything is in the `--out` folder (`nomadqa-reports/` unless you choose another):

| File               | For whom                | What is in it                                                                                                                                                                                                                                               |
| ------------------ | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `report.html`      | People (QAs, reviewers) | One page: the totals, every test and step with its time, and for each failure the step, why it failed, what was expected and what the page had, Salesforce's messages, the page's address, and a picture. It opens in any browser, with nothing else needed |
| `<test>.junit.xml` | Your CI                 | One per test, and one per group. Most CI tools show these as a list of tests (passed, failed, skipped). NomadQA can also read them back: **Tests › Upload** runs that test again                                                                            |
| `<test>-step3.jpg` | People                  | A small picture (about 100 KB) of the page when that step failed. Only failed steps get one                                                                                                                                                                 |
| `summary.md`       | Your CI's job page      | A short table of tests, and why each failed                                                                                                                                                                                                                 |

The console shows each step with ✓ or ✕ while it runs. **On GitHub Actions** the summary also shows on the run's
page, and each failure is marked as an error, without any extra setup.

## Keep or share the reports, anywhere

The reports are plain files in one folder. Send them wherever your team looks:

- **Your CI's own storage.** Most CI tools can keep a folder with the run: GitHub "artifacts", GitLab `artifacts:`,
  Jenkins "Archive the artifacts", Azure DevOps "Publish Pipeline Artifact". Keep `nomadqa-reports/` for as many days as
  you like, or skip this if storage is tight. The job page and the console still say what failed.
- **Your CI's test results tab.** Point its JUnit reader (GitLab `reports: junit`, Jenkins "Publish JUnit test result
  report", Azure "Publish Test Results") at `nomadqa-reports/*.junit.xml`.
- **Shared storage.** Copy the folder to an S3 bucket, Azure Blob, Google Cloud Storage, SharePoint or a network drive.
  `report.html` opens straight from there.
- **A web page.** Publish the folder to an internal site or GitHub Pages. `report.html` is the page, and the pictures
  sit next to it.
- **A ticket or a chat.** Attach `report.html` to the Jira ticket, the pull request or a Slack/Teams message. Or post
  `summary.md` as the message itself.

Upload the folder even when tests fail. Most CI tools need a setting for that (for example "always", or "on
failure"), because that is when people need the report most.

## Good to know

- Run the same tests in the extension first: **Run**, then **Step by step on the page** to fix a step. The runner uses
  the same engine, so a test that passes there passes here.
- With `--parallel`, each test has its own cookies, so tests that log in as someone else run side by side too.
- Test data that a test makes is deleted after it, as in the extension.
- Setup stays read-only for tests: they open pages, search and check, but never change Setup.
