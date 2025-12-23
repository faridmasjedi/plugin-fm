# Deploy Cache Extension Feature

## Problem

When you start an async deployment with `sf project deploy start --async`, Salesforce CLI caches the job ID in `.sf/deploy-cache.json` with a **default 33-minute timeout**.

After 33 minutes:

- ❌ The cache entry expires
- ❌ You can't use `--use-most-recent` flag
- ❌ You must manually specify `--job-id` every time
- ❌ Long-running deployments become difficult to monitor

## Solution

Our `sf fm deploy status` command **automatically extends the cache timeout** before checking deployment status!

### How It Works

```bash
# Step 1: Start async deployment
sf fm deploy \
  --manifest ./manifest \
  --target-org production \
  --async

# Returns job ID: 0Af5e000004zXXX
```

```bash
# Step 2: Check status (extends cache timeout automatically!)
sf fm deploy status \
  --job-id 0Af5e000004zXXX \
  --target-org production \
  --timeout 120

# ✅ Cache timeout extended to 120 minutes
# ✅ Job stays in cache longer
# ✅ You can check status many times over hours
```

### What Happens Behind the Scenes

1. **Before** checking deployment status
2. **Reads** `.sf/deploy-cache.json`
3. **Finds** the job entry for your job ID
4. **Updates** `expirationDate` to current time + timeout minutes
5. **Saves** the updated cache back to disk
6. **Then** checks deployment status using `sf project deploy report`

### Benefits

✅ **No manual --job-id needed after first check** - Cache stays alive
✅ **Long-running deployments supported** - Check status over hours
✅ **CI/CD friendly** - Poll status without cache expiring
✅ **Automatic** - Happens transparently every time you check status
✅ **Safe** - If cache update fails, status check still works

## Usage Examples

### Example 1: Long-Running Deployment

```bash
# Start deployment (2 hours expected)
JOB_ID=$(sf fm deploy \
  --manifest ./manifest \
  --target-org production \
  --test-level RunLocalTests \
  --async \
  --json | jq -r '.result.jobId')

# Check status every 10 minutes for up to 3 hours
sf fm deploy status \
  --job-id $JOB_ID \
  --target-org production \
  --watch \
  --interval 10 \
  --timeout 180

# ✅ Cache extended to 180 minutes
# ✅ Can check status for 3 hours without expiring
```

### Example 2: GitHub Actions

```yaml
- name: Start Deployment
  id: deploy
  run: |
    JOB_ID=$(sf fm deploy \
      --manifest ./manifest \
      --target-org production \
      --async \
      --json | jq -r '.result.jobId')
    echo "job_id=$JOB_ID" >> $GITHUB_OUTPUT

- name: Monitor Deployment
  run: |
    sf fm deploy status \
      --job-id ${{ steps.deploy.outputs.job_id }} \
      --target-org production \
      --watch \
      --interval 15 \
      --timeout 120
```

### Example 3: Manual Monitoring

```bash
# Start deployment
sf fm deploy --manifest ./manifest --target-org prod --async
# Job ID: 0Af5e000004zXXX

# Check immediately
sf fm deploy status -i 0Af5e000004zXXX -o prod --timeout 120

# 45 minutes later, check again (still works!)
sf fm deploy status -i 0Af5e000004zXXX -o prod --timeout 120

# 90 minutes later, check again (still works!)
sf fm deploy status -i 0Af5e000004zXXX -o prod --timeout 120

# ✅ Cache gets extended each time
# ✅ No "job not found" errors
```

## Technical Details

### Cache File Location

```
~/.sf/deploy-cache.json
```

### Cache Entry Structure

```json
{
  "0Af5e000004zXXX": {
    "jobId": "0Af5e000004zXXX",
    "username": "user@example.com",
    "expirationDate": 1735123456789, // ← Extended by our command
    "completedDate": 1735123400000,
    "status": "InProgress"
  }
}
```

### Extension Logic

```typescript
// Before checking status
const newExpirationTime = Date.now() + timeoutMinutes * 60 * 1000;
jobEntry.expirationDate = newExpirationTime;
```

### Error Handling

If cache update fails (permissions, file locked, etc.):

- ⚠️ Warning logged to console
- ✅ Status check continues normally
- ✅ No disruption to deployment monitoring

## Comparison with Native SF CLI

### Without Our Extension (Native SF CLI)

```bash
# Start async deployment
sf project deploy start --source-dir src --target-org prod --async
# Job ID: 0Af5e000004zXXX

# Check status (works fine)
sf project deploy report --job-id 0Af5e000004zXXX --target-org prod

# 35 minutes later...
sf project deploy report --job-id 0Af5e000004zXXX --target-org prod
# ❌ Error: Cannot find job in cache (expired after 33 min)
# Must specify --job-id manually forever
```

### With Our Extension (sf fm deploy status)

```bash
# Start async deployment
sf fm deploy --manifest ./manifest --target-org prod --async
# Job ID: 0Af5e000004zXXX

# Check status (extends cache)
sf fm deploy status -i 0Af5e000004zXXX -o prod --timeout 120

# 35 minutes later...
sf fm deploy status -i 0Af5e000004zXXX -o prod --timeout 120
# ✅ Works! Cache was extended to 120 minutes

# 90 minutes later...
sf fm deploy status -i 0Af5e000004zXXX -o prod --timeout 120
# ✅ Still works! Cache extended again
```

## Configuration

### Default Timeout

```bash
# Default: 60 minutes
sf fm deploy status --job-id 0Af... --target-org prod
```

### Custom Timeout

```bash
# Extend cache to 3 hours (180 minutes)
sf fm deploy status \
  --job-id 0Af... \
  --target-org prod \
  --timeout 180
```

### Watch Mode

```bash
# Watch mode uses timeout value for cache extension
sf fm deploy status \
  --job-id 0Af... \
  --target-org prod \
  --watch \
  --interval 15 \
  --timeout 120

# Every 15 seconds:
# 1. Extend cache to 120 minutes
# 2. Check deployment status
# 3. Display progress
```

## Best Practices

### For Production Deployments

Use generous timeout values:

```bash
sf fm deploy status \
  --job-id $JOB_ID \
  --target-org production \
  --timeout 240  # 4 hours
```

### For CI/CD Pipelines

Use timeout matching your max deployment time:

```bash
sf fm deploy status \
  --job-id $JOB_ID \
  --target-org prod \
  --watch \
  --interval 15 \
  --timeout 120  # 2 hours max
```

### For Development

Shorter timeouts are fine:

```bash
sf fm deploy status \
  --job-id $JOB_ID \
  --target-org sandbox \
  --timeout 30  # 30 minutes
```

## Troubleshooting

### Warning: "Could not extend deploy cache timeout"

**Cause**: Permission issue or file locked

**Solution**:

- Check `.sf/deploy-cache.json` permissions
- Ensure no other process is modifying the file
- Status check will still work, just won't extend cache

### Cache Still Expires

**Cause**: Timeout too short for long-running deployments

**Solution**: Use larger `--timeout` value

```bash
# Instead of:
--timeout 60

# Use:
--timeout 180  # 3 hours
```

### Job Not Found in Cache

**Cause**: Deployment started without our plugin, or cache manually deleted

**Solution**: Job ID still works, just specify it explicitly

```bash
sf fm deploy status --job-id 0Af... --target-org prod
```

## Summary

The cache extension feature makes async deployments **much more manageable** by:

1. ✅ Automatically extending cache timeouts
2. ✅ Supporting long-running deployments (hours, not minutes)
3. ✅ Perfect for CI/CD pipelines
4. ✅ No manual job ID management after first check
5. ✅ Safe and non-disruptive

**No configuration needed - it just works!** 🎉
