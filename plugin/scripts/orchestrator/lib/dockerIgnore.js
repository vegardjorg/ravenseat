// =============================================================
// dockerIgnore.js: does a container build in the main tree keep .claude/ and the data folder out of its context
// (roadmap 1c SEC-T item 3; the doctor row "dockerignore", cli/doctorBaseline.mjs checkDockerignore).
//
// WHY: `docker build .` (or podman) sends the whole folder to the builder, and the common `COPY . .` puts it in the
// image: .claude/ with the personal settings (settings.local.json can hold an approved command with a key) and the
// worktrees, and the queue's data folder with the time log and the tasks. Anyone who pulls the image can read them.
// .dockerignore is the only filter, and git's .gitignore does not count for docker.
//
// The doctor row is advice (WARN, never FAIL) and appears only when a container file is in the root: most projects have
// none, so there is no setting. Only the root is looked at: a Dockerfile in a subfolder usually builds with that folder
// as its context.
//
// Matching follows docker's rules closely enough for this question: one pattern per line, # comments, a leading / or ./
// dropped, * within one path part, ** across parts, ? one character, a pattern matches a path or any folder above it,
// and the last matching line wins (! re-includes). Pure, no I/O. Tested in lib/__tests__/dockerIgnore.test.ts.
// =============================================================
'use strict';

/** A root file name that is a container build: Dockerfile, Dockerfile.<x>, <x>.Dockerfile, Containerfile (any case). */
const CONTAINER = /^(?:(?:dockerfile|containerfile)(?:\.[^.]+)*|.+\.(?:dockerfile|containerfile))$/i;

/** The container build files among the root's names, sorted. */
function containerFiles(names) {
  return (names ?? []).filter((n) => CONTAINER.test(String(n))).sort();
}

/** One pattern as a regular expression over a path with forward slashes. */
function patternRegex(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** The lines of a .dockerignore as { negate, regex }, in order. */
function rules(text) {
  const out = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    if (negate) line = line.slice(1).trim();
    // A trailing /** (everything inside) keeps the folder's content out, which is what counts here.
    line = line.replace(/^(?:\.\/|\/)+/, '').replace(/(?:\/\*\*)+\/*$/, '').replace(/\/+$/, '');
    if (!line) continue;
    out.push({ negate, regex: patternRegex(line) });
  }
  return out;
}

/**
 * Does the .dockerignore text keep the folder `dir` (relative, forward slashes) out of the build context?
 * @param {string} text the .dockerignore content
 * @param {string} dir  e.g. ".claude" or ".queue/data"
 */
function excludes(text, dir) {
  const parts = String(dir).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').split('/');
  const paths = parts.map((_, i) => parts.slice(0, i + 1).join('/'));
  let excluded = false;
  for (const r of rules(text)) if (paths.some((p) => r.regex.test(p))) excluded = !r.negate;
  return excluded;
}

/**
 * The doctor row's facts, or null when the root has no container file.
 * @param {{ names: string[], dockerignore: string|null, folders: string[] }} x  the root's names, the .dockerignore
 *   text (null when missing) and the folders to keep out
 * @returns {{ files: string[], hasIgnore: boolean, missing: string[] } | null}
 */
function facts({ names, dockerignore, folders }) {
  const files = containerFiles(names);
  if (!files.length) return null;
  const hasIgnore = dockerignore != null;
  const missing = (folders ?? []).filter((d) => !hasIgnore || !excludes(dockerignore, d));
  return { files, hasIgnore, missing };
}

module.exports = { containerFiles, excludes, facts };
