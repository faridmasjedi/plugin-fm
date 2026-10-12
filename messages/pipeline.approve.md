# summary

Approve or reject a pipeline step that is waiting for approval.

# description

Records a decision for an approval gate. A runner started with --wait-for-approval continues immediately; a paused run continues with 'sf fm pipeline run --resume <run>'.

# examples

- Approve the step the latest run is waiting for:

  <%= config.bin %> <%= command.id %>

- Reject a specific step:

  <%= config.bin %> <%= command.id %> --run 20261012-093000-3fbda8f --stage approve --reject

# flags.run.summary

Run ID, or 'latest'.

# flags.stage.summary

Stage ID. Defaults to the stage that is waiting for approval.

# flags.reject.summary

Reject instead of approve.

# flags.runsDir.summary

Directory where runs are recorded.

# error.runNotFound

Run '%s' not found.

# error.noStage

Run %s has no step waiting for approval. Pass --stage to choose one.

# info.approved

Approved '%s' in run %s.

# info.rejected

Rejected '%s' in run %s.

# info.resumeHint

The run is paused. Continue it with: sf fm pipeline run --resume %s
