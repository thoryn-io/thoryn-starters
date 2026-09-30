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

`.github/workflows/publish.yml` runs after the `CI` workflow succeeds for a push to `main` (or on demand).
For every directory under `starters/` it mirrors the directory to `thoryn-io/starter-<name>` (`rsync
--delete`, one commit naming the source SHA). A published template is therefore always a starter that just
passed this repository's CI, including its staging end-to-end run once the staging fixture exists.

The template repository is a GitHub template (`is_template`), so its own CI runs the build and unit tests
and skips the Thoryn jobs with a notice. A repository generated from it runs them as soon as its variables
are set.

## One-time setup (product owner)

```bash
# 1. The template repositories, public, marked as templates.
for s in express spring-boot aspnet-core config; do
  gh repo create "thoryn-io/starter-$s" --public \
    --description "Thoryn starter ($s). Generated from thoryn-io/thoryn-starters; do not edit here."
  gh repo edit "thoryn-io/starter-$s" --template --enable-issues=false --enable-wiki=false
done

# 2. A GitHub App for publishing, installed on those four repositories only, with
#    Repository permissions → Contents: Read and write, and Workflows: Read and write (nothing else).
#    Workflows is required because every starter carries .github/workflows/ files; GitHub refuses a
#    push that adds or changes a workflow file from an App without it.
gh variable set STARTERS_PUBLISH_APP_ID -R thoryn-io/thoryn-starters --body '<app id>'
gh secret set STARTERS_PUBLISH_APP_PRIVATE_KEY -R thoryn-io/thoryn-starters < publish-app.private-key.pem
```

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
