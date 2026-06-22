#!/usr/bin/env node
// publish a release for the version recorded in the root package.json. run by
// the changesets action's `publish` step once the "Version Packages" PR has
// merged (no changesets pending).
//
// everything happens here at merge time (playlistz has a single fast artifact,
// so there is no draft-during-the-PR build step):
//   1. builds dist (needed for the npm package and the standalone bundle asset).
//   2. creates the github release `v$VERSION` at main HEAD - this creates the
//      tag - sets its body to the changeset changelog + github generated notes,
//      and uploads dist/freqhole-playlistz.js.
//   3. publishes the npm package via npm trusted publishing (oidc). the
//      changesets job runs with `id-token: write`, so `npm publish` performs the
//      oidc exchange itself - no npm token needed. npm matches the oidc token's
//      workflow filename (changesets.yml) against the trusted publisher on
//      npmjs.com.
//
// safe to re-run: reuses an existing github release (refreshing notes + bundle)
// and skips the npm publish if that version is already on the registry.
//
// requires the `gh` cli with GH_TOKEN / GITHUB_TOKEN in the environment.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { applyReleaseNotes } from "./release-notes.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const tag = `v${pkg.version}`;

function gh(args) {
    return execFileSync("gh", args, {
        cwd: root,
        stdio: ["ignore", "pipe", "inherit"],
    })
        .toString()
        .trim();
}

function run(cmd, args) {
    execFileSync(cmd, args, { cwd: root, stdio: "inherit" });
}

// build dist: needed for the npm package (files: dist) and the standalone
// bundle asset attached to the github release.
console.log("building dist");
run("npm", ["run", "build"]);

// create the github release (and its v$VERSION tag at main HEAD) if it does not
// already exist. idempotent: a re-run reuses the existing release.
let releaseExists = false;
try {
    gh(["release", "view", tag, "--json", "tagName"]);
    releaseExists = true;
} catch {
    releaseExists = false;
}

if (releaseExists) {
    console.log(`release ${tag} already exists; refreshing notes + bundle`);
} else {
    console.log(`creating release ${tag}`);
    gh(["release", "create", tag, "--target", "main", "--generate-notes", "--title", tag]);
}

// set the body to the changeset changelog + github generated notes, then attach
// the single-file standalone player (--clobber so re-runs overwrite cleanly).
applyReleaseNotes(tag);
gh(["release", "upload", tag, "dist/freqhole-playlistz.js", "--clobber"]);

// publish the npm package. skip if this version is already on the registry so
// re-runs stay idempotent.
let alreadyOnNpm = false;
try {
    execFileSync("npm", ["view", `${pkg.name}@${pkg.version}`, "version"], {
        cwd: root,
        stdio: ["ignore", "ignore", "ignore"],
    });
    alreadyOnNpm = true;
} catch {
    alreadyOnNpm = false;
}

if (alreadyOnNpm) {
    console.log(`${pkg.name}@${pkg.version} already on npm; skipping publish`);
    process.exit(0);
}

console.log(`publishing ${pkg.name}@${pkg.version} to npm`);
run("npm", ["publish", "--access", "public", "--provenance"]);
console.log(`published ${pkg.name}@${pkg.version}`);
