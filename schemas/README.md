# Schemas

| File | What it is | Source |
|---|---|---|
| `template.schema.json` | The starter declaration, `.thoryn/template.json` (`thoryn.io/starter-template/v2`, SSO-3428): the Actions variables the creation flow sets, with their level, and each connection's scopes, production flag and grant. | Owned here. The starter orchestrator (oauthy) reads the same declaration. |
| `provision.schema.json` | The CLI's provisioning file, `.thoryn/provision.yaml`. | Vendored from thoryn-io/thoryn-cli `src/main/resources/provision/provision.schema.json` at `d08d84658135612e4f33b590bd6845f770288abc` (SSO-3308, #94). |

`npm run check` validates every starter as it is published, with no rendering:

- each `.thoryn/template.json` against `template.schema.json` and the fixed variable contract (README, "The
  variable contract");
- each connection's provisioning file against `provision.schema.json`.

A template that the orchestrator or the CLI would reject is never published.

The starters no longer carry a `connection.json`. Sign-in is declared by `connections` in
`template.json`, and CI signs in with `thoryn login --workload-identity`. So the CLI's connection schema is
no longer vendored.

Refresh `provision.schema.json` with `npm run schemas:refresh` when the CLI changes it, and update the
commit above. SSO-3430 (thoryn-cli, `{{env.NAME}}` in a resource's `environment`) changes only a
description, not the grammar; `environment` was already any non-empty string.
