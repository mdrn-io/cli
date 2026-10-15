import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { CliError, secureOrigin } from "./client.js";

// A browser sign-in: the CLI is a public OAuth client (RFC 7591 registration, PKCE S256, the code
// grant with a refresh token) of the Platform at the API origin, whose consent page is the
// console's /oauth/authorize. The person picks one workspace and the scopes there; the access
// token is a management token that expires in an hour, and the refresh token rotates on every
// use (one presented twice ends the grant, config.js `credential` serialises refreshes).

// Every scope a browser sign-in asks for by default: what the CLI's commands use, among those the
// Platform grants to an app (platform/src/domain.rs SCOPES less billing:write, team:write,
// workspace:write and project:delete, which a sign-in never holds).
export const SCOPES = [
  "account:read", "workspace:read", "team:read", "project:read", "project:write", "environment:read",
  "deploy:read", "deploy:write", "logs:read", "logs:write", "database:read", "database:write",
  "storage:read", "storage:write", "mail:read", "mail:write", "auth:read", "auth:write",
  "operation:read", "usage:read", "billing:read",
];
export const CLIENT_NAME = "MDRN CLI";
export const CALLBACK_PATH = "/callback";
// A person has this long to approve in the browser.
export const SIGN_IN_MS = 5 * 60_000;
const CALL_MS = 10_000;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

const base64url = (bytes) => Buffer.from(bytes).toString("base64url");

// The OAuth endpoints never go through `execute` (they are not under /v1/), so this is their own
// guard: https, or http on this machine; no redirects; ten seconds. An OAuth refusal (RFC 6749
// 5.2) reads as `error: description`.
export async function oauthFetch(url, { method = "GET", headers = {}, body, form } = {}, { fetcher = globalThis.fetch, timeoutMs = CALL_MS } = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new CliError(`Not a URL: ${url}`, 2); }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && LOOPBACK.has(parsed.hostname))) throw new CliError(`${url} is not https`, 2);
  const sent = new Headers({ Accept: "application/json", ...headers });
  let payload = body;
  if (form) { sent.set("Content-Type", "application/x-www-form-urlencoded"); payload = new URLSearchParams(form).toString(); }
  else if (body !== undefined) { sent.set("Content-Type", "application/json"); payload = JSON.stringify(body); }
  let response;
  try {
    response = await fetcher(url, { method, headers: sent, body: payload, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new CliError(`${parsed.origin} could not be reached: ${error.cause?.message ?? error.message}`);
  }
  const text = await response.text();
  let answer;
  try { answer = text ? JSON.parse(text) : null; } catch { answer = { raw: text }; }
  if (!response.ok) {
    const error = answer?.error && typeof answer.error === "object" ? answer.error : answer ?? {};
    const code = typeof answer?.error === "string" ? answer.error : error.code ?? `HTTP_${response.status}`;
    throw new CliError(`${code}: ${answer?.error_description ?? error.message ?? response.statusText}`);
  }
  return answer;
}

const discovered = new Map();

// RFC 8414 metadata at the API origin. The issuer must be that origin, and the token,
// registration and revocation endpoints must sit on it: a credential goes nowhere else.
export async function discover(origin, deps = {}) {
  const base = new URL(secureOrigin(origin)).origin;
  if (discovered.has(base)) return discovered.get(base);
  const metadata = await oauthFetch(`${base}/.well-known/oauth-authorization-server`, {}, deps);
  const on = (key, host) => {
    let url;
    try { url = new URL(metadata?.[key]); } catch { throw new CliError(`${base} publishes no ${key}`); }
    if (host && url.origin !== host) throw new CliError(`${base} publishes ${key} on another origin (${url.origin})`);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) throw new CliError(`${key} is not https`);
    return url.href;
  };
  const issuer = new URL(on("issuer")).origin;
  if (issuer !== base) throw new CliError(`${base} names another issuer (${issuer}); sign in with --origin ${issuer}`);
  const result = {
    issuer: metadata.issuer, authorizationEndpoint: on("authorization_endpoint"), tokenEndpoint: on("token_endpoint", base),
    registrationEndpoint: on("registration_endpoint", base), revocationEndpoint: on("revocation_endpoint", base),
    scopesSupported: Array.isArray(metadata.scopes_supported) ? metadata.scopes_supported.filter((s) => typeof s === "string") : undefined,
  };
  discovered.set(base, result);
  return result;
}

// Registers this CLI as a public client answering at one loopback redirect URI (matched
// exactly, port included). The caller keeps the client ID per origin.
export async function register(metadata, redirectUri, deps = {}) {
  const answer = await oauthFetch(metadata.registrationEndpoint, { method: "POST", body: { client_name: CLIENT_NAME, redirect_uris: [redirectUri] } }, deps);
  if (typeof answer?.client_id !== "string" || !answer.client_id) throw new CliError("The registration answered without a client_id");
  return answer.client_id;
}

// PKCE (RFC 7636): a 64-character base64url verifier and its S256 challenge.
export function pkce(random = randomBytes) {
  const verifier = base64url(random(48));
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function authorizeUrl(metadata, { clientId, redirectUri, challenge, state, scopes }) {
  const url = new URL(metadata.authorizationEndpoint);
  for (const [key, value] of Object.entries({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", state, scope: scopes.join(" ") })) url.searchParams.set(key, value);
  return url.href;
}

const page = (text) => `<!doctype html><meta charset="utf-8"><title>MDRN CLI</title><p>${text}</p>`;

// The loopback server the browser is sent back to. Listening on the cached port fails with
// EADDRINUSE (the caller then takes any port and registers again); port 0 takes any free one.
// `code` settles with the authorization code, or rejects when the answer is refused, carries
// another state or issuer, or does not come in time. Anything but the callback path is 404.
export function listen({ port = 0, path = CALLBACK_PATH, state, issuer, timeoutMs = SIGN_IN_MS } = {}) {
  return new Promise((resolve, reject) => {
    let settle;
    const code = new Promise((ok, no) => { settle = { ok, no }; });
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== path) { response.writeHead(404, { "Content-Type": "text/html; charset=utf-8" }); response.end(page("Not found")); return; }
      const answer = (status, text, error) => {
        response.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        response.end(page(text));
        if (error) settle.no(new CliError(error)); else settle.ok(url.searchParams.get("code"));
      };
      if (url.searchParams.get("state") !== state) return answer(400, "This answer does not belong to the sign-in that is waiting.", "The sign-in answered with another state; run mdrn login again");
      if (url.searchParams.get("iss") !== issuer) return answer(400, "This answer did not come from the expected server.", `The sign-in answered for issuer ${url.searchParams.get("iss") ?? "(none)"}, not ${issuer}; run mdrn login again`);
      const refused = url.searchParams.get("error");
      if (refused) return answer(200, "Sign-in was refused, you can close this tab.", `The sign-in was ${refused === "access_denied" ? "refused" : `refused (${refused})`}${url.searchParams.get("error_description") ? `: ${url.searchParams.get("error_description")}` : ""}`);
      if (!url.searchParams.get("code")) return answer(400, "The answer carries no code.", "The sign-in answered without a code; run mdrn login again");
      answer(200, "Signed in, you can close this tab.");
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const taken = server.address().port;
      const timer = setTimeout(() => settle.no(new CliError(`No sign-in arrived within ${Math.round(timeoutMs / 60_000)} minutes; run mdrn login again`)), timeoutMs);
      const close = () => new Promise((done) => { clearTimeout(timer); server.close(() => done()); server.closeAllConnections?.(); });
      // The server closes once the answer is in; a refusal that arrives before the caller
      // awaits `code` (while the browser is still being opened) is kept for that await.
      const result = code.finally(close);
      result.catch(() => {});
      resolve({ port: taken, redirectUri: `http://127.0.0.1:${taken}${path}`, code: result, close });
    });
  });
}

// Opens the URL in the person's browser: `start` on Windows (through cmd, with the URL quoted
// so its & and = stay literal), `open` on macOS, `xdg-open` elsewhere. The child is left to
// itself; a failure to start is the caller's cue to print the URL.
export function openBrowser(url, platform = process.platform) {
  return new Promise((resolve) => {
    const [command, args, options] = platform === "win32" ? ["cmd", ["/c", "start", '""', `"${url}"`], { windowsVerbatimArguments: true }]
      : platform === "darwin" ? ["open", [url], {}] : ["xdg-open", [url], {}];
    let child;
    try { child = spawn(command, args, { ...options, detached: true, stdio: "ignore" }); } catch { resolve(false); return; }
    child.once("error", () => resolve(false));
    child.once("spawn", () => { child.unref(); resolve(true); });
  });
}

// What a token answer gives the profile: the pair, the absolute expiry and the scopes held.
function tokens(answer, now) {
  if (typeof answer?.access_token !== "string" || !answer.access_token) throw new CliError("The token answer carries no access_token");
  const expiresIn = Number.isSafeInteger(answer.expires_in) && answer.expires_in > 0 ? answer.expires_in : 3600;
  return {
    accessToken: answer.access_token,
    refreshToken: typeof answer.refresh_token === "string" && answer.refresh_token ? answer.refresh_token : undefined,
    expiresAt: now() + expiresIn,
    scopes: typeof answer.scope === "string" ? answer.scope.split(" ").filter(Boolean) : undefined,
  };
}

const seconds = () => Math.floor(Date.now() / 1000);

export async function exchange(metadata, { clientId, redirectUri, code, verifier }, { now = seconds, ...deps } = {}) {
  const answer = await oauthFetch(metadata.tokenEndpoint, { method: "POST", form: { grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier } }, deps);
  return tokens(answer, now);
}

export async function refresh(origin, { clientId, refreshToken }, { now = seconds, ...deps } = {}) {
  const metadata = await discover(origin, deps);
  const answer = await oauthFetch(metadata.tokenEndpoint, { method: "POST", form: { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId } }, deps);
  return tokens(answer, now);
}

// RFC 7009: ends the grant the token belongs to (the refresh token names it; so does the access
// token). The Platform answers 200 whether or not it knew the token.
export async function revoke(origin, { clientId, token }, deps = {}) {
  const metadata = await discover(origin, deps);
  await oauthFetch(metadata.revocationEndpoint, { method: "POST", form: { token, client_id: clientId } }, deps);
}

// What a bearer is: its scopes and the workspaces it reaches.
export async function tokenInfo(origin, token, deps = {}) {
  return oauthFetch(`${new URL(secureOrigin(origin)).origin}/v1/platform/oauth/token-info`, { headers: { Authorization: `Bearer ${token}` } }, deps);
}

export async function me(origin, token, deps = {}) {
  return oauthFetch(`${new URL(secureOrigin(origin)).origin}/v1/platform/me`, { headers: { Authorization: `Bearer ${token}` } }, deps);
}

export const newState = () => base64url(randomBytes(24));

// Clears the in-process discovery cache (tests start a new fake server per case).
export function forget() { discovered.clear(); }
