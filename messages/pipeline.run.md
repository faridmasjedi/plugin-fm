# summary

Run the optional release pipeline defined in .fm/pipeline.yml.

# description

Runs the stages of a pipeline file one after another: build, quality, deploy, check-duplicates, scripts (.apex, .sh, .js, .ts, .py), shell commands and approval gates. Every stage is a command you can also run on its own, so the pipeline is optional.

Each run is recorded in .fm/runs so the dashboard (sf fm dashboard) can show it live, including logs, metrics and the next step.

At an approval gate (uses: approval, manual: true, or --step-by-step) the runner asks in the terminal. With --wait-for-approval it waits for a decision from the dashboard or 'sf fm pipeline approve'. In CI or with --no-prompt it pauses the run; approve it and continue with --resume.

The command exits with code 1 when the run fails or is canceled.

# examples

- Run the pipeline in .fm/pipeline.yml:

  <%= config.bin %> <%= command.id %>

- Run step by step, confirming each stage:

  <%= config.bin %> <%= command.id %> --step-by-step

- Run with approvals handled in the dashboard:

  <%= config.bin %> <%= command.id %> --wait-for-approval

- In CI: run, export a dashboard snapshot, and resume a paused run later:

  <%= config.bin %> <%= command.id %> --release "R-2026.10" --dashboard-export dashboard.html
  <%= config.bin %> fm pipeline approve --run latest
  <%= config.bin %> <%= command.id %> --resume latest

# flags.file.summary

Pipeline file. Defaults to .fm/pipeline.yml (or .yaml/.json).

# flags.event.summary

Event that triggered the run: pr, push or manual. Stages with 'on:' only run for matching events.

# flags.event.description

Detected from GitHub Actions (GITHUB_EVENT_NAME: pull_request -> pr, push -> push) or the FM_EVENT variable; defaults to manual. Use it to run one pipeline file as a release train: for example validate on pr, deploy on push.

# flags.release.summary

Release name used to group runs on the dashboard (default: the pipeline's 'release' value or the branch name).

# flags.resume.summary

Resume a paused or failed run by ID ('latest' for the most recent). Finished stages are kept.

# flags.stepByStep.summary

Ask for confirmation before every stage.

# flags.waitForApproval.summary

At approval gates, wait for a decision from the dashboard or 'sf fm pipeline approve' instead of asking in the terminal.

# flags.prompt.summary

Ask in the terminal at approval gates. With --no-prompt the run pauses instead.

# flags.dashboardExport.summary

Write a self-contained HTML dashboard of the runs to this file when the run ends (useful as a CI artifact).

# flags.runsDir.summary

Directory where runs are recorded.

# error.noPipelineFile

No pipeline file found. Create one with 'sf fm pipeline init' or pass --file.

# error.runNotFound

Run '%s' not found.

# info.dashboardExported

Dashboard written to %s

# warn.manualEvent

This run's event is 'manual', so stages limited to pr or push (on: [...]) will be skipped. Pass --event pr or --event push to run them.
