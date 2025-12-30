# summary

Check for duplicate metadata between parent repository and submodules.

# description

This command analyzes metadata files to detect duplicates between the parent repository and its submodules. It can check either changed files (based on git diff) or all files in the working tree.

The command detects three types of duplicates:

1. **Component-level duplicates**: Same metadata type and name (e.g., LWC with same name in parent and submodule)

2. **Context-aware duplicates**: Same metadata type, name, and context for child metadata (e.g., Account.MyField**c in both parent and submodule is duplicate, but Account.MyField**c and Contact.MyField\_\_c are not)

3. **Granular metadata duplicates**: Same element name in CustomLabels or SharingRules files across parent and submodules

The command exits with code 1 if duplicates are found, and code 0 if no duplicates exist.

# examples

- <%= config.bin %> <%= command.id %> --from main --to HEAD

- <%= config.bin %> <%= command.id %> --from main --to HEAD --all

- <%= config.bin %> <%= command.id %> -r HEAD~1 -R HEAD

# flags.from.summary

Starting git reference to compare from.

# flags.from.description

Specify the Git reference for the starting point of comparison. This can be a commit hash, branch name, or tag.

# flags.to.summary

Ending git reference to compare to.

# flags.to.description

Specify the Git reference for the ending point of comparison. This can be a commit hash, branch name, or tag. Defaults to 'HEAD' if not specified.

# flags.all.summary

Check all files in working tree instead of only changed files.

# flags.all.description

When set, the command will check all files in the working tree for duplicates, rather than only files that changed between the two git references. This is useful for comprehensive duplicate detection.

# info.checkingDuplicates

Checking for duplicates between '%s' and '%s'...

# info.checkedAllFiles

Checked %s parent files and %s submodule files.

# info.checkedChangedFiles

Checked %s changed parent files and %s changed submodule files.

# success.noDuplicates

✅ No duplicates found! All metadata is unique between parent and submodules.

# error.duplicatesFound

❌ Found %s duplicate(s) between parent and submodules. See details above.

# output.componentDuplicatesHeader

Component-level Duplicates:

# output.customLabelDuplicatesHeader

CustomLabel Duplicates:

# output.sharingRuleDuplicatesHeader

SharingRule Duplicates:
