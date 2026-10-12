# summary

Run a pre- or post-deployment runbook (Markdown) with AI, approving every change to the org.

# description

Reads a runbook written in plain language and has an AI model carry it out against the target org: it lists the steps, looks things up with SOQL, runs anonymous Apex or allowlisted sf commands, and asks a person to do anything that can only be done in Setup.

Every action that changes the org waits for approval (in the terminal, or in the dashboard with --wait-for-approval). Use --plan to only work out what would be done. With --pr, repository files the runbook changes (for example retrieved metadata) are committed to a new branch and a pull request is opened with the GitHub CLI.

The AI provider is configured in .fm/ai.yml (Anthropic Claude by default; OpenAI, Azure OpenAI, Gemini, Mistral, Groq, OpenRouter, Ollama or any OpenAI-compatible endpoint). API keys are read from environment variables. The run is recorded in .fm/runs and appears on the dashboard.

# examples

- Plan a runbook without changing anything:

  <%= config.bin %> <%= command.id %> --file .fm/runbooks/pre-deploy.md --target-org uat --plan

- Run it, approving each change in the terminal:

  <%= config.bin %> <%= command.id %> --file .fm/runbooks/pre-deploy.md --target-org uat

- Run it from the dashboard's approvals and open a PR for repository changes:

  <%= config.bin %> <%= command.id %> --file .fm/runbooks/post-deploy.md --target-org uat --wait-for-approval --pr

# flags.file.summary

Runbook Markdown file.

# flags.targetOrg.summary

Org to run the runbook against.

# flags.plan.summary

Only plan: read-only queries, no changes.

# flags.approve.summary

Which actions need approval: writes (org changes, default), all (also repository files), none.

# flags.approve.description

Manual steps always need a person to confirm them. 'none' lets the AI change the org without asking; use it only for trusted runbooks in non-production orgs.

# flags.pr.summary

Commit repository changes made by the runbook to a new branch and open a pull request (GitHub CLI).

# flags.baseBranch.summary

Base branch for the pull request.

# flags.provider.summary

AI provider, overriding .fm/ai.yml.

# flags.model.summary

AI model, overriding .fm/ai.yml.

# flags.waitForApproval.summary

Wait for approvals from the dashboard (sf fm dashboard) instead of asking in the terminal.

# flags.release.summary

Release name used to group the run on the dashboard.

# flags.runsDir.summary

Directory where runs are recorded.
