# Quality Command Implementation Summary

## Overview

Created a new SF CLI plugin command `sf fm quality` that runs comprehensive quality checks on changed files between two Git commits. This is perfect for CI/CD pipelines where clients want to validate code quality on their changed files only.

---

## What Was Created

### 1. Command Implementation

**File:** `src/commands/fm/quality.ts`

A comprehensive quality checking command that:

- Takes base SHA and head SHA as input
- Finds changed files using Git diff
- Runs appropriate quality checks based on file types
- Returns detailed results with errors and warnings
- Supports JSON output for CI/CD integration

---

### 2. Quality Checks

The command runs 4 different quality checks:

#### a) **ESLint** (JavaScript/TypeScript)

- Checks code style and best practices
- Runs on `.js`, `.ts`, `.jsx`, `.tsx` files
- Uses project's existing ESLint configuration
- Reports errors and warnings separately

#### b) **XML Validation**

- Validates XML syntax and well-formedness
- Uses `xmllint` tool
- Checks all `.xml` files
- Validates Salesforce metadata structure

#### c) **PMD Static Analysis**

- Analyzes code for smells and anti-patterns
- Uses custom ruleset if provided
- Auto-detects ruleset in standard locations:
  - `.pmd/ruleset.xml`
  - `pmd-ruleset.xml`
  - `--pmd-ruleset` flag
- Skips if PMD not installed or no ruleset found

#### d) **Tests** (Jest/Mocha)

- Runs unit tests for changed test files
- Uses `npm run test:only`
- Reports test failures
- Parses test output for results

---

### 3. Message Catalog

**File:** `messages/quality.md`

Complete message catalog with:

- Command summary and description
- Examples for common use cases
- Flag descriptions
- Info messages
- Error messages
- All localization-ready

---

### 4. JSON Schema

**File:** `schemas/quality.json`

Schema definition for JSON output with:

- `QualityResult` type definition
- `QualityCheckResult` type definition
- Complete field descriptions
- Required fields specified
- Type validation

---

### 5. Documentation

**File:** `QUALITY_COMMAND.md`

Comprehensive documentation including:

- Command overview and usage
- All flags with examples
- PMD ruleset configuration
- CI/CD integration examples (GitHub Actions, GitLab, Azure)
- Output format (human-readable and JSON)
- Troubleshooting guide
- Best practices
- API reference

---

## Command Signature

```bash
sf fm quality --base-sha <base> --head-sha <head> [options]
```

### Required Flags

| Flag         | Short | Description                                  |
| ------------ | ----- | -------------------------------------------- |
| `--base-sha` | `-b`  | Base commit SHA or ref (e.g., `origin/main`) |
| `--head-sha` | `-h`  | Head commit SHA or ref (e.g., `HEAD`)        |

### Optional Flags

| Flag                 | Description                | Default     |
| -------------------- | -------------------------- | ----------- |
| `--pmd-ruleset`      | Path to custom PMD ruleset | Auto-detect |
| `--skip-eslint`      | Skip ESLint checks         | `false`     |
| `--skip-xml-lint`    | Skip XML validation        | `false`     |
| `--skip-pmd`         | Skip PMD analysis          | `false`     |
| `--skip-tests`       | Skip test execution        | `false`     |
| `--fail-on-warnings` | Fail on warnings           | `false`     |
| `--json`             | Output as JSON             | `false`     |

---

## Usage Examples

### Basic Usage

```bash
# Check changes in current PR
sf fm quality --base-sha origin/main --head-sha HEAD
```

### CI/CD Pipeline

```bash
# GitHub Actions
sf fm quality \
  --base-sha origin/${{ github.base_ref }} \
  --head-sha ${{ github.sha }}

# GitLab CI
sf fm quality \
  --base-sha $CI_MERGE_REQUEST_TARGET_BRANCH_SHA \
  --head-sha $CI_COMMIT_SHA
```

### Custom Configuration

```bash
# With custom PMD ruleset, skip tests
sf fm quality \
  --base-sha origin/main \
  --head-sha HEAD \
  --pmd-ruleset ./custom-rules.xml \
  --skip-tests
```

### JSON Output

```bash
# For parsing in CI/CD
sf fm quality \
  --base-sha origin/main \
  --head-sha HEAD \
  --json > quality-report.json
```

---

## Output Format

### Human-Readable

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

============================================================
Total Errors: 3
Total Warnings: 0
============================================================

❌ Quality checks failed with 3 error(s)
```

### JSON Format

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
        "check": "PMD",
        "status": "fail",
        "errors": 3,
        "warnings": 0,
        "details": [...]
      }
    ],
    "totalErrors": 3,
    "totalWarnings": 0,
    "passed": false
  }
}
```

---

## Key Features

### ✅ Flexible

- Skip any check with flags
- Custom PMD ruleset support
- Works with any Git reference
- JSON output for automation

### ✅ Smart

- Only checks changed files
- Auto-detects file types
- Skips checks if tools not available
- Graceful degradation

### ✅ CI/CD Ready

- Exit codes for pipeline integration
- JSON output for parsing
- Detailed error messages
- Artifact-friendly reports

### ✅ Client-Controlled

- Clients provide their own rulesets
- Runs in their CI/CD environment
- Uses their ESLint configuration
- No opinionated defaults

---

## Benefits for Clients

### 1. **Run on Changed Files Only**

Instead of linting entire codebase, only check what changed:

```bash
# Only checks files changed between commits
sf fm quality --base-sha origin/main --head-sha HEAD
```

### 2. **Use Their Own Rules**

Clients control quality standards:

- Provide custom PMD ruleset
- Use existing ESLint config
- Skip checks they don't need

### 3. **Integrate with Any CI/CD**

Works everywhere:

- GitHub Actions
- GitLab CI
- Jenkins
- Azure DevOps
- Bitbucket Pipelines
- CircleCI
- Travis CI

### 4. **Fast Feedback**

Quick results because:

- Only checks changed files
- Parallel execution where possible
- Skips unavailable tools
- Clear error messages

---

## Integration Example

### GitHub Actions Workflow

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

      - name: Install Dependencies
        run: npm install

      - name: Run Quality Checks
        run: |
          sf fm quality \
            --base-sha origin/${{ github.base_ref }} \
            --head-sha ${{ github.sha }}
```

---

## PMD Ruleset Configuration

Clients can provide their own PMD ruleset:

```xml
<?xml version="1.0"?>
<ruleset name="Custom Rules"
    xmlns="http://pmd.sourceforge.net/ruleset/2.0.0">

    <description>Custom PMD rules</description>

    <!-- JavaScript rules -->
    <rule ref="category/ecmascript/bestpractices.xml"/>
    <rule ref="category/ecmascript/codestyle.xml"/>

    <!-- XML rules -->
    <rule ref="category/xml/errorprone.xml"/>

    <!-- Exclude test files -->
    <exclude-pattern>.*/test/.*</exclude-pattern>
</ruleset>
```

Place in:

- `.pmd/ruleset.xml` (recommended)
- `pmd-ruleset.xml` (alternative)
- Or specify with `--pmd-ruleset ./path/to/rules.xml`

---

## Requirements

### Command Requirements

- Node.js 18.x or higher
- Git repository
- SF CLI installed

### Tool Requirements (Optional)

| Tool     | For             | Required?                      |
| -------- | --------------- | ------------------------------ |
| ESLint   | JS/TS linting   | No - skipped if not in project |
| xmllint  | XML validation  | No - skipped if not installed  |
| PMD      | Static analysis | No - skipped if not installed  |
| npm/jest | Tests           | No - skipped if not available  |

All tools are **optional** - checks are automatically skipped if tools aren't available!

---

## Exit Codes

| Code | Meaning                   |
| ---- | ------------------------- |
| `0`  | All checks passed         |
| `1`  | One or more checks failed |

---

## Files Created

```
src/
└── commands/
    └── fm/
        └── quality.ts              # Command implementation

messages/
└── quality.md                      # Message catalog

schemas/
└── quality.json                    # JSON schema (auto-generated)

QUALITY_COMMAND.md                  # Comprehensive documentation
QUALITY_COMMAND_SUMMARY.md         # This file
```

---

## Testing the Command

### Test 1: Basic Usage

```bash
# Create test branch
git checkout -b test/quality-command

# Make some changes
echo "// test" >> src/index.ts

# Commit
git add .
git commit -m "test: quality command"

# Run quality checks
sf fm quality --base-sha main --head-sha HEAD
```

### Test 2: JSON Output

```bash
sf fm quality \
  --base-sha main \
  --head-sha HEAD \
  --json > report.json

cat report.json
```

### Test 3: Skip Checks

```bash
# Skip PMD and tests
sf fm quality \
  --base-sha main \
  --head-sha HEAD \
  --skip-pmd \
  --skip-tests
```

---

## Next Steps

### For This PR

1. ✅ Command implementation complete
2. ✅ Documentation created
3. ✅ Schema generated
4. ✅ Examples provided

### For Clients

1. Install plugin: `sf plugins install @salesforce/plugin-fm`
2. Create PMD ruleset (optional): `.pmd/ruleset.xml`
3. Add to CI/CD pipeline
4. Configure which checks to run

---

## Comparison with Previous Approach

### ❌ Previous: GitHub Actions Workflows

- Tied to GitHub
- Not reusable across platforms
- Hard-coded in repository
- Not client-configurable

### ✅ New: SF CLI Command

- Works everywhere (GitHub, GitLab, Jenkins, etc.)
- Fully client-controlled
- Reusable across projects
- Configurable via flags
- Can be run locally

---

## Summary

Created `sf fm quality` command that:

✅ **Runs quality checks** on changed files between two commits
✅ **Supports 4 check types**: ESLint, XML Lint, PMD, Tests
✅ **Client-controlled**: Provide own rulesets and configuration
✅ **CI/CD ready**: JSON output, exit codes, detailed reports
✅ **Flexible**: Skip any check, custom rulesets, works anywhere
✅ **Smart**: Auto-detects tools, graceful degradation
✅ **Fast**: Only checks changed files
✅ **Complete**: Full documentation and examples

**Status: Implementation Complete ✅**

Ready for clients to use in their CI/CD pipelines!
