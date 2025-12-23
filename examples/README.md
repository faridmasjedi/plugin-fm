# SF FM Plugin - Command Examples

This directory contains comprehensive, real-world examples for all commands in the `@salesforce/plugin-fm` package.

## 📂 Example Files

| File                        | Command               | Description                                    |
| --------------------------- | --------------------- | ---------------------------------------------- |
| `build-examples.sh`         | `sf fm build`         | Building deployment artifacts from Git changes |
| `deploy-examples.sh`        | `sf fm deploy`        | Deploying to Salesforce orgs                   |
| `deploy-status-examples.sh` | `sf fm deploy status` | Monitoring deployment progress                 |
| `deploy-cancel-examples.sh` | `sf fm deploy cancel` | Canceling deployments                          |
| `quality-examples.sh`       | `sf fm quality`       | Running quality checks on changed files        |

---

## 🚀 Quick Start

### Make Examples Executable

```bash
chmod +x examples/*.sh
```

### Run Specific Examples

Each file contains multiple numbered examples. To run a specific section:

```bash
# Extract and run Example 1 from build-examples.sh
sed -n '/Example 1:/,/Example 2:/p' examples/build-examples.sh | bash
```

### Copy and Modify

Copy examples to your own scripts:

```bash
# Copy specific example
grep -A 20 "Example 5:" examples/deploy-examples.sh > my-deploy.sh
chmod +x my-deploy.sh
```

---

## 📋 What's Included

### Build Examples (20 examples)

- Basic PR builds
- Chunking large deployments
- Destructive changes
- JSON output for CI/CD
- Multi-environment builds
- Complete workflows

### Deploy Examples (20 examples)

- Validation modes
- Intelligent testing
- Quick deploys
- Async deployments
- GitHub Actions integration
- Multi-chunk deployments
- Production workflows

### Deploy Status Examples (17 examples)

- Real-time monitoring
- Custom polling intervals
- JSON parsing
- Alert systems
- Progress tracking
- CI/CD integration

### Deploy Cancel Examples (17 examples)

- Basic cancellation
- PR workflow integration
- GitHub Actions examples
- Bulk cancellation
- Safe cancellation patterns
- Notification systems

### Quality Examples (23 examples)

- Basic quality checks
- Custom PMD rulesets
- CI/CD integration
- Pre-commit hooks
- Quality gates
- Metrics tracking
- Slack integration

---

## 💡 Common Use Cases

### 1. PR Validation Workflow

```bash
# Build changed components
sf fm build \
  --ref-a origin/main \
  --ref-b HEAD \
  --output-dir ./manifest

# Run quality checks
sf fm quality \
  --base-sha origin/main \
  --head-sha HEAD

# Validate deployment
sf fm deploy \
  --manifest ./manifest \
  --target-org ci-sandbox \
  --mode validation \
  --intelligent-tests
```

### 2. Production Deployment with Quality Gates

```bash
# 1. Quality checks
sf fm quality \
  --base-sha origin/main \
  --head-sha HEAD \
  --fail-on-warnings

# 2. Build package
sf fm build \
  --ref-a origin/main \
  --ref-b HEAD \
  --output-dir ./deploy

# 3. Validate in production
OUTPUT=$(sf fm deploy \
  --manifest ./deploy \
  --target-org production \
  --mode validation \
  --intelligent-tests \
  --async)

JOB_ID=$(echo "$OUTPUT" | grep "^Job ID:" | cut -d: -f2 | tr -d ' ')

# 4. Monitor validation
sf fm deploy status \
  --job-id $JOB_ID \
  --target-org production \
  --watch

# 5. Quick deploy
sf fm deploy \
  --mode quick \
  --validation-id $JOB_ID \
  --target-org production
```

### 3. Cancel Previous PR Validation on New Commit

```bash
# Cancel previous validation
sf fm deploy cancel \
  --job-id-file ./artifacts/previous-job-id.txt \
  --target-org ci-sandbox \
  --skip-if-not-found

# Build new artifacts
sf fm build \
  --ref-a origin/main \
  --ref-b HEAD \
  --output-dir ./manifest

# Start new validation
OUTPUT=$(sf fm deploy \
  --manifest ./manifest \
  --target-org ci-sandbox \
  --mode validation \
  --intelligent-tests \
  --async)

JOB_ID=$(echo "$OUTPUT" | grep "^Job ID:" | cut -d: -f2 | tr -d ' ')
echo "$JOB_ID" > current-job-id.txt
```

---

## 🔧 CI/CD Integration Examples

### GitHub Actions

See `deploy-examples.sh` Example 11 for complete workflow.

Key snippets:

```yaml
- name: Build
  run: sf fm build --ref-a origin/${{ github.base_ref }} --ref-b HEAD --output-dir ./manifest

- name: Quality
  run: sf fm quality --base-sha origin/${{ github.base_ref }} --head-sha ${{ github.sha }}

- name: Deploy
  run: sf fm deploy --manifest ./manifest --target-org ci-sandbox --mode validation --intelligent-tests
```

### GitLab CI

See `quality-examples.sh` Example 8 for complete pipeline.

Key snippets:

```yaml
script:
  - sf fm quality --base-sha $CI_MERGE_REQUEST_TARGET_BRANCH_SHA --head-sha $CI_COMMIT_SHA
  - sf fm build --ref-a $CI_MERGE_REQUEST_TARGET_BRANCH_SHA --ref-b $CI_COMMIT_SHA --output-dir ./manifest
  - sf fm deploy --manifest ./manifest --target-org $SANDBOX_USERNAME --mode validation --intelligent-tests
```

### Jenkins

```groovy
stage('Build') {
    steps {
        sh '''
            sf fm build \
              --ref-a origin/main \
              --ref-b ${GIT_COMMIT} \
              --output-dir ./manifest
        '''
    }
}

stage('Quality') {
    steps {
        sh '''
            sf fm quality \
              --base-sha origin/main \
              --head-sha ${GIT_COMMIT}
        '''
    }
}

stage('Deploy') {
    steps {
        sh '''
            sf fm deploy \
              --manifest ./manifest \
              --target-org ci-sandbox \
              --mode validation \
              --intelligent-tests
        '''
    }
}
```

---

## 📖 Learning Path

### Beginner

1. Start with basic examples (Example 1 in each file)
2. Try building a simple deployment package
3. Run a validation deployment
4. Check deployment status

### Intermediate

1. Use JSON output for automation
2. Implement GitHub Actions workflows
3. Add quality checks to your pipeline
4. Set up deployment monitoring

### Advanced

1. Multi-chunk deployments
2. Custom PMD rulesets
3. Automated cancellation workflows
4. Quality gates and metrics tracking
5. Complete PR-to-production automation

---

## 🛠️ Customization Tips

### Modify Examples for Your Environment

1. **Replace org aliases:**

   ```bash
   # Change
   --target-org my-sandbox
   # To
   --target-org YOUR_ORG_ALIAS
   ```

2. **Update branch names:**

   ```bash
   # Change
   --ref-a origin/main
   # To
   --ref-a origin/YOUR_MAIN_BRANCH
   ```

3. **Adjust paths:**
   ```bash
   # Change
   --output-dir ./deploy
   # To
   --output-dir /your/preferred/path
   ```

### Add Your Own Examples

Create a new file following the pattern:

```bash
#!/bin/bash
# ============================================================
# MY CUSTOM WORKFLOW - Examples
# ============================================================

# ------------------------------------------------------------
# Example 1: Your Use Case
# ------------------------------------------------------------
# Description of what this does

sf fm build \
  --ref-a origin/main \
  --ref-b HEAD \
  --output-dir ./deploy

# Add more commands...
```

---

## 🔍 Finding Specific Examples

### By Use Case

| Use Case             | Example File              | Example Number |
| -------------------- | ------------------------- | -------------- |
| PR Validation        | deploy-examples.sh        | #11            |
| Hotfix Deployment    | deploy-examples.sh        | #14            |
| Quality Gate         | quality-examples.sh       | #17            |
| Cancel on New Commit | deploy-cancel-examples.sh | #4             |
| Multi-Chunk Deploy   | deploy-examples.sh        | #13            |
| Real-time Monitoring | deploy-status-examples.sh | #2             |
| Slack Notifications  | deploy-cancel-examples.sh | #14            |
| Metrics Tracking     | quality-examples.sh       | #19            |

### By CI/CD Platform

| Platform       | Examples                                                                     |
| -------------- | ---------------------------------------------------------------------------- |
| GitHub Actions | deploy-examples.sh #11, deploy-cancel-examples.sh #4, quality-examples.sh #7 |
| GitLab CI      | deploy-examples.sh #12, quality-examples.sh #8                               |
| Jenkins        | quality-examples.sh (see README snippets)                                    |
| Azure DevOps   | deploy-examples.sh #13                                                       |

---

## 📚 Related Documentation

- [Build Command Docs](../README.md#sf-fm-build)
- [Deploy Command Docs](../README.md#sf-fm-deploy)
- [Quality Command Docs](../QUALITY_COMMAND.md)
- [CI/CD Workflows](../PR_WORKFLOW.md)

---

## ⚠️ Important Notes

### Before Running Examples

1. **Install Plugin:**

   ```bash
   sf plugins install @salesforce/plugin-fm
   ```

2. **Authenticate to Orgs:**

   ```bash
   sf org login web --alias my-sandbox
   ```

3. **Verify Git Repository:**
   ```bash
   git status  # Ensure you're in a Git repo
   ```

### Testing Examples Safely

1. **Use Sandbox Orgs:** Always test with sandbox orgs first
2. **Dry Run:** Use `--mode validation` before actual deployments
3. **Review Changes:** Check `package.xml` before deploying
4. **Test Locally:** Run quality checks locally before CI/CD

---

## 🤝 Contributing Examples

Have a great workflow? Add it to the examples!

1. Fork the repository
2. Add your example to the appropriate file
3. Follow the existing format
4. Test your example
5. Submit a pull request

---

## 💬 Support

- **Questions:** Create an issue in the repository
- **Bug Reports:** Report via GitHub issues
- **Feature Requests:** Suggest new examples or use cases

---

## 🎯 Quick Reference

### Extract Job ID

```bash
JOB_ID=$(echo "$OUTPUT" | grep "^Job ID:" | cut -d: -f2 | tr -d ' ')
```

### Parse JSON Output

```bash
STATUS=$(jq -r '.result.status' result.json)
```

### Make Script Executable

```bash
chmod +x script.sh
```

### Run in Background

```bash
./script.sh &
```

### Monitor Progress

```bash
tail -f output.log
```

---

## 📊 Example Statistics

- **Total Examples:** 97+
- **Lines of Code:** 3000+
- **Use Cases Covered:** 20+
- **CI/CD Platforms:** 5+
- **Command Coverage:** 100%

**All commands, all scenarios, all platforms covered!** 🚀
