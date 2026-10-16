# summary

Roll an org back to an earlier successful deployment of a branch.

# description

Uses the deployment tags written by 'sf fm deploy --tag-on-success' (sf-deploy-success/<branch>/<time>). The org is assumed to be on the newest tag; by default it goes back to the newest earlier tag that points at a different commit, or to the tag given with --to. The delta between the two is built in a temporary worktree of the target: metadata changed since comes back in its earlier version, and metadata added since is deleted (post-destructive). On success the target commit is tagged again, so the next delta build starts from it.

Data changes, and metadata Salesforce cannot delete through the API, are not rolled back. Use --dry-run first to validate the rollback without changing the org.

# examples

- Validate a rollback of main to the previous deployment:

  <%= config.bin %> <%= command.id %> --target-org prod --branch main --dry-run

- Roll back to a specific deployment, without a prompt (CI):

  <%= config.bin %> <%= command.id %> --target-org prod --branch main --to sf-deploy-success/main/20261012T093000Z --no-prompt

# flags.targetOrg.summary

Org to roll back.

# flags.branch.summary

Branch whose deployment tags describe what the org is on.

# flags.to.summary

Deployment tag to go back to (default: the previous deployment).

# flags.dryRun.summary

Validate the rollback only (check-only deployment); nothing changes in the org.

# flags.testLevel.summary

Tests to run with the rollback deployment.

# flags.noPrompt.summary

Do not ask for confirmation before deploying.
