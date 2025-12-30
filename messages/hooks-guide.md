# Deployment Hooks Guide

This guide explains how to use pre-deployment and post-deployment hooks with `sf fm deploy`, including how to orchestrate multiple scripts in a single hook.

## Overview

Hooks allow you to execute custom scripts before and after deployments. They're perfect for:

- Backing up data before deployments
- Running validation checks
- Clearing caches
- Sending notifications
- Running smoke tests
- Custom cleanup tasks

## Basic Usage

### Single Script Hook

```bash
# Pre-deployment hook
sf fm deploy \
  --manifest ./manifest \
  --target-org myorg \
  --pre-steps ./scripts/pre-deploy.sh

# Post-deployment hook
sf fm deploy \
  --manifest ./manifest \
  --target-org myorg \
  --post-steps ./scripts/post-deploy.sh

# Both hooks
sf fm deploy \
  --manifest ./manifest \
  --target-org myorg \
  --pre-steps ./scripts/pre-deploy.sh \
  --post-steps ./scripts/post-deploy.sh
```

## Environment Variables

All hooks receive the following environment variables:

| Variable          | Description                            | Available In    |
| ----------------- | -------------------------------------- | --------------- |
| `FM_HOOK_TYPE`    | "pre" or "post"                        | Both            |
| `FM_DEPLOY_MODE`  | "validation", "deployment", or "quick" | Both            |
| `FM_TARGET_ORG`   | Target Salesforce org username         | Both            |
| `FM_MANIFEST_DIR` | Path to manifest directory             | Both            |
| `FM_JOB_ID`       | Deployment job ID                      | Post hooks only |

## Hook Behavior

### Pre-Deployment Hooks

- Execute **before** deployment starts
- If hook **fails** (exits with non-zero), deployment is **cancelled**
- Timeout: 15 minutes
- Max output: 10MB

### Post-Deployment Hooks

- Execute **after successful** deployment
- Only run if deployment **succeeded**
- If hook **fails**, deployment is already complete (only warning shown)
- Timeout: 15 minutes
- Max output: 10MB

## Multiple Files in One Hook

Since `--pre-steps` and `--post-steps` accept only one file path, you can use a master orchestrator script to run multiple scripts.

### Method 1: Master Script (Bash)

Create a master script that calls multiple sub-scripts:

**master-pre-deploy.sh:**

```bash
#!/bin/bash

# Master Pre-Deployment Hook
# Orchestrates multiple deployment steps

set -e  # Exit on first error

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "========================================"
echo "PRE-DEPLOYMENT HOOKS"
echo "========================================"
echo "Target Org: $FM_TARGET_ORG"
echo "Mode: $FM_DEPLOY_MODE"
echo ""

# Define steps to execute
STEPS=(
  "$SCRIPT_DIR/01-backup-metadata.sh"
  "$SCRIPT_DIR/02-validate-environment.sh"
  "$SCRIPT_DIR/03-check-dependencies.sh"
  "$SCRIPT_DIR/04-prepare-data.sh"
)

# Execute each step
for i in "${!STEPS[@]}"; do
  STEP="${STEPS[$i]}"
  STEP_NUM=$((i + 1))
  TOTAL=${#STEPS[@]}

  echo "[$STEP_NUM/$TOTAL] Executing: $(basename "$STEP")"

  if [ -f "$STEP" ]; then
    chmod +x "$STEP"
    if ! "$STEP"; then
      echo "✗ Step failed: $STEP"
      exit 1
    fi
    echo "✓ Step completed"
  else
    echo "✗ Step not found: $STEP"
    exit 1
  fi
  echo ""
done

echo "✓ All pre-deployment steps completed successfully!"
exit 0
```

**Individual step scripts:**

**01-backup-metadata.sh:**

```bash
#!/bin/bash
echo "  Backing up current metadata..."
# Your backup logic here
sleep 1
echo "  Backup completed to /backups/$(date +%Y%m%d_%H%M%S)"
exit 0
```

**02-validate-environment.sh:**

```bash
#!/bin/bash
echo "  Validating environment configuration..."
# Your validation logic here
if [ -z "$FM_TARGET_ORG" ]; then
  echo "  ERROR: Target org not set"
  exit 1
fi
echo "  Environment validated"
exit 0
```

### Method 2: Master Script (Node.js/JavaScript)

For more complex logic, use JavaScript:

**master-pre-deploy.js:**

```javascript
#!/usr/bin/env node

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Configuration
const SCRIPT_DIR = __dirname;
const STEPS = ['01-backup-metadata.sh', '02-validate-environment.sh', '03-check-dependencies.sh', '04-prepare-data.sh'];

async function main() {
  console.log('========================================');
  console.log('PRE-DEPLOYMENT HOOKS');
  console.log('========================================');
  console.log(`Target Org: ${process.env.FM_TARGET_ORG}`);
  console.log(`Mode: ${process.env.FM_DEPLOY_MODE}`);
  console.log('');

  for (let i = 0; i < STEPS.length; i++) {
    const step = STEPS[i];
    const stepPath = path.join(SCRIPT_DIR, step);
    const stepNum = i + 1;
    const total = STEPS.length;

    console.log(`[${stepNum}/${total}] Executing: ${step}`);

    if (!fs.existsSync(stepPath)) {
      console.error(`✗ Step not found: ${stepPath}`);
      process.exit(1);
    }

    try {
      // Make executable
      fs.chmodSync(stepPath, '755');

      // Execute
      execSync(`"${stepPath}"`, {
        stdio: 'inherit',
        env: process.env,
      });

      console.log('✓ Step completed\n');
    } catch (error) {
      console.error(`✗ Step failed: ${step}`);
      process.exit(1);
    }
  }

  console.log('✓ All pre-deployment steps completed successfully!');
  process.exit(0);
}

main().catch((error) => {
  console.error('Hook failed:', error);
  process.exit(1);
});
```

### Method 3: Conditional Execution

Run different steps based on deployment mode:

**conditional-pre-deploy.sh:**

```bash
#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Deployment Mode: $FM_DEPLOY_MODE"

case "$FM_DEPLOY_MODE" in
  validation)
    echo "Running validation-only checks..."
    "$SCRIPT_DIR/quick-validation.sh"
    ;;
  deployment)
    echo "Running full deployment checks..."
    "$SCRIPT_DIR/full-backup.sh"
    "$SCRIPT_DIR/data-validation.sh"
    "$SCRIPT_DIR/dependency-check.sh"
    ;;
  quick)
    echo "Quick deploy - minimal checks..."
    "$SCRIPT_DIR/smoke-test.sh"
    ;;
esac

exit 0
```

### Method 4: Parallel Execution

Run independent steps in parallel for speed:

**parallel-pre-deploy.sh:**

```bash
#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Running parallel pre-deployment checks..."

# Run independent checks in parallel
"$SCRIPT_DIR/check-apex-coverage.sh" &
PID1=$!

"$SCRIPT_DIR/validate-metadata.sh" &
PID2=$!

"$SCRIPT_DIR/check-org-limits.sh" &
PID3=$!

# Wait for all to complete
wait $PID1 || exit 1
wait $PID2 || exit 1
wait $PID3 || exit 1

echo "All parallel checks passed!"
exit 0
```

## Complete Example

### Project Structure

```
project-root/
├── .fm-deploy/
│   ├── hooks/
│   │   ├── master-pre-deploy.sh      # Master orchestrator
│   │   ├── master-post-deploy.sh     # Master orchestrator
│   │   ├── pre/
│   │   │   ├── 01-backup-metadata.sh
│   │   │   ├── 02-validate-env.sh
│   │   │   ├── 03-check-deps.sh
│   │   │   └── 04-prepare-data.sh
│   │   └── post/
│   │       ├── 01-clear-cache.sh
│   │       ├── 02-smoke-tests.sh
│   │       ├── 03-notify-team.sh
│   │       └── 04-update-docs.sh
│   └── config/
│       └── deployment-settings.json
└── manifest/
    └── package.xml
```

### Master Pre-Deploy Script

**.fm-deploy/hooks/master-pre-deploy.sh:**

```bash
#!/bin/bash

# Master Pre-Deployment Hook
# Executes all pre-deployment steps in sequence

set -e  # Exit immediately if any command fails

HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRE_DIR="$HOOKS_DIR/pre"

echo "╔════════════════════════════════════════╗"
echo "║   PRE-DEPLOYMENT HOOKS                 ║"
echo "╚════════════════════════════════════════╝"
echo ""
echo "Target Org: $FM_TARGET_ORG"
echo "Deploy Mode: $FM_DEPLOY_MODE"
echo "Manifest: $FM_MANIFEST_DIR"
echo ""

# Find and execute all scripts in pre/ directory
STEPS=($(find "$PRE_DIR" -name "*.sh" | sort))

if [ ${#STEPS[@]} -eq 0 ]; then
  echo "No pre-deployment steps found"
  exit 0
fi

FAILED=0
START_TIME=$(date +%s)

for i in "${!STEPS[@]}"; do
  STEP="${STEPS[$i]}"
  STEP_NUM=$((i + 1))
  TOTAL=${#STEPS[@]}
  STEP_NAME=$(basename "$STEP" .sh)

  echo "[$STEP_NUM/$TOTAL] $STEP_NAME"
  echo "────────────────────────────────────────"

  chmod +x "$STEP"

  if "$STEP"; then
    echo "✓ $STEP_NAME completed"
  else
    echo "✗ $STEP_NAME failed"
    FAILED=1
    break
  fi

  echo ""
done

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo "════════════════════════════════════════"
if [ $FAILED -eq 0 ]; then
  echo "✓ All pre-deployment steps completed"
  echo "  Duration: ${DURATION}s"
  exit 0
else
  echo "✗ Pre-deployment failed"
  echo "  Duration: ${DURATION}s"
  exit 1
fi
```

### Master Post-Deploy Script

**.fm-deploy/hooks/master-post-deploy.sh:**

```bash
#!/bin/bash

# Master Post-Deployment Hook
# Executes all post-deployment steps in sequence

HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POST_DIR="$HOOKS_DIR/post"

echo "╔════════════════════════════════════════╗"
echo "║   POST-DEPLOYMENT HOOKS                ║"
echo "╚════════════════════════════════════════╝"
echo ""
echo "Job ID: $FM_JOB_ID"
echo "Target Org: $FM_TARGET_ORG"
echo "Deploy Mode: $FM_DEPLOY_MODE"
echo ""

# Find and execute all scripts in post/ directory
STEPS=($(find "$POST_DIR" -name "*.sh" | sort))

if [ ${#STEPS[@]} -eq 0 ]; then
  echo "No post-deployment steps found"
  exit 0
fi

WARNINGS=0
START_TIME=$(date +%s)

for i in "${!STEPS[@]}"; do
  STEP="${STEPS[$i]}"
  STEP_NUM=$((i + 1))
  TOTAL=${#STEPS[@]}
  STEP_NAME=$(basename "$STEP" .sh)

  echo "[$STEP_NUM/$TOTAL] $STEP_NAME"
  echo "────────────────────────────────────────"

  chmod +x "$STEP"

  # Post-hooks continue even if one fails
  if "$STEP"; then
    echo "✓ $STEP_NAME completed"
  else
    echo "⚠ $STEP_NAME had issues (continuing)"
    WARNINGS=$((WARNINGS + 1))
  fi

  echo ""
done

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo "════════════════════════════════════════"
if [ $WARNINGS -eq 0 ]; then
  echo "✓ All post-deployment steps completed"
else
  echo "⚠ Completed with $WARNINGS warnings"
fi
echo "  Duration: ${DURATION}s"
exit 0
```

### Usage

```bash
# Deploy with hooks
sf fm deploy \
  --manifest ./manifest \
  --target-org production \
  --mode deployment \
  --intelligent-tests \
  --pre-steps ./.fm-deploy/hooks/master-pre-deploy.sh \
  --post-steps ./.fm-deploy/hooks/master-post-deploy.sh \
  --progress
```

## Best Practices

### 1. Script Organization

- Number scripts (01-, 02-) for clear execution order
- Use descriptive names (backup-metadata.sh, not script1.sh)
- Keep scripts focused on one task
- Store scripts in version control

### 2. Error Handling

```bash
#!/bin/bash
set -e  # Exit on error
set -u  # Exit on undefined variable
set -o pipefail  # Exit on pipe failure

# Your script here
```

### 3. Logging

```bash
# Add timestamps and context
echo "[$(date +'%Y-%m-%d %H:%M:%S')] Starting backup..."
echo "[$(date +'%Y-%m-%d %H:%M:%S')] Backup completed"

# Save logs
LOG_FILE="/tmp/deployment-$(date +%Y%m%d_%H%M%S).log"
exec 1> >(tee -a "$LOG_FILE")
exec 2>&1
```

### 4. Timeouts and Retries

```bash
# Add timeout for long operations
timeout 300 ./long-running-check.sh || {
  echo "Operation timed out after 5 minutes"
  exit 1
}

# Retry logic
MAX_RETRIES=3
RETRY=0

while [ $RETRY -lt $MAX_RETRIES ]; do
  if ./flaky-operation.sh; then
    break
  fi
  RETRY=$((RETRY + 1))
  echo "Retry $RETRY/$MAX_RETRIES"
  sleep 5
done
```

### 5. Idempotency

Make hooks safe to run multiple times:

```bash
# Check if already done
if [ -f "/tmp/backup-done.flag" ]; then
  echo "Backup already exists, skipping"
  exit 0
fi

# Do backup
./backup.sh

# Mark as done
touch "/tmp/backup-done.flag"
```

### 6. Testing Hooks Locally

```bash
# Test without deploying
FM_HOOK_TYPE=pre \
FM_DEPLOY_MODE=validation \
FM_TARGET_ORG=test-org \
FM_MANIFEST_DIR=./manifest \
  ./master-pre-deploy.sh
```

### 7. Security

- Don't hardcode credentials in scripts
- Use SF CLI authentication
- Validate inputs
- Sanitize file paths

```bash
# Bad
curl https://api.example.com/notify?org=$FM_TARGET_ORG

# Good
ORG=$(printf '%s' "$FM_TARGET_ORG" | jq -sRr @uri)
curl "https://api.example.com/notify?org=$ORG"
```

## Real-World Examples

### Example 1: Data Backup Before Deployment

**01-backup-data.sh:**

```bash
#!/bin/bash
BACKUP_DIR="/backups/salesforce/$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BACKUP_DIR"

echo "Backing up data to $BACKUP_DIR"

# Export data using SF CLI
sf data export tree \
  --query "SELECT Id, Name FROM Account" \
  --target-org "$FM_TARGET_ORG" \
  --output-dir "$BACKUP_DIR"

echo "Backup completed: $BACKUP_DIR"
exit 0
```

### Example 2: Slack Notifications

**03-notify-team.sh:**

```bash
#!/bin/bash
SLACK_WEBHOOK_URL="https://hooks.slack.com/services/YOUR/WEBHOOK/URL"

MESSAGE="Deployment to $FM_TARGET_ORG completed! Job ID: $FM_JOB_ID"

curl -X POST -H 'Content-type: application/json' \
  --data "{\"text\":\"$MESSAGE\"}" \
  "$SLACK_WEBHOOK_URL"

exit 0
```

### Example 3: Run Smoke Tests

**02-smoke-tests.sh:**

```bash
#!/bin/bash
echo "Running smoke tests..."

# Run Apex tests
sf apex run test \
  --test-level RunSpecifiedTests \
  --tests SmokeTest \
  --target-org "$FM_TARGET_ORG" \
  --wait 10 \
  --result-format human

exit $?
```

## Troubleshooting

### Hook Not Executing

- Check file permissions: `chmod +x script.sh`
- Verify shebang: `#!/bin/bash` must be first line
- Check file path is correct
- Ensure script exists and is readable

### Hook Timeout

- Increase timeout (currently 15 minutes)
- Optimize long-running operations
- Consider async operations

### No Output Visible

- Output is now displayed (as of latest version)
- Check stdout/stderr in script
- Ensure `echo` statements exist

### Exit Codes

- `0` = Success
- `1-255` = Failure
- Pre-hooks must exit 0 or deployment stops
- Post-hooks can fail (only warning shown)

## Summary

- Use **master scripts** to orchestrate multiple files
- **Pre-hooks** must succeed or deployment stops
- **Post-hooks** run only after successful deployment
- All hooks receive **environment variables**
- Hooks timeout after **15 minutes**
- Scripts must be **executable** and have proper **shebang**
- Use **exit codes** to signal success/failure
