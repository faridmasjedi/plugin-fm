# summary

Open NomadSF: release dashboard, org explorer, runbooks and AI settings.

# description

Serves a local dashboard (127.0.0.1 only) that shows every pipeline run recorded in .fm/runs, grouped by release. Runs update live; steps waiting for approval can be approved or rejected, runs can be canceled, and a new run can be started from the page.

With --export, writes a self-contained HTML snapshot instead, which can be attached to a CI run or shared.

# examples

- Open the live dashboard:

  <%= config.bin %> <%= command.id %> --open

- Export a snapshot for a CI artifact:

  <%= config.bin %> <%= command.id %> --export dashboard.html

# flags.port.summary

Port for the local dashboard server.

# flags.export.summary

Write a self-contained HTML snapshot to this file and exit.

# flags.open.summary

Open the dashboard in the default browser.

# flags.file.summary

Pipeline file used to start runs from the dashboard. Defaults to .fm/pipeline.yml.

# flags.runsDir.summary

Directory where runs are recorded.

# info.serving

Dashboard running at %s (press Ctrl+C to stop)

# info.exported

Dashboard snapshot written to %s (%s run(s))
