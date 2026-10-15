import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CliError } from "./client.js";
import { refresh } from "./auth.js";

// The configuration file, at $MDRN_CONFIG, $XDG_CONFIG_HOME/mdrn/config.json or
// ~/.config/mdrn/config.json. Schema version 1:
//   { "version": 1,
//     "profiles": { "<name>": { "origin", "console", "workspace", "project", "environment", "service",
//                               "token"?, "auth"?: { "type": "oauth", "clientId", "accessToken",
//                                                    "refreshToken", "expiresAt", "scopes": [], "account" } } },
//     "clients": { "<api origin>": { "clientId", "redirectUri" } } }
// A profile holds either a management token (`token`) or a browser sign-in (`auth`); `auth` wins
// when both are present, and `login --token` deletes `auth`. `clients` is the CLI's own OAuth
// registration at each API origin, kept so the same client and loopback port serve the next
// sign-in. A file from before the schema was versioned (`{ "profiles": {...} }`) reads as
// version 1 and is rewritten as such the first time something is saved.
export const CONFIG_VERSION = 1;
// What a project directory's .mdrn/link.json may set, and what MDRN_* may override.
const SELECTORS = ["workspace", "project", "environment", "service"];
// An access token is refreshed this many seconds before it expires, so a request never carries
// one that expires in flight.
const EXPIRY_MARGIN = 120;
const LOCK = { pollMs: 100, waitMs: 10_000, staleMs: 60_000 };

const text = (value) => (typeof value === "string" && value ? value : undefined);
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : undefined);

export function configPath(env) {
  return env.MDRN_CONFIG || join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "mdrn", "config.json");
}

// The file's content in the current schema, or the empty configuration when there is no file.
export function readConfig(path, read = (p) => readFileSync(p, "utf8")) {
  let parsed;
  try {
    parsed = JSON.parse(read(path));
  } catch (error) {
    if (error.code !== "ENOENT") throw new CliError(`${path} is not a readable JSON configuration: ${error.message}`, 2);
    return { version: CONFIG_VERSION, profiles: {}, clients: {}, exists: false };
  }
  if (!object(parsed)) throw new CliError(`${path} is not a readable JSON configuration: not an object`, 2);
  if (parsed.version !== undefined && parsed.version !== CONFIG_VERSION) throw new CliError(`${path} is schema version ${parsed.version}; this CLI reads version ${CONFIG_VERSION}`, 2);
  const profiles = {};
  for (const [name, profile] of Object.entries(object(parsed.profiles) ?? {})) if (object(profile)) profiles[name] = { ...profile };
  return { version: CONFIG_VERSION, profiles, clients: { ...(object(parsed.clients) ?? {}) }, exists: true };
}

// Writes the whole file at once: a temporary file next to it is renamed over it, so a reader
// never sees half a file and a crash leaves the old one. The file is created readable only by
// its owner (0600) and its directory only enterable by them (0700); Windows ignores POSIX modes,
// where the profile directory's own ACL protects it.
export function writeConfig(path, config) {
  const { exists, ...content } = config;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(temporary, JSON.stringify({ version: CONFIG_VERSION, ...content }, null, 2) + "\n", { mode: 0o600 });
  try { renameSync(temporary, path); } catch (error) { try { unlinkSync(temporary); } catch {} throw error; }
}

// The nearest .mdrn/link.json at or above `cwd`: the project a directory is linked to
// (`mdrn link`). Only its four selectors are read.
export function findLink(cwd, read = (p) => readFileSync(p, "utf8")) {
  let dir = resolve(cwd);
  for (;;) {
    const path = join(dir, ".mdrn", "link.json");
    try {
      const parsed = JSON.parse(read(path));
      const link = {};
      for (const key of SELECTORS) if (text(parsed?.[key])) link[key] = parsed[key];
      return { dir, path, link };
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw new CliError(`${path} is not a readable JSON link: ${error.message}`, 2);
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// Everything a command runs with. Options given on the command line win over MDRN_WORKSPACE,
// MDRN_PROJECT, MDRN_ENVIRONMENT and MDRN_SERVICE, which win over the directory's link, which
// wins over the profile. MDRN_API_TOKEN and MDRN_API_ORIGIN win over the profile's credential and
// origin. --profile (or MDRN_PROFILE) picks the profile, otherwise "default"; `lenient` lets a
// named profile be absent (login creates it).
export function settings(env, options, { read, cwd = process.cwd(), lenient = false } = {}) {
  const path = configPath(env);
  const named = typeof options.profile === "string" ? options.profile : text(env.MDRN_PROFILE);
  const config = readConfig(path, read);
  if (named && !config.exists && !lenient) throw new CliError(`Profile ${named} needs ${path}`, 2);
  const name = named || "default";
  const profile = config.profiles[name];
  if (named && !profile && !lenient) throw new CliError(`${path} has no profile ${named}`, 2);
  const chosen = profile ?? {};
  const found = findLink(cwd, read);
  const link = found?.link ?? {};
  const filled = { ...options };
  for (const key of SELECTORS) {
    if (filled[key] !== undefined) continue;
    const value = text(env[`MDRN_${key.toUpperCase()}`]) ?? link[key] ?? text(chosen[key]);
    if (value !== undefined) filled[key] = value;
  }
  const auth = object(chosen.auth)?.type === "oauth" ? chosen.auth : undefined;
  const envToken = text(env.MDRN_API_TOKEN);
  return {
    path, name, config, profile, linkDir: found?.dir,
    token: envToken ?? (auth ? undefined : text(chosen.token)),
    // How the bearer is held: an environment token, a browser sign-in, a profile token, or nothing.
    authType: envToken ? "env" : auth ? "oauth" : text(chosen.token) ? "token" : undefined,
    auth: envToken ? undefined : auth,
    origin: text(env.MDRN_API_ORIGIN) ?? text(chosen.origin),
    console: text(chosen.console),
    options: filled,
  };
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

// One process at a time refreshes a profile: a refresh token presented twice ends the grant, so
// the lock file keeps two CLIs (or two commands of one script) from racing. A lock older than a
// minute belongs to a process that died holding it.
async function locked(path, action, { now = Date.now, pollMs = LOCK.pollMs, waitMs = LOCK.waitMs, staleMs = LOCK.staleMs } = {}) {
  const lock = `${path}.lock`;
  const start = now();
  for (;;) {
    let handle;
    try {
      handle = openSync(lock, "wx", 0o600);
    } catch (error) {
      if (error.code === "ENOENT") { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); continue; }
      if (error.code !== "EEXIST") throw error;
      let age = 0;
      try { age = now() - statSync(lock).mtimeMs; } catch (seen) { if (seen.code === "ENOENT") continue; throw seen; }
      if (age > staleMs) { try { unlinkSync(lock); } catch {} continue; }
      if (now() - start > waitMs) throw new CliError(`Another mdrn is refreshing the sign-in (${lock}); try again, or remove the file if no mdrn is running`);
      await wait(pollMs);
      continue;
    }
    try { writeSync(handle, `${process.pid} ${new Date(now()).toISOString()}\n`); } finally { closeSync(handle); }
    try { return await action(); } finally { try { unlinkSync(lock); } catch {} }
  }
}

function fresh(auth, now) {
  return Number.isFinite(auth.expiresAt) && auth.expiresAt - EXPIRY_MARGIN > now;
}

// The bearer a request carries. A token is what it is; a browser sign-in's access token is
// refreshed when it is about to expire (or on `force`, after the API refused it), and the rotated
// pair is saved. Under the lock the file is read again, so a rotation another process made in
// the meantime is used rather than repeated.
export async function credential(configured, { force = false, fetcher, now = () => Math.floor(Date.now() / 1000), lock } = {}) {
  if (configured.token) return configured.token;
  const { auth, name, path } = configured;
  if (!auth) throw new CliError("Sign in with mdrn login, or set MDRN_API_TOKEN to a management token", 2);
  if (!force && fresh(auth, now())) return auth.accessToken;
  if (!text(auth.refreshToken)) throw new CliError("The sign-in has expired; run mdrn login again", 2);
  return locked(path, async () => {
    const config = readConfig(path);
    const current = object(config.profiles[name]?.auth);
    if (!current || current.type !== "oauth" || !text(current.refreshToken)) throw new CliError("The sign-in was removed while this command ran; run mdrn login again", 2);
    // Another process rotated it since this one looked: a token newer than the one the API
    // refused (or one still fresh) is used as it is.
    if (fresh(current, now()) && (!force || current.accessToken !== auth.accessToken)) { configured.auth = current; return current.accessToken; }
    let rotated;
    try {
      rotated = await refresh(configured.origin, { clientId: current.clientId, refreshToken: current.refreshToken }, { fetcher, now });
    } catch (error) {
      if (!/^invalid_grant\b/.test(error.message)) throw error;
      // The grant ended (revoked in the console, expired, or its refresh token was used twice);
      // the dead credential is dropped so the next command says what to do.
      delete config.profiles[name].auth;
      writeConfig(path, config);
      throw new CliError(`The sign-in is no longer valid (${error.message}); run mdrn login again`, 2);
    }
    config.profiles[name].auth = { ...current, accessToken: rotated.accessToken, refreshToken: rotated.refreshToken, expiresAt: rotated.expiresAt, scopes: rotated.scopes ?? current.scopes };
    writeConfig(path, config);
    // The rest of this command (a deploy makes many requests) uses the new pair without the lock.
    configured.auth = config.profiles[name].auth;
    return rotated.accessToken;
  }, lock);
}
