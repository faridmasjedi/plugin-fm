# Pull Request Workflow Guide

## Overview

This guide shows how to use `sf fm deploy` and `sf fm deploy cancel` together for efficient PR validation workflows.

### Key Features

1. ✅ **Easy Job ID Capture** - No need for `jq`
2. ✅ **Cancel Previous Jobs** - Automatically cancel old validations when new commits are pushed
3. ✅ **Artifact Support** - Save/load job IDs between steps
4. ✅ **Safe Cancellation** - Skip gracefully if no previous job exists
5. ✅ **CI/CD Optimized** - Automatically creates cache entries in fresh containers

---

## Basic PR Validation Workflow

### Simple Workflow (Single Job)

```yaml
name: PR Validation

on:
  pull_request:
    types: [opened, synchronize, reopened]

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

      - name: Start Validation
        id: deploy
        run: |
          # Easy job ID capture - no jq needed!
          OUTPUT=$(sf fm deploy \
            --manifest ./manifest \
            --target-org target-org \
            --mode validation \
            --intelligent-tests \
            --async)

          # Extract job ID from output
          JOB_ID=$(echo "$OUTPUT" | grep "^Job ID:" | cut -d: -f2 | tr -d ' ')
          echo "job_id=$JOB_ID" >> $GITHUB_OUTPUT
          echo "$JOB_ID" > job-id.txt

      - name: Monitor Validation
        run: |
          sf fm deploy status \
            --job-id ${{ steps.deploy.outputs.job_id }} \
            --target-org target-org \
            --watch \
            --interval 15 \
            --timeout 120
```

---

## Advanced: Cancel Previous Validation on New Commit

When a new commit is pushed to a PR, cancel the old validation automatically!

### Workflow with Cancellation

```yaml
name: PR Validation with Cancellation

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
        with:
          fetch-depth: 0

      - name: Install SF CLI and Plugin
        run: |
          npm install -g @salesforce/cli
          sf plugins install @salesforce/plugin-fm

      - name: Authenticate
        run: |
          echo "${{ secrets.SF_AUTH_URL }}" > authfile
          sf org login sfdx-url --sfdx-url-file authfile --alias target-org

      # Download previous job ID artifact (if exists)
      - name: Download Previous Job ID
        uses: dawidd6/action-download-artifact@v2
        continue-on-error: true
        with:
          workflow: ${{ github.workflow }}
          pr: ${{ github.event.pull_request.number }}
          name: pr-${{ github.event.pull_request.number }}-job-id
          path: ./artifacts

      # Cancel previous validation job
      - name: Cancel Previous Validation
        run: |
          sf fm deploy cancel \
            --job-id-file ./artifacts/job-id.txt \
            --target-org target-org \
            --skip-if-not-found
        continue-on-error: true

      - name: Build Deployment Artifacts
        run: |
          sf fm build \
            --ref-a origin/${{ github.base_ref }} \
            --ref-b HEAD \
            --output-dir ./manifest

      - name: Start New Validation
        id: deploy
        run: |
          OUTPUT=$(sf fm deploy \
            --manifest ./manifest \
            --target-org target-org \
            --mode validation \
            --intelligent-tests \
            --async)

          JOB_ID=$(echo "$OUTPUT" | grep "^Job ID:" | cut -d: -f2 | tr -d ' ')
          echo "job_id=$JOB_ID" >> $GITHUB_OUTPUT

          # Save job ID for next run
          echo "$JOB_ID" > job-id.txt

      # Save job ID as artifact for next commit
      - name: Save Job ID for Next Run
        uses: actions/upload-artifact@v3
        with:
          name: pr-${{ github.event.pull_request.number }}-job-id
          path: job-id.txt
          retention-days: 7

      - name: Monitor Validation
        run: |
          sf fm deploy status \
            --job-id ${{ steps.deploy.outputs.job_id }} \
            --target-org target-org \
            --watch \
            --interval 15 \
            --timeout 120
```

### How It Works

```
┌─────────────────────────────────────────────┐
│ Commit 1 pushed to PR                       │
└──────────────┬──────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────┐
│ 1. No previous artifact exists              │
│ 2. Skip cancel (--skip-if-not-found)       │
│ 3. Start validation → Job ID: 0Af111       │
│ 4. Save job ID to artifact                  │
└──────────────┬──────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────┐
│ Commit 2 pushed to PR (before #1 finishes!) │
└──────────────┬──────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────┐
│ 1. Download previous artifact (0Af111)      │
│ 2. Cancel job 0Af111 ✅                     │
│ 3. Start new validation → Job ID: 0Af222   │
│ 4. Save new job ID to artifact              │
└─────────────────────────────────────────────┘
```

---

## Capturing Job ID Without jq

### Before (Complex)

```yaml
- name: Deploy
  run: |
    JOB_ID=$(sf fm deploy \
      --manifest ./manifest \
      --target-org org \
      --async \
      --json | jq -r '.result.jobId')
```

**Problems:**

- ❌ Requires `jq` to be installed
- ❌ Requires `--json` flag
- ❌ Complex JSON parsing

### After (Simple)

```yaml
- name: Deploy
  run: |
    OUTPUT=$(sf fm deploy \
      --manifest ./manifest \
      --target-org org \
      --async)

    JOB_ID=$(echo "$OUTPUT" | grep "^Job ID:" | cut -d: -f2 | tr -d ' ')
```

**Benefits:**

- ✅ No `jq` required
- ✅ Uses standard tools (`grep`, `cut`, `tr`)
- ✅ Clean, readable output

**Output Format:**

```
Deployment started: 0Af5e000004zXXX

Job ID: 0Af5e000004zXXX

To check status, run: sf fm deploy status --job-id 0Af5e000004zXXX --target-org <org>
```

---

## How Cache Creation Works in CI/CD

### The Problem

In CI/CD, each commit runs in a fresh container:

- ❌ No `.sf/deploy-cache.json` exists
- ❌ SF CLI can't find job to cancel
- ❌ Cancel command would fail

### The Solution

Our cancel command **automatically creates a cache entry with manifest and destructive changes** before canceling:

```typescript
// What happens when you run: sf fm deploy cancel --job-id 0Af...

1. Check if .sf/deploy-cache.json exists
   ├─ No: Create .sf directory
   └─ Yes: Read existing cache

2. Add job entry to cache with manifest and destructive changes:
   {
     "0Af5e000004zXXX": {
       "jobId": "0Af5e000004zXXX",
       "username": "user@example.com",
       "expirationDate": 1735123456789,
       "manifest": "/path/to/plugin/config/empty-package.xml",
       "postDestructiveChanges": "/path/to/plugin/config/empty-destructive.xml",
       "createdDate": 1735123456789
     }
   }

3. Now SF CLI can cancel the job ✅
```

### Benefits

✅ **Works in fresh containers** - Creates cache automatically
✅ **No manual setup** - Happens transparently
✅ **Uses empty config files** - References empty-package.xml and empty-destructive.xml
✅ **Complete cache entries** - Includes manifest and destructive changes paths
✅ **Fast** - No extra API calls or deployments

---

## Cancel Command Options

### Option 1: Cancel by Job ID

```bash
sf fm deploy cancel \
  --job-id 0Af5e000004zXXX \
  --target-org production
```

### Option 2: Cancel from File

```bash
sf fm deploy cancel \
  --job-id-file ./artifacts/job-id.txt \
  --target-org production
```

### Option 3: Safe Cancel (CI/CD Recommended)

```bash
sf fm deploy cancel \
  --job-id-file ./artifacts/job-id.txt \
  --target-org production \
  --skip-if-not-found
```

**Behaviors:**

- ✅ If file doesn't exist → Skip (no error)
- ✅ If job not found → Skip (no error)
- ✅ If job already completed → Skip (no error)
- ✅ If job is running → Cancel successfully

---

## Multi-Stage Workflow

For complex pipelines with validation → approval → deployment:

```yaml
name: Multi-Stage Deployment

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  # Stage 1: Cancel previous validation
  cancel-previous:
    runs-on: ubuntu-latest
    steps:
      - uses: dawidd6/action-download-artifact@v2
        continue-on-error: true
        with:
          workflow: ${{ github.workflow }}
          pr: ${{ github.event.pull_request.number }}
          name: validation-job-id
          path: ./artifacts

      - name: Install Plugin
        run: sf plugins install @salesforce/plugin-fm

      - name: Authenticate
        run: |
          echo "${{ secrets.SF_AUTH_URL }}" > authfile
          sf org login sfdx-url --sfdx-url-file authfile --alias target-org

      - name: Cancel Previous Job
        run: |
          sf fm deploy cancel \
            --job-id-file ./artifacts/job-id.txt \
            --target-org target-org \
            --skip-if-not-found

  # Stage 2: Start new validation
  validate:
    needs: cancel-previous
    runs-on: ubuntu-latest
    outputs:
      validation_id: ${{ steps.deploy.outputs.validation_id }}
    steps:
      - uses: actions/checkout@v3
        with:
          fetch-depth: 0

      - name: Install Plugin
        run: sf plugins install @salesforce/plugin-fm

      - name: Authenticate
        run: |
          echo "${{ secrets.SF_AUTH_URL }}" > authfile
          sf org login sfdx-url --sfdx-url-file authfile --alias target-org

      - name: Build Artifacts
        run: |
          sf fm build \
            --ref-a origin/${{ github.base_ref }} \
            --ref-b HEAD \
            --output-dir ./manifest

      - name: Start Validation
        id: deploy
        run: |
          OUTPUT=$(sf fm deploy \
            --manifest ./manifest \
            --target-org target-org \
            --mode validation \
            --intelligent-tests \
            --async)

          JOB_ID=$(echo "$OUTPUT" | grep "^Job ID:" | cut -d: -f2 | tr -d ' ')
          echo "job_id=$JOB_ID" >> $GITHUB_OUTPUT
          echo "validation_id=$JOB_ID" >> $GITHUB_OUTPUT
          echo "$JOB_ID" > job-id.txt

      - name: Save Job ID
        uses: actions/upload-artifact@v3
        with:
          name: validation-job-id
          path: job-id.txt

      - name: Monitor Validation
        run: |
          sf fm deploy status \
            --job-id ${{ steps.deploy.outputs.job_id }} \
            --target-org target-org \
            --watch \
            --timeout 120

  # Stage 3: Quick deploy on merge (manual approval)
  deploy:
    needs: validate
    if: github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    environment: production
    steps:
      - name: Install Plugin
        run: sf plugins install @salesforce/plugin-fm

      - name: Authenticate
        run: |
          echo "${{ secrets.PROD_AUTH_URL }}" > authfile
          sf org login sfdx-url --sfdx-url-file authfile --alias production

      - name: Quick Deploy
        run: |
          sf fm deploy \
            --mode quick \
            --validation-id ${{ needs.validate.outputs.validation_id }} \
            --target-org production
```

---

## Best Practices

### 1. Always Use `--skip-if-not-found` in CI/CD

```yaml
# ✅ GOOD - Won't fail on first commit
sf fm deploy cancel \
  --job-id-file ./artifacts/job-id.txt \
  --target-org org \
  --skip-if-not-found

# ❌ BAD - Will fail on first commit (no previous job)
sf fm deploy cancel \
  --job-id-file ./artifacts/job-id.txt \
  --target-org org
```

### 2. Use PR-Specific Artifact Names

```yaml
# ✅ GOOD - Separate artifacts per PR
name: pr-${{ github.event.pull_request.number }}-job-id

# ❌ BAD - All PRs share same artifact
name: job-id
```

### 3. Set Appropriate Retention

```yaml
- uses: actions/upload-artifact@v3
  with:
    name: pr-job-id
    path: job-id.txt
    retention-days: 7 # Keep for 1 week
```

### 4. Use `continue-on-error` for Cancellation

```yaml
- name: Cancel Previous
  run: sf fm deploy cancel ...
  continue-on-error: true # Don't block if cancel fails
```

---

## Troubleshooting

### Job ID Not Captured

**Problem**: `JOB_ID` variable is empty

**Solution**: Check output format

```bash
OUTPUT=$(sf fm deploy --async)
echo "$OUTPUT"  # Debug: see what's returned

# Look for "Job ID: " line
JOB_ID=$(echo "$OUTPUT" | grep "^Job ID:" | cut -d: -f2 | tr -d ' ')
```

### Artifact Not Found

**Problem**: "Download Previous Job ID" step fails

**Solution**: Use `continue-on-error: true`

```yaml
- name: Download Previous Job ID
  uses: dawidd6/action-download-artifact@v2
  continue-on-error: true # ← Don't fail if no previous artifact
```

### Cancel Fails on First Commit

**Problem**: No previous job to cancel on first PR commit

**Solution**: Use `--skip-if-not-found`

```bash
sf fm deploy cancel \
  --job-id-file ./artifacts/job-id.txt \
  --target-org org \
  --skip-if-not-found  # ← Skip gracefully if file/job doesn't exist
```

---

## Summary

### Commands Created

1. ✅ **`sf fm deploy --async`** - Returns clean job ID output (no `jq` needed)
2. ✅ **`sf fm deploy cancel`** - Cancel running deployments
3. ✅ **`sf fm deploy status`** - Monitor deployment progress

### Key Features

- ✅ Easy job ID capture with standard tools
- ✅ Cancel previous PR validations automatically
- ✅ Artifact-based job ID storage
- ✅ Safe cancellation with `--skip-if-not-found`
- ✅ Perfect for GitHub Actions, GitLab CI, Azure DevOps

### Complete PR Workflow

```bash
# 1. Cancel previous validation (if exists)
sf fm deploy cancel --job-id-file ./prev-job.txt --skip-if-not-found

# 2. Start new validation
OUTPUT=$(sf fm deploy --manifest ./manifest --async)
JOB_ID=$(echo "$OUTPUT" | grep "^Job ID:" | cut -d: -f2 | tr -d ' ')

# 3. Save job ID for next commit
echo "$JOB_ID" > job-id.txt

# 4. Monitor validation
sf fm deploy status --job-id $JOB_ID --watch

# 5. On merge, quick deploy to production
sf fm deploy --mode quick --validation-id $JOB_ID --target-org prod
```

**Perfect for PR-based development workflows! 🚀**
