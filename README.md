# NomadSF

Salesforce release tooling as a Salesforce CLI plugin (`sf fm …`) plus the **NomadSF** app (`sf fm dashboard`).

## Features

- 🚀 **Delta builds** — deployment artifacts from Git changes, including submodules, bundles and granular CustomLabels/SharingRules
- 🌊 **Deployment waves** — Data Cloud → core (incl. Agentforce) → OmniStudio, as separate artifacts ([PIPELINE.md](PIPELINE.md))
- 🏷️ **Deployment tags** — every build starts from the last successful deployment
- 🧹 **Quality gate** — Code Analyzer / PMD (your `ruleset.xml`) / ESLint on changed files, SARIF for PRs ([QUALITY_COMMAND.md](QUALITY_COMMAND.md))
- 🚂 **Release train** — optional pipeline over pull request and push, with approvals, scripts (`.apex`, `.sh`, …) and step-by-step runs
- 🤖 **AI runbooks** — pre/post-deployment steps in plain language, carried out with approval for every change ([AI_RUNBOOKS.md](AI_RUNBOOKS.md))
- 🔎 **Org explorer** — queries with a filterable table, all fields, Tooling API, deleted rows; Bulk API import/export/delete; login history, audit trail, permission set assignment; metadata retrieve ([ORG_EXPLORER.md](ORG_EXPLORER.md))
- 🎭 **Playwright scenarios** — end-to-end tests against any org without stored passwords
- 🧑‍💻 **NomadSF Studio** — Execute Anonymous with debug logs, debug log viewer and trace flags, SOQL with autocomplete; in the app and as a Chrome/Edge extension ([nomadsf/STUDIO.md](nomadsf/STUDIO.md))
- 📊 **NomadSF app** — runs per release, orgs, repository and deployment history, runbooks, AI settings; also publishable on GitHub Pages

## Installation

```bash
# From a release (GitHub Releases has the tarball for each version)
sf plugins install https://github.com/faridmasjedi/plugin-fm

# Or the ready-made image with the Salesforce CLI, plugin-fm, Code Analyzer and Java
docker pull ghcr.io/faridmasjedi/nomadsf:latest
```

Releasing and repository rules: [RELEASING.md](RELEASING.md).

## Quick Start

### 1. Build Deployment Artifacts

Generate manifests and prepare files for deployment based on Git changes:

```bash
# Compare main branch with current changes
sf fm build --ref-a main --ref-b HEAD

# Use the last successful deployment as baseline
sf fm build --from-last-successful-deployment --base-branch main
```

### 2. Deploy to Salesforce

Deploy with intelligent test detection and progress monitoring:

```bash
# Validation with auto-detected tests
sf fm deploy --manifest ./manifest --target-org myorg --intelligent-tests --progress

# Full deployment with specific tests
sf fm deploy --manifest ./manifest --target-org myorg \
  --mode deployment --tests AccountTest,ContactTest --progress
```

### 3. Monitor Deployment Status

```bash
# Watch deployment progress in real-time
sf fm deploy status --job-id 0Af... --target-org myorg --watch --interval 15
```

## Commands

### `sf fm build`

Build deployment artifacts from Git changes including manifests and changed files.

**Key Features:**

- Analyzes Git diff between any two references (commits, branches, tags)
- Generates `package.xml` for changed/new metadata
- Generates `destructiveChanges.xml` for deleted metadata
- Copies changed files to deployment directory
- Handles Salesforce bundles (LWC, Aura, Experience Bundle)
- Optimizes CustomLabels and SharingRules (only changed labels/rules)
- Respects `.forceignore` patterns

**Examples:**

```bash
# Changes between commits
sf fm build --ref-a HEAD~1 --ref-b HEAD

# Changes from main branch
sf fm build --ref-a main --ref-b HEAD

# From last successful deployment
sf fm build --from-last-successful-deployment --base-branch main

# Custom output directory
sf fm build --ref-a main --output-dir my-deployment
```

[Full Documentation →](./messages/build.md)

### `sf fm deploy`

Deploy or validate Salesforce metadata with intelligent features.

**Key Features:**

- Three modes: validation, deployment, quick
- Intelligent test detection based on changed Apex code
- Real-time progress monitoring
- Pre/post deployment hooks
- Destructive changes support (pre, post, both)
- Async mode for CI/CD pipelines

**Examples:**

```bash
# Validation with intelligent tests
sf fm deploy --manifest ./manifest --target-org myorg \
  --mode validation --intelligent-tests --progress

# Full deployment with specific tests
sf fm deploy --manifest ./manifest --target-org myorg \
  --mode deployment --test-level RunSpecifiedTests \
  --tests AccountTest,ContactTest --progress

# Quick deploy from validation
sf fm deploy --mode quick --validation-id 0Af... --target-org myorg

# Async deployment for CI/CD
sf fm deploy --manifest ./manifest --target-org myorg --async
```

[Full Documentation →](./messages/deploy.md)

### `sf fm deploy status`

Monitor deployment progress with real-time updates.

**Key Features:**

- One-time status check or continuous watching
- Beautiful progress visualization
- Component and test progress tracking
- Error and warning details
- Code coverage reporting
- JSON output for automation

**Examples:**

```bash
# Check status once
sf fm deploy status --job-id 0Af... --target-org myorg

# Watch continuously
sf fm deploy status --job-id 0Af... --target-org myorg \
  --watch --interval 15 --timeout 60

# JSON output for CI/CD
sf fm deploy status --job-id 0Af... --target-org myorg --json
```

[Full Documentation →](./messages/deploy.status.md)

### `sf fm deploy cancel`

Cancel a running deployment.

**Examples:**

```bash
# Cancel by job ID
sf fm deploy cancel --job-id 0Af... --target-org myorg

# Cancel using cached job ID
sf fm deploy cancel --target-org myorg
```

[Full Documentation →](./messages/deploy.cancel.md)

### `sf fm docker init`

Generate Docker configuration files for containerized CI/CD pipelines.

**Key Features:**

- Generates complete Docker setup (Dockerfile, .dockerignore, GitHub Actions workflow)
- Customizable base image (Alpine, Ubuntu, etc.)
- Multiple plugin installation methods (npm, local, git)
- Includes all necessary dependencies for SF CLI and plugin-fm
- Optional GitHub Actions workflow for automated image builds
- Comprehensive documentation and examples

**Examples:**

```bash
# Generate with defaults
sf fm docker init

# Custom base image
sf fm docker init --base-image node:20-alpine

# Custom maintainer and output directory
sf fm docker init --maintainer "DevOps Team" --output-dir ./docker

# Skip GitHub workflow
sf fm docker init --no-github-workflow

# Full customization
sf fm docker init \
  --base-image node:20-alpine \
  --maintainer "DevOps Team" \
  --sf-cli-version latest \
  --plugin-install-method npm \
  --output-dir ./ci
```

**Generated Files:**

- `Dockerfile` - Container image with SF CLI and plugin-fm
- `.dockerignore` - Optimize Docker build context
- `.github/workflows/docker-publish.yml` - Automated image builds
- `DOCKER_README.md` - Usage documentation

[Full Documentation →](./messages/docker.init.md)

## CI/CD Integration

Perfect for GitHub Actions, GitLab CI, and other automation tools.

### Using Docker (Recommended)

Use `sf fm docker init` to generate a complete Docker setup:

```bash
sf fm docker init
```

This creates a Dockerfile with SF CLI and plugin-fm, plus a GitHub Actions workflow. Then use it in your pipelines:

```yaml
name: Salesforce Deployment

on:
  pull_request:
    branches: [main]

jobs:
  validate:
    runs-on: ubuntu-latest
    container:
      image: ghcr.io/your-org/your-repo/sf-fm-cicd:latest
      credentials:
        username: ${{ github.actor }}
        password: ${{ secrets.GITHUB_TOKEN }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Authenticate
        run: |
          echo "${{ secrets.SF_AUTH_URL }}" > authfile
          sf org login sfdx-url --sfdx-url-file authfile --alias target-org

      - name: Build Deployment Artifacts
        run: |
          sf fm build \
            --ref-a origin/${{ github.base_ref }} \
            --ref-b HEAD \
            --output-dir ./manifest

      - name: Deploy with Validation
        run: |
          JOB_ID=$(sf fm deploy \
            --manifest ./manifest \
            --target-org target-org \
            --mode validation \
            --intelligent-tests \
            --async \
            --json | jq -r '.result.jobId')

          sf fm deploy status \
            --job-id $JOB_ID \
            --target-org target-org \
            --watch \
            --interval 15 \
            --json
```

### Without Docker

You can also install SF CLI and plugin-fm directly:

```yaml
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Install SF CLI
        run: npm install -g @salesforce/cli

      - name: Install Plugin
        run: sf plugins install @salesforce/plugin-fm

      # ... rest of steps same as Docker example
```

[Full CI/CD Guide →](./CI_CD_USAGE.md)

## Pre/Post Deployment Hooks

Execute custom scripts before and after deployments:

```bash
# Deploy with hooks
sf fm deploy --manifest ./manifest --target-org myorg \
  --pre-steps ./scripts/backup.sh \
  --post-steps ./scripts/cleanup.sh
```

**Hook Environment Variables:**

- `FM_HOOK_TYPE` - pre or post
- `FM_DEPLOY_MODE` - validation, deployment, or quick
- `FM_TARGET_ORG` - Target org username
- `FM_MANIFEST_DIR` - Manifest directory path
- `FM_JOB_ID` - Deployment job ID (post hooks only)

**Hook Specifications:**

- Timeout: 15 minutes per hook
- Max output: 10MB
- Pre-hooks: Must succeed or deployment stops
- Post-hooks: Only run after successful deployment
- All hook output (stdout/stderr) is displayed in real-time

**Multiple Files in One Hook:**

Since each flag accepts only one file, use a master script to orchestrate multiple steps:

```bash
# master-pre-deploy.sh
#!/bin/bash
set -e
./steps/01-backup.sh
./steps/02-validate.sh
./steps/03-prepare.sh
```

[Complete Hooks Guide →](./messages/hooks-guide.md)

## Development

### Build

```bash
# Clone the repository
git clone git@github.com:salesforcecli/plugin-fm

# Install dependencies and build
yarn && yarn build
```

### Test

```bash
# Run tests
yarn test

# Run tests with coverage
yarn test:coverage

# Run specific test
yarn test path/to/test.ts
```

### Local Development

```bash
# Link plugin to SF CLI
sf plugins link .

# Run commands locally
./bin/dev fm build --ref-a main --ref-b HEAD
```

## Contributing

1. Read our [Code of Conduct](CODE_OF_CONDUCT.md)
2. Create a new issue before starting your project
3. Fork this repository
4. Build the plugin locally
5. Create a topic branch in your fork
6. Write tests (aim for 95%+ coverage)
7. Sign the [CLA](https://cla.salesforce.com/sign-cla)
8. Submit a pull request

## Issues

Report issues at: https://github.com/forcedotcom/cli/issues

## License

Apache-2.0 © Salesforce

## Resources

- [Salesforce CLI](https://developer.salesforce.com/tools/sfdxcli)
- [Plugin Developer Guide](https://developer.salesforce.com/docs/atlas.en-us.sfdx_cli_plugins.meta/sfdx_cli_plugins/cli_plugins_architecture_sf_cli.htm)
- [OCLIF Documentation](https://oclif.io/docs/introduction)
