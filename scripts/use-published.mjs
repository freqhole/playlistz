#!/usr/bin/env node
// switch @freqhole/* deps back to published npm versions.
// run: npm run use-published && npm install
//
// the published versions are read from .freqhole-versions.json (git-tracked).
// update that file when you publish a new version.
import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = resolve(root, "package.json");
const versionsPath = resolve(root, ".freqhole-versions.json");

const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
const versions = JSON.parse(readFileSync(versionsPath, "utf-8"));

let changed = false;
for (const [name, version] of Object.entries(versions)) {
    for (const section of ["dependencies", "devDependencies", "peerDependencies"]) {
        if (pkg[section]?.[name] !== undefined && pkg[section][name] !== version) {
            console.log(`  ${name}: ${pkg[section][name]} -> ${version}`);
            pkg[section][name] = version;
            changed = true;
        }
    }
}

if (!changed) {
    console.log("already using published versions - nothing to change");
    process.exit(0);
}

writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log("\nwritten. running npm install...");
execSync("npm install", { cwd: root, stdio: "inherit" });
