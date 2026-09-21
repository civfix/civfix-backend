# Contributing to civfix

civfix is a civic-tech platform that runs in production for real residents
and holds government contracts. The bar for every change is production
quality: correct, secure, fast, reviewed.

## License and contributor agreement

This repository is licensed under the GNU Affero General Public License,
version 3 only (`LICENSE`). civfix is a project of Reach Out Los Angeles Inc.. By
contributing you agree to the civfix Individual Contributor License Agreement
in `CLA.md`, which lets Reach Out Los Angeles Inc. distribute your work under the
AGPL, under the additional permissions the project carries, and under
commercial terms when a government customer requires them. Until the automated
agreement check is in place, state your acceptance in your first pull request
as `CLA.md` describes.

Never add a dependency whose license is incompatible with the AGPLv3 (for
example SSPL, BUSL, Commons Clause or Creative Commons NonCommercial).
`pnpm licenses list --prod` in the repository root is the check to run before
a pull request that adds one.

## How changes land

- Branch from a just-pulled `main` (`fix/<slug>`, `feat/<slug>`,
  `chore/<slug>`). `main` deploys staging on every merge; production ships
  from a `v*` release.
- Open a pull request against `main`. CI must be green, and the branch must be
  up to date with `main` before it can merge. Merges are squash merges.
- **Keep pull requests reviewable.** One logical change per PR: one bug fix,
  one feature slice, one refactor. Aim for at most 200 changed lines of
  hand-written code and never more than 400 (lockfiles, snapshots,
  changesets, non-English locale catalogs, generated output and verbatim
  license texts do not count). Split larger work into slices that each leave
  `main` deployable: preparatory refactor first, then the contract change,
  then the database change, then services and routes, then one UI slice per
  screen. Dependent slices may be opened as stacked PRs (base = the previous
  slice's branch). A PR that must exceed the cap says why in a `Size:` line
  in its description. Refactoring and behavior changes never share a PR.
- The PR description is a manual test plan: the physical steps a tester
  performs in the app to verify the change, the expected result after each,
  and a regression sweep of the flows that share the changed code.
- Commit messages are short, plain, single-line summaries.

## Code expectations

- Match the surrounding idioms. Use the design tokens and shared helpers;
  never hardcode a value that exists as a token.
- Validate every input at the boundary, check authorization on every path,
  keep secrets out of code and logs, minimize personal data.
- No N+1 queries, index new query paths, bound every result set.
- Add or update tests with the change. Typecheck, lint and tests pass in the
  repository before the PR opens.
