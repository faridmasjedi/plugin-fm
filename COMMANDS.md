# Commands Reference

Comprehensive guide for all `@salesforce/plugin-fm` commands with examples and scenarios.

## Table of Contents

- [sf fm build](#sf-fm-build)
- [sf fm deploy](#sf-fm-deploy)
- [sf fm deploy status](#sf-fm-deploy-status)
- [sf fm deploy cancel](#sf-fm-deploy-cancel)
- [sf fm docker init](#sf-fm-docker-init)
- [sf fm quality](#sf-fm-quality)
- [sf fm pipeline run / init / approve](#sf-fm-pipeline-run--init--approve)
- [sf fm dashboard](#sf-fm-dashboard)
- [sf fm runbook run / init](#sf-fm-runbook-run--init)
- [sf fm e2e run / init](#sf-fm-e2e-run--init)
- [sf fm drift](#sf-fm-drift)
- [sf fm rollback](#sf-fm-rollback)
- [sf fm org create](#sf-fm-org-create)
- [Validate on the PR, quick deploy on merge](#validate-on-the-pr-quick-deploy-on-merge)

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
| `--from-last-successful-deployment` | boolean | Use the latest `sf-deploy-success/<base-branch>/*` tag as baseline; falls back to `--ref-a`   |
| `--base-branch`                     | string  | Base branch for last successful deployment lookup                                             |
| `--ignore`                          | string  | Extra ignore patterns, combined with `.forceignore`                                           |
| `--create-docker-image`             | boolean | Build a Docker image containing the artifact                                                  |
| `--summary`                         | choice  | Summary format: console, json, github                                                         |
| `--waves`                           | boolean | Split into ordered wave artifacts (Data Cloud → core → OmniStudio), see PIPELINE.md           |
| `--waves-file`                      | file    | Waves definition (default `.fm/waves.yml`)                                                    |
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

### Working with Git Submodules

The `fm build` command automatically detects and processes changes in Git submodules, making it easy to manage shared metadata across multiple Salesforce projects.

#### How Submodules Are Processed

1. **Automatic Detection**: Changed files in submodules are detected alongside parent repo changes
2. **Package Directory Filtering**: Uses the **parent repo's** `sfdx-project.json` to filter all files (including submodule files)
3. **Granular Metadata Merging**: CustomLabels and SharingRules from parent and submodule are automatically merged

#### Package Directory Filtering

All files (parent + submodule) are filtered based on package directories defined in the **parent repo's** `sfdx-project.json`:

**Example:**

```json
// Parent repo's sfdx-project.json
{
  "packageDirectories": [{ "path": "force-app" }]
}
```

**Files Included:**

- ✅ `force-app/main/default/classes/MyClass.cls` (parent repo)
- ✅ `force-app/main/shared/classes/SharedClass.cls` (submodule at `force-app/main/shared`)
- ✅ `force-app/main/shared/force-app/main/default/classes/SubClass.cls` (nested structure)
- ❌ `scripts/deploy.sh` (not under `force-app`)

#### Granular Metadata Merging

When both parent and submodule have CustomLabels or SharingRules changes, they are automatically merged:

**Example Scenario:**

- Parent: `force-app/main/default/labels/CustomLabels.labels-meta.xml` (1 label changed)
- Submodule: `force-app/main/shared/labels/CustomLabels.labels-meta.xml` (3 labels changed)

**Result:**

- Single merged file: `ChangedFiles/labels/CustomLabels.labels-meta.xml` (4 labels total)
- Package.xml: 4 individual `CustomLabel` entries
- Logs: Shows all 4 labels in metadata summary

**Note:** SharingRules files are deployed as complete files (Salesforce doesn't support individual rule deployment), but the logs show which specific rules changed.

#### Submodule Setup Example

```bash
# Add a submodule for shared metadata
git submodule add https://github.com/myorg/shared-metadata.git force-app/main/shared

# Initialize and update submodules
git submodule update --init --recursive

# Build with submodule changes
sf fm build --ref-a main --ref-b HEAD
```

#### Build Output with Submodules

When submodules have changes, the logs include submodule information:

```
🔗 Submodules: 1 submodule with changes (25 files)
   - force-app/main/shared (abc1234 → def5678)

📝 CHANGED FILES: 30
   ✓ force-app/main/default/classes/MyClass.cls
   ✓ force-app/main/shared/classes/SharedClass.cls
   ...

METADATA CHANGE SUMMARY

📝 CHANGED/ADDED METADATA: 15 components across 5 types
   CustomLabels: 4 components
      ✓ My_Label (parent)
      ✓ Shared_Label_1 (submodule)
      ✓ Shared_Label_2 (submodule)
      ✓ Shared_Label_3 (submodule)
```

#### Best Practices

1. **Package Directories**: Ensure your parent repo's `sfdx-project.json` includes paths that cover both parent and submodule files
2. **Submodule Structure**: Keep submodule structure consistent with Salesforce metadata format
3. **Commit References**: When submodules update, the parent repo records the specific commit SHA, ensuring reproducible builds
4. **Testing**: Test metadata merging behavior with CustomLabels/SharingRules when using in both parent and submodule

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
| `--pre-steps`         | file      | Script to run before deployment (.sh .js .ts .py .apex)              |
| `--post-steps`        | file      | Script to run after deployment (.sh .js .ts .py .apex)               |
| `--tag-on-success`    | string    | Tag the deployed commit as `sf-deploy-success/<branch>/<timestamp>`  |
| `--tag-commit`        | string    | Commit to tag (default: HEAD)                                        |
| `--push-tag`          | boolean   | Push the deployment tag to `origin`                                  |
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

**Hook Specifications:**

- Timeout: 15 minutes per hook
- Max output: 10MB
- Pre-hooks must succeed or deployment stops
- Post-hooks only run after successful deployment
- All output (stdout/stderr) is displayed in real-time

For orchestrating multiple scripts, see the [Complete Hooks Guide](../messages/hooks-guide.md).

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

## sf fm docker init

Generate Docker configuration files for using plugin-fm in CI/CD environments.

### Synopsis

```bash
sf fm docker init [options]
```

### Description

This command generates a complete Docker setup for running plugin-fm in containerized CI/CD pipelines.

Generated files include:

- `Dockerfile` - Container image with SF CLI and plugin-fm
- `.dockerignore` - Optimize Docker build context
- `.github/workflows/docker-publish.yml` - GitHub Actions workflow to build and publish the image
- `DOCKER_README.md` - Comprehensive usage documentation

The generated Dockerfile includes:

- Salesforce CLI (sf)
- plugin-fm plugin
- Git for version control operations
- All necessary system dependencies (including GNU coreutils for Alpine Linux compatibility)

### Key Features

- **Customizable Base Image** - Choose any Node.js Docker image (Alpine, Ubuntu, etc.)
- **Multiple Install Methods** - Install plugin-fm from npm, local source, git, or skip
- **GitHub Actions Integration** - Optional workflow for building and publishing to GHCR
- **Complete Documentation** - Generated README with usage examples and best practices
- **Alpine Linux Support** - Includes coreutils for SF CLI compatibility

### Options

| Flag                      | Type    | Description                                                                |
| ------------------------- | ------- | -------------------------------------------------------------------------- |
| `--output-dir`, `-d`      | string  | Directory where Docker files will be generated (default: .)                |
| `--base-image`, `-b`      | string  | Docker base image to use (default: node:18-alpine)                         |
| `--maintainer`, `-m`      | string  | Maintainer information for the Docker image (default: Salesforce DevOps)   |
| `--sf-cli-version`        | string  | Version of Salesforce CLI to install (default: latest)                     |
| `--plugin-install-method` | string  | Method to install plugin-fm: npm, local, git, or skip (default: npm)       |
| `--plugin-version`        | string  | Version of plugin-fm to install when using npm method (default: latest)    |
| `--github-workflow`       | boolean | Generate GitHub Actions workflow (default: true, use --no-github-workflow) |
| `--json`                  | boolean | Output in JSON format                                                      |

### Examples

#### Basic Usage

```bash
# Generate Docker files in current directory with defaults
sf fm docker init

# Generate in specific directory
sf fm docker init --output-dir ./docker
```

#### Custom Base Image

```bash
# Use Node.js 20 with Alpine Linux
sf fm docker init --base-image node:20-alpine

# Use Ubuntu instead of Alpine
sf fm docker init --base-image node:18

# Use specific Node.js version
sf fm docker init --base-image node:18.19.0-alpine
```

#### Custom Maintainer

```bash
# Set maintainer information
sf fm docker init --maintainer "DevOps Team"

# With email
sf fm docker init --maintainer "DevOps Team <devops@company.com>"
```

#### Plugin Installation Methods

```bash
# Install from npm (default)
sf fm docker init --plugin-install-method npm --plugin-version latest

# Install from local source (for development)
sf fm docker init --plugin-install-method local

# Install from git repository
sf fm docker init --plugin-install-method git

# Skip plugin installation (install manually later)
sf fm docker init --plugin-install-method skip
```

#### Without GitHub Workflow

```bash
# Generate only Dockerfile and documentation
sf fm docker init --no-github-workflow
```

#### Full Customization

```bash
# All options
sf fm docker init \
  --output-dir ./ci \
  --base-image node:20-alpine \
  --maintainer "DevOps Team" \
  --sf-cli-version latest \
  --plugin-install-method npm \
  --plugin-version latest \
  --github-workflow
```

### Using Generated Files

#### Build Docker Image Locally

```bash
# After generating files
cd <output-dir>

# Build the image
docker build -t myorg/sf-fm-cicd:latest .

# Test it
docker run --rm myorg/sf-fm-cicd:latest sf --version
docker run --rm myorg/sf-fm-cicd:latest sf fm --help
```

#### Publish to GitHub Container Registry

The generated GitHub Actions workflow (`.github/workflows/docker-publish.yml`) automatically:

- Builds the image when Dockerfile changes
- Publishes to `ghcr.io/your-org/your-repo/sf-fm-cicd:latest`
- Tags with branch name and commit SHA
- Uses Docker layer caching for fast builds

Push the workflow file to your repository to enable automated builds.

#### Use in CI/CD Pipelines

**GitHub Actions:**

```yaml
jobs:
  deploy:
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
      - name: Build and Deploy
        run: |
          sf fm build --ref-a origin/main --ref-b HEAD --output-dir ./manifest
          sf fm deploy --manifest ./manifest --target-org prod
```

**GitLab CI:**

```yaml
deploy:
  image: registry.company.com/sf-fm-cicd:latest
  script:
    - sf fm build --ref-a origin/main --ref-b HEAD --output-dir ./manifest
    - sf fm deploy --manifest ./manifest --target-org prod
```

### Customizing the Dockerfile

The generated Dockerfile can be customized for your needs:

**Add Quality Tools:**

```dockerfile
# Install ESLint
RUN npm install -g eslint

# Install PMD (requires Java)
RUN apk add --no-cache openjdk11-jre
RUN wget -q https://github.com/pmd/pmd/releases/download/pmd_releases%2F7.0.0/pmd-dist-7.0.0-bin.zip \
    && unzip -q pmd-dist-7.0.0-bin.zip -d /opt \
    && ln -s /opt/pmd-bin-7.0.0/bin/pmd /usr/local/bin/pmd
```

**Install Additional SF Plugins:**

```dockerfile
RUN sf plugins install @salesforce/plugin-data
RUN sf plugins install @salesforce/plugin-org
```

### Output

The command creates these files in the specified output directory:

```
<output-dir>/
├── Dockerfile                              # Container image definition
├── .dockerignore                          # Docker build context optimization
├── .github/
│   └── workflows/
│       └── docker-publish.yml             # GitHub Actions workflow (optional)
└── DOCKER_README.md                       # Usage documentation
```

### Best Practices

1. **Version Your Images** - Use tags like `v1.0.0` instead of just `latest`
2. **Cache Layers** - Order Dockerfile steps from least to most frequently changing
3. **Security Scanning** - Use tools like Trivy to scan images
4. **Keep Updated** - Rebuild regularly to get security updates
5. **Test Locally** - Test the Docker image locally before using in CI/CD

---

## sf fm quality

Static code analysis on the files that changed, so pull requests are judged on the code they touch. See [QUALITY_COMMAND.md](QUALITY_COMMAND.md) for details.

```bash
# Changed files of a PR, team ruleset, block on High or worse
sf fm quality --ref-a origin/main --pmd-ruleset config/pmd/ruleset.xml --severity-threshold 2

# Whole project, report only
sf fm quality --all --warn-only
```

Engines are picked automatically: Salesforce Code Analyzer when installed (bundles PMD, ESLint, RetireJS, Flow Scanner), otherwise a local `pmd` with your `ruleset.xml` and the repository's own ESLint. Results are written to `quality-report/quality.md`, `quality.sarif` (GitHub code scanning) and `quality.json`, and the Markdown is added to the GitHub Actions job summary.

---

## sf fm pipeline run / init / approve

An **optional** pipeline that chains the commands above in `.fm/pipeline.yml`. Nothing else depends on it. See [PIPELINE.md](PIPELINE.md) for the full reference.

```bash
sf fm pipeline init --target-org uat --base-branch main   # starter .fm/pipeline.yml + example scripts
sf fm pipeline init --train --target-org uat              # release train: Data Cloud / core / OmniStudio over PR and push
sf fm pipeline run                                        # run it, asking at approval gates
sf fm pipeline run --step-by-step                         # confirm before every stage
sf fm pipeline approve --run latest                       # approve a paused run (CI)
sf fm pipeline run --resume latest                        # continue a paused run
```

---

## sf fm dashboard

Local release app: pipeline runs per release (stages, live logs, metrics, approvals), connected orgs, repository and deployment history, AI runbooks and AI settings.

```bash
sf fm dashboard --open                    # live at http://127.0.0.1:7007
sf fm dashboard --export dashboard.html   # self-contained snapshot, e.g. a CI artifact or GitHub Pages
```

---

## sf fm runbook run / init

Run pre- and post-deployment steps written in plain language (Markdown) with AI. Every change to the org waits for approval, and manual Setup steps become instructions to confirm. See [AI_RUNBOOKS.md](AI_RUNBOOKS.md).

```bash
sf fm runbook init                                                     # .fm/ai.yml + example runbooks
sf fm runbook run -f .fm/runbooks/pre-deploy.md -o uat --plan          # read-only plan
sf fm runbook run -f .fm/runbooks/pre-deploy.md -o uat                 # approve each change in the terminal
sf fm runbook run -f .fm/runbooks/post-deploy.md -o uat --wait-for-approval --pr
```

---

## sf fm e2e run / init

Playwright end-to-end scenarios against an org, logged in through the frontdoor URL (no stored passwords). See [ORG_EXPLORER.md](ORG_EXPLORER.md#playwright-scenarios).

```bash
sf fm e2e init
sf fm e2e run --target-org uat --grep Smoke
```

---

## Common Patterns

### Pattern 1: Complete CI/CD Workflow

```bash
# 1. Build
sf fm build --ref-a origin/main --ref-b HEAD --output-dir ./manifest

# 2. Deploy
JOB_ID=$(sf fm deploy --manifest ./manifest --target-org prod \
  --intelligent-tests --async --json | jq -r '.result.jobId')

# 3. Monitor
sf fm deploy status --job-id $JOB_ID --target-org prod --watch

# 4. Quick deploy if validated
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

### Docker Init Command

- Use `--base-image` to match your organization's standards
- Generate once and customize the Dockerfile for your needs
- Version your Docker images with tags
- Rebuild images regularly for security updates

---

## sf fm drift

Finds what changed directly in an org: builds a manifest from the package directories, retrieves the same metadata into a temporary folder and compares file by file (line endings, trailing spaces and whitespace between XML tags are ignored).

```bash
sf fm drift --target-org prod
sf fm drift --target-org prod --include-org-only ApexClass,Flow --fail-on-drift --output-file drift.md
```

| Option               | Meaning                                                                     |
| -------------------- | --------------------------------------------------------------------------- |
| `--target-org`       | Org to compare                                                              |
| `--source-dir`       | Folders to compare (default: package directories)                           |
| `--include-org-only` | Types to retrieve completely, to find components that exist only in the org |
| `--output-file`      | Markdown report (also written to the GitHub job summary in Actions)         |
| `--fail-on-drift`    | Exit 1 when anything differs                                                |

The report lists **changed in the org**, **in the org, not in the repository** and **in the repository, missing in the org**. As a pipeline stage: `uses: drift` (`with:` takes the same flags); it fails the stage only with `fail-on-drift: true`. A scheduled workflow running it nightly against production catches Setup changes early.

---

## sf fm rollback

Puts an org back on an earlier successful deployment of a branch, using the `sf-deploy-success/<branch>/*` tags written by `sf fm deploy --tag-on-success`.

```bash
sf fm rollback --target-org prod --branch main --dry-run      # validate only
sf fm rollback --target-org prod --branch main                # asks, then deploys
sf fm rollback --target-org prod --branch main --to sf-deploy-success/main/20261012T093000Z --no-prompt
```

The org is assumed to be on the newest tag. The delta from it to the target (the previous tag with a different commit, or `--to`) is built in a temporary git worktree of the target: metadata changed since is deployed in its earlier version, metadata added since is deleted (post-destructive). On success the target commit is tagged again, so the next `sf fm build --from-last-successful-deployment` starts from it. Data, and metadata Salesforce cannot delete through the API, are not rolled back.

---

## sf fm org create

One command for a ready-to-work org; each step is a Salesforce CLI command and the run stops at the first failure.

```bash
sf fm org create --alias feature-x --permset App_User --data-plan data/plan.json --apex-script scripts/apex/setup.apex --open
sf fm org create --type sandbox --alias uat2 --target-org prod --license-type Developer --dry-run
```

Scratch org (default): create from `config/project-scratch-def.json` (`--definition-file`, `--duration-days`, `--target-dev-hub`), deploy the project (`--no-deploy` to skip). Sandbox: `--target-org` is the production org (`--sandbox-name`, `--license-type`, or `--source-sandbox` to clone); the project is not deployed. Then `--permset`, `--data-plan` (`sf data import tree`) and `--apex-script` (each repeatable), `--set-default`, `--open`. `--dry-run` prints the commands.

---

## Validate on the PR, quick deploy on merge

`sf fm deploy` records every successful validation against a fingerprint of the package (every file in the manifest directory) in `.fm/validations.json`. With `--share-validation` it is also pushed as a git tag `sf-validation/<org>/<package>`, so another CI job can find it.

```bash
# pull request job
sf fm deploy --manifest manifest --target-org prod --mode validation --test-level RunLocalTests --share-validation
# merge (push) job, same package
sf fm deploy --manifest manifest --target-org prod --mode deployment --reuse-validation --tag-on-success main
```

With `--reuse-validation` a deployment looks for a validation of exactly the same package in the same org from the last 10 days and quick deploys it (no second test run). Without one, or when Salesforce refuses the quick deploy (for example because something else was deployed since), it deploys normally.
