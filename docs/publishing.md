# Publishing the templates

Each starter under `starters/<name>/` is published to its own **template repository**,
`thoryn-io/starter-<name>`. The starter-project flow (oathy SSO-3310) creates a customer repository from it
with `POST /repos/thoryn-io/starter-<name>/generate` and then sets the repository's GitHub Actions variables.
It **commits nothing**: templates are not rendered (SSO-3428), and a generated repository reads its wiring
from those variables at run time. What to set is declared in each template's `.thoryn/template.json`; see
[the variable contract](../README.md#the-variable-contract).

## Why one repository per starter

- GitHub's "generate from template" works on a whole repository, not a subdirectory, and records the
  provenance ("generated from thoryn-io/starter-express").
- The alternative, creating an empty repository and uploading a subdirectory through the Git Data API,
  reimplements what GitHub already does and loses the provenance.
- This repository stays the only place the starters are developed and tested; the template repositories are
  write-only mirrors. Never edit them by hand: the next publish overwrites them.

## How publishing works

`.github/workflows/publish.yml` runs after the `CI` workflow succeeds for a push to `main` (or on demand,
`workflow_dispatch`). Its publish matrix names every directory under `starters/` — a literal list, and
`npm run check` (`scripts/validate-templates.mjs`) fails when that list and `starters/*` differ, so a starter
cannot be added or renamed without being published. For each starter the job:

1. mints an installation token for the publish App, scoped to that one template repository
   (`actions/create-github-app-token`, `repositories: starter-<name>`);
2. mirrors the directory (`scripts/publish/mirror.sh`: fresh clone of `thoryn-io/starter-<name>`,
   `rsync --delete`, one commit naming the source SHA, pushed to the repository's default branch);
3. **verifies the result from a second, fresh clone** (`scripts/publish/verify-published.sh`): the clone
   is at the pushed commit, and its tree equals `starters/<name>` file for file — same paths, same sha256,
   same executable bits, and not empty (`scripts/publish/assert-mirror.sh`);
4. verifies the repository is a GitHub template (`scripts/publish/assert-template-repo.sh`, `is_template`),
   because the starter flow generates customer repositories with `POST /repos/thoryn-io/starter-<name>/generate`
   and GitHub serves that only for a template.

A published template is therefore always a starter that just passed this repository's CI, including its
staging end-to-end run once the staging fixture exists, and a green publish job means the template
repository verifiably holds it.

**An unconfigured publisher is a failure (SSO-3675).** The `plan` job fails with
`::error title=The template publisher is not configured::…` when the repository variable
`STARTERS_PUBLISH_APP_ID` or the secret `STARTERS_PUBLISH_APP_PRIVATE_KEY` is missing. Until 2026-10-13 it
printed a notice and exited 0 instead: every publish run since 2026-09-30 was green while the four template
repositories stayed at 0 KB, and a customer creating a starter got an empty repository. The only soft skip
left is a fork of this repository, where the App cannot exist: there every job is skipped (shown as skipped,
never as a green publish), because `plan` has `if: !github.event.repository.fork && …`.

The template repository is a GitHub template (`is_template`), so its own CI runs the build and unit tests
and skips the Thoryn jobs with a notice. A repository generated from it runs them as soon as its variables
are set.

## One-time setup (product owner)

The four template repositories exist and are marked as templates (checked 2026-10-13:
`is_template=true`, default branch `main`, 0 KB). What is missing is the publish App and its two settings
on `thoryn-io/thoryn-starters`. Do these steps once, in order:

```bash
# 0. (Already done.) The template repositories, public, marked as templates.
for s in express spring-boot aspnet-core config; do
  gh repo create "thoryn-io/starter-$s" --public \
    --description "Thoryn starter ($s). Generated from thoryn-io/thoryn-starters; do not edit here."
  gh repo edit "thoryn-io/starter-$s" --template --enable-issues=false --enable-wiki=false
done
```

1. **Register the GitHub App** "Thoryn starters publish" under the `thoryn-io` organisation
   (Organization settings → Developer settings → GitHub Apps → New GitHub App). Webhook: inactive.
   Repository permissions, and nothing else:
   - **Contents: Read and write** — the mirror pushes commits.
   - **Workflows: Read and write** — every starter carries `.github/workflows/` files; GitHub refuses a push
     that adds or changes a workflow file from an App without it.
   - Metadata: Read (mandatory, added automatically).
   No organization or account permissions. Note the **App ID** shown on the App's settings page.
2. **Generate a private key** on the same page (Private keys → Generate a private key); it downloads as a
   `.pem` file. Keep it out of git; delete it from your machine after step 4.
3. **Install the App on `thoryn-io`**, choosing **Only select repositories** and selecting exactly the four:
   `starter-express`, `starter-spring-boot`, `starter-aspnet-core`, `starter-config`. The workflow mints a
   token per repository (`repositories: starter-<name>`); a repository the App is not installed on fails
   the token step for that starter with "not installed" — the fix is this step, not a wider installation.
4. **Set the variable and the secret on `thoryn-io/thoryn-starters`:**

   ```bash
   gh variable set STARTERS_PUBLISH_APP_ID -R thoryn-io/thoryn-starters --body '<app id from step 1>'
   gh secret set STARTERS_PUBLISH_APP_PRIVATE_KEY -R thoryn-io/thoryn-starters < thoryn-starters-publish.<date>.private-key.pem
   rm thoryn-starters-publish.<date>.private-key.pem
   ```

5. **Dispatch the workflow once** and watch it publish all four:

   ```bash
   gh workflow run publish.yml -R thoryn-io/thoryn-starters
   gh run watch -R thoryn-io/thoryn-starters "$(gh run list -R thoryn-io/thoryn-starters --workflow=publish.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
   for s in express spring-boot aspnet-core config; do
     gh api "repos/thoryn-io/starter-$s" --jq '"\(.full_name) is_template=\(.is_template) size=\(.size) pushed=\(.pushed_at)"'
   done
   ```

   Every `Publish <starter>` job must end with `Mirror verified: N files …` and `… is a template repository.`
   From then on every push to `main` whose CI is green republishes automatically.

## What a failing publish run means

| Message | Meaning | Fix |
|---|---|---|
| `::error title=The template publisher is not configured::… needs the repository variable STARTERS_PUBLISH_APP_ID …` (job *Publisher configured*) | The variable is unset on `thoryn-io/thoryn-starters`. Nothing was published. | Step 4 above (`gh variable set …`). |
| `… needs the repository secret STARTERS_PUBLISH_APP_PRIVATE_KEY …` | The secret is missing or empty. Nothing was published. | Step 4 above (`gh secret set …`). Both missing → both are named in one message. |
| `actions/create-github-app-token` fails: `Not Found` / `not installed` for `starter-<name>` | The App is not installed on that template repository, or the App ID and key do not belong to the same App. | Step 3 (install on the four repositories), or re-check steps 1, 2 and 4. |
| `git push` rejected: `refusing to allow a GitHub App to create or update workflow … without workflows permission` | The App lacks **Workflows: Read and write**. | Add the permission on the App, accept the updated permissions on the installation, re-run. |
| `::error::verify-published: thoryn-io/starter-<name> has no branch main to clone (is the repository still empty?)` | The push did not land on the default branch, or did not happen. | Read the mirror step's log for the push; the script pushes `HEAD:refs/heads/<default_branch>` as reported by `gh api repos/… --jq .default_branch`. |
| `::error::verify-published: … is at <sha>, not the published commit <sha>` | Something else pushed to the template repository between the mirror and its verification (a hand edit, or a concurrent publish). | Template repositories are write-only mirrors: revert the hand edit and re-run the workflow. The `concurrency` group serialises publish runs. |
| `::error::assert-mirror: the mirror … is EMPTY (expected N files …)` | The template repository has a branch but no files. | Re-run; if it persists, the clone or rsync in the mirror step failed — read its log. |
| `::error::assert-mirror: the mirror … differs from … (M files, expected N)` followed by `<` / `>` lines | The published tree is not the starter: a file the starter's own `.gitignore` ignores but this repository tracks (the mirror's `git add` skips it), a stale file, changed content, or a lost executable bit (`x` vs `-` in the listing). | Fix the starter (usually its `.gitignore`), merge, let CI republish. Never edit the template repository by hand. |
| `::error title=thoryn-io/starter-<name> is not a template repository::… Fix: gh repo edit thoryn-io/starter-<name> --template` | The repository lost its template flag; the starter flow cannot generate from it. | Run the printed command, re-run the workflow. |
| Every job *skipped* | The workflow ran in a fork of this repository (`github.event.repository.fork`), where the App cannot exist. | Nothing; publishing happens only from `thoryn-io/thoryn-starters`. |

## The GitHub App that creates customer repositories

The Thoryn GitHub App the starter orchestrator (in oauthy) uses to create customer repositories (SSO-3306)
is a different App from the publishing App above. It needs **no Contents write**: it generates the
repository and sets variables, and never pushes a commit. Its repository permissions:

| Permission | Access | Why |
|---|---|---|
| Administration | Read and write | Create the repository from a template (`POST /repos/{template_owner}/{template_repo}/generate`). Config project: create the production GitHub environment (`github.productionEnvironment`) with required reviewers and a `main`-only deployment-branch policy (`PUT /repos/{owner}/{repo}/environments/{name}`). |
| Contents | Read | Read the template, including its `.thoryn/template.json` declaration. The templates are public. |
| Variables | Read and write | Set the repository variables the declaration lists (`POST /repos/{owner}/{repo}/actions/variables`). |
| Environments | Read and write | Config project only. Set the environment-level variable `THORYN_PRODUCTION_WIF_CLIENT_ID` in the production GitHub environment (`POST /repos/{owner}/{repo}/environments/{name}/variables`). |
| Metadata | Read | Mandatory for every App. |

Check these against GitHub's current "permissions required for GitHub Apps" table when you register the App;
the orchestrator (oauthy SSO-3310) owns the exact calls.

**Order.** The initial commit of a generated repository triggers its workflow. That first run can start
before the variables are set. The workflow expects this: on the first push, with **no** Thoryn variable set,
the Thoryn jobs skip with a notice and the run stays green. Every later run with a missing variable fails
and names it. The Thoryn jobs therefore first run on the next push, or when someone re-runs the workflow. To
run them straight away, the orchestrator could dispatch the workflow after it sets the variables
(`POST /repos/{owner}/{repo}/actions/workflows/<file>/dispatches`, where `<file>` is `ci.yml` for an
application project and `thoryn.yml` for the config project). That call needs **Actions: Read and write**.
It is the only extra permission, and it is optional. A re-run of the first run also works: the variables
are set by then, so the jobs run.
