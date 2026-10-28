# Releasing and repository rules

## Workflows

| Workflow                                                | When                                  | What                                                                                                                                         |
| ------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `CI` (`.github/workflows/ci.yml`)                       | every pull request and push to `main` | install, compile + lint, unit tests, command snapshot, JSON schemas; the Studio tests; on `main`, the rolling `extension-latest` pre-release |
| `Release draft` (`.github/workflows/release-draft.yml`) | every merge into `main`               | keeps **one draft release** up to date: the next version and its notes                                                                       |
| `Release` (`.github/workflows/release.yml`)             | when you **publish** that draft       | three steps, **each waiting for approval**: build and test, the release files, the Docker image                                              |

Local hooks (husky) run lint on commit and the full build + tests on push. They need `yarn` (v1) on the PATH.

## Making a release

1. **Merge pull requests into `main`.** After each merge, _Release draft_ updates the draft release. The first release is **v1.0.0**; after that the version comes from the commit titles since the last published release — `feat:` → minor, a `!` (e.g. `feat!:`) or `BREAKING CHANGE` → major, anything else → patch — and the notes list the merged pull requests. To choose the version yourself: Actions → _Release draft_ → Run workflow → patch / minor / major.
2. **Publish the draft**: Releases → the draft → Edit → **Publish release**. This creates the tag `vX.Y.Z` on the commit the draft points to.
3. **Approve each step** of the _Release_ run (Actions → the run → **Review deployments** → `release` → Approve):

   1. **Build and test** the tag (plugin and Studio).
   2. **Release files**: the plugin tarball, the browser extension zip and the VS Code `.vsix`, attached to the release.
   3. **Docker image** `ghcr.io/<owner>/nomadsf:X.Y.Z` and `latest` (Salesforce CLI, plugin-fm, Code Analyzer, Java).

   As a repository admin you can also choose **bypass** instead of approving. If the tests or the files fail, the release goes back to a draft.

**What's new on the website**: each pull request with a visible change adds a few words under `next` in `docs/assets/whats-new.js`. The download section shows them for the newest release that has no entry of its own, so publishing needs no edit; in the next pull request after a release, rename `next` to that version.

**One version for everything**: the tag sets the same version on the `sf fm` plugin, the browser extension (its manifest) and the VS Code extension (`scripts/set-version.mjs`), so a release `v1.1.0` ships plugin 1.1.0, extension 1.1.0 and VS Code 1.1.0. The download names stay the same (`nomadsf-extension.zip`, `nomadsf-vscode.vsix`), so "latest" links never change.

Nothing is pushed to `main` by a release: the version is set from the tag while building. To bring `main` in line after a release (optional, in a pull request): `node scripts/set-version.mjs 1.1.0`. The website and the README show the latest version from GitHub, so they need no edit per release.

The approvals come from the `release` environment (Settings → Environments → `release`): required reviewer `@faridmasjedi`, self-review allowed, admins may bypass, only `v*` tags may use it.

## Only reviewed, green changes reach `main`

`.github/rulesets/protect-main.json` protects the default branch:

- no deletion and no force-push;
- changes only through a pull request, with a code-owner review (`CODEOWNERS`: `@faridmasjedi`), resolved conversations, and green `CI / test` and `CI / studio` on an up-to-date branch;
- repository admins (you) may bypass **only through a pull request** — you can merge your own pull requests without a second reviewer, but nobody pushes to `main` directly (releases do not push to `main` either).

Rulesets need a public repository (or GitHub Pro / Team for a private one). Apply or update it with:

```bash
gh api -X POST repos/faridmasjedi/plugin-fm/rulesets --input .github/rulesets/protect-main.json
# later changes: gh api -X PUT repos/faridmasjedi/plugin-fm/rulesets/<id> --input .github/rulesets/protect-main.json
```

## Using the image in other repositories

```yaml
container:
  image: ghcr.io/faridmasjedi/nomadsf:latest
  credentials: { username: '${{ github.actor }}', password: '${{ secrets.GHCR_TOKEN }}' } # token with read:packages
```

See `examples/github-release-train.yml` and `examples/github-dashboard-pages.yml`.
