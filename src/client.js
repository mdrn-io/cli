import { randomUUID } from "node:crypto";

export class CliError extends Error {
  constructor(message, exitCode = 1) { super(message); this.exitCode = exitCode; }
}

// Options that never take a value, so `--json builds list` keeps `builds` as a positional.
const FLAGS = new Set(["json", "follow", "plain", "build", "no-browser", "help", "version"]);
export const DEFAULT_ORIGIN = "https://api.mdrn.io";

// `--name value`, `--name=value` and a bare `--name` (true). An empty value stays an empty
// string; everything after a lone `--` is positional. A value that itself starts with `--` would
// be read as the next option, so it is given as `--name=--value`. A single dash is a value
// (`--data -` reads standard input), except `-h`, which is `--help`.
export function parse(argv) {
  const positionals = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--") { positionals.push(...argv.slice(index + 1)); break; }
    if (value === "-h") { options.help = true; continue; }
    if (!value.startsWith("--")) { positionals.push(value); continue; }
    const equals = value.indexOf("=");
    if (equals > 2) { options[value.slice(2, equals)] = value.slice(equals + 1); continue; }
    const key = value.slice(2);
    if (!key) throw new CliError(`Invalid option ${value}`, 2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--") || FLAGS.has(key)) options[key] = true;
    else { options[key] = next; index += 1; }
  }
  return { positionals, options };
}

// Every command the CLI resolves, as --help shows it and the README lists it (a test compares the
// two): its name, the arguments after it, and one line on what it does. The scope flags
// (--workspace, --project, --environment, --service) are left out of the usage: a linked
// directory supplies them (mdrn link), and --help names them once.
const command = (name, usage, summary) => ({ name, usage, summary });
export const SPEC = [
  command("login", "[--workspace id] [--scopes a:b,c:d] [--no-browser] [--token secret|-] [--origin url]", "Sign in through the browser, or keep a management token"),
  command("logout", "", "Revoke the sign-in, or forget the token"),
  command("whoami", "", "Who the API says you are, and how the CLI holds that"),
  command("link", "[--project id] [--environment sandbox|production] [--service id]", "Write .mdrn/link.json so commands here need no scope flags"),
  command("init", "<dir>", "A new app from github.com/mdrn-io/app-template"),
  command("open", "[project|billing|tokens]", "Print and open the console page"),
  command("workspaces list", "", "The workspaces you belong to"),
  command("projects list", "", "The workspace's projects"),
  command("projects create", "--name <name>", "A project with a sandbox and a production environment"),
  command("products list", "", "The environment's products and their state"),
  command("products enable", "database|storage|mail|logs [--engine sqlite|postgres]", "Switch a product on (--engine only for database)"),
  command("products disable", "database|storage|mail|logs", "Switch a product off, keeping its data"),
  command("products delete", "database|storage|mail|logs", "Delete a product and its data (permanent)"),
  command("products restore", "database|storage|mail|logs", "Re-enable a disabled product"),
  command("identity list", "", "The app origins sign-in is on for"),
  command("identity enable", "--origin https://host", "Switch sign-in on for an app origin"),
  command("mail templates add", "--id id --subject text --text text [--html html]", "Add a template (a new version is a new id)"),
  command("mail callback set", "--url https://host/path", "Set the delivery webhook"),
  command("mail suppressions add", "--email address", "Stop mail to an address"),
  command("usage get", "[--period id]", "The workspace's metered usage"),
  command("billing get", "", "The workspace's plan, credit and invoices"),
  command("billing checkout", "--plan id | --credit-usd 5..1000, --return-path /path", "A checkout link for the plan or prepaid credit"),
  command("billing portal", "--return-path /path", "A link to the billing portal"),
  command("operations get", "<id>", "A pending operation's state"),
  command("deploy", "[dir] [--timeout 1800]", "Pack the directory, build it and wait until it is live"),
  command("deploy services", "", "The environment's services"),
  command("deploy get", "<id>", "One deployment"),
  command("services create", "--name name [--hostname-label label]", "A service, with its hostname"),
  command("services enable", "<id>", "Serve the service again"),
  command("services disable", "<id>", "Stop serving the service"),
  command("builds list", "", "The service's builds"),
  command("builds get", "<id>", "One build"),
  command("builds logs", "<id> [--follow]", "A build's output; --follow waits for the build to end"),
  command("builds cancel", "<id>", "Cancel a build"),
  command("releases list", "", "The service's releases, newest first"),
  command("deployments list", "", "The service's deployments"),
  command("deployments cancel", "<id>", "Cancel a deployment that has not finished"),
  command("rollback", "--artifact id", "Publish an earlier artifact and wait until it serves"),
  command("github connect", "--repo owner/name [--branch name]", "Build the service from pushes to a GitHub repository"),
  command("variables list", "", "The service's variables (never their secret values)"),
  command("variables set", "NAME --value text|- [--plain] [--build]", "Set a variable (secret unless --plain)"),
  command("variables unset", "NAME", "Remove a variable"),
  command("domains list", "", "The environment's custom domains"),
  command("domains add", "--hostname host [--accept-charge microUsd]", "Add a custom domain to the service"),
  command("domains get", "<id>", "One domain, with its verification state"),
  command("domains verify", "<id>", "Check the domain's DNS now"),
  command("domains move", "<id>", "Move the domain to the --service named"),
  command("domains remove", "<id>", "Remove the domain"),
  command("logs", "[--q text] [--level info,warn,error] [--since 15m|2h|1d] [--follow]", "Search the application logs, newest first; --follow repeats it every 3 s (a search, not a stream)"),
  command("logs trace", "<traceId>", "Every log item of one request, across services"),
  command("tokens list", "", "The workspace's management tokens (never their secrets)"),
  command("tokens revoke", "<id>", "Revoke a management token"),
  command("request", "METHOD /v1/path [--data json|-] [--idempotency-key key]", "A raw API request on the API origin"),
];
export const COMMANDS = SPEC.map((entry) => entry.name);
// The first words: `mdrn <group> --help` shows one group.
export const GROUPS = [...new Set(COMMANDS.map((name) => name.split(" ")[0]))];
// What the Platform lets only a console session do, so the CLI has no command for it.
export const CONSOLE_ONLY_NOTE = "Creating, rotating and editing management tokens (tokens create, rotate, edit) is the console's: mdrn open tokens.";

// `--data -` reads the JSON body from standard input, for a body too long or awkward to quote;
// `--value -` reads a variable's value from it, and `login --token -` a management token, so a
// secret stays out of shell history.
export async function readDataFromStdin(parsed, read) {
  if (parsed.options.data === "-") return { ...parsed, options: { ...parsed.options, data: await read() } };
  if (parsed.options.value === "-") return { ...parsed, options: { ...parsed.options, value: (await read()).replace(/\r?\n$/, "") } };
  if (parsed.options.token === "-" && parsed.positionals[0] === "login") return { ...parsed, options: { ...parsed.options, token: (await read()).replace(/\r?\n$/, "") } };
  return parsed;
}

// What a browser sign-in can never do, because the Platform grants no app the scope it needs:
// the console does it with the person's session, and a management token (MDRN_API_TOKEN)
// holds it. Refused before any request when the active credential is a sign-in.
export const CONSOLE_ONLY = {
  "billing checkout": "billing checkout needs billing:write, which a browser sign-in never holds: use the console (mdrn open billing) or a management token (MDRN_API_TOKEN)",
  "billing portal": "billing portal needs billing:write, which a browser sign-in never holds: use the console (mdrn open billing) or a management token (MDRN_API_TOKEN)",
};

// What a 403 to a browser sign-in means for a command the Platform refuses it by scope.
export const FORBIDDEN = {
  "tokens revoke": "tokens revoke needs workspace:write, which a browser sign-in never holds: revoke the token in the console (mdrn open tokens) or with a management token (MDRN_API_TOKEN)",
};

function jsonData(options) {
  if (options.data === undefined) return undefined;
  if (typeof options.data !== "string") throw new CliError("--data takes a JSON value: --data '{...}', --data='--...' for a value starting with --, or --data - to read standard input", 2);
  try { return JSON.parse(options.data); } catch { throw new CliError("--data is not valid JSON", 2); }
}

function required(options, name) {
  const value = options[name];
  if (typeof value !== "string" || !value) throw new CliError(`--${name} is required`, 2);
  return value;
}

function requiredEnvironment(options) {
  const value = required(options, "environment");
  if (!["sandbox", "production"].includes(value)) throw new CliError("--environment must be sandbox or production", 2);
  return value;
}

// Every change makes up a key when none is given. Repeating a command then repeats the change;
// pass the same --idempotency-key to make a retry apply it once.
function idempotencyKey(options) {
  if (options["idempotency-key"] === undefined) return `cli-${randomUUID()}`;
  return required(options, "idempotency-key");
}

function positional(value, what) {
  if (!value) throw new CliError(`${what} is required`, 2);
  return value;
}

const seconds = (options, name, fallback) => {
  if (options[name] === undefined) return fallback;
  const value = typeof options[name] === "string" && /^\d+$/.test(options[name]) ? Number(options[name]) : NaN;
  if (!Number.isSafeInteger(value) || value < 1) throw new CliError(`--${name} takes a whole number of seconds`, 2);
  return value;
};

// `--since 15m|2h|1d` as milliseconds; the API searches the last hour when it is left out.
function since(options) {
  if (options.since === undefined) return undefined;
  const match = typeof options.since === "string" ? /^(\d+)([smhd])$/.exec(options.since) : null;
  if (!match || Number(match[1]) < 1) throw new CliError("--since takes a number of seconds, minutes, hours or days, such as 15m, 2h or 1d", 2);
  return Number(match[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]];
}

export const LOG_LEVELS = ["debug", "log", "info", "warn", "error"];

// The console pages `open` knows.
export const OPEN_PAGES = ["project", "billing", "tokens"];

// The table columns a list shows by default; --json prints everything.
const COLUMNS = {
  builds: ["id", "state", "deploymentState", "revision", "errorCode", "createdAt"],
  releases: ["id", "artifactId", "generation", "createdAt"],
  deployments: ["id", "state", "artifactId", "buildId", "reason", "errorCode", "createdAt"],
  variables: ["name", "secret", "build", "updatedAt"],
  services: ["id", "name", "hostname", "activeReleaseId", "disabledAt"],
  workspaces: ["id", "name", "role"],
  tokens: ["id", "name", "scopes", "last4", "expiresAt", "lastUsedAt"],
  logs: ["timestamp", "kind", "level", "serviceName", "message", "method", "path", "status"],
};

// Commands of the Deploy API, all scoped to one project environment.
function resolveDeploy(group, action, value, options) {
  const scope = { project: required(options, "project"), environment: requiredEnvironment(options) };
  const id = encodeURIComponent;
  if (group === "deploy") {
    // Anything but `services` and `get` is the directory to deploy (`./services` for one so named).
    return { kind: "deploy", dir: action ?? ".", serviceId: required(options, "service"), idempotencyKey: idempotencyKey(options), timeout: seconds(options, "timeout", 1800), ...scope };
  }
  if (group === "builds") {
    if (action === "list") return { method: "GET", path: `/v1/deploy/builds?serviceId=${id(required(options, "service"))}`, columns: COLUMNS.builds, ...scope };
    if (action === "get") return { method: "GET", path: `/v1/deploy/builds/${id(positional(value, "A build ID"))}`, ...scope };
    if (action === "logs") return { kind: "logs", buildId: positional(value, "A build ID"), follow: options.follow === true, ...scope };
    if (action === "cancel") return { method: "POST", path: `/v1/deploy/builds/${id(positional(value, "A build ID"))}/cancel`, body: {}, idempotencyKey: idempotencyKey(options), ...scope };
  }
  if (group === "releases" && action === "list") return { method: "GET", path: `/v1/deploy/releases?serviceId=${id(required(options, "service"))}`, columns: COLUMNS.releases, ...scope };
  if (group === "deployments" && action === "list") return { method: "GET", path: `/v1/deploy/deployments?serviceId=${id(required(options, "service"))}`, columns: COLUMNS.deployments, ...scope };
  if (group === "deployments" && action === "cancel") return { method: "POST", path: `/v1/deploy/deployments/${id(positional(value, "A deployment ID"))}/cancel`, body: {}, idempotencyKey: idempotencyKey(options), ...scope };
  if (group === "logs") {
    if (action === "trace") return { method: "GET", path: `/v1/deploy/logs/trace/${id(positional(value, "A trace ID"))}`, columns: COLUMNS.logs, ...scope };
    // The search's terms; `from` comes from --since here, and is moved on by --follow.
    const query = {};
    if (options.q !== undefined) query.q = required(options, "q");
    if (options.level !== undefined) {
      const levels = required(options, "level").split(",").map((level) => level.trim());
      if (!levels.every((level) => LOG_LEVELS.includes(level))) throw new CliError(`--level is a comma-separated list of ${LOG_LEVELS.join(", ")}`, 2);
      query.level = levels.join(",");
    }
    if (options.service !== undefined) query.service = required(options, "service");
    const window = since(options);
    return { kind: "search", method: "GET", path: "/v1/deploy/logs", query, from: window === undefined ? undefined : Date.now() - window, follow: options.follow === true, columns: COLUMNS.logs, ...scope };
  }
  if (group === "rollback") {
    // A release that served before goes out again as a new deployment; the CLI waits for it.
    return { kind: "publish", body: { serviceId: required(options, "service"), artifactId: required(options, "artifact") }, idempotencyKey: idempotencyKey(options), timeout: seconds(options, "timeout", 600), ...scope };
  }
  if (group === "services") {
    if (action === "create") {
      const body = { name: required(options, "name") };
      if (options["hostname-label"] !== undefined) body.hostnameLabel = required(options, "hostname-label");
      return { method: "POST", path: "/v1/deploy/services", body, idempotencyKey: idempotencyKey(options), ...scope };
    }
    if (action === "enable" || action === "disable") return { method: "POST", path: `/v1/deploy/services/${id(positional(value, "A service ID"))}/${action}`, body: {}, idempotencyKey: idempotencyKey(options), ...scope };
  }
  if (group === "github" && action === "connect") {
    const repository = required(options, "repo");
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new CliError("--repo is owner/name, as on GitHub", 2);
    return { kind: "github", serviceId: required(options, "service"), repository, branch: options.branch === undefined ? undefined : required(options, "branch"), idempotencyKey: idempotencyKey(options), ...scope };
  }
  if (group === "variables") {
    const base = `/v1/deploy/services/${id(required(options, "service"))}/variables`;
    if (action === "list") return { method: "GET", path: base, columns: COLUMNS.variables, ...scope };
    if (action === "set" || action === "unset") {
      const name = positional(value, "A variable name");
      if (!/^[A-Z0-9_]{1,64}$/.test(name) || name.startsWith("MDRN_")) throw new CliError("A variable is named in capitals, digits and underscores, at most 64 characters, and never begins with MDRN_", 2);
      if (action === "unset") return { method: "DELETE", path: `${base}/${name}`, idempotencyKey: idempotencyKey(options), ...scope };
      // Secret unless --plain; --build also hands it to the build.
      return { method: "PUT", path: `${base}/${name}`, body: { value: required(options, "value"), secret: options.plain !== true, build: options.build === true }, idempotencyKey: idempotencyKey(options), ...scope };
    }
  }
  return undefined;
}

export function resolveCommand(parsed) {
  const [group, action, value] = parsed.positionals;
  const { options } = parsed;
  // A group's unknown action is said before any scope flag is asked for (a group that is itself
  // a command, such as deploy <dir>, takes any word).
  if (GROUPS.includes(group) && (group === "logs" ? action !== undefined : !COMMANDS.includes(group)) && !COMMANDS.some((name) => name === `${group} ${action}` || name.startsWith(`${group} ${action} `))) throw new CliError(unknown(parsed.positionals), 2);
  if (group === "request") {
    const method = (action || "GET").toUpperCase();
    const path = value;
    if (!path?.startsWith("/")) throw new CliError("request requires METHOD and an absolute API path", 2);
    return { method, path, body: jsonData(options), idempotencyKey: options["idempotency-key"] };
  }
  if (group === "projects" && action === "list") {
    return { method: "GET", path: `/v1/platform/projects?workspaceId=${encodeURIComponent(required(options, "workspace"))}` };
  }
  if (group === "projects" && action === "create") {
    return { method: "POST", path: "/v1/platform/projects", body: { workspaceId: required(options, "workspace"), name: required(options, "name") }, idempotencyKey: idempotencyKey(options) };
  }
  if (group === "workspaces" && action === "list") return { method: "GET", path: "/v1/platform/workspaces", columns: COLUMNS.workspaces };
  if (group === "tokens" && action === "list") {
    return { method: "GET", path: `/v1/platform/workspaces/${encodeURIComponent(required(options, "workspace"))}/tokens`, columns: COLUMNS.tokens };
  }
  if (group === "tokens" && action === "revoke") {
    // Revoking another token needs workspace:write, which no OAuth client is granted: a sign-in
    // is answered 403, which is said in those words.
    return { method: "DELETE", path: `/v1/platform/tokens/${encodeURIComponent(positional(value, "A token ID"))}`, idempotencyKey: idempotencyKey(options), forbidden: FORBIDDEN["tokens revoke"] };
  }
  if (group === "products" && action === "list") {
    const project = required(options, "project"); const environment = requiredEnvironment(options);
    return { method: "GET", path: `/v1/platform/projects/${encodeURIComponent(project)}/environments/${encodeURIComponent(environment)}/products` };
  }
  if (group === "products" && ["enable", "disable", "delete", "restore"].includes(action)) {
    const project = required(options, "project"); const environment = requiredEnvironment(options);
    if (!["database","storage","mail","logs"].includes(value)) throw new CliError(`products ${action} requires database, storage, mail or logs`, 2);
    // Only enabling Database chooses an engine; without --engine it is SQLite.
    const body = {};
    if (options.engine !== undefined) {
      if (value !== "database" || action !== "enable") throw new CliError("--engine applies only to products enable database", 2);
      if (!["sqlite", "postgres"].includes(options.engine)) throw new CliError("--engine must be sqlite or postgres", 2);
      body.engine = options.engine;
    }
    return { method: "POST", path: `/v1/platform/projects/${encodeURIComponent(project)}/environments/${encodeURIComponent(environment)}/products/${encodeURIComponent(value)}/${action}`, body, idempotencyKey: idempotencyKey(options) };
  }
  if (group === "mail" && ["templates", "callback", "suppressions"].includes(action)) {
    const project = required(options, "project"); const environment = requiredEnvironment(options);
    const path = `/v1/platform/projects/${encodeURIComponent(project)}/environments/${encodeURIComponent(environment)}/mail/${action}`;
    const key = idempotencyKey(options);
    // A template never changes once added: a new version is a new ID.
    if (action === "templates" && value === "add") return { method: "POST", path, idempotencyKey: key, body: { id: required(options, "id"), subject: required(options, "subject"), text: required(options, "text"), ...(typeof options.html === "string" ? { html: options.html } : {}) } };
    // The delivery webhook; the answer carries its signing key the first time only.
    if (action === "callback" && value === "set") return { method: "POST", path, idempotencyKey: key, body: { url: required(options, "url") } };
    if (action === "suppressions" && value === "add") return { method: "POST", path, idempotencyKey: key, body: { email: required(options, "email") } };
    throw new CliError("Use mail templates add, mail callback set or mail suppressions add", 2);
  }
  if (group === "identity" && action === "list") {
    const project = required(options, "project"); const environment = requiredEnvironment(options);
    return { method: "GET", path: `/v1/platform/projects/${encodeURIComponent(project)}/environments/${encodeURIComponent(environment)}/identity/origins` };
  }
  if (group === "identity" && action === "enable") {
    // Sign-in is switched on per app hostname: the origin is one Deploy serves for this environment.
    const origin = required(options, "origin");
    if (!/^https:\/\/[^/]+$/.test(origin)) throw new CliError("--origin must be an https origin, such as https://app.example.com", 2);
    return { method: "POST", path: "/v1/platform/identity/activations", body: { origin, projectId: required(options, "project"), environmentId: requiredEnvironment(options) }, idempotencyKey: idempotencyKey(options) };
  }
  if (group === "usage" && action === "get") {
    const workspace = required(options, "workspace");
    const period = typeof options.period === "string" ? `&periodId=${encodeURIComponent(options.period)}` : "";
    return { method: "GET", path: `/v1/platform/usage?workspaceId=${encodeURIComponent(workspace)}${period}` };
  }
  if (group === "billing" && action === "get") {
    return { method: "GET", path: `/v1/platform/workspaces/${encodeURIComponent(required(options, "workspace"))}/billing` };
  }
  if (group === "billing" && action === "checkout") {
    const workspace = required(options, "workspace");
    // Checkout buys either the plan or prepaid credit in whole dollars ($5 to $1000), not both.
    if ((options.plan === undefined) === (options["credit-usd"] === undefined)) throw new CliError("billing checkout takes either --plan or --credit-usd", 2);
    let purchase;
    if (options.plan !== undefined) purchase = { planId: required(options, "plan") };
    else {
      const usd = typeof options["credit-usd"] === "string" && /^\d+$/.test(options["credit-usd"]) ? Number(options["credit-usd"]) : NaN;
      if (!Number.isSafeInteger(usd) || usd < 5 || usd > 1000) throw new CliError("--credit-usd takes whole US dollars from 5 to 1000", 2);
      purchase = { creditUsd: usd };
    }
    return { method: "POST", path: `/v1/platform/workspaces/${encodeURIComponent(workspace)}/billing/checkout`, body: { ...purchase, returnPath: required(options, "return-path") }, idempotencyKey: idempotencyKey(options), consoleOnly: "billing checkout" };
  }
  if (group === "billing" && action === "portal") {
    const workspace = required(options, "workspace");
    return { method: "POST", path: `/v1/platform/workspaces/${encodeURIComponent(workspace)}/billing/portal`, body: { returnPath: required(options, "return-path") }, idempotencyKey: idempotencyKey(options), consoleOnly: "billing portal" };
  }
  if (group === "operations" && action === "get") {
    if (!value) throw new CliError("operations get requires an operation ID", 2);
    return { method: "GET", path: `/v1/platform/operations/${encodeURIComponent(value)}` };
  }
  if (group === "whoami" && !action) return { kind: "whoami", method: "GET", path: "/v1/platform/me" };
  if (group === "login" && !action) {
    // The sign-in's own options; --origin is the API origin here (identity enable's is an app's).
    const scopes = options.scopes === undefined ? undefined : required(options, "scopes").split(",").map((s) => s.trim()).filter(Boolean);
    if (scopes && !scopes.every((s) => /^[a-z]+:[a-z]+$/.test(s))) throw new CliError("--scopes is a comma-separated list such as project:read,deploy:write", 2);
    if (options.token !== undefined && typeof options.token !== "string") throw new CliError("--token takes a management token, or - to read it from standard input", 2);
    return { kind: "login", origin: options.origin === undefined ? undefined : required(options, "origin"), workspace: options.workspace === undefined ? undefined : required(options, "workspace"), scopes, browser: options["no-browser"] !== true, token: options.token };
  }
  if (group === "logout" && !action) return { kind: "logout" };
  if (group === "link" && !action) {
    const chosen = {};
    for (const key of ["project", "environment", "service"]) if (options[key] !== undefined) chosen[key] = required(options, key);
    if (chosen.environment !== undefined) requiredEnvironment(options);
    return { kind: "link", workspace: options.workspace === undefined ? undefined : required(options, "workspace"), ...chosen };
  }
  if (group === "init" && !value) return { kind: "init", dir: positional(action, "A directory to create") };
  if (group === "open" && !value) {
    if (action !== undefined && !OPEN_PAGES.includes(action)) throw new CliError(`open takes ${OPEN_PAGES.join(", ")} or nothing`, 2);
    return { kind: "open", page: action ?? "project", project: options.project, environment: options.environment };
  }
  if (group === "deploy" && action === "services") {
    return { method: "GET", path: "/v1/deploy/services", columns: COLUMNS.services, project: required(options, "project"), environment: requiredEnvironment(options) };
  }
  if (group === "deploy" && action === "get") {
    if (!value) throw new CliError("deploy get requires a deployment ID", 2);
    return { method: "GET", path: `/v1/deploy/deployments/${encodeURIComponent(value)}`, project: required(options, "project"), environment: requiredEnvironment(options) };
  }
  if (["deploy", "builds", "releases", "deployments", "rollback", "services", "github", "variables", "logs"].includes(group)) {
    const command = resolveDeploy(group, action, value, options);
    if (command) return command;
  }
  if (group === "domains") {
    const scope = { project: required(options, "project"), environment: requiredEnvironment(options) };
    if (action === "list") return { method: "GET", path: "/v1/deploy/domains", ...scope };
    if (action === "add") {
      // Beyond the included hostnames the price must be named, never assumed: pass the
      // micro-USD amount Deploy quoted, which it checks against the current price.
      const body = { serviceId: required(options, "service"), hostname: required(options, "hostname") };
      if (options["accept-charge"] !== undefined) {
        const price = typeof options["accept-charge"] === "string" ? Number(options["accept-charge"]) : NaN;
        if (!Number.isSafeInteger(price) || price <= 0) throw new CliError("--accept-charge takes the quoted monthly price in micro-USD, e.g. 150000", 2);
        body.acceptCharge = { microUsdPerMonth: price };
      }
      return { method: "POST", path: "/v1/deploy/domains", body, idempotencyKey: idempotencyKey(options), ...scope };
    }
    if (["get", "verify", "move", "remove"].includes(action)) {
      if (!value) throw new CliError(`domains ${action} requires a domain ID`, 2);
      const path = `/v1/deploy/domains/${encodeURIComponent(value)}`;
      if (action === "get") return { method: "GET", path, ...scope };
      if (action === "verify") return { method: "POST", path: path + "/verify", body: {}, idempotencyKey: idempotencyKey(options), ...scope };
      if (action === "move") return { method: "PATCH", path, body: { serviceId: required(options, "service") }, idempotencyKey: idempotencyKey(options), ...scope };
      return { method: "DELETE", path, idempotencyKey: idempotencyKey(options), ...scope };
    }
  }
  throw new CliError(unknown(parsed.positionals), 2);
}

// One line, pointing at the help that lists what there is.
export function unknown(positionals) {
  const [group] = positionals;
  if (!group) return "A command is required. Run mdrn --help.";
  const known = GROUPS.includes(group);
  return `Unknown command ${positionals.slice(0, known ? 2 : 1).join(" ")}. Run mdrn ${known ? `${group} ` : ""}--help.`;
}

// The token is a bearer credential: it only ever travels over https (plain http is allowed for a
// local development server on this machine).
export function secureOrigin(origin) {
  let url;
  try { url = new URL(origin); } catch { throw new CliError("MDRN_API_ORIGIN must be an https origin", 2); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new CliError("MDRN_API_ORIGIN must be an https origin", 2);
  return origin;
}
// A raw API path stays on the API origin under /v1/: no backslash (raw or encoded), fragment, dot
// segment or encoded slash (%2f, which a server may decode into another route), and no malformed
// percent escape, which decodeURIComponent cannot read. The MCP server (mcp/src/server.js) holds
// this function byte for byte; both packages test it against cli/test/api-paths.json, and the
// CLI's test fails when the two copies differ.
export function safeApiPath(path, origin) {
  if (typeof path !== "string" || !path.startsWith("/v1/") || path.includes("\\") || path.includes("#")) return false;
  let parsed, decoded;
  try {
    parsed = new URL(path, origin);
    decoded = decodeURIComponent(parsed.pathname);
  } catch {
    return false;
  }
  return parsed.origin === new URL(origin).origin && parsed.pathname === path.split("?")[0] && !/%2f/i.test(parsed.pathname)
    && !decoded.includes("\\") && !decoded.split("/").some((part) => part === "." || part === "..");
}
// The bearer is a fixed `token`, or comes from `credential(force)`: a browser sign-in's access
// token, refreshed when about to expire, and refreshed once more (force) when the API answers
// 401 to it, after which the request is sent once again with the new one.
export async function execute(command, { token, credential, authType, origin = DEFAULT_ORIGIN, fetcher = globalThis.fetch, timeoutMs = 10_000 }) {
  if (command.consoleOnly && authType === "oauth") throw new CliError(CONSOLE_ONLY[command.consoleOnly], 2);
  const bearer = token ?? (credential ? await credential(false) : undefined);
  if (!bearer) throw new CliError("MDRN_API_TOKEN is required", 2);
  secureOrigin(origin);
  if (!["GET","POST","PUT","PATCH","DELETE"].includes(command.method)) throw new CliError("Unsupported method",2);
  if (!safeApiPath(command.path, origin)) throw new CliError("Unsafe API path", 2);
  const send = (value) => {
    const headers = new Headers({ Accept: "application/json", Authorization: `Bearer ${value}` });
    if (command.project) headers.set("MDRN-Project", command.project);
    if (command.environment) headers.set("MDRN-Environment", command.environment);
    if (command.idempotencyKey) headers.set("Idempotency-Key", command.idempotencyKey);
    if (command.body !== undefined) headers.set("Content-Type", "application/json");
    return fetcher(origin.replace(/\/$/, "") + command.path, { method: command.method, headers, redirect:"error", signal:AbortSignal.timeout(timeoutMs), body: command.body === undefined ? undefined : JSON.stringify(command.body) });
  };
  let response = await send(bearer);
  if (response.status === 401 && token === undefined && credential) {
    const renewed = await credential(true);
    if (renewed !== bearer) response = await send(renewed);
  }
  if (response.status === 403 && command.forbidden && authType === "oauth") throw new CliError(command.forbidden, 2);
  return readResponse(response);
}

// An API answer's JSON, or the refusal it carries as a CliError (exit code 1) with the status.
export async function readResponse(response) {
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  if (!response.ok) {
    const error = body?.error ?? body ?? {};
    // A quote is part of the answer: say exactly what to pass to accept it.
    const quote = error.code === "DOMAIN_CHARGE_CONFIRMATION_REQUIRED" && Number.isSafeInteger(error.quota?.microUsdPerMonth) ? `
To add it for $${(error.quota.microUsdPerMonth / 1e6).toFixed(2)} per month, run the same command with --accept-charge ${error.quota.microUsdPerMonth}.` : "";
    throw Object.assign(new CliError(`${error.code ?? `HTTP_${response.status}`}: ${error.message ?? response.statusText}${quote}`), { status: response.status });
  }
  return body;
}
