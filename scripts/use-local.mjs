#!/usr/bin/env node
// switch @freqhole/* deps to local file: paths for development.
// run: npm run use-local && npm install
import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = resolve(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

// paths are relative to the playlistz/ directory (adjust if your monorepo layout differs)
const LOCAL = {
    "@freqhole/api-client": "file:../tomb/client-codegen/freqhole-api-client",
    "@freqhole/midden": "file:../tomb/client/midden/pkg",
};

let changed = false;
for (const [name, localPath] of Object.entries(LOCAL)) {
    for (const section of ["dependencies", "devDependencies", "peerDependencies"]) {
        if (pkg[section]?.[name] !== undefined && pkg[section][name] !== localPath) {
            console.log(`  ${name}: ${pkg[section][name]} -> ${localPath}`);
            pkg[section][name] = localPath;
            changed = true;
        }
    }
}

if (!changed) {
    console.log("already using local paths - nothing to change");
    process.exit(0);
}

writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log("\nwritten. running npm install...");
execSync("npm install", { cwd: root, stdio: "inherit" });
