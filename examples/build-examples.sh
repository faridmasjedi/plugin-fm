#!/bin/bash
# ============================================================
# SF FM BUILD - Examples
# ============================================================
# This file contains real-world examples for the build command
# ============================================================

# ------------------------------------------------------------
# Example 1: Basic PR Build
# ------------------------------------------------------------
# Build deployment artifacts for a PR from feature branch to main

sf fm build \
  --ref-a origin/main \
  --ref-b HEAD \
  --output-dir ./deploy

# Output:
# - ./deploy/package.xml (changed components)
# - ./deploy/destructiveChanges.xml (deleted components)
# - ./deploy/metadata/ (copied files)

# ------------------------------------------------------------
# Example 2: Build with Chunking
# ------------------------------------------------------------
# Large deployments need to be split into chunks (max 10,000 files)

sf fm build \
  --ref-a origin/main \
  --ref-b HEAD \
  --output-dir ./deploy \
  --chunk-size 5000

# Output:
# - ./deploy/chunk-1/package.xml
# - ./deploy/chunk-2/package.xml
# - ./deploy/chunk-3/package.xml

# ------------------------------------------------------------
# Example 3: Specific Commit Range
# ------------------------------------------------------------
# Build for specific commits

sf fm build \
  --ref-a abc123def \
  --ref-b 456789ghi \
  --output-dir ./hotfix-deploy

# ------------------------------------------------------------
# Example 4: Build with Destructive Changes
# ------------------------------------------------------------
# Include both pre and post destructive changes

sf fm build \
  --ref-a origin/main \
  --ref-b HEAD \
  --output-dir ./deploy \
  --destructive-mode both

# Output:
# - ./deploy/Destructive/destructiveChangesPre.xml
# - ./deploy/package.xml
# - ./deploy/Destructive/destructiveChanges.xml

# ------------------------------------------------------------
# Example 5: JSON Output for CI/CD
# ------------------------------------------------------------
# Get JSON output for parsing in scripts

sf fm build \
  --ref-a origin/main \
  --ref-b HEAD \
  --output-dir ./deploy \
  --json > build-result.json

# Parse in script:
# FILES_CHANGED=$(cat build-result.json | jq -r '.result.statistics.totalChanged')
# echo "Changed files: $FILES_CHANGED"

# ------------------------------------------------------------
# Example 6: Build from Tag to Branch
# ------------------------------------------------------------
# Compare release tag to current development

sf fm build \
  --ref-a v1.2.0 \
  --ref-b develop \
  --output-dir ./release-deploy

# ------------------------------------------------------------
# Example 7: Build with Force Include
# ------------------------------------------------------------
# Force include specific metadata even if not changed

sf fm build \
  --ref-a origin/main \
  --ref-b HEAD \
  --output-dir ./deploy \
  --force-include "CustomObject:Account,ApexClass:AccountTriggerHandler"

# ------------------------------------------------------------
# Example 8: Build with Ignore Patterns
# ------------------------------------------------------------
# Ignore certain files from deployment

sf fm build \
  --ref-a origin/main \
  --ref-b HEAD \
  --output-dir ./deploy \
  --ignore "**/*.profile,**/*.permissionset"

# ------------------------------------------------------------
# Example 9: GitHub Actions Integration
# ------------------------------------------------------------
# Build in GitHub Actions workflow

# - name: Build Deployment Package
#   run: |
#     sf fm build \
#       --ref-a origin/${{ github.base_ref }} \
#       --ref-b ${{ github.sha }} \
#       --output-dir ./manifest \
#       --json | tee build-output.json
#
#     # Save output for later steps
#     echo "files_changed=$(jq -r '.result.statistics.totalChanged' build-output.json)" >> $GITHUB_OUTPUT

# ------------------------------------------------------------
# Example 10: Multi-Environment Build
# ------------------------------------------------------------
# Build different packages for different environments

# Development
sf fm build \
  --ref-a origin/main \
  --ref-b HEAD \
  --output-dir ./deploy/dev \
  --ignore "**/*.profile-prod"

# Production
sf fm build \
  --ref-a origin/staging \
  --ref-b origin/main \
  --output-dir ./deploy/prod \
  --ignore "**/*.profile-dev"

# ------------------------------------------------------------
# Example 11: Hotfix Build
# ------------------------------------------------------------
# Build for hotfix from production to hotfix branch

sf fm build \
  --ref-a origin/production \
  --ref-b hotfix/TICKET-123 \
  --output-dir ./hotfix \
  --destructive-mode none

# ------------------------------------------------------------
# Example 12: Release Build
# ------------------------------------------------------------
# Build complete release package

sf fm build \
  --ref-a v2.0.0 \
  --ref-b v2.1.0 \
  --output-dir ./release-2.1.0 \
  --chunk-size 10000 \
  --json > release-manifest.json

# Generate release notes from output
# jq -r '.result.statistics' release-manifest.json > release-notes.txt

# ------------------------------------------------------------
# Real-World Workflow
# ------------------------------------------------------------

# Step 1: Build deployment package
sf fm build \
  --ref-a origin/main \
  --ref-b HEAD \
  --output-dir ./deploy

# Step 2: Review what will be deployed
echo "=== Files to Deploy ==="
cat ./deploy/package.xml

echo "=== Files to Delete ==="
cat ./deploy/destructiveChanges.xml

# Step 3: Deploy to sandbox (see deploy-examples.sh)
# Step 4: Run tests
# Step 5: Deploy to production

# ------------------------------------------------------------
# CI/CD Pipeline Example
# ------------------------------------------------------------

#!/bin/bash
set -e

echo "Building deployment package..."

# Build
sf fm build \
  --ref-a origin/main \
  --ref-b HEAD \
  --output-dir ./manifest \
  --json > build-result.json

# Check if there are changes
TOTAL_CHANGED=$(jq -r '.result.statistics.totalChanged' build-result.json)
TOTAL_DELETED=$(jq -r '.result.statistics.totalDeleted' build-result.json)

if [ "$TOTAL_CHANGED" -eq 0 ] && [ "$TOTAL_DELETED" -eq 0 ]; then
  echo "No changes detected. Skipping deployment."
  exit 0
fi

echo "Changes detected: $TOTAL_CHANGED changed, $TOTAL_DELETED deleted"

# Check if chunking was needed
CHUNKS=$(jq -r '.result.statistics.chunksGenerated' build-result.json)

if [ "$CHUNKS" -gt 1 ]; then
  echo "Package split into $CHUNKS chunks"

  # Deploy each chunk
  for i in $(seq 1 $CHUNKS); do
    echo "Deploying chunk $i/$CHUNKS..."
    # Deploy chunk (see deploy examples)
  done
else
  echo "Deploying single package..."
  # Deploy single package
fi

echo "Build complete!"
