import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CliError, COMMANDS, CONSOLE_ONLY, execute, parse, readDataFromStdin, resolveCommand, safeApiPath } from "../src/client.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
// The raw-path rule the CLI shares with the MCP server, and the one table both test it against.
const paths = JSON.parse(read("./api-paths.json"));

test("builds a scoped product activation command", () => {
  const command = resolveCommand(parse(["products", "enable", "database", "--project", "project_one", "--environment", "sandbox", "--idempotency-key", "enable-one"]));
  assert.equal(command.path, "/v1/platform/projects/project_one/environments/sandbox/products/database/enable");
  assert.equal(command.idempotencyKey, "enable-one");
});

test("builds fenced lifecycle, usage, and billing commands", () => {
  assert.equal(resolveCommand(parse(["products", "delete", "mail", "--project", "p", "--environment", "production", "--idempotency-key", "delete-1"])).path, "/v1/platform/projects/p/environments/production/products/mail/delete");
  assert.equal(resolveCommand(parse(["usage", "get", "--workspace", "w", "--period", "period one"])).path, "/v1/platform/usage?workspaceId=w&periodId=period%20one");
  assert.deepEqual(resolveCommand(parse(["billing", "checkout", "--workspace", "w", "--plan", "base", "--return-path", "/billing", "--idempotency-key", "checkout-1"])).body, { planId: "base", returnPath: "/billing" });
});

test("sends bearer authority and prints only response data", async () => {
  let request;
  const result = await execute({ method: "GET", path: "/v1/deploy/services", project: "p", environment: "sandbox" }, { token: "secret", fetcher: async (url, init) => { request = { url, init }; return Response.json({ items: [] }); } });
  assert.deepEqual(result, { items: [] });
  assert.equal(request.init.headers.get("authorization"), "Bearer secret");
  assert.equal(request.init.headers.get("mdrn-project"), "p");
});

test("rejects a raw relative API path", () => {
  assert.throws(() => resolveCommand(parse(["request", "GET", "v1/platform/session"])), /absolute API path/);
});

test('refuses traversal and cross-origin raw requests before fetch',async()=>{
 for(const path of ['/v1/../internal/secrets','//evil.test/v1/x','/v1/platform/%2e%2e/secrets'])await assert.rejects(()=>execute({method:'GET',path},{token:'t',fetcher:()=>{throw Error('must not fetch')}}),/Unsafe API path/);
});
test('a malformed percent escape is an unsafe path with exit code 2, not a URIError',async()=>{
 for(const path of ['/v1/platform/projects/%zz','/v1/platform/projects/100%','/v1/platform/%E0%A4%A'])await assert.rejects(()=>execute({method:'GET',path},{token:'t',fetcher:()=>{throw Error('must not fetch')}}),error=>error instanceof CliError&&error.exitCode===2&&/Unsafe API path/.test(error.message));
});
test('bounds lifecycle request without retrying or following redirects',async()=>{
 let calls=0;const cmd=resolveCommand(parse(['products','restore','database','--project','p','--environment','sandbox','--idempotency-key','stable']));
 const result=await execute(cmd,{token:'t',fetcher:async(_,init)=>{calls++;assert.equal(init.redirect,'error');assert.ok(init.signal);assert.equal(init.headers.get('idempotency-key'),'stable');return Response.json({state:'pending'},{status:202});}});assert.equal(result.state,'pending');assert.equal(calls,1);
});

test('operation reads use canonical operation resource path',()=>{assert.equal(resolveCommand(parse(['operations','get','op_one'])).path,'/v1/platform/operations/op_one')});
test('rejects internal deployment stages as customer environments',()=>{assert.throws(()=>resolveCommand(parse(['products','list','--project','p','--environment','development'])),/sandbox or production/)});

test("adds a custom domain only with the quoted price named, and says how to accept a quote", async () => {
  const add = ["domains", "add", "--project", "p", "--environment", "sandbox", "--service", "svc_1", "--hostname", "shop.example.com", "--idempotency-key", "dom-1"];
  const free = resolveCommand(parse(add));
  assert.deepEqual(free.body, { serviceId: "svc_1", hostname: "shop.example.com" });
  assert.equal(free.project, "p");
  assert.deepEqual(resolveCommand(parse([...add, "--accept-charge", "150000"])).body.acceptCharge, { microUsdPerMonth: 150000 });
  assert.throws(() => resolveCommand(parse([...add, "--accept-charge"])), /micro-USD/);
  assert.equal(resolveCommand(parse(["domains", "verify", "dom_1", "--project", "p", "--environment", "sandbox"])).path, "/v1/deploy/domains/dom_1/verify");
  assert.equal(resolveCommand(parse(["domains", "remove", "dom_1", "--project", "p", "--environment", "sandbox"])).method, "DELETE");
  for (const args of [["verify", "dom_1"], ["move", "dom_1", "--service", "svc_2"], ["remove", "dom_1"]]) {
    assert.equal(resolveCommand(parse(["domains", ...args, "--project", "p", "--environment", "sandbox", "--idempotency-key", "k-1"])).idempotencyKey, "k-1");
    assert.match(resolveCommand(parse(["domains", ...args, "--project", "p", "--environment", "sandbox"])).idempotencyKey, /^cli-/);
  }
  const quota = { included: 5, used: 5, billable: 0, limit: 100, microUsdPerMonth: 150000, currency: "USD" };
  await assert.rejects(() => execute(free, { token: "t", fetcher: async () => Response.json({ error: { code: "DOMAIN_CHARGE_CONFIRMATION_REQUIRED", message: "Confirm the charge.", quota } }, { status: 402 }) }), /--accept-charge 150000/);
});

test("moves a custom domain to another deployment", () => {
  const command = resolveCommand(parse(["domains", "move", "dom_1", "--service", "svc_2", "--project", "p", "--environment", "sandbox"]));
  assert.equal(command.method, "PATCH");
  assert.deepEqual(command.body, { serviceId: "svc_2" });
});

test("switches sign-in on for one app origin, and lists an environment's origins", () => {
  const on = resolveCommand(parse(["identity", "enable", "--origin", "https://app.example.com", "--project", "p", "--environment", "sandbox", "--idempotency-key", "k"]));
  assert.equal(on.path, "/v1/platform/identity/activations");
  assert.deepEqual(on.body, { origin: "https://app.example.com", projectId: "p", environmentId: "sandbox" });
  assert.equal(resolveCommand(parse(["identity", "list", "--project", "p", "--environment", "production"])).path, "/v1/platform/projects/p/environments/production/identity/origins");
  assert.throws(() => resolveCommand(parse(["identity", "enable", "--origin", "https://app.example.com/path", "--project", "p", "--environment", "sandbox", "--idempotency-key", "k"])), /https origin/);
});
test('sends the token only to an https origin, defaulting to production', async () => {
  const seen = [];
  const fetcher = async url => { seen.push(url); return Response.json({ items: [] }); };
  const command = { method: "GET", path: "/v1/platform/projects" };
  await execute(command, { token: "t", fetcher });
  assert.equal(seen[0], "https://api.mdrn.io/v1/platform/projects");
  await assert.rejects(execute(command, { token: "t", origin: "http://api.mdrn.io", fetcher }), /https origin/);
  await execute(command, { token: "t", origin: "http://127.0.0.1:8787", fetcher });
  assert.equal(seen.length, 2);
});

test('adds a template, sets the delivery webhook and suppresses an address', () => {
  const base = '/v1/platform/projects/p/environments/production/mail/';
  const k = ['--project', 'p', '--environment', 'production', '--idempotency-key', 'k'];
  assert.deepEqual(resolveCommand(parse(['mail', 'templates', 'add', '--id', 'welcome', '--subject', 'Hi', '--text', 'Hello', ...k])), {method: 'POST', path: base + 'templates', idempotencyKey: 'k', body: {id: 'welcome', subject: 'Hi', text: 'Hello'}});
  assert.equal(resolveCommand(parse(['mail', 'callback', 'set', '--url', 'https://hooks.example.com/mail', ...k])).path, base + 'callback');
  assert.deepEqual(resolveCommand(parse(['mail', 'suppressions', 'add', '--email', 'a@example.com', ...k])).body, {email: 'a@example.com'});
});

test('a template keeps its HTML part, and Mail settings refuse unknown verbs and make up a retry key', () => {
  const k = ['--project', 'p', '--environment', 'sandbox', '--idempotency-key', 'k'];
  assert.equal(resolveCommand(parse(['mail', 'templates', 'add', '--id', 'w', '--subject', 'Hi', '--text', 'Hello', '--html', '<p>Hello</p>', ...k])).body.html, '<p>Hello</p>');
  assert.throws(() => resolveCommand(parse(['mail', 'templates', 'remove', '--id', 'w', ...k])), /mail templates add/);
  assert.match(resolveCommand(parse(['mail', 'suppressions', 'add', '--email', 'a@example.com', '--project', 'p', '--environment', 'sandbox'])).idempotencyKey, /^cli-[0-9a-f-]{36}$/);
  assert.throws(() => resolveCommand(parse(['mail', 'callback', 'set', '--url', 'https://h.example.com', '--project', 'p', '--environment', 'development', '--idempotency-key', 'k'])), /sandbox or production/);
});

test("parses --name=value, keeps an empty value empty, and never turns it into a positional", () => {
  assert.deepEqual(parse(["request", "POST", "/v1/x", "--data={\"a\":1}", "--idempotency-key", ""]), { positionals: ["request", "POST", "/v1/x"], options: { data: "{\"a\":1}", "idempotency-key": "" } });
  assert.deepEqual(parse(["--flag", "--name=a=b", "--", "--not-an-option"]), { positionals: ["--not-an-option"], options: { flag: true, "name": "a=b" } });
  assert.throws(() => resolveCommand(parse(["products", "enable", "database", "--project", "", "--environment", "sandbox", "--idempotency-key", "k"])), error => error.exitCode === 2 && /--project is required/.test(error.message));
});

test("request --data must be JSON, and a mistake there is a usage error", () => {
  assert.deepEqual(resolveCommand(parse(["request", "POST", "/v1/x", "--data", "{\"a\":1}"])).body, { a: 1 });
  assert.equal(resolveCommand(parse(["request", "GET", "/v1/x"])).body, undefined);
  for (const argv of [["--data", "{not json"], ["--data"]]) {
    assert.throws(() => resolveCommand(parse(["request", "POST", "/v1/x", ...argv])), error => error.exitCode === 2 && /--data/.test(error.message));
  }
});

test("the command line exits 2 on bad --data JSON", async () => {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, [new URL("../src/main.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "request", "POST", "/v1/x", "--data", "{oops"], { env: { ...process.env, MDRN_API_TOKEN: "t" }, encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--data is not valid JSON/);
});

test("enabling Database can choose its engine; nothing else takes one", () => {
  const base = ["products", "enable", "database", "--project", "p", "--environment", "sandbox", "--idempotency-key", "k"];
  assert.deepEqual(resolveCommand(parse(base)).body, {});
  assert.deepEqual(resolveCommand(parse([...base, "--engine", "postgres"])).body, { engine: "postgres" });
  assert.deepEqual(resolveCommand(parse([...base, "--engine=sqlite"])).body, { engine: "sqlite" });
  assert.throws(() => resolveCommand(parse([...base, "--engine", "mysql"])), /sqlite or postgres/);
  assert.throws(() => resolveCommand(parse(["products", "enable", "storage", "--project", "p", "--environment", "sandbox", "--idempotency-key", "k", "--engine", "postgres"])), /only to products enable database/);
  assert.throws(() => resolveCommand(parse(["products", "restore", "database", "--project", "p", "--environment", "sandbox", "--idempotency-key", "k", "--engine", "postgres"])), /only to products enable database/);
});

test("billing checkout buys the plan or $5 to $1000 of prepaid credit, never both", () => {
  const base = ["billing", "checkout", "--workspace", "w", "--return-path", "/billing", "--idempotency-key", "k"];
  assert.deepEqual(resolveCommand(parse([...base, "--credit-usd", "25"])).body, { creditUsd: 25, returnPath: "/billing" });
  assert.deepEqual(resolveCommand(parse([...base, "--credit-usd", "5"])).body.creditUsd, 5);
  assert.deepEqual(resolveCommand(parse([...base, "--credit-usd", "1000"])).body.creditUsd, 1000);
  for (const usd of ["4", "1001", "12.5", "-5", "ten", ""]) assert.throws(() => resolveCommand(parse([...base, "--credit-usd", usd])), error => error.exitCode === 2, usd);
  assert.throws(() => resolveCommand(parse(base)), /either --plan or --credit-usd/);
  assert.throws(() => resolveCommand(parse([...base, "--plan", "base", "--credit-usd", "25"])), /either --plan or --credit-usd/);
});

test("a value starting with -- needs --name=value", () => {
  assert.deepEqual(parse(["mail", "templates", "add", "--text", "--draft--"]).options, { text: true, "draft--": true });
  assert.equal(parse(["mail", "templates", "add", "--text=--draft--"]).options.text, "--draft--");
  assert.deepEqual(resolveCommand(parse(["request", "POST", "/v1/x", "--data={\"a\":\"--b\"}"])).body, { a: "--b" });
  assert.throws(() => resolveCommand(parse(["request", "POST", "/v1/x", "--data", "--idempotency-key", "k"])), /--data='--\.\.\.'|standard input/);
});

test("--data - reads the body from standard input, and only then", async () => {
  let reads = 0;
  const read = async () => { reads += 1; return '{"from":"stdin"}'; };
  const parsed = await readDataFromStdin(parse(["request", "POST", "/v1/x", "--data", "-", "--idempotency-key", "k"]), read);
  assert.deepEqual(resolveCommand(parsed).body, { from: "stdin" });
  assert.equal(reads, 1);
  const inline = parse(["request", "POST", "/v1/x", "--data", "{}"]);
  assert.equal(await readDataFromStdin(inline, read), inline);
  assert.equal(reads, 1);
  const bad = await readDataFromStdin(parse(["request", "POST", "/v1/x", "--data", "-"]), async () => "not json");
  assert.throws(() => resolveCommand(bad), /--data is not valid JSON/);
});

test("main.js sends the JSON piped to --data -", async () => {
  const { spawn } = await import("node:child_process");
  const { createServer } = await import("node:http");
  let received;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => { received = { method: request.method, url: request.url, body }; response.setHeader("content-type", "application/json"); response.end('{"ok":true}'); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const main = new URL("../src/main.js", import.meta.url);
    const child = spawn(process.execPath, [main.pathname.replace(/^\/([A-Za-z]:)/, "$1"), "request", "POST", "/v1/echo", "--data", "-", "--idempotency-key", "k", "--json"], {
      env: { ...process.env, MDRN_API_TOKEN: "t", MDRN_API_ORIGIN: `http://127.0.0.1:${server.address().port}` },
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stdin.end('{"piped":[1,2]}');
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(stdout), { ok: true });
    assert.deepEqual(received, { method: "POST", url: "/v1/echo", body: '{"piped":[1,2]}' });
  } finally {
    server.close();
  }
});

// Splits a README example line the way a shell would, for the quoting the README uses.
function words(line) {
  return [...line.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

test("the README lists every command, and every listed example resolves", async () => {
  const { readFile } = await import("node:fs/promises");
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const lines = readme.split(/\r?\n/).filter((line) => line.startsWith("mdrn "));
  for (const command of COMMANDS) {
    assert.ok(lines.some((line) => (line + " ").startsWith(`mdrn ${command} `)), `README lacks an example of ${command}`);
  }
  for (const line of lines) {
    assert.ok(COMMANDS.some((command) => (line + " ").startsWith(`mdrn ${command} `)), `README shows a command the CLI does not have: ${line}`);
    if (line.includes("...")) continue;
    const argv = words(line.replace(/#.*$/, "").replace(/\[[^\]]*\]/g, "").replace(/<.*$/, "")).slice(1);
    assert.doesNotThrow(() => resolveCommand(parse(argv)), `README example does not resolve: ${line}`);
  }
});

test("a raw path follows the shared rule: safe paths are fetched, every unsafe one is refused before fetch", async () => {
  for (const path of paths.safe) {
    assert.equal(safeApiPath(path, "https://api.mdrn.io"), true, path);
    let url;
    await execute({ method: "GET", path }, { token: "t", fetcher: async (target) => { url = target; return Response.json({}); } });
    assert.equal(url, `https://api.mdrn.io${path}`);
  }
  for (const path of paths.unsafe) {
    assert.equal(safeApiPath(path, "https://api.mdrn.io"), false, path);
    await assert.rejects(() => execute({ method: "GET", path }, { token: "t", fetcher: () => { throw Error("must not fetch"); } }), (error) => error instanceof CliError && error.exitCode === 2 && /Unsafe API path/.test(error.message), path);
  }
});

test("the MCP server holds the same raw-path rule, byte for byte", () => {
  // The function, from its signature to the closing brace at the start of a line.
  const rule = (text) => {
    const start = text.indexOf("export function safeApiPath(path, origin) {");
    assert.notEqual(start, -1);
    return text.slice(start, text.indexOf("\n}", start) + 2);
  };
  assert.equal(rule(read("../../mcp/src/server.js")), rule(read("../src/client.js")));
});

test("billing checkout and portal are refused before any request when the credential is a browser sign-in", async () => {
  const checkout = resolveCommand(parse(["billing", "checkout", "--workspace", "w", "--plan", "base", "--return-path", "/billing", "--idempotency-key", "k"]));
  const portal = resolveCommand(parse(["billing", "portal", "--workspace", "w", "--return-path", "/billing", "--idempotency-key", "k"]));
  assert.equal(checkout.consoleOnly, "billing checkout");
  assert.equal(portal.consoleOnly, "billing portal");
  const never = () => { throw new Error("must not fetch"); };
  for (const command of [checkout, portal]) {
    await assert.rejects(execute(command, { authType: "oauth", credential: async () => "access", fetcher: never }), (error) => error.exitCode === 2 && error.message === CONSOLE_ONLY[command.consoleOnly]);
  }
  assert.match(CONSOLE_ONLY["billing checkout"], /needs billing:write, which a browser sign-in never holds: use the console \(mdrn open billing\) or a management token \(MDRN_API_TOKEN\)/);
  // A management token, from the environment or the profile, sends it.
  let sent = 0;
  await execute(checkout, { authType: "env", token: "t", fetcher: async () => { sent += 1; return Response.json({ url: "https://checkout.example" }); } });
  await execute(checkout, { authType: "token", token: "t", fetcher: async () => { sent += 1; return Response.json({ url: "https://checkout.example" }); } });
  assert.equal(sent, 2);
  assert.deepEqual(Object.keys(CONSOLE_ONLY), ["billing checkout", "billing portal"]);
});

test("workspaces, projects create and tokens resolve to Platform routes, every change with a made-up key", () => {
  assert.deepEqual(resolveCommand(parse(["workspaces", "list"])), { method: "GET", path: "/v1/platform/workspaces", columns: ["id", "name", "role"] });
  const created = resolveCommand(parse(["projects", "create", "--name", "Shop", "--workspace", "ws_1"]));
  assert.equal(created.method, "POST");
  assert.equal(created.path, "/v1/platform/projects");
  assert.deepEqual(created.body, { workspaceId: "ws_1", name: "Shop" });
  assert.match(created.idempotencyKey, /^cli-[0-9a-f-]{36}$/);
  assert.equal(resolveCommand(parse(["projects", "create", "--name", "Shop", "--workspace", "ws_1", "--idempotency-key", "p-1"])).idempotencyKey, "p-1");
  assert.throws(() => resolveCommand(parse(["projects", "create", "--workspace", "ws_1"])), /--name is required/);
  assert.throws(() => resolveCommand(parse(["projects", "create", "--name", "Shop"])), /--workspace is required/);
  assert.equal(resolveCommand(parse(["tokens", "list", "--workspace", "ws 1"])).path, "/v1/platform/workspaces/ws%201/tokens");
  const revoke = resolveCommand(parse(["tokens", "revoke", "tok_1"]));
  assert.equal(revoke.method, "DELETE");
  assert.equal(revoke.path, "/v1/platform/tokens/tok_1");
  assert.match(revoke.idempotencyKey, /^cli-/);
  assert.throws(() => resolveCommand(parse(["tokens", "revoke"])), /A token ID is required/);
  assert.throws(() => resolveCommand(parse(["tokens", "create", "--name", "ci"])), /Unknown command tokens create\. Run mdrn tokens --help\./);
  // Every change makes a key up; the raw request sends only what it is given.
  for (const argv of [["products", "enable", "database", "--project", "p", "--environment", "sandbox"], ["identity", "enable", "--origin", "https://a.example", "--project", "p", "--environment", "sandbox"], ["billing", "portal", "--workspace", "w", "--return-path", "/b"], ["domains", "add", "--service", "s", "--hostname", "a.example", "--project", "p", "--environment", "sandbox"]]) {
    assert.match(resolveCommand(parse(argv)).idempotencyKey, /^cli-[0-9a-f-]{36}$/, argv.join(" "));
  }
  assert.equal(resolveCommand(parse(["request", "DELETE", "/v1/platform/tokens/tok_1"])).idempotencyKey, undefined);
});

test("tokens revoke says what a 403 to a browser sign-in means, and passes any other refusal through", async () => {
  const revoke = resolveCommand(parse(["tokens", "revoke", "tok_1"]));
  const forbidden = async () => Response.json({ error: { code: "FORBIDDEN", message: "workspace:write is required" } }, { status: 403 });
  await assert.rejects(execute(revoke, { authType: "oauth", credential: async () => "access", fetcher: forbidden }), (error) => error.exitCode === 2 && /tokens revoke needs workspace:write, which a browser sign-in never holds: revoke the token in the console \(mdrn open tokens\) or with a management token \(MDRN_API_TOKEN\)/.test(error.message));
  await assert.rejects(execute(revoke, { authType: "token", token: "t", fetcher: forbidden }), (error) => error.exitCode === 1 && error.status === 403 && /^FORBIDDEN: workspace:write is required$/.test(error.message));
  await assert.rejects(execute(revoke, { authType: "oauth", credential: async () => "access", fetcher: async () => Response.json({ error: { code: "NOT_FOUND", message: "no such token" } }, { status: 404 }) }), /NOT_FOUND/);
  // A 403 to anything else is the API's answer.
  await assert.rejects(execute(resolveCommand(parse(["workspaces", "list"])), { authType: "oauth", credential: async () => "access", fetcher: forbidden }), (error) => error.message === "FORBIDDEN: workspace:write is required");
  assert.equal(await execute(revoke, { authType: "oauth", credential: async () => "access", fetcher: async () => new Response(null, { status: 204 }) }), null);
});

test("a 401 to a sign-in's token refreshes it once and sends the request again with the new one", async () => {
  const bearers = [];
  const forced = [];
  const fetcher = async (_, init) => { bearers.push(init.headers.get("authorization")); return bearers.length === 1 ? Response.json({ error: { code: "UNAUTHENTICATED", message: "expired" } }, { status: 401 }) : Response.json({ ok: true }); };
  const credential = async (force) => { forced.push(force); return force ? "access2" : "access1"; };
  assert.deepEqual(await execute({ method: "GET", path: "/v1/platform/me" }, { credential, fetcher }), { ok: true });
  assert.deepEqual(bearers, ["Bearer access1", "Bearer access2"]);
  assert.deepEqual(forced, [false, true]);
  // A second 401 is the answer; a refresh that gives the same token is not retried; a fixed
  // token is never refreshed.
  const refused = async () => Response.json({ error: { code: "UNAUTHENTICATED", message: "still expired" } }, { status: 401 });
  await assert.rejects(execute({ method: "GET", path: "/v1/platform/me" }, { credential, fetcher: refused }), /UNAUTHENTICATED: still expired/);
  let calls = 0;
  await assert.rejects(execute({ method: "GET", path: "/v1/platform/me" }, { credential: async () => "same", fetcher: async () => { calls += 1; return refused(); } }), /UNAUTHENTICATED/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(execute({ method: "GET", path: "/v1/platform/me" }, { token: "fixed", credential: async () => { throw new Error("must not refresh"); }, fetcher: async () => { calls += 1; return refused(); } }), /UNAUTHENTICATED/);
  assert.equal(calls, 1);
});
