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
cannot be added or renamed without being published.

First the `plan` job (*Publish key confined to main*), which is **not** bound to any environment, checks where
the key lives (`scripts/publish/assert-environment.sh`, see [Where the key lives](#where-the-key-lives)): the
GitHub environment `starters-publish` exists, its deployment-branch policy allows exactly the branch `main`,
and the private key is not also a repository or organisation secret. Any of those wrong fails the run before
a job that could read the key starts. Then, for each starter, the `publish` job, bound to `starters-publish`:

0. checks that the environment holds the App id and the key (`scripts/publish/gate.sh`), and fails otherwise;
1. mints an installation token for the publish App, scoped to that one template repository
   (`actions/create-github-app-token`, `repositories: starter-<name>`) with only Contents and Workflows
   write (and Metadata read), whatever the App itself is granted;
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

**An unconfigured publisher is a failure (SSO-3675).** Each `Publish <starter>` job fails with
`::error title=The template publisher is not configured::…` when the variable `STARTERS_PUBLISH_APP_ID` or
the secret `STARTERS_PUBLISH_APP_PRIVATE_KEY` is missing from the environment `starters-publish`. The check
runs inside the bound job because an environment's variables and secrets are invisible to every other job: a
check anywhere else would see nothing and could not tell "configured" from "missing". Until 2026-10-13 the
workflow
printed a notice and exited 0 instead: every publish run since 2026-09-30 was green while the four template
repositories stayed at 0 KB, and a customer creating a starter got an empty repository. The only soft skip
left is a fork of this repository, where the App cannot exist: there every job is skipped (shown as skipped,
never as a green publish), because `plan` has `if: !github.event.repository.fork && …`.

The template repository is a GitHub template (`is_template`), so its own CI runs the build and unit tests
and skips the Thoryn jobs with a notice. A repository generated from it runs them as soon as its variables
are set.

## Where the key lives

The publish App's private key is a long-lived credential with write access to the four template
repositories, and through them to every customer repository generated afterwards. It is therefore readable
only by a job **running for `main`**:

- The App id and the key are a variable and a secret of the GitHub **environment** `starters-publish`, not of
  the repository. GitHub hands an environment's secrets only to a job that names the environment.
- The environment's **deployment-branch policy** allows exactly the branch `main`. GitHub refuses a job bound
  to it on any other ref, so a workflow edited on a branch, or a `workflow_dispatch` from a branch, never sees
  the key, whatever its YAML says. A repository secret has no such boundary: any workflow on any branch
  someone with write access pushes could read it.
- The workflow cannot create that boundary, only check it. `assert-environment.sh` runs on every publish, in
  a job **not** bound to the environment and before any job that is, and fails when the environment is
  missing, has no policy or a wider one, or when a repository or organisation secret of the same name exists.
  Running first also matters: a job that names an environment which does not exist makes GitHub **create** it,
  unprotected.
- `npm run check` pins the workflow side: every job that mints the App token is bound to `starters-publish`,
  runs the gate before minting, and needs the unbound environment check (`checkPublishEnvironment` in
  `scripts/validate-templates.mjs`).

This is the same custody class as the starter orchestrator's own App key (oauthy ADR
`2026-09-30-github-app-installation-handshake.md` §7: a GitHub environment secret of the deploy repository).

## One-time setup (product owner)

The four template repositories exist and are marked as templates (checked 2026-10-13:
`is_template=true`, default branch `main`, 0 KB; still 0 KB on 2026-10-23 and 2026-10-26). What is missing is
the publish App, the environment `starters-publish` on `thoryn-io/thoryn-starters`, and the App's id and key in
that environment. Do these steps once, in order:

> **Why `thoryn-io/starter-config` (and the other three) is empty — checked 2026-10-26 (SSO-3971).** The config
> starter IS in the publish matrix (`config` is one of the four `starters/*`, enforced by `checkPublishMatrix`), so
> this is not a matrix gap, and nothing ever pushed to any template repository (`GET …/commits` answers `409 Git
> Repository is empty` for all four). Every run before 2026-10-13 skipped green (the SSO-3675 bug). Since SSO-3675
> the runs fail in `plan` before any token is minted: run 40064912179 (2026-10-24, the latest) failed
> `assert-environment.sh` with "the environment starters-publish does not exist on thoryn-io/thoryn-starters". On
> 2026-10-26 the repository still has no environment, no `STARTERS_PUBLISH_APP_ID` variable and no
> `STARTERS_PUBLISH_APP_PRIVATE_KEY` secret, and no publish App is installed on `thoryn-io` (the installed Apps are
> `hetzner-runners-app`, `thoryn-forge-bridge` and `thoryn-starters-staging`, the starter orchestrator's App, which
> is not the publisher). Steps 1–5 below are the whole fix; then run step 6.

```bash
# 0. (Already done.) The template repositories, public, marked as templates.
for s in express spring-boot aspnet-core config; do
  gh repo create "thoryn-io/starter-$s" --public \
    --description "Thoryn starter ($s). Generated from thoryn-io/thoryn-starters; do not edit here."
  gh repo edit "thoryn-io/starter-$s" --template --enable-issues=false --enable-wiki=false
done
```

1. **Register the GitHub App** "Thoryn starters publish" under the `thoryn-io` organisation
   (Organization settings → Developer settings → GitHub Apps → New GitHub App).
   - **Webhook: off** (untick *Active*). The App never receives events.
   - **Where can this GitHub App be installed: Only on this account.**
   - Repository permissions, and nothing else:
     - **Contents: Read and write** — the mirror pushes commits.
     - **Workflows: Read and write** — every starter carries `.github/workflows/` files; GitHub refuses a push
       that adds or changes a workflow file from an App without it.
     - Metadata: Read (mandatory, added automatically).
   - No organization or account permissions.

   Note the **App ID** shown on the App's settings page.
2. **Generate a private key** on the same page (Private keys → Generate a private key). It downloads as a
   `.pem` file. Keep it out of git and out of any synced folder; step 5 deletes it.
3. **Install the App on `thoryn-io`**, choosing **Only select repositories** and selecting exactly the four:
   `starter-express`, `starter-spring-boot`, `starter-aspnet-core`, `starter-config`. Not "All repositories",
   and not `thoryn-starters` itself. The workflow mints a token per repository (`repositories: starter-<name>`);
   a repository the App is not installed on fails the token step for that starter with "not installed". The
   fix is this step, not a wider installation.
4. **Create the environment `starters-publish` with a `main`-only deployment-branch policy** on
   `thoryn-io/thoryn-starters`. In the UI: Settings → Environments → New environment → `starters-publish` →
   Deployment branches and tags: **Selected branches and tags** → Add rule → branch `main`. Add no other rule,
   and do not choose "Protected branches only". Or with `gh`:

   ```bash
   gh api -X PUT repos/thoryn-io/thoryn-starters/environments/starters-publish --input - <<'JSON'
   {"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
   JSON
   gh api -X POST repos/thoryn-io/thoryn-starters/environments/starters-publish/deployment-branch-policies \
     -f name=main -f type=branch
   # Must print exactly: branch main
   gh api repos/thoryn-io/thoryn-starters/environments/starters-publish/deployment-branch-policies \
     --jq '.branch_policies[] | "\(.type) \(.name)"'
   ```

   Do this **before** step 5. Every publish run checks it and fails until it holds.
5. **Set the variable and the secret on the environment, not the repository, then delete the key file.**
   The key goes in on **stdin** (`<`), never as a `--body` argument or `"$(cat …)"`, which would put it in
   the process list and the shell history:

   ```bash
   gh variable set STARTERS_PUBLISH_APP_ID --env starters-publish -R thoryn-io/thoryn-starters --body '<app id from step 1>'
   gh secret set STARTERS_PUBLISH_APP_PRIVATE_KEY --env starters-publish -R thoryn-io/thoryn-starters \
     < thoryn-starters-publish.<date>.private-key.pem
   rm thoryn-starters-publish.<date>.private-key.pem
   # Neither may exist at repository level (the run fails if the key does):
   gh secret list -R thoryn-io/thoryn-starters
   gh variable list -R thoryn-io/thoryn-starters
   ```

   If the key is ever lost, generate a new one (step 2) and delete the old one on the App's settings page;
   there is no reason to keep a copy anywhere else.
6. **Dispatch the workflow once, from `main`,** and watch it publish all four:

   ```bash
   gh workflow run publish.yml -R thoryn-io/thoryn-starters --ref main
   gh run watch -R thoryn-io/thoryn-starters "$(gh run list -R thoryn-io/thoryn-starters --workflow=publish.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
   for s in express spring-boot aspnet-core config; do
     gh api "repos/thoryn-io/starter-$s" --jq '"\(.full_name) is_template=\(.is_template) size=\(.size) pushed=\(.pushed_at)"'
   done
   ```

   The job *Publish key confined to main* must end with `Environment starters-publish: only the branch main can
   deploy …`, and every `Publish <starter>` job with `Mirror verified: N files …` and `… is a template
   repository.` All four repositories must show `is_template=true` and a `size` above 0. From then on every
   push to `main` whose CI is green republishes automatically.

## What a failing publish run means

| Message | Meaning | Fix |
|---|---|---|
| `::error title=The publish key is not confined to main::… the environment starters-publish does not exist …` (job *Publish key confined to main*) | The environment was never created. Nothing was published, and no job could read a key. | Step 4 above. |
| `… has no deployment-branch policy …` / `… may be deployed from any protected branch …` / `… may be deployed from [<rules>]; it must allow exactly the branch main …` | The environment exists but jobs on other branches could read its secrets. | Step 4: *Selected branches and tags* with the single rule `branch main`. |
| `… STARTERS_PUBLISH_APP_PRIVATE_KEY is readable outside the environment starters-publish …` | A repository (or organisation) secret of that name exists as well, readable by a workflow on any branch. | Keep the environment secret; `gh secret delete STARTERS_PUBLISH_APP_PRIVATE_KEY -R thoryn-io/thoryn-starters` (and the organisation one, if any). |
| `… could not read the environment starters-publish (the job needs permissions: actions: read)` | The `plan` job's token cannot read environments. | Restore `actions: read` in the `plan` job's `permissions:`. |
| `::error title=The template publisher is not configured::… needs the variable STARTERS_PUBLISH_APP_ID in the GitHub environment starters-publish …` (job *Publish &lt;starter&gt;*) | The variable is not set on the environment. Nothing was published. A repository-level variable does not count. | Step 5 above (`gh variable set … --env starters-publish`). |
| `… needs the secret STARTERS_PUBLISH_APP_PRIVATE_KEY in the GitHub environment starters-publish …` | The secret is missing or empty on the environment. Nothing was published. | Step 5 above (`gh secret set … --env starters-publish`). Both missing → both are named in one message. |
| `Branch "<name>" is not allowed to deploy to starters-publish due to environment protection rules.` | The workflow was dispatched from a branch other than `main`. This is the policy working. | Dispatch with `--ref main`. |
| `actions/create-github-app-token` fails: `Not Found` / `not installed` for `starter-<name>` | The App is not installed on that template repository, or the App ID and key do not belong to the same App. | Step 3 (install on the four repositories), or re-check steps 1, 2 and 5. |
| `actions/create-github-app-token` fails asking for permissions the installation lacks (`contents` / `workflows`) | The App was registered without Contents or Workflows write, or the installation has not accepted an updated permission set. | Step 1's permissions; accept the update on the installation. |
| `git push` rejected: `refusing to allow a GitHub App to create or update workflow … without workflows permission` | The App lacks **Workflows: Read and write**. | Add the permission on the App, accept the updated permissions on the installation, re-run. |
| `::error::verify-published: thoryn-io/starter-<name> has no branch main to clone (is the repository still empty?)` | The push did not land on the default branch, or did not happen. | Read the mirror step's log for the push; the script pushes `HEAD:refs/heads/<default_branch>` as reported by `gh api repos/… --jq .default_branch`. |
| `::error::verify-published: … is at <sha>, not the published commit <sha>` | Something else pushed to the template repository between the mirror and its verification (a hand edit, or a concurrent publish). | Template repositories are write-only mirrors: revert the hand edit and re-run the workflow. The `concurrency` group serialises publish runs. |
| `::error::assert-mirror: the mirror … is EMPTY (expected N files …)` | The template repository has a branch but no files. | Re-run; if it persists, the clone or rsync in the mirror step failed — read its log. |
| `::error::assert-mirror: the mirror … differs from … (M files, expected N)` followed by `<` / `>` lines | The published tree is not the starter: a file the starter's own `.gitignore` ignores but this repository tracks (the mirror's `git add` skips it), a stale file, changed content, or a lost executable bit (`x` vs `-` in the listing). | Fix the starter (usually its `.gitignore`), merge, let CI republish. Never edit the template repository by hand. |
| `::error title=thoryn-io/starter-<name> is not a template repository::… Fix: gh repo edit thoryn-io/starter-<name> --template` | The repository lost its template flag; the starter flow cannot generate from it. | Run the printed command, re-run the workflow. |
| Every job *skipped* | The workflow ran in a fork of this repository (`github.event.repository.fork`), where the App cannot exist. | Nothing; publishing happens only from `thoryn-io/thoryn-starters`. |

## The GitHub App that creates customer repositories

The Thoryn GitHub App the starter orchestrator (in oauthy) uses to create customer repositories (SSO-3306)
is a different App from the publishing App above. **It is not separate because it lacks write access**: since
SSO-3436 it has Contents, Workflows and Pull requests write, to open a pull request that adds a starter to an
existing repository (oauthy ADR `2026-09-30-github-app-installation-handshake.md` §5). The publish App stays
separate for two reasons:

- **Least privilege.** The publish App can write contents and workflows to four repositories, and nothing
  else. The Thoryn App holds Administration write, among others, in **every customer installation**;
  publishing through it would give a CI job of a public repository the platform's most powerful GitHub
  credential, and would add a machine-triggered direct push to it that nothing in the starter flow needs.
- **One template set for both environments.** There is a staging and a production Thoryn App (ADR §6), and
  both orchestrators generate from the same four template repositories. Publishing with the staging App would
  make production depend on a staging credential; publishing with the production App would mean installing
  it on `thoryn-io` for a Thoryn-internal job.

Its repository permissions (ADR §5 is the authority):

| Permission | Access | Why |
|---|---|---|
| Administration | Read and write | Create the repository from a template (`POST /repos/{template_owner}/{template_repo}/generate`). Config project: create the production GitHub environment (`github.productionEnvironment`) with required reviewers and a `main`-only deployment-branch policy (`PUT /repos/{owner}/{repo}/environments/{name}`). |
| Contents | Read and write | Read the template, including its `.thoryn/template.json` declaration (the templates are public). Write: SSO-3436, the branch and commit of the pull request into an existing repository. |
| Workflows | Read and write | SSO-3436: that commit adds files under `.github/workflows/`. |
| Pull requests | Read and write | SSO-3436: open that pull request. |
| Variables | Read and write | Set the repository variables the declaration lists (`POST /repos/{owner}/{repo}/actions/variables`). |
| Environments | Read and write | Config project only. Set the environment-level variable `THORYN_PRODUCTION_WIF_CLIENT_ID` in the production GitHub environment (`POST /repos/{owner}/{repo}/environments/{name}/variables`). |
| Metadata | Read | Mandatory for every App. |
| Members (organization) | Read | The org-owner check during the installation handshake (SSO-3440); user token only. |

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
