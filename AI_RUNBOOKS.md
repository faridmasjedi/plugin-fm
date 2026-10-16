# AI runbooks (optional)

Most releases come with steps that are not metadata: assign a permission set, fix some records, switch off automation during a data load, change something in Setup. Teams usually keep these in a document and someone does them by hand.

With plugin-fm the team writes those steps in plain language in a Markdown file. An AI model carries them out against the org: it looks things up, runs the change, checks the result, and asks a person whenever something changes the org or can only be done in Setup.

```bash
sf fm runbook init                                                   # .fm/ai.yml + example runbooks
sf fm runbook run -f .fm/runbooks/pre-deploy.md -o uat --plan        # work out what would be done, change nothing
sf fm runbook run -f .fm/runbooks/pre-deploy.md -o uat               # run it, approving each change in the terminal
sf fm runbook run -f .fm/runbooks/post-deploy.md -o uat --wait-for-approval --pr   # approve in the dashboard, PR for file changes
```

Or as a pipeline stage, before and after the deployment:

```yaml
- id: pre-deploy-steps
  uses: ai-runbook
  run: .fm/runbooks/pre-deploy.md
  with: { target-org: uat, approve: writes }

- id: post-deploy-steps
  uses: ai-runbook
  run: .fm/runbooks/post-deploy.md
  with: { target-org: uat, pr: true, base: main }
```

The dashboard's **Runbooks** page lists `.fm/runbooks/*.md` and starts a run (plan or execute) against any connected org.

## A runbook

```markdown
# Post-deployment steps

1. Assign the permission set `Case_Intake_User` to every active user with the profile "Customer Support".
2. Run the Apex tests in `CaseServiceTest` and report the result.
3. If the Case page layout needs the new field `Escalation_Reason__c`, ask a person to add it in Setup.
```

The model first reports the steps as a checklist, then works through them in order and records each step as done, skipped, failed or manual. The run page shows the checklist, every action with its code or command and output, who approved it, and the final summary.

## What the AI can do

| Tool                      | What it does                                                                                                                                                                            | Approval                              |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `soql_query`              | Read-only SOQL (also Tooling API)                                                                                                                                                       | never                                 |
| `read_file`, `list_files` | Read the repository                                                                                                                                                                     | never                                 |
| `sf_cli`                  | Allowlisted `sf` commands: queries and describes, permission set assignment, data create/update/delete/import, Apex tests, `project retrieve start`, Experience publish, agent activate | read-only ones: never; others: yes    |
| `run_apex`                | Anonymous Apex                                                                                                                                                                          | yes                                   |
| `write_file`              | Create or change a repository file (goes into the pull request)                                                                                                                         | only with `approve: all`              |
| `request_manual_step`     | Ask a person to do something (e.g. in Setup) with exact instructions                                                                                                                    | always: the person confirms it's done |

There is no general shell. `sf org display` is deliberately not allowed because it prints the access token. Paths outside the repository are rejected. In `--plan` mode only the read-only tools are offered.

**Approval policy** (`--approve` / `with.approve`):

- `writes` (default): everything that changes the org waits for a person.
- `all`: repository file changes wait too.
- `none`: the AI changes the org without asking. Use this only for trusted runbooks in non-production orgs. Manual steps still need a person.

Approvals happen in the terminal, or in the dashboard when the run is started with `--wait-for-approval` (or from the dashboard). A rejected action is never run, and the model is told not to retry it. In CI without a person available, a run that needs an approval stops with a clear error.

**Pull requests** (`--pr` / `with.pr`): files the runbook's tools changed (for example metadata retrieved after a Setup change) are committed to a branch `fm/runbook/<name>-<time>`, pushed, and a pull request is opened with the GitHub CLI (`gh`). Your working copy goes back to the original branch.

## Choosing the AI

`.fm/ai.yml` (also editable on the dashboard's **AI** page):

```yaml
provider: anthropic # anthropic | openai | azure-openai | gemini | mistral | groq | openrouter | github-models | ollama | openai-compatible
model: claude-opus-5-5
# baseUrl: https://my-gateway.example.com/v1   # company gateway, Azure deployment URL, self-hosted model
# apiKeyEnv: ANTHROPIC_API_KEY                  # which environment variable holds the key
```

| Provider                        | Key variable                                            | Notes                                                                                                                         |
| ------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `anthropic`                     | `ANTHROPIC_API_KEY`                                     | Default, `claude-opus-5-5`. Uses the official SDK; a safety decline is retried on another Claude model (server-side fallback) |
| `openai`                        | `OPENAI_API_KEY`                                        | Set `model`                                                                                                                   |
| `azure-openai`                  | `AZURE_OPENAI_API_KEY`                                  | `baseUrl` = deployment URL incl. `?api-version=…`                                                                             |
| `gemini`                        | `GEMINI_API_KEY`                                        | Gemini's OpenAI-compatible endpoint; set `model`                                                                              |
| `mistral`, `groq`, `openrouter` | `MISTRAL_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY` | Set `model`                                                                                                                   |
| `github-models`                 | `GITHUB_MODELS_TOKEN`, or your `gh auth login`          | Models of your GitHub / Copilot plan (`https://models.github.ai/inference`); set `model`, e.g. `openai/gpt-4.1`               |
| `ollama`                        | none                                                    | Local models on `http://localhost:11434/v1`                                                                                   |
| `openai-compatible`             | `FM_AI_API_KEY`                                         | Any endpoint that speaks the OpenAI Chat Completions API: set `baseUrl` and `model`                                           |

### AI help outside runbooks

The same provider also answers one-off questions in NomadSF: SOQL from plain English, explain a debug log, failed Apex tests or a failed pipeline stage, and draft release notes (see [STUDIO.md](nomadsf/STUDIO.md)). Only what the task needs is sent: the question with object and field names, the shortened log, the failures, or commit subjects and file names.

### Connect your AI account

The **AI** page of the app (also in the extension under Local app) has a **Connect your AI account** list:

- **OpenRouter — Sign in with OpenRouter.** A browser sign-in (OAuth PKCE); OpenRouter hands the app a key for your account, which gives you Claude, GPT, Gemini and others on one bill.
- **GitHub Models** — no key at all: the GitHub CLI's login (`gh auth login`) is used, within your GitHub or Copilot plan's limits.
- **Anthropic, OpenAI, Gemini, Mistral, Groq, Azure, custom — Connect with key**, with a link to each provider's key page. Pasted once.
- **Use** makes a provider the one runbooks use; **Disconnect** forgets a connected key.

Subscriptions such as ChatGPT Plus or Claude Pro cannot be used by other apps, so a sign-in is offered only where the provider supports one.

Where keys come from, in order: the environment variable (so CI is unchanged) → a key connected in the app → for GitHub Models, the `gh` login. Connected keys live in `~/.nomadsf/credentials.json`, readable only by you (mode 600), outside every project. Keys are never written to `.fm/ai.yml`, run files or logs. `FM_AI_PROVIDER`, `FM_AI_MODEL`, `FM_AI_BASE_URL` and `FM_AI_API_KEY_ENV` override the file, for example in CI.

**Data:** the runbook, query results and file contents the AI reads are sent to the provider you choose. For production data, use a provider and contract your company approves, or a self-hosted model.
