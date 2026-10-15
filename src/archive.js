import { readdirSync, readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { CliError } from "./client.js";

// Deploy refuses a source archive over this many bytes (deploy-worker uploads.rs MAX_SOURCE_BYTES),
// so the CLI says so before sending anything.
export const MAX_SOURCE_BYTES = 95_000_000;
// Never part of a source archive, at any depth: the build installs dependencies itself, and
// .mdrn is the CLI's own link to the project (link.js).
const ALWAYS_SKIPPED = new Set([".git", "node_modules", ".mdrn"]);
// Every entry sits under this one directory, which the builder strips (deploy/builder/build.mjs
// `extract`), so a project whose only top-level entry is a directory keeps that directory.
const ROOT = "source";

// One `.mdrnignore` line as gitignore reads it: `#` comments, `!` re-includes, a trailing `/`
// matches directories only, a `/` elsewhere anchors the pattern at the project root, and `*`,
// `?`, `**` and `[...]` match as in gitignore.
function rule(line) {
  let text = line.replace(/\s+$/, "");
  if (!text || text.startsWith("#")) return undefined;
  const negate = text.startsWith("!");
  if (negate) text = text.slice(1);
  if (text.startsWith("\\")) text = text.slice(1);
  const directory = text.endsWith("/");
  if (directory) text = text.replace(/\/+$/, "");
  const anchored = text.includes("/");
  text = text.replace(/^\//, "");
  if (!text) return undefined;
  let source = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (text.startsWith("**/", index) && (index === 0 || text[index - 1] === "/")) { source += "(?:.*/)?"; index += 2; }
    else if (text.startsWith("**", index) && index + 2 === text.length && (index === 0 || text[index - 1] === "/")) { source += ".*"; index += 1; }
    else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (char === "[" && text.indexOf("]", index + 2) !== -1) {
      const end = text.indexOf("]", index + 2);
      const body = text.slice(index + 1, end).replace(/\\/g, "\\\\");
      source += "[" + (body.startsWith("!") ? "^" + body.slice(1) : body) + "]";
      index = end;
    } else source += char.replace(/[.+^${}()|\\\]]/g, "\\$&");
  }
  return { negate, directory, pattern: new RegExp(anchored ? `^${source}$` : `^(?:.*/)?${source}$`) };
}

export function ignoreRules(text) {
  return text.split(/\r?\n/).map(rule).filter(Boolean);
}

// The last rule that matches decides, as in gitignore.
export function ignored(rules, path, directory) {
  let result = false;
  for (const item of rules) {
    if (item.directory && !directory) continue;
    if (item.pattern.test(path)) result = !item.negate;
  }
  return result;
}

// Regular files under `dir`, relative and with `/` separators, sorted so the same tree always
// packs to the same bytes. An ignored directory is not entered, so nothing below it comes back
// (as in gitignore). Symbolic links are left out: they could point outside the project.
export function sourceFiles(dir) {
  let rules = [];
  try { rules = ignoreRules(readFileSync(join(dir, ".mdrnignore"), "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const files = [];
  const walk = (relative) => {
    const entries = readdirSync(join(dir, relative), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!ALWAYS_SKIPPED.has(entry.name) && !ignored(rules, path, true)) walk(path);
      } else if (entry.isFile() && !ignored(rules, path, false)) files.push(path);
    }
  };
  walk("");
  return files;
}

function field(buffer, offset, length, value) {
  buffer.write(value, offset, length, "utf8");
}
function octal(buffer, offset, length, value) {
  field(buffer, offset, length, value.toString(8).padStart(length - 1, "0") + "\0");
}
function header(name, size, mode, type) {
  const block = Buffer.alloc(512);
  field(block, 0, 100, name);
  octal(block, 100, 8, mode);
  octal(block, 108, 8, 0);
  octal(block, 116, 8, 0);
  octal(block, 124, 12, size);
  octal(block, 136, 12, 0); // a fixed time keeps the archive the same for the same files
  block.fill(" ", 148, 156);
  field(block, 156, 1, type);
  field(block, 257, 8, "ustar\u000000");
  let sum = 0;
  for (const byte of block) sum += byte;
  field(block, 148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
  return block;
}
function padded(data) {
  const rest = data.length % 512;
  return rest ? [data, Buffer.alloc(512 - rest)] : [data];
}
// A name longer than ustar's 100 bytes travels in a PAX extended header before its entry.
function pax(name) {
  const body = ` path=${name}\n`;
  let length = Buffer.byteLength(body);
  while (Buffer.byteLength(`${length}${body}`) !== length) length = Buffer.byteLength(`${length}${body}`);
  const record = Buffer.from(`${length}${body}`);
  return [header("PaxHeader", record.length, 0o644, "x"), ...padded(record)];
}

export function tar(entries) {
  const blocks = [];
  for (const { name, data, mode } of entries) {
    if (Buffer.byteLength(name) > 100) blocks.push(...pax(name));
    blocks.push(header(Buffer.byteLength(name) > 100 ? name.slice(0, 50) : name, data.length, mode, "0"), ...padded(data));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

// The project as Deploy's builder reads it: a gzipped tar of its source, with its SHA-256.
export function packSource(dir, limit = MAX_SOURCE_BYTES) {
  let stat;
  try { stat = lstatSync(dir); } catch { throw new CliError(`${dir} is not a directory`, 2); }
  if (!stat.isDirectory()) throw new CliError(`${dir} is not a directory`, 2);
  const files = sourceFiles(dir);
  if (!files.length) throw new CliError(`${dir} has no files to deploy (after .mdrnignore, .git and node_modules)`, 2);
  const entries = files.map((path) => {
    const mode = lstatSync(join(dir, path)).mode & 0o111 ? 0o755 : 0o644;
    return { name: `${ROOT}/${path}`, data: readFileSync(join(dir, path)), mode };
  });
  const archive = gzipSync(tar(entries));
  if (archive.length > limit) {
    throw new CliError(`The source archive is ${(archive.length / 1e6).toFixed(1)} MB; Deploy accepts at most ${limit / 1e6} MB. Leave out dependencies, build output and large files with .mdrnignore — the build installs dependencies itself.`, 1);
  }
  return { archive, files: files.length, sha256: createHash("sha256").update(archive).digest("hex") };
}
