import { describe, it } from "node:test";
import assert from "node:assert";
import { join } from "node:path";
import { execSync } from "node:child_process";
import * as git from "../src/";

describe("git", () => {
  const mocks = ["detached-head", "loose", "pruned"];
  mocks.forEach((mock) => {
    describe(mock, () => {
      const gitDir = join(__dirname, "fixtures", mock);
      it(`should get the latest commit hash for: ${mock}`, () => {
        const gitHash = execSync(`git --git-dir "${gitDir}" rev-parse HEAD`);
        const commitHash = git.getLastCommitHash(gitDir);
        assert.strictEqual(commitHash, gitHash.toString().trim());
      });

      it(`should get the last commit's author timestamp for: ${mock}`, async () => {
        const gitTimestamp = execSync(`git --git-dir "${gitDir}" log -1 --format='%at'`).toString();
        const timestamp = git.getCommitTimestamp(null, gitDir);
        // our timestamps have millisecond precision, because: JavaScript.
        assert.strictEqual(timestamp, Number(gitTimestamp) * 1000);
      });

      it(`should throw a "not found" error if the commit doesn't exist for: ${mock}`, () => {
        assert.throws(
          () => git.getCommitTimestamp("0000000000000000000000000000000000000000", gitDir),
          /commit 0000000000000000000000000000000000000000 not found/u
        );
      });
    });
  });

  it("should throw if there is no HEAD file", () => {
    const gitDir = join(__dirname, "fixtures", "doesnt-exist");
    assert.throws(() => git.getCommitTimestamp(null, gitDir), /ENOENT: no such file or directory/u);
    assert.throws(() => git.getCommitTimestamp(undefined, gitDir), /ENOENT: no such file or directory/u);
  });

  it("should throw if there are no commits", () => {
    const gitDir = join(__dirname, "fixtures", "no-commit");
    assert.throws(() => git.getCommitTimestamp(null, gitDir), /ENOENT: no such file or directory/u);
    assert.throws(() => git.getCommitTimestamp(undefined, gitDir), /ENOENT: no such file or directory/u);
  });
});
