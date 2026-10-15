import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, resolveCommand } from "../src/client.js";
import { credential, readConfig, settings, writeConfig } from "../src/config.js";
import { forget, pkce, SCOPES } from "../src/auth.js";
import { session } from "../src/session.js";

// A fake Platform: RFC 8414 metadata, registration, the code and refresh grants with PKCE and
// rotation (a refresh token presented twice ends the grant), revocation, token-info and me.
// Its console is the same origin; the test's "browser" turns an authorize URL into the redirect.
async function fakeAuthServer({ codeSeconds = 60, now = () => Math.floor(Date.now() / 1000) } = {}) {
  const state = { clients: [], codes: new Map(), grants: new Map(), refreshes: new Map(), accesses: new Map(), revoked: [], calls: [], next: 1 };
  const issue = (grant) => {
    const access = `mdrn_mgmt_access_${state.next}`;
    const refresh = `mdrn_rt_${state.next++}`;
    state.accesses.set(access, grant);
    state.refreshes.set(refresh, { grant, used: false });
    return { access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: grant.scopes.join(" ") };
  };
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url, origin);
      const text = Buffer.concat(chunks).toString();
      const form = Object.fromEntries(new URLSearchParams(text));
      state.calls.push({ method: request.method, path: url.pathname, form, authorization: request.headers.authorization });
      const json = (status, body) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
      const refusal = (status, error, description) => json(status, { error, error_description: description });
      const bearer = request.headers.authorization?.replace(/^Bearer /, "");
      if (url.pathname === "/.well-known/oauth-authorization-server") return json(200, { issuer: origin, authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`, registration_endpoint: `${origin}/oauth/register`, revocation_endpoint: `${origin}/oauth/revoke`, scopes_supported: SCOPES, code_challenge_methods_supported: ["S256"] });
      if (url.pathname === "/oauth/register") {
        const input = JSON.parse(text);
        const client = { client_id: `oac_${state.clients.length + 1}`, redirect_uris: input.redirect_uris, client_name: input.client_name };
        state.clients.push(client);
        return json(201, client);
      }
      if (url.pathname === "/oauth/token") {
        if (!state.clients.some((c) => c.client_id === form.client_id)) return refusal(401, "invalid_client", "The client is not registered.");
        if (form.grant_type === "authorization_code") {
          const code = state.codes.get(form.code);
          if (!code || code.used || code.expiresAt <= now() || code.redirectUri !== form.redirect_uri || code.clientId !== form.client_id || createHash("sha256").update(form.code_verifier ?? "").digest("base64url") !== code.challenge) return refusal(400, "invalid_grant", "The code is invalid, used or expired.");
          code.used = true;
          const grant = { id: `oag_${state.grants.size + 1}`, workspace: code.workspace, scopes: code.scopes, clientId: form.client_id, revoked: false };
          state.grants.set(grant.id, grant);
          return json(200, issue(grant));
        }
        if (form.grant_type === "refresh_token") {
          const row = state.refreshes.get(form.refresh_token);
          if (!row) return refusal(400, "invalid_grant", "The refresh token is invalid.");
          if (row.used) { row.grant.revoked = true; return refusal(400, "invalid_grant", "The refresh token was already used."); }
          if (row.grant.revoked) return refusal(400, "invalid_grant", "The grant was revoked or has expired.");
          row.used = true;
          return json(200, issue(row.grant));
        }
        return refusal(400, "unsupported_grant_type", "Use authorization_code or refresh_token.");
      }
      if (url.pathname === "/oauth/revoke") {
        state.revoked.push(form.token);
        const grant = state.refreshes.get(form.token)?.grant ?? state.accesses.get(form.token);
        if (grant) grant.revoked = true;
        return json(200, {});
      }
      const grant = state.accesses.get(bearer);
      if (!grant || grant.revoked) return json(401, { error: { code: "UNAUTHENTICATED", message: "The credential is invalid." } });
      if (url.pathname === "/v1/platform/oauth/token-info") return json(200, { credentialId: "cred_1", accountId: "acc_1", scopes: grant.scopes, workspaceIds: [grant.workspace], projectIds: null, environmentIds: null, expiresAt: now() + 3600, grantId: grant.id, clientId: grant.clientId, resource: null });
      if (url.pathname === "/v1/platform/me") return json(200, { account: { id: "acc_1", displayName: "Ann" }, user: { email: "ann@example.com" }, grants: [{ workspaceId: grant.workspace, role: "Admin", scopes: grant.scopes }], billingConfigured: true });
      json(404, { error: { code: "NOT_FOUND", message: url.pathname } });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  // What the console does once the person approves: a code bound to the request, sent back to
  // the redirect URI with the state and the issuer. `tamper` changes what is sent back.
  const browser = ({ workspace = "ws_1", tamper = {} } = {}) => async (url) => {
    const query = new URL(url).searchParams;
    assert.equal(query.get("response_type"), "code");
    assert.equal(query.get("code_challenge_method"), "S256");
    const code = `mdrn_code_${state.codes.size + 1}`;
    state.codes.set(code, { clientId: query.get("client_id"), redirectUri: query.get("redirect_uri"), challenge: query.get("code_challenge"), scopes: query.get("scope").split(" "), workspace, expiresAt: now() + codeSeconds, used: false });
    const redirect = new URL(query.get("redirect_uri"));
    for (const [key, value] of Object.entries({ code, state: query.get("state"), iss: origin, ...tamper })) redirect.searchParams.set(key, value);
    state.lastRedirect = redirect.href;
    const answer = await fetch(redirect, { redirect: "manual" });
    state.lastPage = { status: answer.status, text: await answer.text() };
    return true;
  };
  return { origin, state, browser, close: () => new Promise((resolve) => server.close(resolve)) };
}

function home() {
  const dir = mkdtempSync(join(tmpdir(), "mdrn-auth-"));
  return { dir, path: join(dir, "config.json"), env: { MDRN_CONFIG: join(dir, "config.json") }, done: () => rmSync(dir, { recursive: true, force: true }) };
}

function output() {
  const out = [];
  const err = [];
  return { out, err, context: { out: (line) => out.push(line), err: (line) => err.push(line) } };
}

async function login(argv, env, fake, extra = {}) {
  const parsed = parse(["login", "--origin", fake.origin, ...argv]);
  const configured = settings(env, parsed.options, { lenient: true });
  const { out, err, context } = output();
  const result = await session(resolveCommand({ ...parsed, options: configured.options }), { ...context, configured, open: fake.browser(), signInMs: 2000, ...extra });
  return { result, out, err };
}

test("pkce makes a 64-character base64url verifier whose S256 is the challenge", () => {
  const { verifier, challenge } = pkce();
  assert.match(verifier, /^[A-Za-z0-9_-]{64}$/);
  assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"));
  assert.equal(challenge.length, 43);
});

test("login registers the CLI, opens the consent page, exchanges the code and writes the profile", async () => {
  const fake = await fakeAuthServer();
  const { path, env, done } = home();
  try {
    forget();
    const { err } = await login([], env, fake);
    assert.equal(fake.state.clients.length, 1, "registered once");
    assert.deepEqual(fake.state.clients[0].redirect_uris.length, 1);
    assert.match(fake.state.clients[0].redirect_uris[0], /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    assert.equal(fake.state.lastPage.status, 200);
    assert.match(fake.state.lastPage.text, /Signed in, you can close this tab/);
    const config = readConfig(path);
    const profile = config.profiles.default;
    assert.equal(profile.origin, fake.origin);
    assert.equal(profile.console, fake.origin);
    assert.equal(profile.workspace, "ws_1");
    assert.equal(profile.token, undefined);
    assert.deepEqual(profile.auth, { type: "oauth", clientId: "oac_1", accessToken: "mdrn_mgmt_access_1", refreshToken: "mdrn_rt_1", expiresAt: profile.auth.expiresAt, scopes: SCOPES, account: "acc_1" });
    assert.ok(profile.auth.expiresAt > Math.floor(Date.now() / 1000) + 3000);
    assert.deepEqual(config.clients[fake.origin], { clientId: "oac_1", redirectUri: fake.state.clients[0].redirect_uris[0] });
    assert.match(err.at(-1), /^Signed in as ann@example\.com in workspace ws_1 \(scopes account:read .*\)\. Next: cd your-app && mdrn link$/);
    const exchange = fake.state.calls.find((c) => c.path === "/oauth/token");
    assert.equal(exchange.form.grant_type, "authorization_code");
    assert.equal(exchange.form.client_id, "oac_1");
    assert.ok(fake.state.calls.some((c) => c.path === "/v1/platform/oauth/token-info" && c.authorization === "Bearer mdrn_mgmt_access_1"));
    // The next sign-in reuses the client and port, replaces the credential and ends the old grant.
    forget();
    await login(["--scopes", "project:read,deploy:read"], env, fake);
    assert.equal(fake.state.clients.length, 1, "no second registration");
    assert.deepEqual(fake.state.revoked, ["mdrn_rt_1"]);
    const again = readConfig(path).profiles.default.auth;
    assert.equal(again.accessToken, "mdrn_mgmt_access_2");
    assert.deepEqual(again.scopes, ["project:read", "deploy:read"]);
  } finally { await fake.close(); done(); }
});

test("an answer with another state or issuer is refused, and no code is exchanged", async () => {
  const fake = await fakeAuthServer();
  const { path, env, done } = home();
  try {
    forget();
    await assert.rejects(login([], env, fake, { open: fake.browser({ tamper: { state: "forged" } }) }), /another state; run mdrn login again/);
    assert.equal(fake.state.lastPage.status, 400);
    await assert.rejects(login([], env, fake, { open: fake.browser({ tamper: { iss: "https://evil.example" } }) }), /issuer https:\/\/evil\.example, not/);
    assert.equal(fake.state.lastPage.status, 400);
    await assert.rejects(login([], env, fake, { open: fake.browser({ tamper: { error: "access_denied", code: "" } }) }), /The sign-in was refused/);
    assert.ok(!fake.state.calls.some((c) => c.path === "/oauth/token"), "nothing was exchanged");
    assert.equal(readConfig(path).profiles.default, undefined);
  } finally { await fake.close(); done(); }
});

test("an expired code is refused by the server and login fails", async () => {
  const fake = await fakeAuthServer({ codeSeconds: -1 });
  const { path, env, done } = home();
  try {
    forget();
    await assert.rejects(login([], env, fake), /invalid_grant: The code is invalid, used or expired/);
    assert.equal(readConfig(path).profiles.default, undefined);
  } finally { await fake.close(); done(); }
});

test("--workspace is checked against what was approved: a mismatch revokes the grant and exits 1", async () => {
  const fake = await fakeAuthServer();
  const { path, env, done } = home();
  try {
    forget();
    await assert.rejects(login(["--workspace", "ws_2"], env, fake), (error) => error.exitCode === 1 && error.message === "You approved ws_1; run again and pick ws_2");
    assert.deepEqual(fake.state.revoked, ["mdrn_rt_1"]);
    assert.equal(readConfig(path).profiles.default, undefined);
    await login(["--workspace", "ws_1"], env, fake);
    assert.equal(readConfig(path).profiles.default.workspace, "ws_1");
  } finally { await fake.close(); done(); }
});

// The signed-in profile with its access token expired `ago` seconds ago (its refresh token as
// it is: the one the server knows).
function expired(path, fake, ago = 10) {
  const config = readConfig(path);
  config.profiles.default.auth.expiresAt = Math.floor(Date.now() / 1000) - ago;
  writeConfig(path, config);
}

test("an expiring access token is refreshed, the pair rotated on disk, and a used refresh token is not presented again", async () => {
  const fake = await fakeAuthServer();
  const { path, env, done } = home();
  try {
    forget();
    await login([], env, fake);
    const fresh = settings(env, {});
    assert.equal(await credential(fresh), "mdrn_mgmt_access_1", "a fresh token is used as it is");
    assert.equal(fake.state.calls.filter((c) => c.form.grant_type === "refresh_token").length, 0);
    expired(path, fake);
    const stale = settings(env, {});
    assert.equal(await credential(stale), "mdrn_mgmt_access_2");
    const saved = readConfig(path).profiles.default.auth;
    assert.equal(saved.refreshToken, "mdrn_rt_2");
    assert.ok(saved.expiresAt > Math.floor(Date.now() / 1000) + 3000);
    assert.deepEqual(saved.scopes, SCOPES);
    // Two refreshes at once: the second waits for the lock, reads the rotated pair and uses it.
    expired(path, fake);
    const racing = settings(env, {});
    const before = fake.state.calls.length;
    const [a, b] = await Promise.all([credential(racing), credential(racing)]);
    assert.equal(a, "mdrn_mgmt_access_3");
    assert.equal(b, "mdrn_mgmt_access_3");
    assert.equal(fake.state.calls.slice(before).filter((c) => c.form.grant_type === "refresh_token").length, 1, "one refresh for two callers");
    assert.ok(!fake.state.grants.get("oag_1").revoked, "the grant survived");
    // The API refusing the token (force) refreshes once more; a token already rotated by someone
    // else is taken instead of refreshing again.
    assert.equal(await credential(settings(env, {}), { force: true }), "mdrn_mgmt_access_4");
    assert.equal(await credential(stale, { force: true }), "mdrn_mgmt_access_4", "the rotation on disk is newer than the refused token");
  } finally { await fake.close(); done(); }
});

test("a refresh the server refuses drops the dead sign-in and says to log in again", async () => {
  const fake = await fakeAuthServer();
  const { path, env, done } = home();
  try {
    forget();
    await login([], env, fake);
    fake.state.grants.get("oag_1").revoked = true;
    expired(path, fake);
    await assert.rejects(credential(settings(env, {})), (error) => error.exitCode === 2 && /no longer valid \(invalid_grant: The grant was revoked or has expired\.\); run mdrn login again/.test(error.message));
    assert.equal(readConfig(path).profiles.default.auth, undefined);
    assert.equal(readConfig(path).profiles.default.workspace, "ws_1", "the defaults stay");
  } finally { await fake.close(); done(); }
});

test("logout revokes the refresh token and forgets the sign-in, keeping the profile's defaults", async () => {
  const fake = await fakeAuthServer();
  const { path, env, done } = home();
  try {
    forget();
    await login([], env, fake);
    const config = readConfig(path);
    config.profiles.default.project = "proj_1";
    writeConfig(path, config);
    const { err, context } = output();
    assert.equal(await session(resolveCommand(parse(["logout"])), { ...context, configured: settings(env, {}) }), null);
    assert.deepEqual(fake.state.revoked, ["mdrn_rt_1"]);
    assert.ok(fake.state.grants.get("oag_1").revoked);
    const profile = readConfig(path).profiles.default;
    assert.equal(profile.auth, undefined);
    assert.deepEqual({ origin: profile.origin, workspace: profile.workspace, project: profile.project }, { origin: fake.origin, workspace: "ws_1", project: "proj_1" });
    assert.match(err[0], /^Signed out of /);
    await assert.rejects(credential(settings(env, {})), /Sign in with mdrn login/);
  } finally { await fake.close(); done(); }
});

test("a busy cached port means any free port and a fresh registration", async () => {
  const fake = await fakeAuthServer();
  const { path, env, done } = home();
  const squatter = createServer(() => {});
  await new Promise((resolve) => squatter.listen(0, "127.0.0.1", resolve));
  const busy = squatter.address().port;
  try {
    forget();
    writeConfig(path, { version: 1, profiles: {}, clients: { [fake.origin]: { clientId: "oac_old", redirectUri: `http://127.0.0.1:${busy}/callback` } } });
    await login([], env, fake);
    assert.equal(fake.state.clients.length, 1);
    const cached = readConfig(path).clients[fake.origin];
    assert.equal(cached.clientId, "oac_1");
    assert.notEqual(new URL(cached.redirectUri).port, String(busy));
    assert.equal(readConfig(path).profiles.default.auth.clientId, "oac_1");
  } finally { squatter.close(); await fake.close(); done(); }
});

test("login --token keeps a management token, deleting any sign-in, and --no-browser only prints the URL", async () => {
  const fake = await fakeAuthServer();
  const { path, env, done } = home();
  try {
    forget();
    await login([], env, fake);
    const grant = fake.state.grants.get("oag_1");
    fake.state.accesses.set("mdrn_mgmt_fixed", grant);
    const { err } = await login(["--token", "mdrn_mgmt_fixed"], env, fake, { open: () => { throw new Error("no browser"); } });
    const profile = readConfig(path).profiles.default;
    assert.equal(profile.token, "mdrn_mgmt_fixed");
    assert.equal(profile.auth, undefined);
    assert.equal(profile.workspace, "ws_1");
    assert.deepEqual(fake.state.revoked, ["mdrn_rt_1"], "the sign-in it replaced is revoked");
    assert.match(err.at(-1), /^Signed in as ann@example\.com with a management token in workspace ws_1/);
    assert.equal(await credential(settings(env, {})), "mdrn_mgmt_fixed");
    assert.equal(settings({ ...env, MDRN_API_TOKEN: "env" }, {}).token, "env");
    // Without a browser, the URL is printed and the sign-in still completes once it is visited.
    const printed = output();
    const configured = settings(env, { "no-browser": true }, { lenient: true });
    const parsed = parse(["login", "--origin", fake.origin, "--no-browser"]);
    const visit = fake.browser();
    const pending = session(resolveCommand({ ...parsed, options: configured.options }), { ...printed.context, configured, open: () => { throw new Error("must not open"); }, signInMs: 2000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const url = printed.err[0].split("\n")[1];
    assert.match(printed.err[0], /^Open this URL in your browser to sign in:\n/);
    await visit(url);
    await pending;
    assert.equal(readConfig(path).profiles.default.auth.accessToken, "mdrn_mgmt_access_2");
    assert.equal(readConfig(path).profiles.default.token, undefined);
  } finally { await fake.close(); done(); }
});

test("a sign-in that nobody completes gives up after the timeout", async () => {
  const fake = await fakeAuthServer();
  const { env, done } = home();
  try {
    forget();
    await assert.rejects(login([], env, fake, { open: async () => true, signInMs: 200 }), /No sign-in arrived within 0 minutes/);
  } finally { await fake.close(); done(); }
});

test("the metadata must name the origin as its issuer and keep the token endpoints on it", async () => {
  const { discover } = await import("../src/auth.js");
  const fetcher = async () => Response.json({ issuer: "https://other.example", authorization_endpoint: "https://console.example/oauth/authorize", token_endpoint: "https://api.example/oauth/token", registration_endpoint: "https://api.example/oauth/register", revocation_endpoint: "https://api.example/oauth/revoke" });
  await assert.rejects(discover("https://api.example", { fetcher }), /names another issuer \(https:\/\/other\.example\)/);
  const elsewhere = async () => Response.json({ issuer: "https://api.example", authorization_endpoint: "https://console.example/oauth/authorize", token_endpoint: "https://evil.example/oauth/token", registration_endpoint: "https://api.example/oauth/register", revocation_endpoint: "https://api.example/oauth/revoke" });
  await assert.rejects(discover("https://api.example", { fetcher: elsewhere }), /token_endpoint on another origin/);
  await assert.rejects(discover("http://api.example", { fetcher }), /https origin/);
});
