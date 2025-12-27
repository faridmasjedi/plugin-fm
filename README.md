# @salesforce/plugin-fm

[![NPM](https://img.shields.io/npm/v/@salesforce/plugin-fm.svg?label=@salesforce/plugin-fm)](https://www.npmjs.com/package/@salesforce/plugin-fm)
[![Downloads/week](https://img.shields.io/npm/dw/@salesforce/plugin-fm.svg)](https://npmjs.org/package/@salesforce/plugin-fm)
[![License](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](https://opensource.org/license/apache-2-0)

A Salesforce CLI plugin for fast, intelligent metadata deployments with built-in CI/CD support.

## Features

- 🚀 **Intelligent Builds** - Automatically analyze Git changes and generate deployment artifacts
- 🧪 **Smart Test Detection** - Auto-detect which Apex tests to run based on code changes
- 📦 **Bundle Handling** - Properly handle LWC, Aura, and Experience Bundle changes
- 🎯 **Granular Metadata** - Optimize CustomLabels and SharingRules deployments
- 🔄 **Progress Monitoring** - Real-time deployment progress with beautiful visualizations
- ⚡ **Quick Deploys** - Deploy validated changesets instantly
- 🎣 **Pre/Post Hooks** - Execute custom scripts before and after deployments
- 🤖 **CI/CD Ready** - Built for GitHub Actions, GitLab CI, and other automation tools
- ✅ **Quality Checks** - Run ESLint, PMD, XML validation, and tests on changed files
- 🗑️ **Destructive Changes** - Handle pre and post destructive deployments safely

## Installation

```bash
sf plugins install @salesforce/plugin-fm
```

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

### 4. Quality Checks

Run quality checks on changed files:

```bash
# Run all quality checks on PR changes
sf fm quality --base-sha origin/main --head-sha HEAD

# Skip specific checks
sf fm quality --base-sha origin/main --head-sha HEAD --skip-tests
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

### `sf fm quality`

Run quality checks on changed files between Git references.

**Key Features:**

- ESLint for JavaScript/TypeScript files
- XML validation with xmllint
- PMD for Apex code quality
- Automated test execution
- Configurable checks

**Examples:**

```bash
# Run all checks on PR changes
sf fm quality --base-sha origin/main --head-sha HEAD

# Skip specific checks
sf fm quality --base-sha origin/main --head-sha HEAD \
  --skip-tests --skip-pmd

# Fail on warnings
sf fm quality --base-sha origin/main --head-sha HEAD --fail-on-warnings
```

[Full Documentation →](./messages/quality.md)

## CI/CD Integration

Perfect for GitHub Actions, GitLab CI, and other automation tools.

### GitHub Actions Example

```yaml
name: Salesforce Deployment

on:
  pull_request:
    branches: [main]

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
        with:
          fetch-depth: 0

      - name: Install SF CLI
        run: npm install -g @salesforce/cli

      - name: Install Plugin
        run: sf plugins install @salesforce/plugin-fm

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

      - name: Run Quality Checks
        run: |
          sf fm quality \
            --base-sha origin/${{ github.base_ref }} \
            --head-sha HEAD

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
