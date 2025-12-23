#!/bin/bash
# ============================================================
# SF FM QUALITY - Examples
# ============================================================
# This file contains real-world examples for the quality command
# ============================================================

# ------------------------------------------------------------
# Example 1: Basic Quality Check
# ------------------------------------------------------------
# Check quality of changes between current branch and main

sf fm quality \
  --base-sha origin/main \
  --head-sha HEAD

# Runs: ESLint, XML Lint, PMD, Tests

# ------------------------------------------------------------
# Example 2: PR Quality Check
# ------------------------------------------------------------
# Check quality for a pull request

sf fm quality \
  --base-sha origin/main \
  --head-sha feature/new-feature

# ------------------------------------------------------------
# Example 3: Skip Specific Checks
# ------------------------------------------------------------
# Skip PMD and tests (only linting)

sf fm quality \
  --base-sha origin/main \
  --head-sha HEAD \
  --skip-pmd \
  --skip-tests

# Use case: Quick pre-commit checks

# ------------------------------------------------------------
# Example 4: Custom PMD Ruleset
# ------------------------------------------------------------
# Use custom PMD rules

sf fm quality \
  --base-sha origin/main \
  --head-sha HEAD \
  --pmd-ruleset ./pmd-rules/custom-ruleset.xml

# ------------------------------------------------------------
# Example 5: Fail on Warnings
# ------------------------------------------------------------
# Strict mode - fail even on warnings

sf fm quality \
  --base-sha origin/main \
  --head-sha HEAD \
  --fail-on-warnings

# Use case: Production-ready code validation

# ------------------------------------------------------------
# Example 6: JSON Output for CI/CD
# ------------------------------------------------------------
# Get JSON output for parsing

sf fm quality \
  --base-sha origin/main \
  --head-sha HEAD \
  --json > quality-report.json

# Parse results
# ERRORS=$(jq -r '.result.totalErrors' quality-report.json)
# WARNINGS=$(jq -r '.result.totalWarnings' quality-report.json)

# ------------------------------------------------------------
# Example 7: GitHub Actions Integration
# ------------------------------------------------------------

# name: Quality Checks
#
# on:
#   pull_request:
#     branches: [main]
#
# jobs:
#   quality:
#     runs-on: ubuntu-latest
#     steps:
#       - uses: actions/checkout@v4
#         with:
#           fetch-depth: 0
#
#       - name: Setup Node.js
#         uses: actions/setup-node@v4
#         with:
#           node-version: '18'
#
#       - name: Install SF CLI
#         run: npm install -g @salesforce/cli
#
#       - name: Install Plugin
#         run: sf plugins install @salesforce/plugin-fm
#
#       - name: Install Dependencies
#         run: npm install
#
#       - name: Install PMD
#         run: |
#           wget https://github.com/pmd/pmd/releases/download/pmd_releases%2F7.0.0/pmd-dist-7.0.0-bin.zip
#           unzip pmd-dist-7.0.0-bin.zip
#           echo "$PWD/pmd-bin-7.0.0/bin" >> $GITHUB_PATH
#
#       - name: Run Quality Checks
#         run: |
#           sf fm quality \
#             --base-sha origin/${{ github.base_ref }} \
#             --head-sha ${{ github.sha }} \
#             --json > quality-report.json
#
#       - name: Upload Report
#         if: always()
#         uses: actions/upload-artifact@v4
#         with:
#           name: quality-report
#           path: quality-report.json

# ------------------------------------------------------------
# Example 8: GitLab CI Integration
# ------------------------------------------------------------

# quality-checks:
#   stage: test
#   image: node:18
#   before_script:
#     - npm install -g @salesforce/cli
#     - sf plugins install @salesforce/plugin-fm
#     - npm install
#     # Install PMD
#     - wget -q https://github.com/pmd/pmd/releases/download/pmd_releases%2F7.0.0/pmd-dist-7.0.0-bin.zip
#     - unzip -q pmd-dist-7.0.0-bin.zip
#     - export PATH=$PWD/pmd-bin-7.0.0/bin:$PATH
#   script:
#     - sf fm quality \
#         --base-sha $CI_MERGE_REQUEST_TARGET_BRANCH_SHA \
#         --head-sha $CI_COMMIT_SHA \
#         --json | tee quality-report.json
#   artifacts:
#     when: always
#     paths:
#       - quality-report.json
#     reports:
#       junit: quality-report.json
#   only:
#     - merge_requests

# ------------------------------------------------------------
# Example 9: Check Specific Commit Range
# ------------------------------------------------------------
# Check quality between two specific commits

sf fm quality \
  --base-sha abc123def \
  --head-sha 456789ghi

# ------------------------------------------------------------
# Example 10: Check Last N Commits
# ------------------------------------------------------------
# Check last 5 commits

sf fm quality \
  --base-sha HEAD~5 \
  --head-sha HEAD

# ------------------------------------------------------------
# Example 11: Pre-commit Hook
# ------------------------------------------------------------
# Add to .husky/pre-push

#!/bin/bash
# .husky/pre-push

echo "Running quality checks before push..."

sf fm quality \
  --base-sha origin/main \
  --head-sha HEAD \
  --skip-tests

if [ $? -ne 0 ]; then
  echo "❌ Quality checks failed. Fix issues before pushing."
  exit 1
fi

echo "✅ Quality checks passed!"

# ------------------------------------------------------------
# Example 12: Selective Linting Only
# ------------------------------------------------------------
# Run only linting checks (no PMD, no tests)

sf fm quality \
  --base-sha origin/main \
  --head-sha HEAD \
  --skip-pmd \
  --skip-tests

# Fast pre-commit checks

# ------------------------------------------------------------
# Example 13: Full Quality Suite
# ------------------------------------------------------------
# Run everything including strict mode

sf fm quality \
  --base-sha origin/main \
  --head-sha HEAD \
  --fail-on-warnings

# For release branches

# ------------------------------------------------------------
# Example 14: Check with Custom Test Command
# ------------------------------------------------------------
# Skip built-in tests, run custom tests separately

sf fm quality \
  --base-sha origin/main \
  --head-sha HEAD \
  --skip-tests

# Then run custom tests
npm run custom-test-command

# ------------------------------------------------------------
# Example 15: Multi-Environment Checks
# ------------------------------------------------------------

#!/bin/bash
# Check quality for different environments

# Development (lenient)
echo "=== Development Quality Checks ==="
sf fm quality \
  --base-sha origin/main \
  --head-sha develop \
  --skip-pmd

# Staging (moderate)
echo "=== Staging Quality Checks ==="
sf fm quality \
  --base-sha origin/develop \
  --head-sha staging

# Production (strict)
echo "=== Production Quality Checks ==="
sf fm quality \
  --base-sha origin/staging \
  --head-sha main \
  --fail-on-warnings

# ------------------------------------------------------------
# Example 16: Automated Quality Report
# ------------------------------------------------------------

#!/bin/bash
# Generate detailed quality report

REPORT_FILE="quality-report-$(date +%Y%m%d-%H%M%S).json"

echo "Running quality checks..."

sf fm quality \
  --base-sha origin/main \
  --head-sha HEAD \
  --json > $REPORT_FILE

# Parse report
PASSED=$(jq -r '.result.passed' $REPORT_FILE)
ERRORS=$(jq -r '.result.totalErrors' $REPORT_FILE)
WARNINGS=$(jq -r '.result.totalWarnings' $REPORT_FILE)
FILES=$(jq -r '.result.filesChanged' $REPORT_FILE)

# Generate HTML report
cat > quality-report.html << EOF
<!DOCTYPE html>
<html>
<head>
    <title>Quality Report</title>
    <style>
        body { font-family: Arial; margin: 20px; }
        .pass { color: green; }
        .fail { color: red; }
        .summary { border: 1px solid #ccc; padding: 15px; margin: 10px 0; }
    </style>
</head>
<body>
    <h1>Quality Report</h1>
    <div class="summary">
        <h2>Summary</h2>
        <p><strong>Status:</strong> <span class="$([ "$PASSED" == "true" ] && echo "pass" || echo "fail")">$([ "$PASSED" == "true" ] && echo "PASSED" || echo "FAILED")</span></p>
        <p><strong>Files Changed:</strong> $FILES</p>
        <p><strong>Total Errors:</strong> $ERRORS</p>
        <p><strong>Total Warnings:</strong> $WARNINGS</p>
    </div>
    <h2>Detailed Results</h2>
    <pre>$(jq -r '.result.checks[] | "\(.check): \(.status) (Errors: \(.errors), Warnings: \(.warnings))"' $REPORT_FILE)</pre>
</body>
</html>
EOF

echo "Report generated: quality-report.html"

# ------------------------------------------------------------
# Example 17: Quality Gate for Deployment
# ------------------------------------------------------------

#!/bin/bash
# Only deploy if quality checks pass

echo "Step 1: Running quality checks..."

if sf fm quality \
  --base-sha origin/main \
  --head-sha HEAD \
  --fail-on-warnings; then

  echo "✅ Quality checks passed!"
  echo ""
  echo "Step 2: Building deployment package..."

  sf fm build \
    --ref-a origin/main \
    --ref-b HEAD \
    --output-dir ./deploy

  echo "Step 3: Deploying..."

  sf fm deploy \
    --manifest ./deploy \
    --target-org production \
    --mode validation \
    --intelligent-tests

  echo "✅ Deployment complete!"
else
  echo "❌ Quality checks failed. Deployment blocked."
  exit 1
fi

# ------------------------------------------------------------
# Example 18: Parallel Quality Checks
# ------------------------------------------------------------

#!/bin/bash
# Run different quality checks in parallel

# Start background jobs
sf fm quality \
  --base-sha origin/main \
  --head-sha HEAD \
  --skip-xml-lint \
  --skip-pmd \
  --skip-tests &
PID_LINT=$!

sf fm quality \
  --base-sha origin/main \
  --head-sha HEAD \
  --skip-eslint \
  --skip-xml-lint \
  --skip-tests &
PID_PMD=$!

sf fm quality \
  --base-sha origin/main \
  --head-sha HEAD \
  --skip-eslint \
  --skip-xml-lint \
  --skip-pmd &
PID_TESTS=$!

# Wait for all to complete
wait $PID_LINT $PID_PMD $PID_TESTS

echo "All quality checks complete!"

# ------------------------------------------------------------
# Example 19: Quality Metrics Tracking
# ------------------------------------------------------------

#!/bin/bash
# Track quality metrics over time

METRICS_FILE="quality-metrics.csv"

# Create header if file doesn't exist
if [ ! -f "$METRICS_FILE" ]; then
  echo "timestamp,commit,files_changed,errors,warnings,passed" > $METRICS_FILE
fi

# Run quality checks
sf fm quality \
  --base-sha origin/main \
  --head-sha HEAD \
  --json > quality-result.json

# Extract metrics
TIMESTAMP=$(date +"%Y-%m-%d %H:%M:%S")
COMMIT=$(git rev-parse --short HEAD)
FILES=$(jq -r '.result.filesChanged' quality-result.json)
ERRORS=$(jq -r '.result.totalErrors' quality-result.json)
WARNINGS=$(jq -r '.result.totalWarnings' quality-result.json)
PASSED=$(jq -r '.result.passed' quality-result.json)

# Append to CSV
echo "$TIMESTAMP,$COMMIT,$FILES,$ERRORS,$WARNINGS,$PASSED" >> $METRICS_FILE

echo "Metrics saved to $METRICS_FILE"

# ------------------------------------------------------------
# Example 20: Quality Dashboard
# ------------------------------------------------------------

#!/bin/bash
# Generate quality dashboard

echo "=== Quality Dashboard ==="
echo ""

# Run checks
sf fm quality \
  --base-sha origin/main \
  --head-sha HEAD \
  --json > quality.json

# Display results
echo "Files Changed: $(jq -r '.result.filesChanged' quality.json)"
echo ""

echo "Check Results:"
jq -r '.result.checks[] | "  \(.check): \(.status) (E:\(.errors) W:\(.warnings))"' quality.json

echo ""
echo "Summary:"
echo "  Total Errors: $(jq -r '.result.totalErrors' quality.json)"
echo "  Total Warnings: $(jq -r '.result.totalWarnings' quality.json)"
echo "  Overall: $(jq -r 'if .result.passed then "✅ PASSED" else "❌ FAILED" end' quality.json)"

# ------------------------------------------------------------
# Example 21: Slack Integration
# ------------------------------------------------------------

#!/bin/bash
# Send quality report to Slack

WEBHOOK="$SLACK_WEBHOOK_URL"

# Run quality checks
sf fm quality \
  --base-sha origin/main \
  --head-sha HEAD \
  --json > quality.json

PASSED=$(jq -r '.result.passed' quality.json)
ERRORS=$(jq -r '.result.totalErrors' quality.json)
WARNINGS=$(jq -r '.result.totalWarnings' quality.json)

# Format message
if [ "$PASSED" == "true" ]; then
  MESSAGE="✅ Quality checks passed!\nErrors: $ERRORS | Warnings: $WARNINGS"
  COLOR="good"
else
  MESSAGE="❌ Quality checks failed!\nErrors: $ERRORS | Warnings: $WARNINGS"
  COLOR="danger"
fi

# Send to Slack
curl -X POST $WEBHOOK \
  -H 'Content-Type: application/json' \
  -d "{
    \"attachments\": [{
      \"color\": \"$COLOR\",
      \"text\": \"$MESSAGE\"
    }]
  }"

# ------------------------------------------------------------
# Example 22: Conditional Checks
# ------------------------------------------------------------

#!/bin/bash
# Run different checks based on branch

BRANCH=$(git rev-parse --abbrev-ref HEAD)

if [[ $BRANCH == feature/* ]]; then
  echo "Feature branch: running basic checks"
  sf fm quality \
    --base-sha origin/develop \
    --head-sha HEAD \
    --skip-pmd \
    --skip-tests

elif [[ $BRANCH == release/* ]]; then
  echo "Release branch: running full checks"
  sf fm quality \
    --base-sha origin/main \
    --head-sha HEAD \
    --fail-on-warnings

else
  echo "Other branch: running standard checks"
  sf fm quality \
    --base-sha origin/main \
    --head-sha HEAD
fi

# ------------------------------------------------------------
# Example 23: Check and Auto-fix
# ------------------------------------------------------------

#!/bin/bash
# Run quality checks and attempt auto-fixes

echo "Running quality checks..."

if sf fm quality \
  --base-sha origin/main \
  --head-sha HEAD; then

  echo "✅ All checks passed!"
else
  echo "❌ Quality checks failed. Attempting auto-fixes..."

  # Auto-fix ESLint issues
  npx eslint --fix src/**/*.ts

  # Re-run checks
  echo "Re-running quality checks..."

  if sf fm quality \
    --base-sha origin/main \
    --head-sha HEAD; then

    echo "✅ Checks passed after auto-fix!"
    echo "Don't forget to commit the fixes!"
  else
    echo "❌ Some issues require manual fixes"
    exit 1
  fi
fi
