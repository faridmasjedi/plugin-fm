We want a code code to find a new diff on a PR for salesforce changes:

- As an input it will check which logic they are using for for finding git diff

  - Do they use tagging on each branch
  - Or they use just commit diff

- For both ways, we will use a logic to find the commits.

  - On pull requests: It will find the diff between HEAD of PR ( which is the latest commit on PR and the last tag/commit on baseRef)
  - If we are using the last commit sha on baseRef, somehow it should find the latest successful salesforce deployment on that base ref, and use that as the latest commit. We might can use tagging logic here, as when a deployment finished successfully, it can create a tag for that baseRef

  - On push, it will use the latest successful deployment ( or lastest tag) and will compare it with latest commit sha on the baseRef.

- The code should check if we have submodules, or not. For finding submodule change, it should find the version of it on PR or push, and compare it to the previous version and should find the git diff on those submodules.

- In finiding diff, we do have different types:
  - A/M : These are new changes
  - D : These are new removed files
  - R: These changes will have two paths: old and new.
    - The old should be removed, and new one should be added to the new changes.
    - If the old and new one has same name, that is just a rebase of a file, and it is considered as same metadata in salesforce. Then we cannot accept it to be removed and it should be added to changed files.

Now check all the commands that we have already on this repo.

If anyone needs to be updated, just update them.
