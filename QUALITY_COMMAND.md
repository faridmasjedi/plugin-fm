# Quality Command Documentation

## Overview

The `sf fm quality` command runs comprehensive quality checks on changed files between two Git commits. It's designed for CI/CD pipelines to ensure code quality on changed files only.

## Command

```bash
sf fm quality --base-sha <base> --head-sha <head> [options]
```

## Quality Checks Performed

### 1. ESLint (JavaScript/TypeScript)

- **What it checks**: Code style, best practices, potential bugs
- **File types**: `.js`, `.ts`, `.jsx`, `.tsx`
- **Tool**: ESLint
- **Skippable**: `--skip-eslint`

### 2. XML Validation

- **What it checks**: XML syntax, well-formedness
- **File types**: `.xml`
- **Tool**: `xmllint`
- **Skippable**: `--skip-xml-lint`

### 3. PMD Static Analysis

- **What it checks**: Code smells, anti-patterns, complexity
- **File types**: All source files
- **Tool**: PMD
- **Skippable**: `--skip-pmd`
- **Requires**: PMD installed + ruleset file

### 4. Tests (Jest/Mocha)

- **What it checks**: Test execution and results
- **File types**: Test files (`.test.ts`, `.spec.ts`)
- **Tool**: `npm run test:only`
- **Skippable**: `--skip-tests`

---

## Flags

### Required

| Flag         | Short | Description                 | Example       |
| ------------ | ----- | --------------------------- | ------------- |
| `--base-sha` | `-b`  | Base commit to compare from | `origin/main` |
| `--head-sha` | `-h`  | Head commit to compare to   | `HEAD`        |

### Optional

| Flag                 | Description                        | Default     |
| -------------------- | ---------------------------------- | ----------- |
| `--pmd-ruleset`      | Path to custom PMD ruleset XML     | Auto-detect |
| `--skip-eslint`      | Skip ESLint checks                 | `false`     |
| `--skip-xml-lint`    | Skip XML validation                | `false`     |
| `--skip-pmd`         | Skip PMD analysis                  | `false`     |
| `--skip-tests`       | Skip test execution                | `false`     |
| `--fail-on-warnings` | Fail on warnings (not just errors) | `false`     |
| `--json`             | Output results as JSON             | `false`     |

---

## Usage Examples

### Basic Usage

```bash
# Compare current branch with main
sf fm quality --base-sha origin/main --head-sha HEAD
```

### CI/CD Pipeline

```bash
# GitHub Actions
sf fm quality --base-sha ${{ github.base_ref }} --head-sha ${{ github.sha }}

# GitLab CI
sf fm quality --base-sha $CI_MERGE_REQUEST_TARGET_BRANCH_SHA --head-sha $CI_COMMIT_SHA

# Jenkins
sf fm quality --base-sha ${env.GIT_PREVIOUS_COMMIT} --head-sha ${env.GIT_COMMIT}
```

### Custom PMD Ruleset

```bash
sf fm quality \
  --base-sha origin/main \
  --head-sha HEAD \
  --pmd-ruleset ./custom-pmd-rules.xml
```

### Skip Specific Checks

```bash
# Skip PMD and tests
sf fm quality \
  --base-sha origin/main \
  --head-sha HEAD \
  --skip-pmd \
  --skip-tests
```

### Fail on Warnings

```bash
# Fail if any warnings found
sf fm quality \
  --base-sha origin/main \
  --head-sha HEAD \
  --fail-on-warnings
```

### JSON Output

```bash
# Get JSON output for parsing
sf fm quality \
  --base-sha origin/main \
  --head-sha HEAD \
  --json > quality-report.json
```

---

## PMD Ruleset Configuration

### Auto-detection

The command looks for PMD rulesets in these locations (in order):

1. `--pmd-ruleset` flag value
2. `.pmd/ruleset.xml`
3. `pmd-ruleset.xml`
4. `.pmd/pmd-ruleset.xml`

If no ruleset is found, PMD checks are skipped.

### Example Ruleset

Create `.pmd/ruleset.xml`:

```xml
<?xml version="1.0"?>
<ruleset name="Custom Ruleset"
    xmlns="http://pmd.sourceforge.net/ruleset/2.0.0"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xsi:schemaLocation="http://pmd.sourceforge.net/ruleset/2.0.0 https://pmd.sourceforge.io/ruleset_2_0_0.xsd">

    <description>Custom PMD rules for project</description>

    <!-- JavaScript/ECMAScript rules -->
    <rule ref="category/ecmascript/bestpractices.xml"/>
    <rule ref="category/ecmascript/codestyle.xml"/>
    <rule ref="category/ecmascript/errorprone.xml"/>

    <!-- XML rules -->
    <rule ref="category/xml/bestpractices.xml"/>
    <rule ref="category/xml/errorprone.xml"/>

    <!-- Exclude specific rules -->
    <rule ref="category/ecmascript/codestyle.xml">
        <exclude name="AssignmentInOperand"/>
    </rule>

    <!-- Exclude specific files -->
    <exclude-pattern>.*/test/.*</exclude-pattern>
    <exclude-pattern>.*/node_modules/.*</exclude-pattern>
</ruleset>
```

---

## Output Format

### Human-readable Output

```
Analyzing changes between origin/main and HEAD...
Found 15 changed file(s)
Running ESLint on 12 file(s)...
Running XML validation on 3 file(s)...
Running PMD static analysis...
Running tests for changed files...

============================================================
Quality Check Results
============================================================

✅ ESLint: PASS

✅ XML Lint: PASS

❌ PMD: FAIL
   Errors: 3
   Details:
     src/utils/helper.ts:45: Avoid using var
     src/services/api.ts:120: Function too complex
     src/models/user.ts:30: Missing documentation

⚠️  Tests: WARNING
   Warnings: 1
   Details:
     1 test skipped

============================================================
Total Errors: 3
Total Warnings: 1
============================================================

❌ Quality checks failed with 3 error(s)
```

### JSON Output (`--json`)

```json
{
  "status": 1,
  "result": {
    "baseSha": "origin/main",
    "headSha": "HEAD",
    "filesChanged": 15,
    "checks": [
      {
        "check": "ESLint",
        "status": "pass",
        "errors": 0,
        "warnings": 0
      },
      {
        "check": "XML Lint",
        "status": "pass",
        "errors": 0,
        "warnings": 0
      },
      {
        "check": "PMD",
        "status": "fail",
        "errors": 3,
        "warnings": 0,
        "details": [
          "src/utils/helper.ts:45: Avoid using var",
          "src/services/api.ts:120: Function too complex",
          "src/models/user.ts:30: Missing documentation"
        ]
      },
      {
        "check": "Tests",
        "status": "warning",
        "errors": 0,
        "warnings": 1,
        "details": ["1 test skipped"]
      }
    ],
    "totalErrors": 3,
    "totalWarnings": 1,
    "passed": false
  }
}
```

---

## Exit Codes

| Code | Meaning                                            |
| ---- | -------------------------------------------------- |
| `0`  | All checks passed                                  |
| `1`  | One or more checks failed with errors              |
| `1`  | Warnings found (when `--fail-on-warnings` is used) |

---

## CI/CD Integration

### GitHub Actions

```yaml
name: Quality Checks

on:
  pull_request:
    branches: [main]

jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '18'

      - name: Install SF CLI
        run: npm install -g @salesforce/cli

      - name: Install Plugin
        run: sf plugins install @salesforce/plugin-fm

      - name: Install PMD (optional)
        run: |
          wget https://github.com/pmd/pmd/releases/download/pmd_releases%2F7.0.0/pmd-dist-7.0.0-bin.zip
          unzip pmd-dist-7.0.0-bin.zip
          echo "$PWD/pmd-bin-7.0.0/bin" >> $GITHUB_PATH

      - name: Install Dependencies
        run: npm install

      - name: Run Quality Checks
        run: |
          sf fm quality \
            --base-sha origin/${{ github.base_ref }} \
            --head-sha ${{ github.sha }} \
            --json > quality-report.json

      - name: Upload Report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: quality-report
          path: quality-report.json
```

### GitLab CI

```yaml
quality-checks:
  stage: test
  image: node:18
  before_script:
    - npm install -g @salesforce/cli
    - sf plugins install @salesforce/plugin-fm
    - npm install
  script:
    - sf fm quality --base-sha $CI_MERGE_REQUEST_TARGET_BRANCH_SHA --head-sha $CI_COMMIT_SHA
  artifacts:
    when: always
    reports:
      junit: quality-report.json
  only:
    - merge_requests
```

### Azure DevOps

```yaml
- task: Bash@3
  displayName: 'Run Quality Checks'
  inputs:
    targetType: 'inline'
    script: |
      npm install -g @salesforce/cli
      sf plugins install @salesforce/plugin-fm
      npm install
      sf fm quality \
        --base-sha $(System.PullRequest.TargetBranch) \
        --head-sha $(Build.SourceVersion)
```

---

## Requirements

### System Requirements

- Node.js 18.x or higher
- Git repository
- npm or yarn

### Tool Requirements

| Tool    | Required For                  | Installation                                                               |
| ------- | ----------------------------- | -------------------------------------------------------------------------- |
| ESLint  | JavaScript/TypeScript linting | `npm install eslint` (usually in project)                                  |
| xmllint | XML validation                | `apt-get install libxml2-utils` (Linux)<br>`brew install libxml2` (macOS)  |
| PMD     | Static analysis               | [Install PMD](https://pmd.github.io/latest/pmd_userdocs_installation.html) |

---

## Troubleshooting

### Issue: "Not a Git repository"

**Solution:**

```bash
# Ensure you're in a Git repository
git init
git remote add origin <repo-url>
```

### Issue: "Invalid Git reference"

**Solution:**

```bash
# Fetch all branches
git fetch --all

# Verify references exist
git rev-parse origin/main
git rev-parse HEAD
```

### Issue: "xmllint: command not found"

**Solution:**

```bash
# Ubuntu/Debian
sudo apt-get install libxml2-utils

# macOS
brew install libxml2

# Or skip XML checks
sf fm quality --base-sha ... --head-sha ... --skip-xml-lint
```

### Issue: "PMD not found"

**Solution:**

```bash
# Install PMD
brew install pmd  # macOS

# Or download manually
wget https://github.com/pmd/pmd/releases/download/pmd_releases%2F7.0.0/pmd-dist-7.0.0-bin.zip
unzip pmd-dist-7.0.0-bin.zip
export PATH=$PATH:$PWD/pmd-bin-7.0.0/bin

# Or skip PMD checks
sf fm quality --base-sha ... --head-sha ... --skip-pmd
```

### Issue: "ESLint errors but code looks fine"

**Solution:**

```bash
# Run ESLint locally to see details
npx eslint <file>

# Auto-fix issues
npx eslint --fix <file>

# Check ESLint config
cat .eslintrc.js
```

---

## Best Practices

### 1. Run Locally Before Push

```bash
# Always run quality checks before pushing
sf fm quality --base-sha origin/main --head-sha HEAD
```

### 2. Use in Pre-commit Hooks

Add to `.husky/pre-push`:

```bash
#!/bin/sh
sf fm quality --base-sha origin/main --head-sha HEAD
```

### 3. Customize for Your Project

- Create custom PMD ruleset
- Configure ESLint rules
- Skip irrelevant checks
- Set appropriate failure thresholds

### 4. Monitor Metrics

Track:

- Pass rate over time
- Common error types
- Time to fix issues
- Coverage trends

---

## Advanced Usage

### Check Specific Commit Range

```bash
# Check last 5 commits
sf fm quality --base-sha HEAD~5 --head-sha HEAD

# Check between two commits
sf fm quality --base-sha abc123 --head-sha def456
```

### Combine with Other Commands

```bash
# Build and quality check
sf fm build --ref-a origin/main --ref-b HEAD --output-dir ./build
sf fm quality --base-sha origin/main --head-sha HEAD
```

### Custom Test Command

If you use a different test command, modify `runTests()` in the source or run tests separately:

```bash
# Run quality checks without tests
sf fm quality --base-sha origin/main --head-sha HEAD --skip-tests

# Run your custom tests
npm run custom-test-command
```

---

## API

### Command

```typescript
sf fm quality --base-sha <base> --head-sha <head>
```

### Return Type

```typescript
interface QualityResult {
  baseSha: string;
  headSha: string;
  filesChanged: number;
  checks: QualityCheckResult[];
  totalErrors: number;
  totalWarnings: number;
  passed: boolean;
}

interface QualityCheckResult {
  check: string;
  status: 'pass' | 'fail' | 'warning' | 'skipped';
  errors: number;
  warnings: number;
  details?: string[];
}
```

---

## Support

For issues or questions:

- Check logs for detailed error messages
- Review tool-specific documentation
- Create issue in repository
- Contact DevOps team

---

## Related Commands

- `sf fm build` - Build deployment artifacts from Git changes
- `sf fm deploy` - Deploy changed components
- `sf fm deploy status` - Check deployment status
