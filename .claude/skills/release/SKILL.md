---
name: release
description: Release a new version of cc-outline - collect the merged PRs, write the release notes, bump the version in a release PR, merge it after CI and publish the GitHub release, which publishes to npm. With --dry-run, only propose the version and the notes.
argument-hint: "[patch|minor|major|x.y.z] [--dry-run]"
disable-model-invocation: true
allowed-tools:
  - Bash(git:*)
  - Bash(gh:*)
  - Bash(npm:*)
  - Bash(npx vitest:*)
  - Bash(node:*)
  - Read
  - Write
  - Edit
  - Grep
  - Glob
---

# Release cc-outline

Arguments: `$ARGUMENTS` — an optional bump (`patch`, `minor`, `major` or an explicit `x.y.z`) and an optional `--dry-run`.

## How releasing works here

Publishing a GitHub release `v<version>` starts `.github/workflows/publish.yml`. It checks that the tag matches `package.json` and publishes to npm through Trusted Publishing (OIDC, no token, with provenance). So the GitHub release *is* the npm release: once it is published, the version is on npm for good, because npm never accepts the same version twice and a published version cannot be replaced. That is why the steps before it check so much, and why you never run `npm publish` yourself — it would take the version away from the workflow, which then fails.

Everything up to step 3 only reads. From step 4 on, each step changes something others can see (a branch, a PR, `main`, the release, npm). Once the user has approved the version and the notes in step 3, go through to the end without asking again; the user started `/release` to have it done. Stop at the first step that fails and report what failed with its output — don't force, skip checks or work around them, since a half-done release is easier to finish by hand than a wrong one is to undo.

If a command is refused by the permission system (e.g. `gh pr merge` or `gh release create` in auto mode), stop, give the user the exact command to run themselves with `!` in front, and continue from there once they say it ran.

## 1. Check the starting point

- On `main`, `git pull` done, nothing uncommitted. Files that `.gitignore` covers (like `docs/posts/`) don't matter.
- The latest CI run on `main` passed and ran on the current `HEAD`: `gh run list --branch main --workflow ci.yml --limit 1 --json status,conclusion,headSha`. If it is still running, wait for it (`gh run watch <id> --exit-status`).
- The last release: `git describe --tags --abbrev=0` (tags are `v<version>`). If `main` has no commits since it, there is nothing to release; say so and stop.

## 2. Collect what changed

Every change reached `main` through a PR merged with a merge commit, so the merge commits since the last tag name the PRs:

```sh
git log <last tag>..main --merges --format='%h %s'
```

Take the lines `Merge pull request #<n> from …` and skip `Merge branch 'main' into …` (a PR branch catching up with main). For each PR: `gh pr view <n> --json number,title,body`. Look at the diff (`gh pr diff <n>`) only where title and body leave unclear what a user would notice.

Sort them:
- **For users**: new features, changed behaviour, fixes, a new minimum Node version, changed requirements. These make up the notes.
- **For the project**: CI, issue forms, release tooling. A short last section, or leave them out if there are none worth mentioning.
- **Nothing to say**: release PRs of earlier versions (`Release x.y.z`), pure refactoring, tests, typos.

## 3. Propose the version and the notes

**Version.** The bump from the arguments, applied to the version in `package.json`. Without one, propose `minor` if users get something new or behaviour changes, `patch` if there are only fixes. If there are only project changes, users get nothing from a new npm version; say so and ask whether to release anyway. The major version stays 0 until the user decides otherwise.

Check that the version is free: `git tag -l v<version>` is empty, no branch `release/<version>` exists (`git ls-remote --heads origin release/<version>`), and `npm view cc-outline@<version> version` fails with 404. A taken version usually means an earlier release was half done; report what exists instead of picking another number.

**Notes**, in English, in the style of the earlier releases (`gh release view <last tag>` shows the last one):
- Sections by area — `### Chat`, `### Sessions`, `### Settings`, … — or `## Fixes` for a patch release, and `## Project` last.
- Each point says what the user notices and, where it helps, how to use it (keys, settings), not how it was built. One to three sentences, no emojis, no marketing words. Refer to the PR as `(#12)`.
- Last line: `**Full changelog:** https://github.com/hopp1395/cc-outline/compare/<last tag>...v<version>`

Write the notes to a file in the scratchpad directory, then show the user the version, the PRs it covers and the notes, and wait for their OK or corrections.

**With `--dry-run`, stop here** and say that nothing was changed.

## 4. Release PR

```sh
git checkout -b release/<version>
npm version <version> --no-git-tag-version
```

npm bumps `package.json` and `package-lock.json`; its `version` hook (`scripts/sync-version.mjs`) updates `plugin/.claude-plugin/plugin.json` and `src/version.ts`. `git diff --stat` should list exactly these four files. Then `npm run typecheck`, `npm test` (`test/version.test.ts` checks that all four agree) and `npm run build`.

If the notes describe visible changes to a view that `docs/*.svg` or `docs/demo.gif` show, ask whether to re-record them with `npm run demo` (it needs Chrome) before committing. Don't re-record unasked: it changes every image and makes the PR large.

Commit as `Release <version>` with one line per point of the notes in the body, push, and open the PR `Release <version>` with the notes as its summary and a test plan (the checks above, CI, and "after merge: GitHub release v<version> publishes to npm"). End the commit message and the PR body with the attribution lines this session prescribes.

## 5. Merge

Wait for CI: `gh pr checks <n> --watch`. Right after pushing it may report that no checks exist yet; wait a few seconds and run it again. When every check passed:

```sh
gh pr merge <n> --merge --delete-branch
git checkout main && git pull && git branch -d release/<version>
```

Merge with `--merge` like every PR here, so step 2 of the next release finds this one by its merge commit.

## 6. Publish

```sh
gh release create v<version> --target main --title "v<version>" --notes-file <notes file>
```

Then follow the publish run. It takes a few seconds to appear: `gh run list --workflow publish.yml --limit 1 --json databaseId,headBranch,status`, and check it is the run for `v<version>` (`headBranch`). Follow it with `gh run watch <id> --exit-status`. When it passed, `npm view cc-outline version` shows the new version; npm can take a minute to list it.

If the run fails, report the failing step with `gh run view <id> --log-failed`. The tag and the release stay as they are: deleting them would hide what happened and does not bring the version back if npm already took it. If nothing reached npm and the cause is fixed without changing the tagged commit (e.g. the trusted publisher setting on npmjs.com), `gh run rerun <id>` publishes it; otherwise the fix needs a new patch release.

## 7. Report

Short, in the user's language: the version, links to the PR, the GitHub release, the publish run and https://www.npmjs.com/package/cc-outline, and what users run to update:

```sh
npm install -g cc-outline
claude plugin marketplace update cc-outline && claude plugin update cco@cc-outline
```

Remind the user that a running viewer keeps its old code until it is closed with `q` and reopened, and that plugin changes need a Claude Code restart.
