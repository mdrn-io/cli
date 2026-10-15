import { execFile as execFileCallback } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { CliError, DEFAULT_ORIGIN, execute, secureOrigin } from "./client.js";
import { readConfig, writeConfig } from "./config.js";
import { SCOPES, authorizeUrl, discover, exchange, listen, me, newState, openBrowser, pkce, register, revoke, tokenInfo } from "./auth.js";
import { link } from "./link.js";

// The commands that act on the CLI's own state (the profile, the directory's link) rather than
// on one API resource: sign in and out, who the CLI is, link, init and open.
export const SESSION_KINDS = new Set(["login", "logout", "whoami", "link", "init", "open"]);
export const DEFAULT_CONSOLE = "https://console.mdrn.io";
export const TEMPLATE = "https://github.com/mdrn-io/app-template";

export async function session(command, context) {
  if (command.kind === "login") return login(command, context);
  if (command.kind === "logout") return logout(command, context);
  if (command.kind === "whoami") return whoami(command, context);
  if (command.kind === "link") return link(command, context);
  if (command.kind === "init") return init(command, context);
  return open(command, context);
}

// The profile as it is on disk now (another command may have changed it since settings() read).
function current(context) {
  const { path, name } = context.configured;
  const config = readConfig(path);
  return { config, profile: config.profiles[name] ?? {}, path, name };
}

const port = (uri) => { try { return Number(new URL(uri).port) || undefined; } catch { return undefined; } };

// A browser sign-in, or with --token a management token kept in the profile. Either way the
// profile ends up holding the origin, the console, the workspace the credential reaches, and
// one credential: `login --token` deletes a sign-in, a sign-in deletes a token.
async function login(command, context) {
  const { config, profile, path, name } = current(context);
  const deps = { fetcher: context.fetcher, now: context.now };
  const origin = secureOrigin(command.origin ?? context.configured.origin ?? DEFAULT_ORIGIN).replace(/\/$/, "");
  if (command.token !== undefined) {
    if (!command.token) throw new CliError("--token takes a management token, or - to read it from standard input", 2);
    const info = await tokenInfo(origin, command.token, deps);
    const who = await me(origin, command.token, deps);
    if (profile.auth?.refreshToken) await revoke(origin, { clientId: profile.auth.clientId, token: profile.auth.refreshToken }, deps).catch(() => {});
    delete profile.auth;
    profile.token = command.token;
    profile.origin = origin;
    // The console is learnt from the origin's OAuth metadata; a token works without it.
    const console = origin === DEFAULT_ORIGIN ? DEFAULT_CONSOLE : await discover(origin, deps).then((m) => new URL(m.authorizationEndpoint).origin).catch(() => undefined);
    if (console) profile.console = console;
    const workspace = command.workspace ?? (info.workspaceIds?.length === 1 ? info.workspaceIds[0] : profile.workspace);
    if (command.workspace && Array.isArray(info.workspaceIds) && !info.workspaceIds.includes(command.workspace)) throw new CliError(`The token reaches ${info.workspaceIds.join(", ") || "no workspace"}, not ${command.workspace}`, 1);
    if (workspace) profile.workspace = workspace;
    config.profiles[name] = profile;
    writeConfig(path, config);
    context.err(`Signed in as ${who.user?.email ?? who.account?.id ?? "(unknown)"} with a management token${workspace ? ` in workspace ${workspace}` : ""} (scopes ${(info.scopes ?? []).join(" ")}). Next: cd your-app && mdrn link`);
    return null;
  }
  const metadata = await discover(origin, deps);
  const supported = metadata.scopesSupported;
  const scopes = command.scopes ?? (supported ? SCOPES.filter((s) => supported.includes(s)) : SCOPES);
  if (!scopes.length) throw new CliError("No scope to ask for", 2);
  const state = newState();
  const { verifier, challenge } = pkce();
  // The registered redirect URI names a port; when something else holds it, any free port and a
  // fresh registration do.
  const cached = config.clients[origin];
  let server;
  try {
    server = await listen({ port: port(cached?.redirectUri) ?? 0, state, issuer: metadata.issuer, timeoutMs: context.signInMs });
  } catch (error) {
    if (error.code !== "EADDRINUSE" || !cached) throw error;
    server = await listen({ port: 0, state, issuer: metadata.issuer, timeoutMs: context.signInMs });
  }
  let outcome;
  try {
    let clientId = cached?.clientId;
    if (!clientId || cached.redirectUri !== server.redirectUri) {
      clientId = await register(metadata, server.redirectUri, deps);
      config.clients[origin] = { clientId, redirectUri: server.redirectUri };
      writeConfig(path, config);
    }
    const url = authorizeUrl(metadata, { clientId, redirectUri: server.redirectUri, challenge, state, scopes });
    const opened = command.browser && await (context.open ?? openBrowser)(url);
    context.err(opened ? `Opening your browser to sign in; if it does not open, visit\n${url}` : `Open this URL in your browser to sign in:\n${url}`);
    const code = await server.code;
    const got = await exchange(metadata, { clientId, redirectUri: server.redirectUri, code, verifier }, deps);
    outcome = { clientId, got };
  } finally {
    await server.close();
  }
  const { clientId, got } = outcome;
  const info = await tokenInfo(origin, got.accessToken, deps);
  const workspace = Array.isArray(info.workspaceIds) ? info.workspaceIds[0] : undefined;
  if (command.workspace && workspace !== command.workspace) {
    await revoke(origin, { clientId, token: got.refreshToken ?? got.accessToken }, deps).catch(() => {});
    throw new CliError(`You approved ${workspace ?? "no workspace"}; run again and pick ${command.workspace}`, 1);
  }
  const who = await me(origin, got.accessToken, deps);
  // A sign-in replaces the last one: its grant ends, so it does not linger among the account's
  // connected apps.
  if (profile.auth?.refreshToken && profile.auth.refreshToken !== got.refreshToken) await revoke(origin, { clientId: profile.auth.clientId, token: profile.auth.refreshToken }, deps).catch(() => {});
  const held = Array.isArray(info.scopes) ? info.scopes : got.scopes ?? scopes;
  delete profile.token;
  profile.auth = { type: "oauth", clientId, accessToken: got.accessToken, refreshToken: got.refreshToken, expiresAt: got.expiresAt, scopes: held, account: who.account?.id ?? info.accountId };
  profile.origin = origin;
  profile.console = new URL(metadata.authorizationEndpoint).origin;
  if (workspace) profile.workspace = workspace;
  config.profiles[name] = profile;
  writeConfig(path, config);
  context.err(`Signed in as ${who.user?.email ?? profile.auth.account ?? "(unknown)"} in workspace ${workspace ?? "(none)"} (scopes ${held.join(" ")}). Next: cd your-app && mdrn link`);
  return null;
}

// Ends the sign-in: the grant is revoked and the credential leaves the profile; the profile's
// origin, console, workspace, project, environment and service stay.
async function logout(command, context) {
  const { config, profile, path, name } = current(context);
  const deps = { fetcher: context.fetcher };
  if (!profile.auth && !profile.token) { context.err(`Profile ${name} holds no sign-in or token`); return null; }
  if (profile.auth) {
    const origin = profile.origin ?? context.configured.origin ?? DEFAULT_ORIGIN;
    try {
      await revoke(origin, { clientId: profile.auth.clientId, token: profile.auth.refreshToken ?? profile.auth.accessToken }, deps);
    } catch (error) {
      context.err(`The grant could not be revoked (${error.message}); it is forgotten here and can be revoked in the console under Connected apps`);
    }
    delete profile.auth;
    context.err(`Signed out of ${origin}`);
  }
  if (profile.token) {
    delete profile.token;
    context.err("The management token is forgotten here; it stays valid until revoked in the console (mdrn open tokens)");
  }
  config.profiles[name] = profile;
  writeConfig(path, config);
  return null;
}

// Who the API says the CLI is, and how the CLI holds that: profile, origin, credential, workspace
// and when a sign-in's access token expires.
async function whoami(command, context) {
  const { configured } = context;
  const answer = await execute(command, context);
  const credential = { env: "management token (MDRN_API_TOKEN)", token: `management token (profile ${configured.name})`, oauth: `browser sign-in (profile ${configured.name})` }[configured.authType] ?? "(none)";
  return {
    profile: configured.name, origin: configured.origin ?? DEFAULT_ORIGIN, credential,
    workspace: configured.options.workspace ?? null,
    expiresAt: configured.auth ? configured.auth.expiresAt : null,
    ...answer,
  };
}

const execFile = (file, args, options) => new Promise((done, fail) => execFileCallback(file, args, options, (error, stdout, stderr) => (error ? fail(Object.assign(error, { stderr })) : done({ stdout, stderr }))));

// A new app from the template: a shallow clone whose history is dropped, so the directory
// starts as the person's own.
async function init(command, context) {
  const dir = resolve(context.cwd ?? process.cwd(), command.dir);
  if (existsSync(dir) && readdirSync(dir).length) throw new CliError(`${dir} exists and is not empty`, 2);
  try {
    await (context.execFile ?? execFile)("git", ["clone", "--depth", "1", "--quiet", TEMPLATE, dir], { windowsHide: true });
  } catch (error) {
    if (error.code === "ENOENT") throw new CliError("git is not on PATH; install Git (https://git-scm.com) and run mdrn init again", 2);
    throw new CliError(`git clone failed: ${(error.stderr || error.message || "").trim()}`);
  }
  rmSync(resolve(dir, ".git"), { recursive: true, force: true });
  context.err(`Created ${command.dir} from ${TEMPLATE}. Next: cd ${command.dir} && mdrn link && mdrn deploy`);
  return null;
}

// The console page for the profile's project: the project itself, its workspace's billing, or
// the management tokens. The URL is printed, then opened.
async function open(command, context) {
  const console = (context.configured.console ?? DEFAULT_CONSOLE).replace(/\/$/, "");
  const url = new URL(command.page === "billing" ? "/billing" : command.page === "tokens" ? "/settings" : "/", console);
  if (command.page === "tokens") url.searchParams.set("tab", "tokens");
  if (command.project) url.searchParams.set("project", command.project);
  if (command.environment === "production") url.searchParams.set("env", "production");
  context.out(url.href);
  if (context.browser !== false && !(await (context.open ?? openBrowser)(url.href))) context.err("The browser could not be opened; visit the URL above");
  return null;
}
