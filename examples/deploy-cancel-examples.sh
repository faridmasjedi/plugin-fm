#!/bin/bash
# ============================================================
# SF FM DEPLOY CANCEL - Examples
# ============================================================
# This file contains real-world examples for deploy cancel command
# ============================================================

# ------------------------------------------------------------
# Example 1: Basic Cancel
# ------------------------------------------------------------
# Cancel a running deployment by job ID

sf fm deploy cancel \
  --job-id 0Af5e000004zXXX \
  --target-org my-sandbox

# Use case: User realizes deployment has issues

# ------------------------------------------------------------
# Example 2: Cancel from File
# ------------------------------------------------------------
# Read job ID from a file (useful in CI/CD)

sf fm deploy cancel \
  --job-id-file ./job-id.txt \
  --target-org my-sandbox

# File contains just the job ID:
# 0Af5e000004zXXX

# ------------------------------------------------------------
# Example 3: Safe Cancel (CI/CD)
# ------------------------------------------------------------
# Skip if job ID file doesn't exist (first commit to PR)

sf fm deploy cancel \
  --job-id-file ./artifacts/job-id.txt \
  --target-org ci-sandbox \
  --skip-if-not-found

# Won't fail if:
# - File doesn't exist
# - Job not found
# - Job already completed

# ------------------------------------------------------------
# Example 4: GitHub Actions PR Workflow
# ------------------------------------------------------------
# Cancel previous validation when new commit is pushed

# name: PR Validation with Cancellation
#
# on:
#   pull_request:
#     types: [opened, synchronize, reopened]
#
# jobs:
#   validate:
#     runs-on: ubuntu-latest
#     steps:
#       - uses: actions/checkout@v4
#         with:
#           fetch-depth: 0
#
#       # Download previous job ID artifact
#       - name: Download Previous Job ID
#         uses: dawidd6/action-download-artifact@v2
#         continue-on-error: true
#         with:
#           workflow: ${{ github.workflow }}
#           pr: ${{ github.event.pull_request.number }}
#           name: pr-${{ github.event.pull_request.number }}-job-id
#           path: ./artifacts
#
#       # Cancel previous validation
#       - name: Cancel Previous Validation
#         run: |
#           sf fm deploy cancel \
#             --job-id-file ./artifacts/job-id.txt \
#             --target-org ci-sandbox \
#             --skip-if-not-found
#         continue-on-error: true
#
#       # Build new artifacts
#       - name: Build Deployment Artifacts
#         run: |
#           sf fm build \
#             --ref-a origin/${{ github.base_ref }} \
#             --ref-b HEAD \
#             --output-dir ./manifest
#
#       # Start new validation
#       - name: Start New Validation
#         id: deploy
#         run: |
#           OUTPUT=$(sf fm deploy \
#             --manifest ./manifest \
#             --target-org ci-sandbox \
#             --mode validation \
#             --intelligent-tests \
#             --async)
#
#           JOB_ID=$(echo "$OUTPUT" | grep "^Job ID:" | cut -d: -f2 | tr -d ' ')
#           echo "job_id=$JOB_ID" >> $GITHUB_OUTPUT
#           echo "$JOB_ID" > job-id.txt
#
#       # Save job ID for next commit
#       - name: Save Job ID
#         uses: actions/upload-artifact@v4
#         with:
#           name: pr-${{ github.event.pull_request.number }}-job-id
#           path: job-id.txt
#
#       # Monitor validation
#       - name: Monitor Validation
#         run: |
#           sf fm deploy status \
#             --job-id ${{ steps.deploy.outputs.job_id }} \
#             --target-org ci-sandbox \
#             --watch

# ------------------------------------------------------------
# Example 5: GitLab CI PR Workflow
# ------------------------------------------------------------

# validate_changes:
#   stage: test
#   script:
#     # Cancel previous job if exists
#     - |
#       if [ -f "previous-job-id.txt" ]; then
#         sf fm deploy cancel \
#           --job-id-file previous-job-id.txt \
#           --target-org $CI_SANDBOX_USERNAME \
#           --skip-if-not-found
#       fi
#
#     # Start new validation
#     - OUTPUT=$(sf fm deploy \
#         --manifest ./manifest \
#         --target-org $CI_SANDBOX_USERNAME \
#         --mode validation \
#         --intelligent-tests \
#         --async)
#
#     # Save job ID
#     - echo "$OUTPUT" | grep "^Job ID:" | cut -d: -f2 | tr -d ' ' > current-job-id.txt
#
#   artifacts:
#     paths:
#       - current-job-id.txt
#   only:
#     - merge_requests

# ------------------------------------------------------------
# Example 6: Cancel Multiple Jobs
# ------------------------------------------------------------
# Cancel multiple running deployments

#!/bin/bash
JOBS=("0Af1..." "0Af2..." "0Af3...")

for JOB_ID in "${JOBS[@]}"; do
  echo "Canceling job: $JOB_ID"

  sf fm deploy cancel \
    --job-id $JOB_ID \
    --target-org my-sandbox \
    --skip-if-not-found

  echo "  Canceled: $JOB_ID"
done

# ------------------------------------------------------------
# Example 7: Cancel with Confirmation
# ------------------------------------------------------------
# Prompt for confirmation before canceling

#!/bin/bash
JOB_ID="0Af5e000004zXXX"
ORG="production"

# Get current status
STATUS=$(sf fm deploy status \
  --job-id $JOB_ID \
  --target-org $ORG \
  --json | jq -r '.result.status')

echo "Current deployment status: $STATUS"

if [ "$STATUS" == "InProgress" ]; then
  read -p "Cancel this deployment? (yes/no): " CONFIRM

  if [ "$CONFIRM" == "yes" ]; then
    sf fm deploy cancel \
      --job-id $JOB_ID \
      --target-org $ORG

    echo "✅ Deployment canceled"
  else
    echo "Cancellation aborted"
  fi
else
  echo "Deployment already completed (status: $STATUS)"
fi

# ------------------------------------------------------------
# Example 8: Cancel and Restart
# ------------------------------------------------------------
# Cancel current deployment and start a new one

#!/bin/bash
OLD_JOB_ID="0Af5e000004zXXX"
ORG="my-sandbox"
MANIFEST="./deploy"

# Cancel old deployment
echo "Canceling previous deployment..."
sf fm deploy cancel \
  --job-id $OLD_JOB_ID \
  --target-org $ORG \
  --skip-if-not-found

# Wait a bit for cancellation to process
sleep 5

# Start new deployment
echo "Starting new deployment..."
OUTPUT=$(sf fm deploy \
  --manifest $MANIFEST \
  --target-org $ORG \
  --mode validation \
  --intelligent-tests \
  --async)

NEW_JOB_ID=$(echo "$OUTPUT" | grep "^Job ID:" | cut -d: -f2 | tr -d ' ')
echo "New deployment started: $NEW_JOB_ID"

# Save new job ID
echo "$NEW_JOB_ID" > current-job-id.txt

# ------------------------------------------------------------
# Example 9: Cancel Stale Deployments
# ------------------------------------------------------------
# Cancel deployments that have been running too long

#!/bin/bash
# Check deployments in org and cancel stale ones

ORG="my-sandbox"
MAX_DURATION_MINUTES=120  # 2 hours

# Get all running deployments (this requires sf CLI)
# In real scenario, you'd track job IDs in a file or database

JOB_IDS_FILE="active-deployments.txt"

if [ -f "$JOB_IDS_FILE" ]; then
  while IFS= read -r JOB_ID; do
    # Get deployment status
    JSON=$(sf fm deploy status \
      --job-id $JOB_ID \
      --target-org $ORG \
      --json 2>/dev/null)

    STATUS=$(echo "$JSON" | jq -r '.result.status // "Unknown"')
    DURATION=$(echo "$JSON" | jq -r '.result.duration // "0"')

    if [ "$STATUS" == "InProgress" ]; then
      # Parse duration (assumes format like "2h 30m")
      # Simplified - you'd need proper parsing
      echo "Job $JOB_ID has been running for $DURATION"

      # Cancel if over limit (simplified logic)
      read -p "Cancel this job? (yes/no): " CONFIRM
      if [ "$CONFIRM" == "yes" ]; then
        sf fm deploy cancel \
          --job-id $JOB_ID \
          --target-org $ORG

        echo "Canceled: $JOB_ID"
      fi
    fi
  done < "$JOB_IDS_FILE"
fi

# ------------------------------------------------------------
# Example 10: CI/CD Cleanup on Branch Delete
# ------------------------------------------------------------
# Cancel validations when PR is closed or branch deleted

# GitHub Actions example:
# on:
#   pull_request:
#     types: [closed]
#
# jobs:
#   cleanup:
#     runs-on: ubuntu-latest
#     steps:
#       - name: Download Job ID
#         uses: dawidd6/action-download-artifact@v2
#         continue-on-error: true
#         with:
#           workflow: validation
#           pr: ${{ github.event.pull_request.number }}
#           name: validation-job-id
#           path: ./artifacts
#
#       - name: Cancel Running Validation
#         run: |
#           sf fm deploy cancel \
#             --job-id-file ./artifacts/job-id.txt \
#             --target-org ci-sandbox \
#             --skip-if-not-found

# ------------------------------------------------------------
# Example 11: Cancel with Logging
# ------------------------------------------------------------
# Cancel deployment and log details

#!/bin/bash
JOB_ID="0Af5e000004zXXX"
ORG="production"
LOG_FILE="cancellation-log.txt"

echo "=== Deployment Cancellation ===" | tee -a $LOG_FILE
echo "Job ID: $JOB_ID" | tee -a $LOG_FILE
echo "Target Org: $ORG" | tee -a $LOG_FILE
echo "Time: $(date)" | tee -a $LOG_FILE

# Get status before cancellation
echo "Status before cancellation:" | tee -a $LOG_FILE
sf fm deploy status \
  --job-id $JOB_ID \
  --target-org $ORG \
  --json | jq -r '.result | {status, progress, componentsDeployed, componentsTotal}' | tee -a $LOG_FILE

# Cancel
echo "Canceling deployment..." | tee -a $LOG_FILE
if sf fm deploy cancel \
  --job-id $JOB_ID \
  --target-org $ORG 2>&1 | tee -a $LOG_FILE; then

  echo "✅ Cancellation successful" | tee -a $LOG_FILE
else
  echo "❌ Cancellation failed" | tee -a $LOG_FILE
fi

echo "================================" | tee -a $LOG_FILE

# ------------------------------------------------------------
# Example 12: Interactive Cancellation Script
# ------------------------------------------------------------

#!/bin/bash
# Interactive script to cancel deployments

ORG="my-sandbox"

echo "=== Deployment Cancellation Tool ==="
echo ""

# Option 1: Enter job ID manually
read -p "Enter Job ID (or press Enter to load from file): " JOB_ID

if [ -z "$JOB_ID" ]; then
  # Option 2: Load from file
  if [ -f ".deploy-job-id" ]; then
    JOB_ID=$(cat .deploy-job-id)
    echo "Loaded Job ID from file: $JOB_ID"
  else
    echo "❌ No job ID provided and no saved file found"
    exit 1
  fi
fi

# Show current status
echo ""
echo "Checking deployment status..."
sf fm deploy status \
  --job-id $JOB_ID \
  --target-org $ORG

echo ""
read -p "Cancel this deployment? (yes/no): " CONFIRM

if [ "$CONFIRM" != "yes" ]; then
  echo "Cancellation aborted"
  exit 0
fi

# Cancel
echo "Canceling deployment..."
sf fm deploy cancel \
  --job-id $JOB_ID \
  --target-org $ORG

echo ""
echo "✅ Deployment canceled successfully"

# ------------------------------------------------------------
# Example 13: Cancel from Environment Variable
# ------------------------------------------------------------
# Use environment variable for job ID (useful in scripts)

export DEPLOY_JOB_ID="0Af5e000004zXXX"
export TARGET_ORG="my-sandbox"

sf fm deploy cancel \
  --job-id $DEPLOY_JOB_ID \
  --target-org $TARGET_ORG

# ------------------------------------------------------------
# Example 14: Cancel with Notification
# ------------------------------------------------------------

#!/bin/bash
JOB_ID="0Af5e000004zXXX"
ORG="production"
WEBHOOK="$SLACK_WEBHOOK_URL"

# Cancel
echo "Canceling deployment $JOB_ID..."

if sf fm deploy cancel \
  --job-id $JOB_ID \
  --target-org $ORG; then

  # Success notification
  curl -X POST $WEBHOOK \
    -H 'Content-Type: application/json' \
    -d "{\"text\":\"⚠️  Deployment $JOB_ID was canceled\"}"

  echo "✅ Deployment canceled and team notified"
else
  # Failure notification
  curl -X POST $WEBHOOK \
    -H 'Content-Type: application/json' \
    -d "{\"text\":\"❌ Failed to cancel deployment $JOB_ID\"}"

  echo "❌ Failed to cancel deployment"
  exit 1
fi

# ------------------------------------------------------------
# Example 15: Bulk Cancel Script
# ------------------------------------------------------------

#!/bin/bash
# Cancel all jobs listed in a file

JOBS_FILE="jobs-to-cancel.txt"
ORG="my-sandbox"
SUCCESS_COUNT=0
FAILED_COUNT=0

if [ ! -f "$JOBS_FILE" ]; then
  echo "❌ Jobs file not found: $JOBS_FILE"
  exit 1
fi

echo "=== Bulk Cancellation ==="
echo "Reading jobs from: $JOBS_FILE"
echo ""

while IFS= read -r JOB_ID; do
  # Skip empty lines and comments
  [[ -z "$JOB_ID" || "$JOB_ID" =~ ^# ]] && continue

  echo "Canceling: $JOB_ID"

  if sf fm deploy cancel \
    --job-id $JOB_ID \
    --target-org $ORG \
    --skip-if-not-found 2>&1 | grep -q "Successfully canceled"; then

    echo "  ✅ Success"
    SUCCESS_COUNT=$((SUCCESS_COUNT+1))
  else
    echo "  ❌ Failed or skipped"
    FAILED_COUNT=$((FAILED_COUNT+1))
  fi

  echo ""
done < "$JOBS_FILE"

echo "================================"
echo "Results:"
echo "  Successful: $SUCCESS_COUNT"
echo "  Failed/Skipped: $FAILED_COUNT"
echo "================================"

# ------------------------------------------------------------
# Example 16: Safe Cancel with Fallback
# ------------------------------------------------------------

#!/bin/bash
# Try to cancel, with graceful fallback

JOB_ID="0Af5e000004zXXX"
ORG="my-sandbox"

echo "Attempting to cancel deployment: $JOB_ID"

# Try cancel with skip-if-not-found
sf fm deploy cancel \
  --job-id $JOB_ID \
  --target-org $ORG \
  --skip-if-not-found

EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
  echo "✅ Cancellation completed (job canceled or already completed)"
else
  echo "⚠️  Cancellation command failed"
  echo "Checking if deployment is still running..."

  # Check status
  STATUS=$(sf fm deploy status \
    --job-id $JOB_ID \
    --target-org $ORG \
    --json 2>/dev/null | jq -r '.result.status // "Unknown"')

  echo "Current status: $STATUS"

  if [ "$STATUS" == "InProgress" ]; then
    echo "⚠️  Deployment is still running despite cancellation attempt"
    exit 1
  else
    echo "✅ Deployment is no longer running"
  fi
fi

# ------------------------------------------------------------
# Example 17: JSON Output for Automation
# ------------------------------------------------------------

#!/bin/bash
# Cancel and parse JSON result

JOB_ID="0Af5e000004zXXX"
ORG="my-sandbox"

# Cancel with JSON output
RESULT=$(sf fm deploy cancel \
  --job-id $JOB_ID \
  --target-org $ORG \
  --json)

# Parse result
STATUS=$(echo "$RESULT" | jq -r '.result.status')
MESSAGE=$(echo "$RESULT" | jq -r '.result.message')

echo "Cancellation Status: $STATUS"
echo "Message: $MESSAGE"

# Take action based on result
case $STATUS in
  "canceled")
    echo "✅ Job was successfully canceled"
    exit 0
    ;;
  "already-completed")
    echo "ℹ️  Job was already completed"
    exit 0
    ;;
  "not-found")
    echo "⚠️  Job not found"
    exit 1
    ;;
  "skipped")
    echo "ℹ️  Cancellation skipped"
    exit 0
    ;;
  *)
    echo "❓ Unknown status: $STATUS"
    exit 1
    ;;
esac
