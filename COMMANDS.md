# Commands Reference

Comprehensive guide for all `@salesforce/plugin-fm` commands with examples and scenarios.

## Table of Contents

- [sf fm build](#sf-fm-build)
- [sf fm deploy](#sf-fm-deploy)
- [sf fm deploy status](#sf-fm-deploy-status)
- [sf fm deploy cancel](#sf-fm-deploy-cancel)
- [sf fm quality](#sf-fm-quality)

---

## sf fm build

Build deployment artifacts from Git changes including manifests and changed files.

### Synopsis

```bash
sf fm build --ref-a <git-ref> [--ref-b <git-ref>] [--output-dir <path>] [options]
```

### Description

Analyzes differences between two Git references and generates:

- `Package/package.xml` - Manifest of changed/new metadata
- `Destructive/destructiveChanges.xml` - Manifest of deleted metadata
- `ChangedFiles/` - Directory containing all changed files
- `RemovedFiles/` - Directory containing deleted files for reference

### Key Features

- **Smart Git Diff Analysis** - Compares any two Git references (commits, branches, tags)
- **Bundle Handling** - Properly handles LWC, Aura, Experience Bundle, and WaveTemplate changes
- **Granular Metadata** - Optimizes CustomLabels and SharingRules (only changed items)
- **Forceignore Support** - Respects `.forceignore` patterns
- **Submodule Support** - Detects and processes Git submodule changes
- **Last Successful Deployment** - Can use tagged commits as baseline

### Options

| Flag                                | Type    | Description                                                                                   |
| ----------------------------------- | ------- | --------------------------------------------------------------------------------------------- |
| `--ref-a`                           | string  | Git reference for the 'old' state (required unless using `--from-last-successful-deployment`) |
| `--ref-b`                           | string  | Git reference for the 'new' state (default: HEAD)                                             |
| `--output-dir`                      | string  | Output directory for manifests and files (default: manifest)                                  |
| `--forceignore`                     | file    | Path to .forceignore file                                                                     |
| `--from-last-successful-deployment` | boolean | Use last successful deployment tag as baseline                                                |
| `--base-branch`                     | string  | Base branch for last successful deployment lookup                                             |
| `--json`                            | boolean | Output in JSON format                                                                         |

### Examples

#### Basic Usage

```bash
# Changes between main and current branch
sf fm build --ref-a main --ref-b HEAD

# Changes in last commit
sf fm build --ref-a HEAD~1 --ref-b HEAD

# Changes between two commits
sf fm build --ref-a abc123 --ref-b def456
```

#### Using Tags

```bash
# Changes since last release
sf fm build --ref-a v1.0.0 --ref-b HEAD

# Between two tags
sf fm build --ref-a v1.0.0 --ref-b v1.1.0
```

#### Last Successful Deployment

```bash
# Use last successful deployment on main
sf fm build --from-last-successful-deployment --base-branch main

# Use last successful deployment on develop
sf fm build --from-last-successful-deployment --base-branch develop
```

#### Custom Output Directory

```bash
# Output to custom directory
sf fm build --ref-a main --output-dir ./deployment

# Output with timestamp
sf fm build --ref-a main --output-dir "./manifest-$(date +%Y%m%d-%H%M%S)"
```

#### With Forceignore

```bash
# Use custom .forceignore
sf fm build --ref-a main --forceignore ./.forceignore-prod

# Multiple scenarios
sf fm build --ref-a main --forceignore ./ignores/.forceignore.uat
```

#### JSON Output

```bash
# JSON output for automation
sf fm build --ref-a main --json | jq '.result'

# Save to file
sf fm build --ref-a main --json > build-result.json
```

### Output Structure

```
manifest/
├── Package/
│   └── package.xml              # Changed/new metadata
├── Destructive/
│   └── destructiveChanges.xml   # Deleted metadata
├── ChangedFiles/                 # All changed files
│   ├── force-app/
│   │   └── main/
│   │       └── default/
│   │           ├── classes/
│   │           ├── lwc/
│   │           └── objects/
│   └── labels/
│       └── CustomLabels.labels   # Only changed labels
└── RemovedFiles/                 # Deleted files (reference only)
    └── labels/
        └── CustomLabels.labels   # Only deleted labels
```

### Scenarios

#### Scenario 1: Pull Request Validation

```bash
# In GitHub Actions
sf fm build \
  --ref-a origin/${{ github.base_ref }} \
  --ref-b HEAD \
  --output-dir ./manifest
```

#### Scenario 2: Continuous Deployment

```bash
# Deploy only what changed since last successful deployment
sf fm build \
  --from-last-successful-deployment \
  --base-branch main \
  --output-dir ./manifest

# Deploy to production
sf fm deploy --manifest ./manifest --target-org production
```

#### Scenario 3: Hotfix Deployment

```bash
# Build hotfix changes
sf fm build \
  --ref-a production-tag \
  --ref-b hotfix-branch \
  --output-dir ./hotfix-manifest
```

#### Scenario 4: Release Deployment

```bash
# Build release package
sf fm build \
  --ref-a v1.0.0 \
  --ref-b v1.1.0 \
  --output-dir ./release-v1.1.0
```

---

## sf fm deploy

Deploy or validate Salesforce metadata with intelligent features.

### Synopsis

```bash
sf fm deploy --manifest <path> --target-org <org> [--mode <mode>] [options]
```

### Description

Deploys or validates Salesforce metadata with:

- Intelligent test detection based on changed Apex code
- Real-time progress monitoring
- Pre/post deployment hooks
- Destructive changes support
- Async mode for CI/CD

### Deployment Modes

| Mode         | Description                             | Use Case                       |
| ------------ | --------------------------------------- | ------------------------------ |
| `validation` | Validate without deploying (check-only) | PR validation, testing changes |
| `deployment` | Full deployment to org                  | Production deployments         |
| `quick`      | Quick deploy from validation            | Fast production deployment     |

### Test Levels

| Level               | Description                 | When to Use                |
| ------------------- | --------------------------- | -------------------------- |
| `NoTestRun`         | No tests (sandbox only)     | Sandboxes, development     |
| `RunSpecifiedTests` | Run specific test classes   | Targeted testing           |
| `RunLocalTests`     | Run all local tests         | Standard deployments       |
| `RunAllTestsInOrg`  | All tests including managed | Production, packages       |
| `RunRelevantTests`  | Smart test selection        | With `--intelligent-tests` |

### Options

| Flag                  | Type      | Description                                                          |
| --------------------- | --------- | -------------------------------------------------------------------- |
| `--manifest`          | directory | Path to manifest directory (required for non-quick)                  |
| `--target-org`        | org       | Target Salesforce org (required)                                     |
| `--mode`              | choice    | Deployment mode: validation, deployment, quick (default: validation) |
| `--test-level`        | choice    | Test level (default: RunLocalTests)                                  |
| `--tests`             | string[]  | Specific test classes to run                                         |
| `--intelligent-tests` | boolean   | Auto-detect tests from changed Apex                                  |
| `--destructive`       | choice    | Destructive mode: pre, post, both                                    |
| `--pre`               | string[]  | Pre-destructive files (with --destructive both)                      |
| `--validation-id`     | string    | Validation ID for quick deploy                                       |
| `--pre-steps`         | file      | Script to run before deployment                                      |
| `--post-steps`        | file      | Script to run after deployment                                       |
| `--wait`              | integer   | Wait time in minutes (default: 120)                                  |
| `--async`             | boolean   | Start deployment and return immediately                              |
| `--progress`          | boolean   | Show real-time progress                                              |
| `--check-only`        | boolean   | Alias for --mode validation                                          |
| `--ignore-warnings`   | boolean   | Ignore warnings during deployment                                    |
| `--ignore-conflicts`  | boolean   | Ignore conflicts during deployment                                   |

### Examples

#### Basic Validation

```bash
# Simple validation
sf fm deploy --manifest ./manifest --target-org myorg

# Validation with progress
sf fm deploy --manifest ./manifest --target-org myorg --progress

# Using --check-only alias
sf fm deploy --manifest ./manifest --target-org myorg --check-only
```

#### Full Deployment

```bash
# Deploy to org
sf fm deploy --manifest ./manifest --target-org myorg --mode deployment

# Deploy with progress
sf fm deploy --manifest ./manifest --target-org myorg \
  --mode deployment --progress
```

#### Intelligent Test Detection

```bash
# Auto-detect tests from changed Apex
sf fm deploy --manifest ./manifest --target-org myorg \
  --intelligent-tests --progress

# Intelligent tests with deployment
sf fm deploy --manifest ./manifest --target-org myorg \
  --mode deployment --intelligent-tests --progress
```

#### Specific Tests

```bash
# Run specific test classes
sf fm deploy --manifest ./manifest --target-org myorg \
  --test-level RunSpecifiedTests \
  --tests AccountTest,ContactTest

# Multiple tests with progress
sf fm deploy --manifest ./manifest --target-org myorg \
  --test-level RunSpecifiedTests \
  --tests AccountTest,ContactTest,LeadTest \
  --progress
```

#### Quick Deploy

```bash
# Quick deploy from validation
sf fm deploy --mode quick \
  --validation-id 0Af5e000000XXXXAAA \
  --target-org production

# Quick deploy with progress
sf fm deploy --mode quick \
  --validation-id 0Af5e000000XXXXAAA \
  --target-org production \
  --progress
```

#### Destructive Changes

```bash
# Post-destructive changes
sf fm deploy --manifest ./manifest --target-org myorg \
  --destructive post

# Pre-destructive changes
sf fm deploy --manifest ./manifest --target-org myorg \
  --destructive pre

# Both pre and post destructive
sf fm deploy --manifest ./manifest --target-org myorg \
  --destructive both \
  --pre ApexClass.MyOldClass,CustomObject.Old__c
```

#### Pre/Post Hooks

```bash
# With pre-deployment script
sf fm deploy --manifest ./manifest --target-org myorg \
  --pre-steps ./scripts/backup.sh \
  --progress

# With post-deployment script
sf fm deploy --manifest ./manifest --target-org myorg \
  --mode deployment \
  --post-steps ./scripts/cleanup.sh \
  --progress

# Both pre and post
sf fm deploy --manifest ./manifest --target-org myorg \
  --mode deployment \
  --pre-steps ./scripts/backup.sh \
  --post-steps ./scripts/cleanup.sh \
  --progress
```

#### Async Deployment for CI/CD

```bash
# Start async deployment
JOB_ID=$(sf fm deploy --manifest ./manifest --target-org myorg \
  --intelligent-tests --async --json | jq -r '.result.jobId')

# Check status separately
sf fm deploy status --job-id $JOB_ID --target-org myorg --watch
```

#### Ignore Warnings/Conflicts

```bash
# Ignore warnings
sf fm deploy --manifest ./manifest --target-org myorg \
  --ignore-warnings

# Ignore conflicts
sf fm deploy --manifest ./manifest --target-org myorg \
  --ignore-conflicts

# Ignore both
sf fm deploy --manifest ./manifest --target-org myorg \
  --ignore-warnings --ignore-conflicts
```

### Scenarios

#### Scenario 1: PR Validation with Intelligent Tests

```bash
# Build artifacts
sf fm build --ref-a origin/main --ref-b HEAD --output-dir ./manifest

# Validate with intelligent tests
sf fm deploy --manifest ./manifest --target-org uat \
  --mode validation --intelligent-tests --progress
```

#### Scenario 2: Production Deployment (Two-Step)

```bash
# Step 1: Validate in production
VALIDATION_ID=$(sf fm deploy \
  --manifest ./manifest \
  --target-org production \
  --mode validation \
  --test-level RunLocalTests \
  --json | jq -r '.result.validationId')

# Step 2: Quick deploy
sf fm deploy --mode quick \
  --validation-id $VALIDATION_ID \
  --target-org production \
  --progress
```

#### Scenario 3: Deployment with Backup and Cleanup

```bash
# Deploy with hooks
sf fm deploy --manifest ./manifest --target-org production \
  --mode deployment \
  --pre-steps ./scripts/backup-metadata.sh \
  --post-steps ./scripts/cleanup-temp-files.sh \
  --progress
```

#### Scenario 4: CI/CD Async Deployment

```yaml
# GitHub Actions
- name: Deploy
  run: |
    JOB_ID=$(sf fm deploy \
      --manifest ./manifest \
      --target-org production \
      --mode validation \
      --intelligent-tests \
      --async \
      --json | jq -r '.result.jobId')

    echo "JOB_ID=$JOB_ID" >> $GITHUB_ENV

- name: Monitor
  run: |
    sf fm deploy status \
      --job-id ${{ env.JOB_ID }} \
      --target-org production \
      --watch \
      --interval 15
```

---

## sf fm deploy status

Monitor deployment progress with real-time updates.

### Synopsis

```bash
sf fm deploy status --job-id <id> --target-org <org> [--watch] [options]
```

### Description

Check deployment status with:

- One-time status check or continuous monitoring
- Beautiful progress visualization
- Component and test progress
- Error and warning details
- Code coverage reporting

### Options

| Flag           | Type    | Description                                 |
| -------------- | ------- | ------------------------------------------- |
| `--job-id`     | string  | Deployment job ID (optional if using cache) |
| `--target-org` | org     | Target Salesforce org (required)            |
| `--watch`      | boolean | Watch continuously until completion         |
| `--interval`   | integer | Polling interval in seconds (default: 15)   |
| `--timeout`    | integer | Timeout in minutes (default: 120)           |
| `--json`       | boolean | Output in JSON format                       |

### Examples

#### Basic Status Check

```bash
# Check once
sf fm deploy status --job-id 0Af... --target-org myorg

# Using cached job ID
sf fm deploy status --target-org myorg
```

#### Watch Continuously

```bash
# Watch until completion
sf fm deploy status --job-id 0Af... --target-org myorg --watch

# Custom interval
sf fm deploy status --job-id 0Af... --target-org myorg \
  --watch --interval 10

# With timeout
sf fm deploy status --job-id 0Af... --target-org myorg \
  --watch --interval 15 --timeout 60
```

#### JSON Output

```bash
# JSON for automation
sf fm deploy status --job-id 0Af... --target-org myorg --json

# Watch with JSON
sf fm deploy status --job-id 0Af... --target-org myorg \
  --watch --json
```

### Exit Codes

| Code | Status      | Description                                |
| ---- | ----------- | ------------------------------------------ |
| 0    | Success     | Deployment succeeded                       |
| 1    | Failure     | Deployment failed                          |
| 2    | In Progress | Deployment still running (watch mode only) |

### Scenarios

#### Scenario 1: CI/CD Monitoring

```bash
# Start deployment
JOB_ID=$(sf fm deploy --manifest ./manifest --target-org prod \
  --async --json | jq -r '.result.jobId')

# Monitor in another step
sf fm deploy status --job-id $JOB_ID --target-org prod \
  --watch --interval 15 --json
```

#### Scenario 2: Manual Monitoring

```bash
# Start deployment in terminal 1
sf fm deploy --manifest ./manifest --target-org myorg --async

# Monitor in terminal 2
sf fm deploy status --target-org myorg --watch
```

---

## sf fm deploy cancel

Cancel a running deployment.

### Synopsis

```bash
sf fm deploy cancel --job-id <id> --target-org <org>
```

### Options

| Flag           | Type    | Description                                 |
| -------------- | ------- | ------------------------------------------- |
| `--job-id`     | string  | Deployment job ID (optional if using cache) |
| `--target-org` | org     | Target Salesforce org (required)            |
| `--json`       | boolean | Output in JSON format                       |

### Examples

```bash
# Cancel by job ID
sf fm deploy cancel --job-id 0Af... --target-org myorg

# Cancel using cached job ID
sf fm deploy cancel --target-org myorg

# JSON output
sf fm deploy cancel --job-id 0Af... --target-org myorg --json
```

---

## sf fm quality

Run quality checks on changed files between Git references.

### Synopsis

```bash
sf fm quality --base-sha <sha> --head-sha <sha> [options]
```

### Description

Runs quality checks on changed files:

- ESLint for JavaScript/TypeScript
- xmllint for XML validation
- PMD for Apex code
- Automated tests

### Options

| Flag                 | Type    | Description             |
| -------------------- | ------- | ----------------------- |
| `--base-sha`         | string  | Base Git SHA (required) |
| `--head-sha`         | string  | Head Git SHA (required) |
| `--pmd-ruleset`      | file    | PMD ruleset file        |
| `--skip-eslint`      | boolean | Skip ESLint checks      |
| `--skip-xml-lint`    | boolean | Skip XML validation     |
| `--skip-pmd`         | boolean | Skip PMD checks         |
| `--skip-tests`       | boolean | Skip automated tests    |
| `--fail-on-warnings` | boolean | Fail if warnings found  |
| `--json`             | boolean | Output in JSON format   |

### Examples

#### Basic Usage

```bash
# Run all checks
sf fm quality --base-sha origin/main --head-sha HEAD

# PR validation
sf fm quality \
  --base-sha origin/${{ github.base_ref }} \
  --head-sha HEAD
```

#### Skip Specific Checks

```bash
# Skip tests
sf fm quality --base-sha origin/main --head-sha HEAD --skip-tests

# Skip multiple checks
sf fm quality --base-sha origin/main --head-sha HEAD \
  --skip-tests --skip-pmd

# Only ESLint
sf fm quality --base-sha origin/main --head-sha HEAD \
  --skip-xml-lint --skip-pmd --skip-tests
```

#### Custom PMD Ruleset

```bash
# Use custom ruleset
sf fm quality --base-sha origin/main --head-sha HEAD \
  --pmd-ruleset ./config/pmd-rules.xml
```

#### Fail on Warnings

```bash
# Strict mode
sf fm quality --base-sha origin/main --head-sha HEAD \
  --fail-on-warnings
```

### Scenarios

#### Scenario 1: PR Quality Gate

```yaml
# GitHub Actions
- name: Quality Checks
  run: |
    sf fm quality \
      --base-sha origin/${{ github.base_ref }} \
      --head-sha HEAD \
      --fail-on-warnings
```

#### Scenario 2: Pre-commit Hook

```bash
# .git/hooks/pre-commit
#!/bin/bash
sf fm quality --base-sha HEAD~1 --head-sha HEAD --skip-tests
```

---

## Common Patterns

### Pattern 1: Complete CI/CD Workflow

```bash
# 1. Build
sf fm build --ref-a origin/main --ref-b HEAD --output-dir ./manifest

# 2. Quality
sf fm quality --base-sha origin/main --head-sha HEAD

# 3. Deploy
JOB_ID=$(sf fm deploy --manifest ./manifest --target-org prod \
  --intelligent-tests --async --json | jq -r '.result.jobId')

# 4. Monitor
sf fm deploy status --job-id $JOB_ID --target-org prod --watch

# 5. Quick deploy if validated
sf fm deploy --mode quick --validation-id $VALIDATION_ID --target-org prod
```

### Pattern 2: Multi-Environment Deployment

```bash
# Build once
sf fm build --ref-a main --ref-b HEAD --output-dir ./manifest

# Deploy to UAT
sf fm deploy --manifest ./manifest --target-org uat --progress

# If successful, deploy to production
sf fm deploy --manifest ./manifest --target-org prod \
  --mode validation --intelligent-tests --progress
```

### Pattern 3: Hotfix Deployment

```bash
# Build hotfix
sf fm build --ref-a production-tag --ref-b hotfix --output-dir ./hotfix

# Validate quickly
sf fm deploy --manifest ./hotfix --target-org prod \
  --test-level RunSpecifiedTests --tests HotfixTest

# Quick deploy
VALIDATION_ID="..." # from validation
sf fm deploy --mode quick --validation-id $VALIDATION_ID --target-org prod
```

---

## Tips and Best Practices

### Build Command

- Always use `--from-last-successful-deployment` for incremental deployments
- Use `.forceignore` to exclude files that shouldn't be deployed
- Test your build locally before CI/CD

### Deploy Command

- Use `--intelligent-tests` to save deployment time
- Always validate production deployments before quick deploy
- Use `--async` in CI/CD pipelines
- Use hooks for backup and cleanup operations

### Status Command

- Use `--watch` in CI/CD to wait for completion
- Set appropriate `--timeout` based on deployment size
- Use `--json` for programmatic parsing

### Quality Command

- Run quality checks before deployment
- Use `--fail-on-warnings` for strict quality gates
- Skip irrelevant checks to save time
- Integrate with pre-commit hooks
