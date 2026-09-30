# Vendored CLI schemas

Copies of the two schemas the `thoryn` CLI validates `.thoryn/` files against. CI renders every
starter with example values and validates the result against these, so a template that the CLI
would reject never gets published.

| File | Source (thoryn-io/thoryn-cli) | Commit |
|---|---|---|
| `connection.schema.json` | `src/main/resources/examples/connection.schema.json` | `d08d84658135612e4f33b590bd6845f770288abc` (SSO-3308, #94) |
| `provision.schema.json` | `src/main/resources/provision/provision.schema.json` | `d08d84658135612e4f33b590bd6845f770288abc` |

Refresh them with `npm run schemas:refresh` when the CLI changes either schema.
