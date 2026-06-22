#!/usr/bin/env node
// publish a release for the version recorded in the root package.json. run by
// the changesets action's `publish` step once the "Version Packages" PR has
// merged (no changesets pending).
//
// this does two things, in order:
//   1. flips the draft github release `v$VERSION` to published, which creates
//      the `v$VERSION` tag at the current main HEAD and marks it latest. the
//      standalone bundle was already built + uploaded to this draft while the
//      version PR was open (see .github/workflows/release.yml).
//   2. builds dist and publishes the npm package via npm trusted publishing
//      (oidc). the changesets job runs with `id-token: write`, so `npm publish`
//      performs the oidc exchange itself - no npm token needed. npm matches the
//      oidc token's workflow filename (changesets.yml) against the trusted
//      publisher configured on npmjs.com.
//
// on a successful npm publish it appends `released_version=$VERSION` to
// $GITHUB_OUTPUT so the bump-tomb job can open the downstream dependency PR.
//
// safe to re-run: skips the draft flip if already published, and skips the npm
// publish if that version is already on the registry.
//
// requires the `gh` cli with GH_TOKEN / GITHUB_TOKEN in the environment.

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
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

// the release should already exist as a draft created by release.yml during the
// version PR. if it doesn't, the build never ran - fail loudly so a human can
// re-run release.yml (or build + upload locally) before publishing.
let view;
try {
    view = JSON.parse(gh(["release", "view", tag, "--json", "isDraft,tagName"]));
} catch {
    console.error(`no release found for ${tag}.`);
    console.error("the release workflow should have created a draft while the version PR was open.");
    console.error("re-run .github/workflows/release.yml for this version, then publish.");
    process.exit(1);
}

if (view.isDraft === false) {
    console.log(`release ${tag} already published; leaving it as-is`);
} else {
    // refresh the body (changeset changelog + generated notes) in case the
    // version PR changed after the draft was first built, then flip it live.
    applyReleaseNotes(tag);
    console.log(`publishing draft release ${tag}`);
    gh(["release", "edit", tag, "--draft=false", "--latest"]);
    console.log(`published ${tag}`);
}

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

console.log("building dist for npm publish");
run("npm", ["run", "build"]);

console.log(`publishing ${pkg.name}@${pkg.version} to npm`);
run("npm", ["publish", "--access", "public", "--provenance"]);
console.log(`published ${pkg.name}@${pkg.version}`);

// signal the freshly published version so the bump-tomb job runs.
if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `released_version=${pkg.version}\n`);
}
