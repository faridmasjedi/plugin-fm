# Release pipeline and dashboard (optional)

`sf fm pipeline run` chains the plugin's commands — build, quality, deploy, duplicate check, scripts and approvals — from one file, and records every run so `sf fm dashboard` can show it.

**It is optional.** Every stage is a normal command (`sf fm build`, `sf fm quality`, `sf fm deploy`, …) that you can keep calling from your own CI scripts. Use the pipeline file for some projects, all of them, or none.

## Quick start

```bash
sf fm pipeline init --target-org uat --base-branch main   # writes .fm/pipeline.yml and .fm/scripts/*
sf fm dashboard --open                                    # live dashboard on http://127.0.0.1:7007
sf fm pipeline run                                        # or press "Run pipeline" in the dashboard
```

## Pipeline file

```yaml
name: Salesforce release
release: ${env.RELEASE_NAME} # optional: groups runs on the dashboard (default: branch name)
env: # optional: environment for every stage
  SF_LOG_LEVEL: warn

stages:
  - id: build
    uses: build
    with:
      from-last-successful-deployment: true
      base-branch: main
      ref-a: origin/main # used until the first deployment tag exists

  - id: quality
    uses: quality
    with: { ref-a: '${stages.build.result.refA}', severity-threshold: 2 }
    continue-on-error: true

  - id: validate
    uses: deploy
    with: { manifest: manifest, target-org: uat, mode: validation, intelligent-tests: true }

  - id: approve
    uses: approval
    description: Check validation and quality, then approve

  - id: deploy
    uses: deploy
    with:
      mode: quick
      validation-id: ${stages.validate.result.validationId}
      target-org: uat
      tag-on-success: main
      push-tag: true # so the next CI run finds the tag

  - id: seed-data
    uses: script
    run: .fm/scripts/post-deploy.apex
    with: { target-org: uat }

  - id: notify
    uses: shell
    if: failure
    run: ./scripts/notify-slack.sh "Release ${run.release} failed"
```

### Stage fields

| Field               | Description                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------- |
| `id`                | Unique id (letters, digits, `-`, `_`). Used in `${stages.<id>...}` and on the dashboard                     |
| `name`              | Display name                                                                                                |
| `description`       | Shown in the dashboard and at approval gates                                                                |
| `uses`              | `build`, `quality`, `deploy`, `check-duplicates`, `script`, `shell`, `approval`, `tag`, `ai-runbook`, `e2e` |
| `with`              | Flags for the command, same names as on the command line (`true` → `--flag`, lists repeat the flag)         |
| `run`               | `script`: path to `.apex`, `.sh`, `.js`, `.ts` or `.py`. `shell`: a command line                            |
| `env`               | Extra environment variables for this stage                                                                  |
| `if`                | `success` (default: all earlier stages passed), `failure`, `always`                                         |
| `on`                | Only run for these events: `pr`, `push`, `manual` (default: every event)                                    |
| `when`              | Only run when this value, or every value in a list, is truthy (`false`, `0`, `""`, `no` are false)          |
| `continue-on-error` | A failure is shown as a warning and later stages still run                                                  |
| `manual`            | Ask for approval before running this stage                                                                  |
| `timeout-minutes`   | Timeout for `script` and `shell` stages                                                                     |

`uses: ai-runbook` runs a Markdown runbook with AI (`run:` the file; `with: { target-org, mode, approve, pr, base }`), see [AI_RUNBOOKS.md](AI_RUNBOOKS.md).

`uses: tag` takes `with: { branch, push, commit }` and tags the commit as `sf-deploy-success/<branch>/<timestamp>`.

### Scripts

`uses: script` runs a file by its extension: `.apex` with `sf apex run --file … --target-org <with.target-org>`, `.js` with Node, `.ts` with `tsx`, `.py` with Python 3, `.sh` with Bash. Scripts receive `FM_TARGET_ORG`, `FM_RUN_ID` and `FM_RELEASE`.

The same script types work for `sf fm deploy --pre-steps / --post-steps`.

### Values

| Expression                       | Value                                                           |
| -------------------------------- | --------------------------------------------------------------- |
| `${env.NAME}`                    | Environment variable                                            |
| `${run.id}`, `${run.release}`    | Run id and release name                                         |
| `${run.event}`                   | `pr`, `push` or `manual`                                        |
| `${run.branch}`, `${run.commit}` | Git branch and commit                                           |
| `${stages.<id>.result.<field>}`  | Result of an earlier stage, e.g. `validate.result.validationId` |

A value that is exactly one expression keeps its type (a boolean stays a boolean). An expression that cannot be resolved fails the stage.

## Deployment waves and the release train

Some metadata has to reach the org before or after everything else: Data Cloud first (Agentforce and Apex can depend on it), OmniStudio last (it calls the Apex, DataRaptors and fields it uses). `sf fm build --waves` splits the changes into ordered artifacts:

```
manifest/1-data-cloud/   Package, Destructive, ChangedFiles, RemovedFiles
manifest/2-core/         everything else, including Agentforce
manifest/3-omnistudio/
manifest/waves.json      what changed in each wave + contains.{dataCloud, agentforce, omnistudio}
```

Each file goes to the first wave whose `types` or `paths` match it, and everything else goes to the default wave. A file is only ever in one wave's manifest. This has the same effect as adding the other waves' paths to `.forceignore` for each build, but the split is decided per file. Types are detected for deleted files too, from the metadata registry. Without `.fm/waves.yml` the built-in waves above are used:

```yaml
# .fm/waves.yml
waves:
  - id: data-cloud
    name: Data Cloud
    types: ['@data-cloud'] # built-in groups: @data-cloud, @omnistudio, @agentforce
    paths: ['force-app/main/data-cloud/**'] # .gitignore-style patterns
  - id: core
    name: Core metadata
    default: true
  - id: omnistudio
    name: OmniStudio
    types: ['@omnistudio']
    paths: ['force-app/main/omnistudio/**']
```

In the pipeline every wave is available as `${stages.build.result.wavesById.<id>.dir}` (artifact folder) and `.hasChanges`.

### Release train

`sf fm pipeline init --train` writes a pipeline that runs one file across pull request and push:

| Event        | Stages                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------- |
| Pull request | build → quality → Data Cloud: validate → [approve] → deploy → core: validate (the PR check) |
| Push (merge) | build → core: deploy → OmniStudio: validate → [approve] → deploy → tag                      |

- Stages for a wave without changes are skipped (`when: ${stages.build.result.wavesById.<id>.hasChanges}`).
- Approvals only run when `FM_REQUIRE_APPROVAL` is `true` (`when:` with a list needs every value to be true).
- The event comes from GitHub Actions (`pull_request` → `pr`, `push` → `push`), `FM_EVENT`, or `--event`.
- The `tag` stage runs last on push, so the next build starts after everything that was deployed. It does nothing if the commit is already tagged.

[examples/github-release-train.yml](examples/github-release-train.yml) runs the train in GitHub Actions. When a run pauses at its approval gate, a second job waits for the reviewers of a GitHub environment, downloads the paused run (`.fm/runs`, `manifest/`), approves it and resumes it.

Notes:

- Data Cloud is deployed while the PR is still open, as designed. If the PR is closed without merging, those changes stay in the org.
- On push, core is deployed with tests (`mode: deployment`). The PR's validation ID is not reused because the merge commit is a different commit. If your merges keep the same content, you can switch to `mode: quick` with the validation ID.
- OmniStudio managed-package DataPacks (Vlocity) are not Metadata API types: put their folders in a wave's `paths` and deploy that wave with a `shell` stage running `vlocity packDeploy`.

## Approvals and step-by-step runs

A stage stops for a decision when it is `uses: approval`, has `manual: true`, or the run uses `--step-by-step`.

| How the run was started                 | What happens at the gate                                                   |
| --------------------------------------- | -------------------------------------------------------------------------- |
| Terminal (`sf fm pipeline run`)         | Asks `[Y/n]` in the terminal                                               |
| `--wait-for-approval` or from dashboard | Waits; approve or reject in the dashboard or with `sf fm pipeline approve` |
| CI or `--no-prompt`                     | Pauses and exits 0; approve, then `sf fm pipeline run --resume <id>`       |

Resuming keeps passed, warning and skipped stages and their results, and runs the rest.

## Dashboard

`sf fm dashboard` is a local app (127.0.0.1 only) with five pages:

- **Runs**: the pipeline runs below, grouped by release.
- **Orgs**: the orgs authorized in the Salesforce CLI on this machine (type, status, open in browser), and a button to connect a new org through the browser login. No credentials are stored by the dashboard.
- **Repository**: deployment history from the `sf-deploy-success/*` tags, open pull requests (GitHub CLI) and recent commits.
- **Runbooks**: the AI runbooks in `.fm/runbooks`, ready to plan or run against a connected org. Every change waits for approval on the run page.
- **AI**: the AI provider and model (`.fm/ai.yml`), and whether its key variable is set.

Every POST must carry the dashboard's own header and origin, and requests for other host names are refused. This stops a web page you visit from triggering actions on the local server.

On the **Runs** page:

- **Pipeline run** — stage track with status and timings, a _Next step_ banner with Approve / Reject, cancel, and per-stage details: build components and destructive changes, quality findings, deployment job/validation ids, tests and coverage, and the live log.
- **Release overview** — every run of a release, deployments and validations per org, the Critical/High quality trend, and the metadata in the release.
- **Run pipeline** button (with a step-by-step option) when a pipeline file exists.

`sf fm dashboard --export dashboard.html` (or `sf fm pipeline run --dashboard-export dashboard.html`) writes a self-contained snapshot with the runs, their logs and a repository snapshot. Use it as a CI artifact.

### On GitHub

[examples/github-dashboard-pages.yml](examples/github-dashboard-pages.yml) publishes the dashboard on GitHub Pages after every release-train run. It keeps the run history on a data branch (`fm-dashboard-data`), so the site shows every release, not only the last run.

Runs contain org usernames, metadata names and logs. On GitHub plans without private Pages, a site published from a private repository is public. Use private Pages (GitHub Enterprise Cloud), or keep the `dashboard.html` artifact instead.

## Run files

```
.fm/runs/<run-id>.json           run state (written by the runner)
.fm/runs/<run-id>.control.json   approvals and cancel requests (written by dashboard / approve)
.fm/runs/<run-id>/<stage>.log    stage output
```

`sf fm pipeline init` adds `.fm/runs/` to `.gitignore`. In CI the folder only lives for the job, so upload it (or the exported dashboard) as an artifact.

## GitHub Actions

```yaml
name: Release
on:
  push:
    branches: [main]

jobs:
  release:
    runs-on: ubuntu-latest
    environment: production # GitHub environment protection can act as the approval
    permissions:
      contents: write # push the sf-deploy-success tag
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0, submodules: recursive }
      - uses: actions/setup-java@v4
        with: { distribution: temurin, java-version: '17' }
      # plugin-fm is not on npm yet: install it from your registry, or use the image from `sf fm docker init`
      - run: npm install -g @salesforce/cli && sf plugins install code-analyzer <your plugin-fm package>
      - run: echo "${{ secrets.SFDX_AUTH_URL }}" > auth.txt && sf org login sfdx-url --sfdx-url-file auth.txt --alias uat
      - run: git config user.name "release-bot" && git config user.email "release-bot@users.noreply.github.com"
      - run: sf fm pipeline run --no-prompt --release "${{ github.ref_name }}-${{ github.run_number }}" --dashboard-export dashboard.html
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: release-dashboard, path: 'dashboard.html' }
```

Remove the `approval` stage in CI when GitHub environments already gate the job, or keep it and resume the paused run in a second job.
