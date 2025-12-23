#!/bin/bash
# ============================================================
# SF FM DEPLOY STATUS - Examples
# ============================================================
# This file contains real-world examples for deploy status command
# ============================================================

# ------------------------------------------------------------
# Example 1: Check Status Once
# ------------------------------------------------------------
# Get current status of a deployment

sf fm deploy status \
  --job-id 0Af5e000004zXXX \
  --target-org my-sandbox

# Output shows:
# - Current status (InProgress, Succeeded, Failed)
# - Progress percentage
# - Components deployed
# - Tests completed
# - Errors/warnings

# ------------------------------------------------------------
# Example 2: Watch Deployment Progress
# ------------------------------------------------------------
# Monitor deployment in real-time (polls every 10 seconds)

sf fm deploy status \
  --job-id 0Af5e000004zXXX \
  --target-org my-sandbox \
  --watch

# Shows live progress:
# ⏳ Status: InProgress (45%)
# 📦 Components: 230/512
# ✅ Tests: 45/120
# ⏱️  Duration: 5m 23s

# ------------------------------------------------------------
# Example 3: Custom Poll Interval
# ------------------------------------------------------------
# Check status every 30 seconds

sf fm deploy status \
  --job-id 0Af5e000004zXXX \
  --target-org my-sandbox \
  --watch \
  --interval 30

# ------------------------------------------------------------
# Example 4: Watch with Timeout
# ------------------------------------------------------------
# Monitor for maximum 2 hours

sf fm deploy status \
  --job-id 0Af5e000004zXXX \
  --target-org my-sandbox \
  --watch \
  --timeout 120

# Exits with error if not completed within 120 minutes

# ------------------------------------------------------------
# Example 5: JSON Output
# ------------------------------------------------------------
# Get status as JSON for parsing

sf fm deploy status \
  --job-id 0Af5e000004zXXX \
  --target-org my-sandbox \
  --json > status.json

# Parse with jq:
# STATUS=$(jq -r '.result.status' status.json)
# PROGRESS=$(jq -r '.result.progress' status.json)

# ------------------------------------------------------------
# Example 6: Monitor Long-Running Deployment
# ------------------------------------------------------------
# For large deployments, use longer interval and timeout

sf fm deploy status \
  --job-id 0Af5e000004zXXX \
  --target-org production \
  --watch \
  --interval 60 \
  --timeout 240

# Checks every minute, waits up to 4 hours

# ------------------------------------------------------------
# Example 7: Check Multiple Deployments
# ------------------------------------------------------------

#!/bin/bash
# Monitor multiple concurrent deployments

JOBS=("0Af1..." "0Af2..." "0Af3...")

for JOB_ID in "${JOBS[@]}"; do
  echo "Checking job: $JOB_ID"

  sf fm deploy status \
    --job-id $JOB_ID \
    --target-org my-sandbox \
    --json > status-$JOB_ID.json

  STATUS=$(jq -r '.result.status' status-$JOB_ID.json)
  echo "  Status: $STATUS"
done

# ------------------------------------------------------------
# Example 8: GitHub Actions Integration
# ------------------------------------------------------------

# - name: Monitor Deployment
#   run: |
#     sf fm deploy status \
#       --job-id ${{ steps.deploy.outputs.job_id }} \
#       --target-org ci-sandbox \
#       --watch \
#       --interval 30 \
#       --timeout 120
#
# - name: Get Final Status
#   if: always()
#   run: |
#     sf fm deploy status \
#       --job-id ${{ steps.deploy.outputs.job_id }} \
#       --target-org ci-sandbox \
#       --json > final-status.json
#
#     cat final-status.json
#
# - name: Upload Status Report
#   if: always()
#   uses: actions/upload-artifact@v4
#   with:
#     name: deployment-status
#     path: final-status.json

# ------------------------------------------------------------
# Example 9: Alert on Deployment Completion
# ------------------------------------------------------------

#!/bin/bash
# Send notification when deployment completes

JOB_ID="0Af5e000004zXXX"
ORG="production"
WEBHOOK="$SLACK_WEBHOOK_URL"

# Monitor deployment
sf fm deploy status \
  --job-id $JOB_ID \
  --target-org $ORG \
  --watch \
  --timeout 120

# Get final status
STATUS=$(sf fm deploy status \
  --job-id $JOB_ID \
  --target-org $ORG \
  --json | jq -r '.result.status')

# Send notification
if [ "$STATUS" == "Succeeded" ]; then
  curl -X POST $WEBHOOK \
    -H 'Content-Type: application/json' \
    -d "{\"text\":\"✅ Deployment $JOB_ID succeeded!\"}"
else
  curl -X POST $WEBHOOK \
    -H 'Content-Type: application/json' \
    -d "{\"text\":\"❌ Deployment $JOB_ID failed! @here\"}"
fi

# ------------------------------------------------------------
# Example 10: Wait for Deployment with Retry
# ------------------------------------------------------------

#!/bin/bash
# Retry checking status if network issues

JOB_ID="0Af5e000004zXXX"
ORG="my-sandbox"
MAX_RETRIES=3

for i in $(seq 1 $MAX_RETRIES); do
  echo "Attempt $i/$MAX_RETRIES..."

  if sf fm deploy status \
    --job-id $JOB_ID \
    --target-org $ORG \
    --watch \
    --timeout 60; then
    echo "✅ Deployment completed successfully"
    exit 0
  else
    echo "⚠️  Check failed, retrying..."
    sleep 10
  fi
done

echo "❌ Failed after $MAX_RETRIES attempts"
exit 1

# ------------------------------------------------------------
# Example 11: Export Status Report
# ------------------------------------------------------------

#!/bin/bash
# Generate detailed status report

JOB_ID="0Af5e000004zXXX"
ORG="production"

# Get status
sf fm deploy status \
  --job-id $JOB_ID \
  --target-org $ORG \
  --json > status.json

# Parse and format report
cat > deployment-report.md << EOF
# Deployment Report

**Job ID:** $JOB_ID
**Target Org:** $ORG
**Status:** $(jq -r '.result.status' status.json)
**Progress:** $(jq -r '.result.progress' status.json)%

## Components
- Deployed: $(jq -r '.result.componentsDeployed' status.json)
- Total: $(jq -r '.result.componentsTotal' status.json)

## Tests
- Completed: $(jq -r '.result.testsCompleted' status.json)
- Total: $(jq -r '.result.testsTotal' status.json)
- Passed: $(jq -r '.result.testsPassed' status.json)
- Failed: $(jq -r '.result.testsFailed' status.json)

## Duration
- Start: $(jq -r '.result.startTime' status.json)
- Duration: $(jq -r '.result.duration' status.json)

## Errors
$(jq -r '.result.errors[] | "- [\(.type)] \(.file): \(.message)"' status.json)
EOF

cat deployment-report.md

# ------------------------------------------------------------
# Example 12: Track Deployment Metrics
# ------------------------------------------------------------

#!/bin/bash
# Log deployment metrics over time

JOB_ID="0Af5e000004zXXX"
ORG="production"
LOG_FILE="deployment-metrics.csv"

# Create header if file doesn't exist
if [ ! -f "$LOG_FILE" ]; then
  echo "timestamp,job_id,status,progress,duration" > $LOG_FILE
fi

# Poll and log metrics
while true; do
  JSON=$(sf fm deploy status \
    --job-id $JOB_ID \
    --target-org $ORG \
    --json)

  STATUS=$(echo "$JSON" | jq -r '.result.status')
  PROGRESS=$(echo "$JSON" | jq -r '.result.progress')
  DURATION=$(echo "$JSON" | jq -r '.result.duration // "0"')

  TIMESTAMP=$(date +"%Y-%m-%d %H:%M:%S")

  echo "$TIMESTAMP,$JOB_ID,$STATUS,$PROGRESS,$DURATION" >> $LOG_FILE

  # Exit if completed
  if [ "$STATUS" == "Succeeded" ] || [ "$STATUS" == "Failed" ]; then
    break
  fi

  sleep 30
done

echo "Metrics saved to $LOG_FILE"

# ------------------------------------------------------------
# Example 13: Check Status from Saved Job ID
# ------------------------------------------------------------

# Job ID was saved by deploy command
JOB_ID=$(cat .deploy-job-id)

sf fm deploy status \
  --job-id $JOB_ID \
  --target-org my-sandbox \
  --watch

# ------------------------------------------------------------
# Example 14: Status Check in CI/CD Pipeline
# ------------------------------------------------------------

#!/bin/bash
# Complete CI/CD pipeline with status checks

set -e

# Deploy
OUTPUT=$(sf fm deploy \
  --manifest ./deploy \
  --target-org ci-sandbox \
  --mode validation \
  --intelligent-tests \
  --async)

# Extract job ID
JOB_ID=$(echo "$OUTPUT" | grep "^Job ID:" | cut -d: -f2 | tr -d ' ')

echo "Deployment started: $JOB_ID"

# Monitor with retries
RETRY_COUNT=0
MAX_RETRIES=3

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
  if sf fm deploy status \
    --job-id $JOB_ID \
    --target-org ci-sandbox \
    --watch \
    --timeout 120; then

    echo "✅ Validation successful!"
    break
  else
    RETRY_COUNT=$((RETRY_COUNT+1))

    if [ $RETRY_COUNT -lt $MAX_RETRIES ]; then
      echo "Retry $RETRY_COUNT/$MAX_RETRIES after 30 seconds..."
      sleep 30
    else
      echo "❌ Validation failed after $MAX_RETRIES attempts"
      exit 1
    fi
  fi
done

# ------------------------------------------------------------
# Example 15: Detailed Progress Monitoring
# ------------------------------------------------------------

#!/bin/bash
# Show detailed progress with custom formatting

JOB_ID="0Af5e000004zXXX"
ORG="production"

echo "Monitoring deployment: $JOB_ID"
echo "================================"

while true; do
  JSON=$(sf fm deploy status \
    --job-id $JOB_ID \
    --target-org $ORG \
    --json 2>/dev/null)

  STATUS=$(echo "$JSON" | jq -r '.result.status')
  PROGRESS=$(echo "$JSON" | jq -r '.result.progress')
  COMPONENTS_DONE=$(echo "$JSON" | jq -r '.result.componentsDeployed')
  COMPONENTS_TOTAL=$(echo "$JSON" | jq -r '.result.componentsTotal')
  TESTS_DONE=$(echo "$JSON" | jq -r '.result.testsCompleted')
  TESTS_TOTAL=$(echo "$JSON" | jq -r '.result.testsTotal')
  DURATION=$(echo "$JSON" | jq -r '.result.duration // "0s"')

  # Clear line and print status
  echo -ne "\r\033[K"
  echo -ne "📊 $STATUS | "
  echo -ne "Progress: $PROGRESS% | "
  echo -ne "Components: $COMPONENTS_DONE/$COMPONENTS_TOTAL | "
  echo -ne "Tests: $TESTS_DONE/$TESTS_TOTAL | "
  echo -ne "Time: $DURATION"

  # Check if completed
  if [ "$STATUS" == "Succeeded" ] || [ "$STATUS" == "Failed" ] || [ "$STATUS" == "Canceled" ]; then
    echo ""
    echo "================================"
    echo "Final Status: $STATUS"
    break
  fi

  sleep 10
done

# ------------------------------------------------------------
# Example 16: Check Status and Download Report
# ------------------------------------------------------------

#!/bin/bash
# Get status and save detailed report

JOB_ID="0Af5e000004zXXX"
ORG="production"

# Wait for completion
sf fm deploy status \
  --job-id $JOB_ID \
  --target-org $ORG \
  --watch \
  --timeout 180

# Get final status with full details
sf fm deploy status \
  --job-id $JOB_ID \
  --target-org $ORG \
  --json > deployment-report-$JOB_ID.json

echo "Report saved: deployment-report-$JOB_ID.json"

# Parse report
STATUS=$(jq -r '.result.status' deployment-report-$JOB_ID.json)
ERRORS=$(jq -r '.result.errors | length' deployment-report-$JOB_ID.json)

if [ "$STATUS" == "Succeeded" ]; then
  echo "✅ Deployment succeeded!"
elif [ "$ERRORS" -gt 0 ]; then
  echo "❌ Deployment failed with $ERRORS errors:"
  jq -r '.result.errors[] | "  - [\(.type)] \(.file): \(.message)"' deployment-report-$JOB_ID.json
fi

# ------------------------------------------------------------
# Example 17: Monitor with Custom Alerts
# ------------------------------------------------------------

#!/bin/bash
# Send alerts at different stages

JOB_ID="0Af5e000004zXXX"
ORG="production"
WEBHOOK="$SLACK_WEBHOOK_URL"

# Function to send alert
send_alert() {
  MESSAGE=$1
  curl -s -X POST $WEBHOOK \
    -H 'Content-Type: application/json' \
    -d "{\"text\":\"$MESSAGE\"}" > /dev/null
}

send_alert "🚀 Starting deployment monitoring: $JOB_ID"

LAST_PROGRESS=0

while true; do
  JSON=$(sf fm deploy status \
    --job-id $JOB_ID \
    --target-org $ORG \
    --json 2>/dev/null)

  STATUS=$(echo "$JSON" | jq -r '.result.status')
  PROGRESS=$(echo "$JSON" | jq -r '.result.progress')

  # Alert on progress milestones
  if [ "$PROGRESS" -ge 50 ] && [ "$LAST_PROGRESS" -lt 50 ]; then
    send_alert "⏳ Deployment 50% complete"
  fi

  if [ "$PROGRESS" -ge 75 ] && [ "$LAST_PROGRESS" -lt 75 ]; then
    send_alert "⏳ Deployment 75% complete"
  fi

  LAST_PROGRESS=$PROGRESS

  # Check completion
  if [ "$STATUS" == "Succeeded" ]; then
    send_alert "✅ Deployment $JOB_ID completed successfully!"
    break
  elif [ "$STATUS" == "Failed" ]; then
    send_alert "❌ Deployment $JOB_ID FAILED! @channel"
    break
  fi

  sleep 30
done
