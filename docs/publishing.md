# Publishing the templates

Each starter under `starters/<name>/` is published to its own **template repository**,
`thoryn-io/starter-<name>`. The starter-project flow (oathy SSO-3310) creates a customer repository from it
with `POST /repos/thoryn-io/starter-<name>/generate`, then commits the rendered `.thoryn/` files.

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

The template repository is unrendered: it still has `.thoryn/template.json`, so its own CI runs the build
and unit tests and skips the Thoryn jobs with a notice.

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

The Thoryn GitHub App that creates customer repositories (SSO-3306) needs read access to the template
repositories only (they are public), so it does not need this publishing App's write permission.
