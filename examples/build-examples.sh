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

# Output structure:
# ./deploy/
# ├── Package/
# │   └── package.xml (changed components manifest)
# ├── Destructive/
# │   ├── destructiveChanges.xml (deleted components)
# │   └── package.xml (empty package for destructive changes)
# ├── ChangedFiles/
# │   └── force-app/... (copied metadata files)
# ├── sfdx-project.json (updated project config)
# └── .forceignore (copied from project root)

# ------------------------------------------------------------
# Example 2: Build with Docker Image
# ------------------------------------------------------------
# Build and create Docker image for containerized deployments

sf fm build \
  --ref-a origin/main \
  --ref-b HEAD \
  --output-dir ./deploy \
  --create-docker-image

# Output:
# - All files from Example 1
# - ./deploy/Dockerfile
# - Docker image: sf-diff-artifact:<timestamp>

# Use the image:
# docker run -it sf-diff-artifact:<timestamp> sf --version

# ------------------------------------------------------------
# Example 3: Specific Commit Range
# ------------------------------------------------------------
# Build for specific commits or tags

sf fm build \
  --ref-a abc123def \
  --ref-b 456789ghi \
  --output-dir ./hotfix-deploy

# Or using tags:
sf fm build \
  --ref-a v1.0.0 \
  --ref-b v1.1.0 \
  --output-dir ./release-deploy

# ------------------------------------------------------------
# Example 4: Build with Ignore Patterns
# ------------------------------------------------------------
# Ignore certain files from deployment using --ignore flag

sf fm build \
  --ref-a origin/main \
  --ref-b HEAD \
  --output-dir ./deploy \
  --ignore "**/*.profile,**/*.permissionset"

# Multiple patterns (comma-separated):
sf fm build \
  --ref-a origin/main \
  --ref-b HEAD \
  --output-dir ./deploy \
  --ignore "**/*.profile,**/*.permissionset,**/test/**"

# ------------------------------------------------------------
# Example 5: Custom .forceignore File
# ------------------------------------------------------------
# Use a custom .forceignore file location

sf fm build \
  --ref-a origin/main \
  --ref-b HEAD \
  --output-dir ./deploy \
  --forceignore ./config/.forceignore-prod

# Combine with additional patterns:
sf fm build \
  --ref-a origin/main \
  --ref-b HEAD \
  --output-dir ./deploy \
  --forceignore ./config/.forceignore-prod \
  --ignore "**/*.snapshot"

# ------------------------------------------------------------
# Example 6: Console Summary (Default)
# ------------------------------------------------------------
# Formatted console output with visual indicators

sf fm build \
  --ref-a origin/main \
  --ref-b HEAD \
  --output-dir ./deploy \
  --summary console

# Output shows:
# - FILE CHANGE SUMMARY (changed, deleted, ignored files)
# - METADATA CHANGE SUMMARY (components by type)
# - DEPLOYMENT SUMMARY (paths and statistics)

# ------------------------------------------------------------
# Example 7: JSON Summary Output
# ------------------------------------------------------------
# Get machine-readable JSON output for CI/CD pipelines

sf fm build \
  --ref-a origin/main \
  --ref-b HEAD \
  --output-dir ./deploy \
  --summary json > build-result.json

# Clean JSON output (no log messages)
# Parse in scripts:
TOTAL_CHANGED=$(jq -r '.statistics.totalChanged' build-result.json)
TOTAL_DELETED=$(jq -r '.statistics.totalDeleted' build-result.json)
PACKAGE_XML=$(jq -r '.manifests.packageXml' build-result.json)

echo "Changed: $TOTAL_CHANGED"
echo "Deleted: $TOTAL_DELETED"
echo "Manifest: $PACKAGE_XML"

# ------------------------------------------------------------
# Example 8: GitHub Actions Summary
# ------------------------------------------------------------
# Generate GitHub Actions-compatible markdown summary

sf fm build \
  --ref-a origin/main \
  --ref-b HEAD \
  --output-dir ./deploy \
  --summary github

# In GitHub Actions workflow:
# - Writes to $GITHUB_STEP_SUMMARY
# - Creates formatted job summary
# - Shows overview table, metadata changes, artifacts

# Example GitHub Actions workflow:
# - name: Build Deployment Package
#   run: |
#     sf fm build \
#       --ref-a origin/${{ github.base_ref }} \
#       --ref-b ${{ github.sha }} \
#       --output-dir ./manifest \
#       --summary github

# ------------------------------------------------------------
# Example 9: Compare Between Branches
# ------------------------------------------------------------
# Build for changes from develop to main

sf fm build \
  --ref-a develop \
  --ref-b main \
  --output-dir ./promote-to-main

# Compare staging to production:
sf fm build \
  --ref-a origin/production \
  --ref-b origin/staging \
  --output-dir ./prod-deploy

# ------------------------------------------------------------
# Example 10: Multi-Environment Builds
# ------------------------------------------------------------
# Build different packages for different environments

# Development (exclude production configs)
sf fm build \
  --ref-a origin/main \
  --ref-b HEAD \
  --output-dir ./deploy/dev \
  --ignore "**/*Production*"

# Production (exclude dev/sandbox configs)
sf fm build \
  --ref-a origin/staging \
  --ref-b origin/main \
  --output-dir ./deploy/prod \
  --ignore "**/*Development*,**/*Sandbox*"

# ------------------------------------------------------------
# Example 11: Hotfix Workflow
# ------------------------------------------------------------
# Build for urgent hotfix deployment

# Step 1: Create hotfix branch from production
# git checkout -b hotfix/TICKET-123 origin/production

# Step 2: Make fixes and commit
# git add .
# git commit -m "fix: critical bug"

# Step 3: Build deployment package
sf fm build \
  --ref-a origin/production \
  --ref-b HEAD \
  --output-dir ./hotfix-deploy

# Step 4: Deploy to production (see deploy-examples.sh)

# ------------------------------------------------------------
# Example 12: Release Package Build
# ------------------------------------------------------------
# Build complete release package with documentation

sf fm build \
  --ref-a v2.0.0 \
  --ref-b v2.1.0 \
  --output-dir ./release-2.1.0 \
  --summary json > release-manifest.json

# Generate release notes from output:
echo "Release 2.1.0 Changes:" > RELEASE_NOTES.md
echo "" >> RELEASE_NOTES.md
echo "Total Changed: $(jq -r '.statistics.totalChanged' release-manifest.json)" >> RELEASE_NOTES.md
echo "Total Deleted: $(jq -r '.statistics.totalDeleted' release-manifest.json)" >> RELEASE_NOTES.md

# ------------------------------------------------------------
# Example 13: CI/CD Pipeline Integration
# ------------------------------------------------------------

#!/bin/bash
set -e

echo "🔨 Building deployment package..."

# Build with JSON output
sf fm build \
  --ref-a origin/main \
  --ref-b HEAD \
  --output-dir ./manifest \
  --summary json > build-result.json

# Parse results
TOTAL_CHANGED=$(jq -r '.statistics.totalChanged' build-result.json)
TOTAL_DELETED=$(jq -r '.statistics.totalDeleted' build-result.json)
CHUNKS=$(jq -r '.statistics.chunksGenerated' build-result.json)

# Check if there are changes
if [ "$TOTAL_CHANGED" -eq 0 ] && [ "$TOTAL_DELETED" -eq 0 ]; then
  echo "✅ No changes detected. Skipping deployment."
  exit 0
fi

echo "📊 Changes detected:"
echo "   Changed: $TOTAL_CHANGED"
echo "   Deleted: $TOTAL_DELETED"
echo "   Chunks: $CHUNKS"

# Validate package.xml exists
if [ ! -f "./manifest/Package/package.xml" ]; then
  echo "❌ Error: package.xml not found"
  exit 1
fi

echo "✅ Build complete!"

# Continue with deployment steps...

# ------------------------------------------------------------
# Example 14: Advanced Filtering
# ------------------------------------------------------------
# Combine .forceignore with additional ignore patterns

# Create custom .forceignore
cat > .forceignore.custom <<EOF
# Standard Salesforce ignores
**/.sfdx
**/.vscode
**/.git

# Additional ignores for this build
**/*.profile-meta.xml
**/profiles/**
EOF

# Build with custom ignore file and additional patterns
sf fm build \
  --ref-a origin/main \
  --ref-b HEAD \
  --output-dir ./deploy \
  --forceignore ./.forceignore.custom \
  --ignore "**/test/**,**/*.snapshot"

# ------------------------------------------------------------
# Example 15: Review Before Deploy Workflow
# ------------------------------------------------------------

# Step 1: Build package
sf fm build \
  --ref-a origin/main \
  --ref-b HEAD \
  --output-dir ./deploy

# Step 2: Review what will be deployed
echo ""
echo "=== 📦 PACKAGE MANIFEST ==="
cat ./deploy/Package/package.xml

echo ""
echo "=== 🗑️  DESTRUCTIVE CHANGES ==="
cat ./deploy/Destructive/destructiveChanges.xml

echo ""
echo "=== 📁 CHANGED FILES ==="
find ./deploy/ChangedFiles -type f

# Step 3: Confirm before proceeding
read -p "Continue with deployment? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  echo "Proceeding with deployment..."
  # Deploy (see deploy-examples.sh)
else
  echo "Deployment cancelled"
  exit 1
fi

# ------------------------------------------------------------
# Example 16: Docker Deployment Workflow
# ------------------------------------------------------------

# Build with Docker image
sf fm build \
  --ref-a origin/main \
  --ref-b HEAD \
  --output-dir ./deploy \
  --create-docker-image

# Get image name
IMAGE_NAME=$(docker images --format "{{.Repository}}:{{.Tag}}" | grep sf-diff-artifact | head -1)

echo "Docker image created: $IMAGE_NAME"

# Deploy using Docker container
docker run -it $IMAGE_NAME \
  sf project deploy start \
  --manifest Package/package.xml \
  --target-org myorg \
  --dry-run

# ------------------------------------------------------------
# Real-World Complete Workflow
# ------------------------------------------------------------

#!/bin/bash
set -euo pipefail

echo "🚀 Starting deployment workflow..."

# 1. Build deployment package
echo "📦 Building package..."
sf fm build \
  --ref-a origin/main \
  --ref-b HEAD \
  --output-dir ./manifest \
  --summary json > build-result.json

# 2. Check for changes
CHANGED=$(jq -r '.statistics.totalChanged' build-result.json)
if [ "$CHANGED" -eq 0 ]; then
  echo "✅ No changes to deploy"
  exit 0
fi

# 3. Display summary
echo "📊 Deployment summary:"
jq '.statistics' build-result.json

# 4. Deploy to sandbox
echo "🔨 Deploying to sandbox..."
# (see deploy-examples.sh for deployment commands)

# 5. Run tests
echo "🧪 Running tests..."
# sf project deploy validate --manifest ./manifest/Package/package.xml

# 6. Deploy to production
echo "🎯 Deploying to production..."
# sf project deploy start --manifest ./manifest/Package/package.xml

echo "✅ Deployment complete!"

# ------------------------------------------------------------
# Troubleshooting Examples
# ------------------------------------------------------------

# Debug: See what files are being detected
sf fm build \
  --ref-a origin/main \
  --ref-b HEAD \
  --output-dir ./debug \
  --summary console | tee build-debug.log

# Check specific file types
sf fm build \
  --ref-a origin/main \
  --ref-b HEAD \
  --output-dir ./apex-only \
  --ignore "**/*.object,**/*.permissionset,**/*.profile"

# Verify .forceignore is working
sf fm build \
  --ref-a origin/main \
  --ref-b HEAD \
  --output-dir ./test-ignore \
  --forceignore ./.forceignore.test

# ------------------------------------------------------------
# Tips & Best Practices
# ------------------------------------------------------------

# ✅ Use tags for release builds
# sf fm build --ref-a v1.0.0 --ref-b v2.0.0

# ✅ Always use origin/ prefix for remote branches
# sf fm build --ref-a origin/main --ref-b origin/develop

# ✅ Use JSON output in CI/CD for parsing
# sf fm build --summary json > results.json

# ✅ Use GitHub summary in GitHub Actions
# sf fm build --summary github

# ✅ Review destructive changes before deploying
# cat ./deploy/Destructive/destructiveChanges.xml

# ✅ Keep .forceignore up to date
# Add patterns for files you don't want to deploy

# ✅ Use Docker images for consistent deployments
# sf fm build --create-docker-image

# ❌ Don't use HEAD without context in CI/CD
# Use specific refs: ${{ github.sha }}

# ❌ Don't ignore the .forceignore file
# It's copied to the artifact directory for deployment
