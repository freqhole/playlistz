#!/usr/bin/env node
// publish the draft github release `v$VERSION` for the version recorded in the
// root package.json. run by the changesets action's `publish` step once the
// "Version Packages" PR has merged.
//
// the standalone bundle was already built and uploaded to this draft release
// while the version PR was open (see .github/workflows/release.yml). publishing
// just flips draft -> published, which creates the `v$VERSION` tag at the
// current main HEAD and marks the release latest. no builds run here.
//
// the npm package itself is published separately by .github/workflows/npm-publish.yml,
// which runs on the `v*.*.*` tag (and matches the npm trusted-publisher config).
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
    console.log(`release ${tag} is already published; nothing to do`);
    process.exit(0);
}

// refresh the body (changeset changelog + generated notes) in case the version
// PR changed after the draft was first built, then flip draft -> published.
applyReleaseNotes(tag);

console.log(`publishing draft release ${tag}`);
gh(["release", "edit", tag, "--draft=false", "--latest"]);
console.log(`published ${tag}`);
