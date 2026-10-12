# summary

Create the AI settings file (.fm/ai.yml) and example pre/post-deployment runbooks.

# description

Writes .fm/ai.yml (provider and model, no secrets) and example runbooks in .fm/runbooks. Edit the runbooks in plain language, then run them with 'sf fm runbook run' or an 'ai-runbook' pipeline stage.

# examples

- <%= config.bin %> <%= command.id %>

# flags.force.summary

Overwrite existing files.

# info.nextSteps

Next: set the API key environment variable for your provider (e.g. ANTHROPIC_API_KEY), then try 'sf fm runbook run --file .fm/runbooks/pre-deploy.md --target-org <org> --plan'.
