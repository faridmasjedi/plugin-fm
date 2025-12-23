# SF CLI Commands Reference

This document outlines the correct Salesforce CLI commands and flags used in the deployment service.

## ✅ Commands Used

### 1. Deployment & Validation: `sf project deploy start`

**Purpose**: Deploy metadata to an org, or validate with `--dry-run` flag.

**Why we use `--dry-run` instead of `sf project deploy validate`:**

- ✅ Returns job ID for quick deploy (same as validate)
- ✅ More flexible: supports `NoTestRun` option (validate doesn't)
- ✅ Simpler: one command for both deployment and validation
- ✅ Same flags and options for consistency

**Command Structure**:

```bash
# For validation (returns job ID for quick deploy):
sf project deploy start \
  --source-dir <path> \
  --target-org <org> \
  --dry-run \
  --test-level <level> \
  --tests <test1> <test2> \
  --ignore-warnings \
  --pre-destructive-changes <file> \
  --post-destructive-changes <file> \
  --wait <minutes> \
  --async \
  --json

# For actual deployment:
sf project deploy start \
  --source-dir <path> \
  --target-org <org> \
  --test-level <level> \
  --tests <test1> <test2> \
  --ignore-warnings \
  --pre-destructive-changes <file> \
  --post-destructive-changes <file> \
  --purge-on-delete \
  --wait <minutes> \
  --async \
  --json
```

**Key Flags**:

- `--dry-run`: **Validate without saving** - returns job ID for quick deploy
- `--source-dir` (`-d`): Path to local source files
- `--target-org` (`-o`): Target org username/alias
- `--test-level` (`-l`): Test execution level
  - `NoTestRun` - No tests run
  - `RunSpecifiedTests` - Run specific tests (requires --tests)
  - `RunLocalTests` - Run all tests in org except @isTest(SeeAllData=true)
  - `RunAllTestsInOrg` - Run all tests including @isTest(SeeAllData=true)
  - `RunRelevantTests` - **NEW in Spring '26** - Run only relevant tests based on code changes
- `--tests` (`-t`): Specific test classes (required when using RunSpecifiedTests)
- `--ignore-warnings` (`-g`): Ignore warnings
- `--ignore-conflicts` (`-c`): Ignore conflicts and deploy local files
- `--ignore-errors` (`-r`): Ignore errors and don't roll back
- `--pre-destructive-changes`: File path for destructiveChangesPre.xml
- `--post-destructive-changes`: File path for destructiveChanges.xml
- `--purge-on-delete`: Permanently delete (skip Recycle Bin)
- `--wait` (`-w`): Minutes to wait
- `--async`: Run asynchronously

**Returns**:

- With `--dry-run`: Job ID for quick deploy (valid 10 days)
- Without `--dry-run`: Deployment result with status, components deployed, test results

---

### 2. Quick Deploy: `sf project deploy quick`

**Purpose**: Quickly deploy a validated deployment (skips re-running tests).

**Command Structure**:

```bash
sf project deploy quick \
  --job-id <id> \
  --target-org <org> \
  --wait <minutes> \
  --async \
  --json
```

**Key Flags**:

- `--job-id` (`-i`): Job ID from previous validation (valid for 10 days)
- `--target-org` (`-o`): Target org username/alias
- `--use-most-recent` (`-r`): Use most recent validation job ID
- `--wait` (`-w`): Minutes to wait (default: 33)
- `--async`: Run asynchronously

**Note**: Intended for production orgs, not sandboxes

---

### 3. Status Check: `sf project deploy report`

**Purpose**: Check or poll for deployment/validation status.

**Command Structure**:

```bash
sf project deploy report \
  --job-id <id> \
  --target-org <org> \
  --wait <minutes> \
  --json
```

**Key Flags**:

- `--job-id` (`-i`): Job ID to check status for
- `--target-org` (`-o`): Target org username/alias
- `--use-most-recent` (`-r`): Use most recent deploy operation
- `--wait` (`-w`): Minutes to poll for status
- `--coverage-formatters`: Format for code coverage results
- `--junit`: Output JUnit test results
- `--results-dir`: Output directory for results

**Returns**: Current deployment status, progress, test results

---

## 🔄 Workflow Examples

### Validation → Quick Deploy Workflow (RECOMMENDED for Production)

```bash
# Step 1: Validate with dry-run (returns job ID)
JOB_ID=$(sf project deploy start \
  --source-dir ./ChangedFiles \
  --target-org production \
  --dry-run \
  --test-level RunLocalTests \
  --json | jq -r '.result.id')

# Step 2: Check validation status
sf project deploy report \
  --job-id $JOB_ID \
  --target-org production

# Step 3: Quick deploy (no tests, faster!)
sf project deploy quick \
  --job-id $JOB_ID \
  --target-org production
```

### Direct Deployment Workflow

```bash
# Deploy with tests
sf project deploy start \
  --source-dir ./ChangedFiles \
  --target-org sandbox \
  --test-level RunLocalTests \
  --json
```

### Async Deployment with Status Monitoring

```bash
# Start async validation
JOB_ID=$(sf project deploy start \
  --source-dir ./ChangedFiles \
  --target-org production \
  --dry-run \
  --test-level RunLocalTests \
  --async \
  --json | jq -r '.result.id')

# Monitor progress
sf project deploy report \
  --job-id $JOB_ID \
  --target-org production \
  --wait 60
```

---

## 🚫 Flags That Don't Exist

The following flags **DO NOT EXIST** in SF CLI:

- ❌ `--check-only` → Use `--dry-run` instead
- ❌ `--validation-only` → Use `--dry-run` instead

---

## ✅ Why We Use `--dry-run` Instead of `sf project deploy validate`

Our implementation uses `sf project deploy start --dry-run` for validation because:

1. **Same functionality**: Returns job ID for quick deploy (just like validate)
2. **More flexible**: Supports `NoTestRun` option (validate requires tests)
3. **Simpler**: One command (`deploy start`) handles both validation and deployment
4. **Consistent**: Same flags and options for both modes
5. **User preference**: Based on real-world usage and CI/CD pipeline requirements

---

## 📚 Implementation in DeploymentService

Our implementation correctly uses:

1. **Validation Mode**: `sf project deploy start --dry-run` (returns job ID)
2. **Deployment Mode**: `sf project deploy start` (deploys immediately)
3. **Quick Mode**: `sf project deploy quick` (uses validation job ID)
4. **Status Check**: `sf project deploy report` (monitors progress)

All commands use:

- ✅ `--dry-run` for validation (not `--check-only`)
- ✅ `--ignore-warnings` (correct flag name)
- ✅ `--pre-destructive-changes` and `--post-destructive-changes`
- ✅ `--async` or `--wait` for async/sync handling
- ✅ `--json` for parseable output

---

---

## 🆕 RunRelevantTests - Spring '26 Feature

### What is RunRelevantTests?

`RunRelevantTests` is a **new test level coming in Spring '26** (expected February 2026) that was announced at Dreamforce 2025. This feature significantly improves deployment performance by running only relevant Apex tests.

### How It Works

Salesforce uses dependency graphs and inference mechanisms to determine which tests are relevant to your changes:

1. **Tests in deployment payload** - Any test classes being deployed
2. **Inferred tests** - Tests that Salesforce determines are related based on dependencies
3. **@IsTest(testFor='ClassName')** - Tests explicitly marked for specific classes
4. **Critical tests** - Tests marked as critical that always run

### Benefits

- **Faster Deployments**: In large orgs with thousands of tests, this can reduce test time by orders of magnitude
- **Automatic Detection**: No need to manually specify tests or analyze dependencies
- **Smarter than RunSpecifiedTests**: Salesforce automatically finds relevant tests
- **Developer Control**: Use `@IsTest` annotations to explicitly define relationships

### Example Usage

```bash
# Deploy with RunRelevantTests (Spring '26+)
sf project deploy start \
  --source-dir ./ChangedFiles \
  --target-org production \
  --test-level RunRelevantTests \
  --json
```

### Comparison with Our Intelligent Tests

Our `--intelligent-tests` flag provides similar functionality today:

- **Intelligent Tests (Now)**: Parses Apex code to find related tests
- **RunRelevantTests (Spring '26+)**: Salesforce's native implementation with platform-level insights

Once Spring '26 is released, you can choose:

- Use `--test-level RunRelevantTests` for native Salesforce intelligence
- Use `--intelligent-tests` for our custom implementation (works on all API versions)

### Availability

- **Beta/Pilot**: Check Salesforce release notes for pilot program details
- **General Availability**: Spring '26 (expected February 2026)
- **Requires**: SF CLI update and API version 66.0+

### References

- [Dreamforce 2025 Developer Announcements](https://www.salesforceben.com/developer-features-and-announcements-from-dreamforce-25/)
- [Salesforce Spring '26 Release Notes](https://www.salesforceben.com/salesforce-spring-26-release-what-to-expect-and-how-to-prepare/)

---

## 🔗 Official Documentation

- [sf project deploy start](https://developer.salesforce.com/docs/atlas.en-us.sfdx_cli_reference.meta/sfdx_cli_reference/cli_reference_project_commands_unified.htm#cli_reference_project_deploy_start_unified)
- [sf project deploy validate](https://developer.salesforce.com/docs/atlas.en-us.sfdx_cli_reference.meta/sfdx_cli_reference/cli_reference_project_commands_unified.htm#cli_reference_project_deploy_validate_unified)
- [sf project deploy quick](https://developer.salesforce.com/docs/atlas.en-us.sfdx_cli_reference.meta/sfdx_cli_reference/cli_reference_project_commands_unified.htm#cli_reference_project_deploy_quick_unified)
- [sf project deploy report](https://developer.salesforce.com/docs/atlas.en-us.sfdx_cli_reference.meta/sfdx_cli_reference/cli_reference_project_commands_unified.htm#cli_reference_project_deploy_report_unified)
