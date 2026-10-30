# Schemas

| File | What it is | Source |
|---|---|---|
| `template.schema.json` | The starter declaration, `.thoryn/template.json` (`thoryn.io/starter-template/v2`, SSO-3428): the Actions variables the creation flow sets, with their level, and each connection's scopes, production flag and grant. | Owned here. The starter orchestrator (oauthy) reads the same declaration. |
| `provision.schema.json` | The CLI's provisioning file: `thoryn.io/tenant/v1` (a config project's sections), `thoryn.io/application/v1` and the mixed `thoryn.io/provision/v1` (the application starters, until they move). | Vendored from thoryn-io/thoryn-cli `engine/src/main/resources/provision/provision.schema.json` at `cli-v0.55.0` (`240435348cae0834fae5f3b325be4967e74dbcb2`; refreshed by SSO-4058: the `legalDocument` kind of thoryn-cli SSO-4057 — the tenant-level terms of use and privacy policy per environment, versioned, Markdown or text with no HTML (SSO-4072). Before that, SSO-4054 at `cli-v0.54.0`: `emailTemplate` is per environment — `environment` is allowed, and a sandbox without its own copy sends production's; SSO-4048 at `cli-v0.53.0`: the `loginTheme` spec gains `displayName`, `pageTitle`, `faviconUrl`, `supportUrl`, `termsUrl` and `privacyUrl`; and SSO-4052 at `cli-v0.52.0`: the `loginTheme` spec grammar of SSO-4041 and the `emailTemplate` kind of SSO-4042). |

`npm run check` validates every starter as it is published, with no rendering:

- each `.thoryn/template.json` against `template.schema.json` and the fixed variable contract (README, "The
  variable contract");
- each connection's provisioning file against `provision.schema.json`.

A template that the orchestrator or the CLI would reject is never published.

The starters no longer carry a `connection.json`. Sign-in is declared by `connections` in
`template.json`, and CI signs in with `thoryn login --workload-identity`. So the CLI's connection schema is
no longer vendored.

Refresh `provision.schema.json` with `npm run schemas:refresh -- <cli-v* tag>` when the CLI changes it, and update
the source above. SSO-3430 (thoryn-cli, `{{env.NAME}}` in a resource's `environment`) changes only a
description, not the grammar; `environment` was already any non-empty string.
