#!/bin/bash
# ============================================================
# SF FM DEPLOY - Examples
# ============================================================
# This file contains real-world examples for the deploy command
# ============================================================

# ------------------------------------------------------------
# Example 1: Basic Validation
# ------------------------------------------------------------
# Validate changes without deploying (dry-run)

sf fm deploy \
  --manifest ./deploy \
  --target-org my-sandbox \
  --mode validation

# Use case: PR validation before merge

# ------------------------------------------------------------
# Example 2: Validation with Intelligent Tests
# ------------------------------------------------------------
# Run only relevant tests based on changed code

sf fm deploy \
  --manifest ./deploy \
  --target-org my-sandbox \
  --mode validation \
  --intelligent-tests

# Faster than RunAllTestsInOrg!

# ------------------------------------------------------------
# Example 3: Validation with Specific Tests
# ------------------------------------------------------------
# Run specific test classes

sf fm deploy \
  --manifest ./deploy \
  --target-org my-sandbox \
  --mode validation \
  --test-level RunSpecifiedTests \
  --tests "AccountTriggerTest,ContactTriggerTest"

# ------------------------------------------------------------
# Example 4: Async Validation
# ------------------------------------------------------------
# Start validation and continue working (don't wait)

sf fm deploy \
  --manifest ./deploy \
  --target-org my-sandbox \
  --mode validation \
  --intelligent-tests \
  --async

# Output includes Job ID:
# Job ID: 0Af5e000004zXXX
# Use this to check status later

# ------------------------------------------------------------
# Example 5: Deployment with Progress
# ------------------------------------------------------------
# Deploy with real-time progress display

sf fm deploy \
  --manifest ./deploy \
  --target-org dev-sandbox \
  --mode deployment \
  --test-level RunLocalTests \
  --progress

# ------------------------------------------------------------
# Example 6: Production Deployment
# ------------------------------------------------------------
# Deploy to production with all tests

sf fm deploy \
  --manifest ./deploy \
  --target-org production \
  --mode deployment \
  --test-level RunAllTestsInOrg

# ------------------------------------------------------------
# Example 7: Quick Deploy
# ------------------------------------------------------------
# Quick deploy after successful validation

# Step 1: Validate and get validation ID
OUTPUT=$(sf fm deploy \
  --manifest ./deploy \
  --target-org production \
  --mode validation \
  --intelligent-tests \
  --async)

VALIDATION_ID=$(echo "$OUTPUT" | grep "^Job ID:" | cut -d: -f2 | tr -d ' ')

# Step 2: Monitor validation
sf fm deploy status \
  --job-id $VALIDATION_ID \
  --target-org production \
  --watch

# Step 3: Quick deploy (uses validated components, no retesting)
sf fm deploy \
  --mode quick \
  --validation-id $VALIDATION_ID \
  --target-org production

# Quick deploy is MUCH faster (no tests re-run)!

# ------------------------------------------------------------
# Example 8: Deployment with Destructive Changes (Both)
# ------------------------------------------------------------
# Deploy with both pre and post destructive changes

sf fm deploy \
  --manifest ./deploy \
  --target-org my-sandbox \
  --mode deployment \
  --test-level RunLocalTests \
  --destructive both \
  --pre "CustomObject:OldObject,ApexClass:DeprecatedClass"

# Execution order:
# 1. destructiveChangesPre.xml (delete specified files before deploy)
# 2. package.xml (deploy new/changed)
# 3. destructiveChanges.xml (delete remaining files after deploy)

# ------------------------------------------------------------
# Example 9: Deployment with Ignore Warnings
# ------------------------------------------------------------
# Deploy even if there are warnings

sf fm deploy \
  --manifest ./deploy \
  --target-org my-sandbox \
  --mode standard \
  --test-level RunLocalTests \
  --ignore-warnings

# ------------------------------------------------------------
# Example 10: JSON Output for CI/CD
# ------------------------------------------------------------
# Get JSON output for automation

sf fm deploy \
  --manifest ./deploy \
  --target-org my-sandbox \
  --mode validation \
  --intelligent-tests \
  --async \
  --json > deploy-result.json

# Parse job ID
JOB_ID=$(jq -r '.result.jobId' deploy-result.json)
echo "Deployment job: $JOB_ID"

# ------------------------------------------------------------
# Example 11: GitHub Actions PR Validation
# ------------------------------------------------------------

# - name: Validate PR Changes
#   id: validate
#   run: |
#     OUTPUT=$(sf fm deploy \
#       --manifest ./manifest \
#       --target-org ci-sandbox \
#       --mode validation \
#       --intelligent-tests \
#       --async)
#
#     JOB_ID=$(echo "$OUTPUT" | grep "^Job ID:" | cut -d: -f2 | tr -d ' ')
#     echo "job_id=$JOB_ID" >> $GITHUB_OUTPUT
#     echo "$JOB_ID" > validation-job-id.txt
#
# - name: Save Job ID
#   uses: actions/upload-artifact@v4
#   with:
#     name: validation-job-id
#     path: validation-job-id.txt
#
# - name: Monitor Validation
#   run: |
#     sf fm deploy status \
#       --job-id ${{ steps.validate.outputs.job_id }} \
#       --target-org ci-sandbox \
#       --watch \
#       --timeout 120

# ------------------------------------------------------------
# Example 12: GitLab CI Deployment
# ------------------------------------------------------------

# deploy_to_sandbox:
#   stage: deploy
#   script:
#     - sf fm deploy \
#         --manifest ./manifest \
#         --target-org $SANDBOX_USERNAME \
#         --mode standard \
#         --test-level RunLocalTests
#   only:
#     - merge_requests

# ------------------------------------------------------------
# Example 13: Deployment with Pre-Destructive Only
# ------------------------------------------------------------
# Delete metadata before deploying new changes

sf fm deploy \
  --manifest ./deploy \
  --target-org production \
  --mode deployment \
  --test-level RunLocalTests \
  --destructive pre \
  --pre "CustomObject:OldObject"

# Use case: Remove old object before deploying new schema

# ------------------------------------------------------------
# Example 14: Check-Only Deployment
# ------------------------------------------------------------
# Alternative to --mode validation using --check-only flag

sf fm deploy \
  --manifest ./deploy \
  --target-org production \
  --check-only \
  --intelligent-tests

# --check-only is equivalent to --mode validation
# Use whichever you prefer for readability

# ------------------------------------------------------------
# Example 15: Deployment with Hooks
# ------------------------------------------------------------
# Use pre and post deployment hooks

#!/bin/bash
set -e

# Create pre-deployment hook script
cat > pre-deploy.sh << 'EOF'
#!/bin/bash
echo "Running pre-deployment checks..."
# Add your pre-deployment logic here
exit 0
EOF

# Create post-deployment hook script
cat > post-deploy.sh << 'EOF'
#!/bin/bash
echo "Running post-deployment tasks..."
# Add your post-deployment logic here
exit 0
EOF

chmod +x pre-deploy.sh post-deploy.sh

# Deploy with hooks
sf fm deploy \
  --manifest ./deploy \
  --target-org production \
  --mode deployment \
  --intelligent-tests \
  --pre-steps ./pre-deploy.sh \
  --post-steps ./post-deploy.sh

echo "Deployment complete!"

# ------------------------------------------------------------
# Example 16: Rollback Deployment
# ------------------------------------------------------------
# Deploy previous version to rollback changes

# Build package for previous version
sf fm build \
  --ref-a HEAD \
  --ref-b v1.2.0 \
  --output-dir ./rollback

# Deploy rollback package
sf fm deploy \
  --manifest ./rollback \
  --target-org production \
  --mode deployment \
  --test-level RunLocalTests \
  --destructive both \
  --pre "CustomObject:NewObject"

# ------------------------------------------------------------
# Example 17: Scheduled Deployment
# ------------------------------------------------------------
# For scheduled production deployments

#!/bin/bash
# run-deployment.sh - Run during maintenance window

set -e

MANIFEST_DIR="./deploy"
TARGET_ORG="production"
SLACK_WEBHOOK="$SLACK_WEBHOOK_URL"

echo "Starting scheduled deployment to $TARGET_ORG..."

# Deploy
if sf fm deploy \
  --manifest $MANIFEST_DIR \
  --target-org $TARGET_ORG \
  --mode deployment \
  --test-level RunLocalTests; then

  echo "✅ Deployment successful!"

  # Notify success
  curl -X POST $SLACK_WEBHOOK \
    -H 'Content-Type: application/json' \
    -d '{"text":"✅ Production deployment completed successfully"}'
else
  echo "❌ Deployment failed!"

  # Notify failure
  curl -X POST $SLACK_WEBHOOK \
    -H 'Content-Type: application/json' \
    -d '{"text":"❌ Production deployment FAILED! @here"}'

  exit 1
fi

# ------------------------------------------------------------
# Example 18: Testing Different Test Levels
# ------------------------------------------------------------

# No tests (not recommended for production)
sf fm deploy \
  --manifest ./deploy \
  --target-org dev-sandbox \
  --mode deployment \
  --test-level NoTestRun

# Run local tests only
sf fm deploy \
  --manifest ./deploy \
  --target-org uat-sandbox \
  --mode deployment \
  --test-level RunLocalTests

# Run all tests (production)
sf fm deploy \
  --manifest ./deploy \
  --target-org production \
  --mode deployment \
  --test-level RunAllTestsInOrg

# Run intelligent tests (recommended)
sf fm deploy \
  --manifest ./deploy \
  --target-org my-sandbox \
  --mode deployment \
  --intelligent-tests

# Run relevant tests (new option)
sf fm deploy \
  --manifest ./deploy \
  --target-org my-sandbox \
  --mode deployment \
  --test-level RunRelevantTests

# ------------------------------------------------------------
# Example 19: Capture Job ID for Later Use
# ------------------------------------------------------------

# Deploy async and save job ID
OUTPUT=$(sf fm deploy \
  --manifest ./deploy \
  --target-org my-sandbox \
  --mode validation \
  --intelligent-tests \
  --async)

# Extract and save job ID
JOB_ID=$(echo "$OUTPUT" | grep "^Job ID:" | cut -d: -f2 | tr -d ' ')
echo "$JOB_ID" > .deploy-job-id

echo "Validation started: $JOB_ID"
echo "To check status: sf fm deploy status --job-id $JOB_ID --target-org my-sandbox"

# Later, check status
JOB_ID=$(cat .deploy-job-id)
sf fm deploy status --job-id $JOB_ID --target-org my-sandbox

# ------------------------------------------------------------
# Example 20: Full PR-to-Production Workflow
# ------------------------------------------------------------

#!/bin/bash
set -e

ORG="production"
MANIFEST="./deploy"

echo "=== PR to Production Deployment Workflow ==="

# Step 1: Validate in production
echo "Step 1: Validating changes..."
OUTPUT=$(sf fm deploy \
  --manifest $MANIFEST \
  --target-org $ORG \
  --mode validation \
  --intelligent-tests \
  --async)

VALIDATION_ID=$(echo "$OUTPUT" | grep "^Job ID:" | cut -d: -f2 | tr -d ' ')
echo "Validation ID: $VALIDATION_ID"

# Step 2: Monitor validation
echo "Step 2: Monitoring validation..."
sf fm deploy status \
  --job-id $VALIDATION_ID \
  --target-org $ORG \
  --watch \
  --timeout 120

# Step 3: Get approval
echo "Step 3: Waiting for approval..."
read -p "Validation successful. Deploy to production? (yes/no): " APPROVAL

if [ "$APPROVAL" != "yes" ]; then
  echo "Deployment cancelled."
  exit 0
fi

# Step 4: Quick deploy
echo "Step 4: Deploying to production..."
sf fm deploy \
  --mode quick \
  --validation-id $VALIDATION_ID \
  --target-org $ORG

echo "✅ Deployment to production complete!"
