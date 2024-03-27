/**
 * @file Fast git utilities for retrieving commit metadata.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getCommitFromPackFile } from "./pack";

/**
 * Retrieves the commit hash of the last commit on the current Git branch.
 *
 * Does not require git and is faster than shelling out to git.
 *
 * TODO: investigate if we need to handle packed-refs
 *
 * @param gitDir - The path to the `.git` directory of the repository. Defaults
 * to the `.git` directory in the root of the project.
 * @returns Millisecond precision timestamp in UTC of the last commit on the
 * current branch. If the branch is detached or has no commits, it will throw an
 * error.
 * @throws Throws an error if the current branch is detached or has no commits.
 * May also throw if the Git repository is malformed (or not found).
 */
export function getLastCommitHash(gitDir = join(__dirname, "../.git")) {
  // read .git/HEAD to get the current branch/commit
  const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
  return fromOidFromSymbolicRef(head, gitDir);
}

/**
 * Retrieves the timestamp of the last commit in UTC for the current Git branch.
 *
 * The author timestamp is used for its consistency across different
 * repositories and its inclusion in the Git commit hash calculation. This makes
 * it a stable choice for reproducible builds.
 *
 * Does not require git and is faster than shelling out to git.
 *
 * This function is synchronous because it's faster for our workloads this way.
 *
 * @param oid - The commit hash to retrieve the timestamp for. Defaults to the
 * latest commit on the current branch.
 * @param gitDir - The path to the `.git` directory of the repository. Defaults
 * to the `.git` directory in the root of the project.
 * @returns Millisecond precision timestamp in UTC of the last commit on the
 * current branch. If the branch is detached or has no commits, it will throw an
 * error.
 * @throws Throws an error if the current branch is detached or has no commits.
 * May also throw if the Git repository is malformed (or not found).
 */
export function getCommitTimestamp(oid: string | null = null, gitDir = join(__dirname, "../.git")) {
  let hash = oid;
  if (hash === null) hash = getLastCommitHash(gitDir);
  const commitBuffer = getCommit(hash, gitDir);
  if (!commitBuffer) throw new Error(`commit ${hash} not found`);

  // the commit object is a text file with a header and a body, we just want the
  // body, which is after the first null byte (if there is one)
  const firstNull = commitBuffer.indexOf(0);
  const commit = commitBuffer.subarray(firstNull + 1).toString("utf8");
  // commits are strictly formatted; use regex to extract the time fields
  const timestamp = extractAuthorTimestamp(commit);
  // convert git timestamp from seconds to milliseconds
  return parseInt(timestamp, 10) * 1000;
}

/**
 * Recursively resolves symbolic refs to their commit hash.
 *
 * @param symbolicRef
 * @param gitDir
 * @returns
 */
function fromOidFromSymbolicRef(symbolicRef: string, gitDir: string) {
  // determine if we're in a detached HEAD state or on a branch
  if (symbolicRef.startsWith("ref: ")) {
    let oid: string | undefined;
    // HEAD is a symbolic ref
    const ref = symbolicRef.slice(5);
    const refPath = join(gitDir, ref);
    try {
      // try to load the commit hash
      oid = readFileSync(refPath, "utf8").trim();
    } catch {
      // if the ref file doesn't exist, it might be packed; try to read
      // packed-refs
      const packedRefs = readFileSync(join(gitDir, "packed-refs"), "utf8");
      for (const line of packedRefs.split("\n")) {
        if (line.startsWith("#")) continue;
        const [_, lineRef] = line.split(" ");
        if (lineRef === ref) {
          oid = line.split(" ")[0];
          break;
        }
      }

      if (!oid) throw new Error(`commit at ${refPath} not found`);
    }
    // recursively resolve the ref until we get to the commit hash
    return fromOidFromSymbolicRef(oid, gitDir);
  }

  // HEAD is detached; so use the commit hash directly
  return symbolicRef;
}

/**
 * Retrieves the commit object from the file system.
 *
 * @param oid
 * @param gitDir
 * @returns
 */
function getCommit(oid: string, gitDir: string): Buffer | null {
  // most commits will be available as loose objects, but if it isn't we'll need
  // to look in the packfiles.
  return getCommitFromLoose(oid, gitDir) || getCommitFromPackFile(oid, gitDir);
}

/**
 * Retrieves the commit object from the file system.
 *
 * @param oid
 * @param gitDir
 */
function getCommitFromLoose(oid: string, gitDir: string) {
  // read the commit object from the file system
  const commitPath = join(gitDir, "objects", oid.slice(0, 2), oid.slice(2));
  try {
    const { inflateSync } = require("node:zlib") as typeof import("node:zlib");
    return inflateSync(readFileSync(commitPath));
  } catch {
    return null;
  }
}

/**
 * Extracts the authorship timestamp from a well-formed git commit string.
 *
 * @param commit - A well-formed git commit
 * @returns timestamp of the commit
 */
function extractAuthorTimestamp(commit: string): string {
  return (commit.match(/^author .* <.*> (.*) .*$/mu) as string[])[1];
}
