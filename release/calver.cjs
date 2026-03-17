"use strict";
// CalVer semantic-release plugin — YYYY.M.D[-iteration]
// Overrides nextRelease.version in the prepare lifecycle before
// @semantic-release/npm and @semantic-release/git consume it.
const { execSync } = require("child_process");

module.exports = {
  prepare(pluginConfig, context) {
    const { nextRelease, logger } = context;

    const now = new Date();
    const base = `${now.getUTCFullYear()}.${now.getUTCMonth() + 1}.${now.getUTCDate()}`;

    // Find any tags already published today
    let existing = [];
    try {
      const out = execSync(`git tag -l "${base}" "${base}-*"`, { encoding: "utf8" });
      existing = out.trim().split("\n").filter(Boolean);
    } catch {
      existing = [];
    }

    let version;
    if (existing.length === 0) {
      version = base;
    } else {
      const iters = existing.map((t) => {
        const m = t.match(/-(\d+)$/);
        return m ? parseInt(m[1], 10) : 0;
      });
      version = `${base}-${Math.max(...iters) + 1}`;
    }

    logger.log("CalVer: %s → %s", nextRelease.version, version);
    nextRelease.version = version;
    nextRelease.gitTag = `v${version}`;
  },
};
