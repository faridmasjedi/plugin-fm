export type DockerfileConfig = {
  baseImage: string;
  maintainer: string;
  sfCliVersion: string;
  pluginInstallMethod: 'npm' | 'local' | 'git' | 'skip';
  pluginVersion: string;
};

export type DockerReadmeConfig = {
  baseImage: string;
  maintainer: string;
};

export function generateDockerfile(config: DockerfileConfig): string {
  const isAlpine = config.baseImage.toLowerCase().includes('alpine');

  return `# Reference Dockerfile for plugin-fm in CI/CD environments
#
# This Dockerfile creates a container image with:
# - Salesforce CLI (sf)
# - plugin-fm plugin
# - Git for version control operations
#
# Generated with: sf fm docker init
# Base image: ${config.baseImage}
# Maintainer: ${config.maintainer}

FROM ${config.baseImage}

# Metadata
LABEL maintainer="${config.maintainer}"
LABEL description="Salesforce CLI with plugin-fm for CI/CD pipelines"
LABEL version="1.0"

${generateSystemDependencies(isAlpine)}

# Configure Git to trust all directories (needed in CI/CD environments)
RUN git config --global --add safe.directory '*'

# Install Salesforce CLI
RUN npm install --global @salesforce/cli@${config.sfCliVersion}

# Install plugin-fm
${generatePluginInstallSection(config)}

# Verify installation
RUN sf version && sf plugins

# Set working directory
WORKDIR /workspace

# Default command
CMD ["bash"]
`;
}

function generateSystemDependencies(isAlpine: boolean): string {
  if (isAlpine) {
    return `# Install system dependencies (Alpine Linux)
# - git: Required for plugin-fm Git operations
# - bash: Better shell than sh for scripts
# - ca-certificates, curl, wget: SSL and download support
# - coreutils: Provides GNU env (required for SF CLI -S flag support)
RUN apk add --no-cache \\
    git \\
    bash \\
    ca-certificates \\
    curl \\
    wget \\
    coreutils`;
  } else {
    return `# Install system dependencies (Debian/Ubuntu)
# - git: Required for plugin-fm Git operations
# - ca-certificates, curl, wget: SSL and download support
RUN apt-get update && apt-get install -y \\
    git \\
    ca-certificates \\
    curl \\
    wget \\
    && rm -rf /var/lib/apt/lists/*`;
  }
}

function generatePluginInstallSection(config: DockerfileConfig): string {
  switch (config.pluginInstallMethod) {
    case 'npm':
      return `RUN sf plugins install @salesforce/plugin-fm@${config.pluginVersion}`;
    case 'local':
      return `# Copy and install local plugin
# COPY . /tmp/plugin-fm
# RUN cd /tmp/plugin-fm && npm install && npm run build
# RUN sf plugins link /tmp/plugin-fm`;
    case 'git':
      return 'RUN sf plugins install https://github.com/salesforcecli/plugin-fm';
    case 'skip':
      return `# Plugin installation skipped
# Install manually if needed:
# RUN sf plugins install @salesforce/plugin-fm`;
    default:
      return 'RUN sf plugins install @salesforce/plugin-fm';
  }
}

export function generateDockerIgnore(): string {
  return `# Node modules
node_modules/
npm-debug.log
yarn-error.log

# Build artifacts
lib/
*.tsbuildinfo
.wireit/

# Test files
test/
coverage/
.nyc_output/

# Git
.git/
.github/
.gitignore

# IDE
.vscode/
.idea/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db

# Documentation
docs/
*.md
!README.md

# Salesforce
.sfdx/
.sf/

# Logs
*.log
logs/

# Temp
tmp/
temp/
*.tmp
`;
}

export function generateDockerBuildWorkflow(): string {
  return `# GitHub Actions workflow to build and publish Docker image
# Generated with: sf fm docker init
#
# This workflow:
# 1. Builds the Docker image from Dockerfile
# 2. Publishes to GitHub Container Registry (GHCR)
# 3. Tags with branch name and commit SHA
#
# Usage:
# - Push changes to main/develop to trigger build
# - Manually trigger with custom tag via workflow_dispatch

name: Build and Publish Docker Image

on:
  push:
    branches: [main, develop]
    paths:
      - 'Dockerfile'
      - '.dockerignore'
      - '.github/workflows/docker-publish.yml'
  workflow_dispatch:
    inputs:
      tag:
        description: 'Custom tag for the image'
        required: false

env:
  REGISTRY: ghcr.io
  # Change this to your repository name
  IMAGE_NAME: \${{ github.repository }}/sf-fm-cicd

jobs:
  build-and-push:
    name: Build and Push Docker Image
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to Container Registry
        uses: docker/login-action@v3
        with:
          registry: \${{ env.REGISTRY }}
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}

      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: \${{ env.REGISTRY }}/\${{ env.IMAGE_NAME }}
          tags: |
            type=ref,event=branch
            type=sha,prefix={{branch}}-
            type=raw,value=latest,enable={{is_default_branch}}
            type=raw,value=\${{ inputs.tag }},enable=\${{ inputs.tag != '' }}

      - name: Build and push Docker image
        uses: docker/build-push-action@v5
        with:
          context: .
          file: ./Dockerfile
          push: true
          tags: \${{ steps.meta.outputs.tags }}
          labels: \${{ steps.meta.outputs.labels }}
          cache-from: type=registry,ref=\${{ env.REGISTRY }}/\${{ env.IMAGE_NAME }}:buildcache
          cache-to: type=registry,ref=\${{ env.REGISTRY }}/\${{ env.IMAGE_NAME }}:buildcache,mode=max

      - name: Image summary
        run: |
          echo "### Docker Image Published! 🚀" >> $GITHUB_STEP_SUMMARY
          echo "" >> $GITHUB_STEP_SUMMARY
          echo "**Registry:** \\\`\${{ env.REGISTRY }}\\\`" >> $GITHUB_STEP_SUMMARY
          echo "**Image:** \\\`\${{ env.IMAGE_NAME }}\\\`" >> $GITHUB_STEP_SUMMARY
          echo "" >> $GITHUB_STEP_SUMMARY
          echo "**Tags:**" >> $GITHUB_STEP_SUMMARY
          echo "\\\`\\\`\\\`" >> $GITHUB_STEP_SUMMARY
          echo "\${{ steps.meta.outputs.tags }}" >> $GITHUB_STEP_SUMMARY
          echo "\\\`\\\`\\\`" >> $GITHUB_STEP_SUMMARY
          echo "" >> $GITHUB_STEP_SUMMARY
          echo "**Usage in workflows:**" >> $GITHUB_STEP_SUMMARY
          echo "\\\`\\\`\\\`yaml" >> $GITHUB_STEP_SUMMARY
          echo "container:" >> $GITHUB_STEP_SUMMARY
          echo "  image: \${{ env.REGISTRY }}/\${{ env.IMAGE_NAME }}:latest" >> $GITHUB_STEP_SUMMARY
          echo "\\\`\\\`\\\`" >> $GITHUB_STEP_SUMMARY
`;
}

export function generateDockerReadme(config: DockerReadmeConfig): string {
  return `# Docker Support for plugin-fm

This directory contains Docker configuration for using plugin-fm in containerized CI/CD environments.

Generated with: \`sf fm docker init\`

**Configuration:**
- Base Image: \`${config.baseImage}\`
- Maintainer: \`${config.maintainer}\`

## Quick Start

### 1. Build the Docker Image Locally

\`\`\`bash
# Build the image
docker build -t myorg/sf-fm-cicd:latest .

# Test it
docker run --rm myorg/sf-fm-cicd:latest sf --version
docker run --rm myorg/sf-fm-cicd:latest sf fm --help
\`\`\`

### 2. Use in CI/CD

#### GitHub Actions

\`\`\`yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    container:
      image: ghcr.io/your-org/your-repo/sf-fm-cicd:latest
      credentials:
        username: \${{ github.actor }}
        password: \${{ secrets.GITHUB_TOKEN }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Build deployment artifacts
        run: |
          sf fm build --ref-a origin/main --ref-b HEAD --output-dir ./manifest

      - name: Deploy to Salesforce
        run: |
          echo "\${{ secrets.SFDX_AUTH_URL }}" > authUrl.txt
          sf org login sfdx-url --sfdx-url-file authUrl.txt --alias target-org
          sf fm deploy --manifest ./manifest --target-org target-org
\`\`\`

#### GitLab CI

\`\`\`yaml
deploy:
  image: registry.company.com/sf-fm-cicd:latest
  script:
    - sf fm build --ref-a origin/main --ref-b HEAD --output-dir ./manifest
    - echo "$SFDX_AUTH_URL" > authUrl.txt
    - sf org login sfdx-url --sfdx-url-file authUrl.txt --alias target-org
    - sf fm deploy --manifest ./manifest --target-org target-org
\`\`\`

## Publishing Your Docker Image

### Option 1: GitHub Container Registry (GHCR)

The included \`.github/workflows/docker-publish.yml\` workflow will:
- Build the image automatically when Dockerfile changes
- Publish to \`ghcr.io/your-org/your-repo/sf-fm-cicd:latest\`
- Tag with branch name and commit SHA
- Use Docker layer caching for fast builds

**Usage in your workflows:**
\`\`\`yaml
container:
  image: ghcr.io/your-org/your-repo/sf-fm-cicd:latest
  credentials:
    username: \${{ github.actor }}
    password: \${{ secrets.GITHUB_TOKEN }}
\`\`\`

### Option 2: Docker Hub

\`\`\`bash
# Build
docker build -t your-dockerhub-username/sf-fm-cicd:latest .

# Login
docker login

# Push
docker push your-dockerhub-username/sf-fm-cicd:latest
\`\`\`

### Option 3: Private Registry

\`\`\`bash
# Build
docker build -t registry.company.com/sf-fm-cicd:latest .

# Login
docker login registry.company.com

# Push
docker push registry.company.com/sf-fm-cicd:latest
\`\`\`

## Customizing the Dockerfile

### Add Quality Tools

Add to the Dockerfile after SF CLI installation:

\`\`\`dockerfile
# Install ESLint
RUN npm install -g eslint

# Install PMD (requires Java)
RUN apk add --no-cache openjdk11-jre
ENV PMD_VERSION=7.0.0
RUN wget -q https://github.com/pmd/pmd/releases/download/pmd_releases%2F\${PMD_VERSION}/pmd-dist-\${PMD_VERSION}-bin.zip \\
    && unzip -q pmd-dist-\${PMD_VERSION}-bin.zip -d /opt \\
    && rm pmd-dist-\${PMD_VERSION}-bin.zip \\
    && ln -s /opt/pmd-bin-\${PMD_VERSION}/bin/pmd /usr/local/bin/pmd
\`\`\`

### Use Different Base Image

To regenerate with a different base image:

\`\`\`bash
sf fm docker init --base-image node:20-alpine
\`\`\`

Or manually change the first line of the Dockerfile:

\`\`\`dockerfile
# Use Ubuntu instead of Alpine
FROM node:18

# Install dependencies (Ubuntu uses apt instead of apk)
RUN apt-get update && apt-get install -y \\
    git \\
    curl \\
    ca-certificates \\
    && rm -rf /var/lib/apt/lists/*
\`\`\`

### Install Additional SF Plugins

Add after plugin-fm installation:

\`\`\`dockerfile
# Install other plugins
RUN sf plugins install @salesforce/plugin-data
RUN sf plugins install @salesforce/plugin-org
\`\`\`

## Using the Docker Image

### Interactive Shell

\`\`\`bash
docker run -it --rm \\
  -v $(pwd):/workspace \\
  -w /workspace \\
  myorg/sf-fm-cicd:latest \\
  bash
\`\`\`

### Run Single Command

\`\`\`bash
docker run --rm \\
  -v $(pwd):/workspace \\
  -w /workspace \\
  myorg/sf-fm-cicd:latest \\
  sf fm build --ref-a main --ref-b HEAD
\`\`\`

### With Environment Variables

\`\`\`bash
docker run --rm \\
  -v $(pwd):/workspace \\
  -w /workspace \\
  -e SFDX_AUTH_URL="force://..." \\
  myorg/sf-fm-cicd:latest \\
  sf org login sfdx-url --sfdx-url-stdin
\`\`\`

## Complete CI/CD Example

### GitHub Actions - Full Pipeline

\`\`\`yaml
name: Salesforce CI/CD

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

env:
  SF_CONTAINER: ghcr.io/your-org/your-repo/sf-fm-cicd:latest

jobs:
  build:
    runs-on: ubuntu-latest
    container:
      image: \${{ env.SF_CONTAINER }}
      credentials:
        username: \${{ github.actor }}
        password: \${{ secrets.GITHUB_TOKEN }}

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Build deployment artifacts
        run: |
          sf fm build \\
            --ref-a origin/\${{ github.base_ref || 'main' }} \\
            --ref-b HEAD \\
            --output-dir ./manifest

      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: deployment-manifest
          path: ./manifest

  validate:
    runs-on: ubuntu-latest
    container:
      image: \${{ env.SF_CONTAINER }}
      credentials:
        username: \${{ github.actor }}
        password: \${{ secrets.GITHUB_TOKEN }}
    needs: [build]
    if: github.event_name == 'pull_request'

    steps:
      - uses: actions/checkout@v4

      - name: Download artifacts
        uses: actions/download-artifact@v4
        with:
          name: deployment-manifest
          path: ./manifest

      - name: Authenticate to Salesforce
        run: |
          echo "\${{ secrets.SFDX_AUTH_URL }}" > authUrl.txt
          sf org login sfdx-url --sfdx-url-file authUrl.txt --alias target-org

      - name: Validate deployment
        run: |
          sf fm deploy \\
            --manifest ./manifest \\
            --target-org target-org \\
            --mode validation \\
            --intelligent-tests \\
            --progress

  deploy:
    runs-on: ubuntu-latest
    container:
      image: \${{ env.SF_CONTAINER }}
      credentials:
        username: \${{ github.actor }}
        password: \${{ secrets.GITHUB_TOKEN }}
    needs: [build]
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'

    steps:
      - uses: actions/checkout@v4

      - name: Download artifacts
        uses: actions/download-artifact@v4
        with:
          name: deployment-manifest
          path: ./manifest

      - name: Authenticate to Salesforce
        run: |
          echo "\${{ secrets.SFDX_AUTH_URL }}" > authUrl.txt
          sf org login sfdx-url --sfdx-url-file authUrl.txt --alias prod

      - name: Deploy to production
        run: |
          sf fm deploy \\
            --manifest ./manifest \\
            --target-org prod \\
            --mode deployment \\
            --intelligent-tests \\
            --progress
\`\`\`

## Troubleshooting

### SF CLI env: unrecognized option: S

**Problem:** Alpine's BusyBox env doesn't support \`-S\` flag.
**Solution:** The Dockerfile includes \`coreutils\` which provides GNU env.

### Permission denied errors

**Problem:** Git safe.directory issues.
**Solution:** The Dockerfile includes \`git config --global --add safe.directory '*'\`.

### Plugin not found

**Problem:** Plugin not installed or build failed.
**Solution:** Check the plugin installation step in Dockerfile. Regenerate with different \`--plugin-install-method\` if needed.

## Best Practices

1. **Version your images** - Use tags like \`v1.0.0\` instead of just \`latest\`
2. **Cache layers** - Order Dockerfile steps from least to most frequently changing
3. **Multi-stage builds** - Use for smaller images if needed
4. **Security scanning** - Use tools like Trivy to scan images
5. **Keep it updated** - Rebuild regularly to get security updates

## Regenerating Files

To regenerate these files with different options:

\`\`\`bash
# Different base image
sf fm docker init --base-image node:20-alpine

# Different maintainer
sf fm docker init --maintainer "DevOps Team <devops@company.com>"

# Skip GitHub workflow
sf fm docker init --no-github-workflow

# Custom output directory
sf fm docker init --output-dir ./docker

# All options
sf fm docker init \\
  --base-image node:20-alpine \\
  --maintainer "DevOps Team" \\
  --sf-cli-version latest \\
  --plugin-install-method npm \\
  --plugin-version latest \\
  --output-dir ./ci
\`\`\`

## Support

For issues related to:
- **plugin-fm**: Open an issue at https://github.com/salesforcecli/plugin-fm
- **SF CLI**: Visit https://github.com/forcedotcom/cli
- **GitHub Actions**: Visit https://docs.github.com/actions

## License

Same as plugin-fm - Apache 2.0
`;
}
