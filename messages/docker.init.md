# summary

Generate Docker configuration files for using plugin-fm in CI/CD environments.

# description

This command generates a complete Docker setup for running plugin-fm in containerized CI/CD pipelines.

Generated files include:

- Dockerfile - Container image with SF CLI and plugin-fm
- .dockerignore - Optimize Docker build context
- .github/workflows/docker-publish.yml - GitHub Actions workflow to build and publish the image
- DOCKER_README.md - Comprehensive usage documentation

The generated Dockerfile includes:

- Salesforce CLI (sf)
- plugin-fm plugin
- Git for version control operations
- All necessary system dependencies

The generated files are customizable and serve as a starting point for your CI/CD setup.

# examples

- Generate Docker files in current directory with default settings:

  <%= config.bin %> <%= command.id %>

- Generate with custom base image:

  <%= config.bin %> <%= command.id %> --base-image node:20-alpine

- Generate with custom maintainer:

  <%= config.bin %> <%= command.id %> --maintainer "DevOps Team <devops@company.com>"

- Generate in specific directory:

  <%= config.bin %> <%= command.id %> --output-dir ./docker

- Skip GitHub workflow generation:

  <%= config.bin %> <%= command.id %> --no-github-workflow

- Full customization:

  <%= config.bin %> <%= command.id %> --base-image node:20-alpine --maintainer "DevOps Team" --sf-cli-version latest --plugin-install-method npm --output-dir ./ci

# flags.output-dir.summary

Directory where Docker files will be generated.

# flags.base-image.summary

Docker base image to use (e.g., node:18-alpine, node:20-alpine).

# flags.maintainer.summary

Maintainer information for the Docker image.

# flags.sf-cli-version.summary

Version of Salesforce CLI to install (e.g., latest, 2.0.0).

# flags.plugin-install-method.summary

Method to install plugin-fm: npm (from registry), local (from source), git (from repository), or skip.

# flags.plugin-version.summary

Version of plugin-fm to install when using npm method (e.g., latest, 1.0.0).

# flags.github-workflow.summary

Generate GitHub Actions workflow for building and publishing the Docker image.
