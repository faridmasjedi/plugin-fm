# CI/CD Usage Guide

## Understanding Cache Behavior in CI/CD

### The Problem

In CI/CD environments, **cache files don't persist between steps**:

```yaml
# ❌ This won't work as expected
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Deploy
        run: sf fm deploy --async
        # Creates .sf/deploy-cache.json in container A

      - name: Check Status
        run: sf fm deploy status --job-id $JOB_ID
        # Runs in same container, but cache might expire
        # Or in different step/job = different container = NO cache!
```

### Why Cache Doesn't Work in CI/CD

1. **Each step can run in a fresh container** - No .sf folder
2. **Cache file is in home directory** - Not in workspace
3. **33-minute default timeout** - Not long enough for most deployments
4. **Not saved as artifact** - Doesn't persist between jobs

## ✅ Recommended CI/CD Approach

**Always use explicit `--job-id` flags** - Don't rely on cache!

### GitHub Actions Example

```yaml
name: Salesforce Deployment

on:
  push:
    branches: [main]

jobs:
  deploy-and-monitor:
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
            --ref-a origin/main \
            --ref-b HEAD \
            --output-dir ./manifest

      # Start deployment and save job ID to artifact
      - name: Start Deployment
        id: deploy
        run: |
          JOB_ID=$(sf fm deploy \
            --manifest ./manifest \
            --target-org target-org \
            --mode validation \
            --intelligent-tests \
            --async \
            --json | jq -r '.result.jobId')

          # Save job ID to GitHub output
          echo "job_id=$JOB_ID" >> $GITHUB_OUTPUT

          # Also save to file as backup
          echo "$JOB_ID" > deployment-job-id.txt

      # Save job ID as artifact (optional, for multi-job workflows)
      - name: Save Job ID Artifact
        uses: actions/upload-artifact@v3
        with:
          name: deployment-job-id
          path: deployment-job-id.txt

      # Monitor deployment status
      - name: Monitor Deployment
        run: |
          sf fm deploy status \
            --job-id ${{ steps.deploy.outputs.job_id }} \
            --target-org target-org \
            --watch \
            --interval 15 \
            --timeout 120

      # If deployment succeeds, quick deploy to production
      - name: Quick Deploy to Production
        if: success()
        run: |
          sf fm deploy \
            --mode quick \
            --validation-id ${{ steps.deploy.outputs.job_id }} \
            --target-org production
```

### Multi-Job Workflow with Artifacts

```yaml
name: Multi-Stage Deployment

jobs:
  validate:
    runs-on: ubuntu-latest
    outputs:
      job_id: ${{ steps.deploy.outputs.job_id }}
    steps:
      - name: Start Validation
        id: deploy
        run: |
          JOB_ID=$(sf fm deploy --async --json | jq -r '.result.jobId')
          echo "job_id=$JOB_ID" >> $GITHUB_OUTPUT

  monitor:
    needs: validate
    runs-on: ubuntu-latest
    steps:
      - name: Check Validation Status
        run: |
          sf fm deploy status \
            --job-id ${{ needs.validate.outputs.job_id }} \
            --target-org prod \
            --watch

  deploy:
    needs: [validate, monitor]
    runs-on: ubuntu-latest
    steps:
      - name: Quick Deploy
        run: |
          sf fm deploy \
            --mode quick \
            --validation-id ${{ needs.validate.outputs.job_id }} \
            --target-org prod
```

## Cache Extension Behavior

### What Happens in CI/CD?

```typescript
// When you run: sf fm deploy status --job-id 0Af...

1. Tries to extend cache (optional)
   ├─ If .sf/deploy-cache.json exists: ✅ Extends timeout
   └─ If not found: ⚠️ Silently skips (normal in CI/CD)

2. Checks deployment status
   ├─ Uses explicit --job-id flag
   └─ Always works regardless of cache
```

### Benefits

✅ **Works in all environments** - Local dev AND CI/CD
✅ **No dependencies** - Just job ID
✅ **No artifacts needed** - Job ID passed via output/env vars
✅ **Fails gracefully** - Cache extension is optional

## Local Development vs CI/CD

### Local Development

```bash
# Start deployment
sf fm deploy --manifest ./manifest --target-org sandbox --async
# Job ID: 0Af5e000004zXXX

# Check status (cache extended automatically)
sf fm deploy status -i 0Af5e000004zXXX -o sandbox

# 45 minutes later, check again
sf fm deploy status -i 0Af5e000004zXXX -o sandbox
# ✅ Still works! Cache was extended
```

**Benefits:**

- Cache extension keeps job "alive"
- Don't need to remember job ID
- Can check status many times

### CI/CD

```yaml
# Start deployment
JOB_ID=$(sf fm deploy --async --json | jq -r '.result.jobId')

# Check status (cache doesn't exist, but still works!)
sf fm deploy status --job-id $JOB_ID --target-org prod --watch
# ✅ Works! Uses explicit job ID, cache not needed
```

**Benefits:**

- No reliance on cache files
- Works in any container
- Explicit job ID tracking

## Best Practices

### 1. Always Save Job ID

```yaml
# Save to GitHub output
echo "job_id=$JOB_ID" >> $GITHUB_OUTPUT

# Save to environment variable
echo "JOB_ID=$JOB_ID" >> $GITHUB_ENV

# Save to file (for artifact)
echo "$JOB_ID" > job-id.txt
```

### 2. Use Watch Mode for Monitoring

```bash
# Don't manually poll in a loop
# ❌ BAD:
while true; do
  sf fm deploy status --job-id $JOB_ID
  sleep 30
done

# ✅ GOOD:
sf fm deploy status \
  --job-id $JOB_ID \
  --watch \
  --interval 30 \
  --timeout 120
```

### 3. Set Appropriate Timeouts

```yaml
# Production deployments (long-running)
--timeout 180  # 3 hours

# Validation (medium)
--timeout 120  # 2 hours

# Sandbox (quick)
--timeout 60   # 1 hour
```

### 4. Handle Deployment Failures

```yaml
- name: Monitor Deployment
  id: monitor
  run: |
    sf fm deploy status \
      --job-id ${{ steps.deploy.outputs.job_id }} \
      --target-org prod \
      --watch \
      --timeout 120
  continue-on-error: false

- name: Handle Failure
  if: failure()
  run: |
    echo "Deployment failed!"
    # Send notification, rollback, etc.
```

## GitLab CI Example

```yaml
deploy:
  stage: deploy
  script:
    # Start deployment
    - >
      JOB_ID=$(sf fm deploy
      --manifest ./manifest
      --target-org production
      --async
      --json | jq -r '.result.jobId')

    # Save job ID
    - echo "$JOB_ID" > deployment-job-id.txt

    # Monitor deployment
    - >
      sf fm deploy status
      --job-id $JOB_ID
      --target-org production
      --watch
      --interval 15
      --timeout 120

  artifacts:
    paths:
      - deployment-job-id.txt
    expire_in: 1 week
```

## Azure DevOps Example

```yaml
- task: Bash@3
  displayName: 'Start Deployment'
  name: deploy
  inputs:
    targetType: 'inline'
    script: |
      JOB_ID=$(sf fm deploy \
        --manifest ./manifest \
        --target-org $(SF_TARGET_ORG) \
        --async \
        --json | jq -r '.result.jobId')

      echo "##vso[task.setvariable variable=jobId;isOutput=true]$JOB_ID"

- task: Bash@3
  displayName: 'Monitor Deployment'
  inputs:
    targetType: 'inline'
    script: |
      sf fm deploy status \
        --job-id $(deploy.jobId) \
        --target-org $(SF_TARGET_ORG) \
        --watch \
        --timeout 120
```

## Troubleshooting

### "Could not extend deploy cache" Warning

**Cause**: Normal in CI/CD - cache file doesn't exist

**Solution**: Ignore this warning. Status check will work with `--job-id`.

### "Job not found" Error

**Cause**: Job ID incorrect or expired (10 days max)

**Solution**:

- Verify job ID is correct
- Check if job is older than 10 days
- Ensure org authentication is valid

### Deployment Times Out

**Cause**: `--timeout` value too small

**Solution**: Increase timeout

```bash
# Instead of:
--timeout 60

# Use:
--timeout 180
```

## Summary

### Key Principles for CI/CD

1. ✅ **Use explicit `--job-id`** - Don't rely on cache
2. ✅ **Save job ID to artifacts/outputs** - Pass between steps
3. ✅ **Use watch mode** - Built-in polling
4. ✅ **Set appropriate timeouts** - Match deployment duration
5. ✅ **Cache extension is optional** - Nice to have locally, not needed in CI/CD

### When Cache Extension Helps

- ✅ Local development
- ✅ Interactive usage
- ✅ Single-session workflows

### When Cache Extension Doesn't Matter

- ⚠️ CI/CD pipelines
- ⚠️ Multi-container environments
- ⚠️ Fresh environments per step

**Bottom Line**: The plugin works perfectly in CI/CD by using explicit job IDs. Cache extension is a bonus feature for local development, not a requirement!

## CI/CD integration

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

## Pre/post deployment hooks

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

[Complete Hooks Guide →](messages/hooks-guide.md)
