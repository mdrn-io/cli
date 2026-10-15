# MDRN CLI

`@mdrnio/cli` (command `mdrn`) deploys apps and calls a fixed set of MDRN management
API operations. It needs Node 20 or later and has no dependencies:

```powershell
npm install -g @mdrnio/cli
```

`mdrn --help` (or `-h`) lists every command by group, `mdrn builds --help` one
group, and `mdrn --version` the version.

## Sign in

```powershell
mdrn login                                  # opens the browser; pick a workspace and the scopes
mdrn login --workspace workspace_id --scopes project:read,deploy:read,deploy:write
mdrn login --no-browser                     # prints the URL to open yourself
mdrn login --token - < token.txt            # a management token instead of a browser sign-in
mdrn whoami
mdrn init my-app                            # a new app from github.com/mdrn-io/app-template
mdrn link                                   # writes .mdrn/link.json: this directory's project and service
mdrn link --project project_id --environment sandbox --service svc_id
mdrn open billing                           # the console: project (default), billing or tokens
mdrn logout
```

`login` registers the CLI as an OAuth app at the API origin, opens the console's
consent page in your browser, and keeps the sign-in in your profile: pick **one**
workspace and the scopes there (every scope the CLI uses is asked for unless
`--scopes` narrows it; `--workspace` makes the CLI check you picked that one, and
sign out again if not). The access token lasts an hour and is refreshed on its
own; `logout` revokes the sign-in. `login --token` keeps a management token
instead, which a workspace Admin creates in the console under Settings, Tokens
(its secret is shown once); `-` reads it from standard input. `--origin` names
another API origin (`--profile` another profile), and `MDRN_API_TOKEN` set in the
environment always wins over the profile.

`link` records the workspace, project, environment (`sandbox` unless named) and
service in `.mdrn/link.json`, picking each when the workspace has exactly one and
listing them otherwise, so that in the directory (or below it) `mdrn deploy`,
`mdrn builds list` and the rest need no `--project`, `--environment` or
`--service`. The file holds identifiers only and may be committed; the archive
`deploy` sends leaves `.mdrn` out. `init <dir>` clones the app template with
`git` (which must be on `PATH`) and drops its history.

**What a browser sign-in cannot do.** The Platform grants no app `billing:write`,
`team:write`, `workspace:write` or `project:delete`, so with a sign-in
`billing checkout` and `billing portal` are refused before any request, and
`tokens revoke` (which needs `workspace:write` for any token but one's own) is
answered 403 and says so: use the console (`mdrn open billing`, `mdrn open tokens`)
or a management token (`MDRN_API_TOKEN`).

**Console only.** Creating, rotating and editing management tokens (`tokens
create`, `rotate`, `edit`) is the console's (`mdrn open tokens`): the Platform
allows it only from a console session, so the CLI has no command for it and
`--help` says so.

`MDRN_API_ORIGIN` is optional and defaults to `https://api.mdrn.io`; it must be
https (plain http is accepted only for a development server on `localhost`,
`127.0.0.1` or `[::1]`).

## Deploying

```powershell
mdrn deploy ./app --service svc_id --project project_id --environment sandbox
```

`deploy [dir]` (the current directory when left out) packs the directory as a
gzipped tar, uploads it as a source archive, starts a build, prints the build's
output as it runs, and waits until the build's deployment is live. It ends with
`Live: https://<hostname>`, or exits 1 when the upload is refused, the build fails
or is cancelled, the deployment fails, or `--timeout` seconds (default 1800) pass;
a build that outlives the CLI carries on, and `mdrn builds get` shows it.

The archive leaves out `.git` and `node_modules` at any depth, and whatever a
`.mdrnignore` at the root of the directory names, read like `.gitignore`
(`dist/`, `*.log`, `/secret.txt`, `docs/**/*.pdf`, `!keep.log`). Symbolic links are
left out. An archive over 95 MB is refused before anything is sent: leave out
dependencies and build output, which the build makes itself. A directory named
`services` or `get` is given as `./services`, since `deploy services` and
`deploy get` are the inspection commands below.

## Commands

```powershell
mdrn whoami

mdrn workspaces list
mdrn projects list --workspace workspace_id
mdrn projects create --name shop --workspace workspace_id

mdrn products list --project project_id --environment sandbox
mdrn products enable database --project project_id --environment sandbox
mdrn products enable database --engine postgres --project project_id --environment sandbox
mdrn products disable logs --project project_id --environment sandbox
mdrn products delete mail --project project_id --environment sandbox
mdrn products restore logs --project project_id --environment sandbox --idempotency-key restore-logs-1   # the same key makes a retry apply it once

mdrn identity list --project project_id --environment sandbox
mdrn identity enable --origin https://app.example.com --project project_id --environment sandbox

mdrn mail templates add --id welcome-v1 --subject "Welcome" --text "Hello" [--html "<p>Hello</p>"] --project project_id --environment sandbox
mdrn mail callback set --url https://app.example.com/hooks/mail --project project_id --environment sandbox
mdrn mail suppressions add --email bounced@example.com --project project_id --environment sandbox

mdrn usage get --workspace workspace_id [--period period_id]

mdrn billing get --workspace workspace_id
mdrn billing checkout --workspace workspace_id --plan base --return-path /billing
mdrn billing checkout --workspace workspace_id --credit-usd 25 --return-path /billing
mdrn billing portal --workspace workspace_id --return-path /billing

mdrn operations get operation_id

mdrn tokens list --workspace workspace_id
mdrn tokens revoke tok_id

mdrn deploy ./app --service svc_id --project project_id --environment sandbox [--timeout 1800]
mdrn deploy services --project project_id --environment sandbox
mdrn deploy get deployment_id --project project_id --environment sandbox

mdrn services create --name shop [--hostname-label shop-app] --project project_id --environment sandbox
mdrn services disable svc_id --project project_id --environment sandbox
mdrn services enable svc_id --project project_id --environment sandbox

mdrn builds list --service svc_id --project project_id --environment sandbox
mdrn builds get bld_id --project project_id --environment sandbox
mdrn builds logs bld_id [--follow] --project project_id --environment sandbox
mdrn builds cancel bld_id --project project_id --environment sandbox

mdrn releases list --service svc_id --project project_id --environment sandbox
mdrn deployments list --service svc_id --project project_id --environment sandbox
mdrn deployments cancel deployment_id --project project_id --environment sandbox
mdrn rollback --service svc_id --artifact art_id --project project_id --environment sandbox

mdrn logs --project project_id --environment sandbox
mdrn logs --q "checkout failed" --level warn,error --since 2h --service svc_id --project project_id --environment sandbox
mdrn logs --follow --project project_id --environment sandbox
mdrn logs trace trace_id --project project_id --environment sandbox

mdrn github connect --service svc_id --repo owner/name [--branch main] --project project_id --environment sandbox

mdrn variables list --service svc_id --project project_id --environment sandbox
mdrn variables set API_KEY --value s3cret --service svc_id --project project_id --environment sandbox
mdrn variables set MODE --value fast --plain --build --service svc_id --project project_id --environment sandbox
mdrn variables set API_KEY --value - --service svc_id --project project_id --environment sandbox < key.txt
mdrn variables unset API_KEY --service svc_id --project project_id --environment sandbox

mdrn domains list --project project_id --environment sandbox
mdrn domains add --service svc_id --hostname app.example.com --project project_id --environment sandbox
mdrn domains add ... --accept-charge 150000   # beyond the 5 included: the quoted price per month, in micro-USD
mdrn domains get dom_id --project project_id --environment sandbox
mdrn domains verify dom_id --project project_id --environment sandbox
mdrn domains move dom_id --service svc_id --project project_id --environment sandbox
mdrn domains remove dom_id --project project_id --environment sandbox

mdrn request GET /v1/platform/workspaces
mdrn request POST /v1/platform/... --data '{"key":"value"}' --idempotency-key raw-1
mdrn request POST /v1/platform/... --data - --idempotency-key raw-2 < body.json
```

Options take `--name value` or `--name=value`. A value that itself starts with
`--` must use the second form (`--text=--draft--`): `--text --draft--` reads
`--draft--` as the next option. `--json`, `--follow`, `--plain`, `--build`,
`--help` (`-h`) and `--version` never take a value. An unknown command is answered
with one line pointing at `mdrn --help` (or `mdrn <group> --help`). `request --data -` reads the JSON body from standard input, and
`variables set --value -` the value (without its last newline), which keeps a
secret out of shell history. `--environment` is `sandbox` or `production`.
`products enable database` takes `--engine sqlite|postgres` (SQLite when
omitted); no other product takes an engine. `billing checkout` buys either the
plan (`--plan`) or prepaid credit in whole US dollars from 5 to 1000
(`--credit-usd`), never both. `request --data` must be JSON.

A variable is secret unless `--plain`; `--build` also hands it to the build.
Setting or removing one republishes the release that is serving. `rollback`
publishes an artifact that served before (`releases list` shows them) as a new
deployment and waits until it is live. `github connect` names the repository as
on GitHub; it must be one GitHub lets MDRN see in this project (authorize GitHub in
the console first), and pushes to the branch (its default branch when left out)
build the service.

`logs` searches the environment's application logs (requests, console lines and
exceptions, redacted) and prints one page, newest first: `--q` matches text,
`--level` a comma-separated list of `debug`, `log`, `info`, `warn` and `error`
(requests are always returned), `--since` the window (`15m`, `2h`, `1d`; the last
hour when left out) and `--service` one service. `--follow` runs the search again
every 3 seconds from a millisecond after the newest item seen and prints what is new,
oldest first: it is a search repeated, not a stream, so a line can take seconds to
appear; Ctrl-C ends it. `logs trace` joins every item of one request across services
by its trace ID (the `traceId` column of a search).

## Output

Lists print as tables and everything else as one field per line; times read as
UTC dates. `--json` prints the API's answer unchanged, for scripts; with `deploy`
and `rollback` it prints a summary (`buildId`, `deploymentId`, `state`,
`hostname`) and sends the build output to standard error.

## Profiles

`~/.config/mdrn/config.json` (or `$XDG_CONFIG_HOME/mdrn/config.json`, or the file
`MDRN_CONFIG` names) holds profiles, written by `login`, `logout` and read by every
command:

```json
{ "version": 1,
  "profiles": {
    "default": { "origin": "https://api.mdrn.io", "console": "https://console.mdrn.io", "workspace": "workspace_id",
                 "auth": { "type": "oauth", "clientId": "oac_...", "accessToken": "mdrn_mgmt_...", "refreshToken": "mdrn_rt_...", "expiresAt": 1760000000, "scopes": ["project:read"], "account": "acc_..." } },
    "dev": { "token": "mdrn_mgmt_...", "origin": "https://development.api.mdrn.io", "project": "project_id", "environment": "sandbox" }
  },
  "clients": { "https://api.mdrn.io": { "clientId": "oac_...", "redirectUri": "http://127.0.0.1:51234/callback" } } }
```

A profile holds either a browser sign-in (`auth`) or a management token
(`token`); `auth` wins when both are present. `clients` is the CLI's own OAuth
registration per API origin, reused by the next `login`. A file from before the
schema was versioned (`{ "profiles": ... }`) is read as it is. The file is written
whole (a temporary file renamed over it), readable only by you (`0600`; Windows
keeps it under your profile instead), and a `config.json.lock` next to it keeps
two commands from refreshing the same sign-in at once.

`--profile dev` (or `MDRN_PROFILE`) picks one, otherwise `default`. Precedence
for `--workspace`, `--project`, `--environment` and `--service`: the command line,
then `MDRN_WORKSPACE`, `MDRN_PROJECT`, `MDRN_ENVIRONMENT` and `MDRN_SERVICE`, then
the directory's `.mdrn/link.json` (found by walking up from the current
directory), then the profile. `MDRN_API_TOKEN` and `MDRN_API_ORIGIN` win over the
profile's credential and origin.

## Behaviour

The CLI writes a credential only to its own configuration file, and only on
`login`. A project or environment identifier is a selector, not authority; the
server evaluates the credential for every operation.

A 202 operation is pending, not success: inspect its operation ID with
`operations get` until it is terminal, then read product state. Product deletion
is permanent; `restore` only re-enables a retained disabled product and returns
`RESTORE_UNAVAILABLE` after deletion. Database, Storage, Mail and Logs take
lifecycle commands. Unknown provider measurements in `usage get` stay null, and
raw facts are not prices.

Required scopes include project:read/project:write, product:read/product:write,
operation:read, usage:read, billing:read/billing:write, deploy:read/deploy:write,
workspace:read (`tokens list`) and account:read (`whoami`) as appropriate; the current workspace role and entitlement checks
still apply. Requests time out after 10 seconds (30 during `deploy` and
`rollback`, 5 minutes for sending the archive), do not follow redirects and never
replay a mutation on their own; the one exception is a request a browser
sign-in's token is refused for (401), which is sent once more after a refresh. The archive goes up with the upload's own
short-lived capability, never the management token, and only to `MDRN_API_ORIGIN`.

Every change makes up an idempotency key (`cli-<uuid>`) when none is given, so
running a command again repeats the change; pass the same `--idempotency-key`
when retrying an ambiguous request so it is applied once. `request` sends only the
key it is given.

When the API refuses a credential (401), the error ends with what to do next
(`Run mdrn login.`, or to fix `MDRN_API_TOKEN`), and a missing `--project`,
`--environment` or `--service` points at `mdrn link`.

Exit codes: 0 success, 1 the API refused the request or it failed (including a
failed build or deployment and a timeout), 2 a usage error (unknown command,
missing or invalid option).

Canonical guide: https://app.notion.com/p/3ddec716de618113b2ece4849866e466

## Contributing

This repository is a mirror: the code is published here from MDRN's main repository on every
release, where it is tested together with the console, the API and the SDKs. Issues are welcome
here. Pull requests are reviewed here and merged in the main repository, from where the next
release brings them back.
