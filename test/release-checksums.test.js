import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { writeReleaseChecksums } from "../scripts/release-checksums.mjs";

test("release checksums are regenerated from the final archive bytes", async t => {
  const directory = await mkdtemp(join(tmpdir(), "capacity-atlas-checksums-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const names = ["mac.zip", "windows.zip"];
  const contents = [Buffer.from("mac-final-archive"), Buffer.from("windows-final-archive")];
  for (let index = 0; index < names.length; index += 1) {
    await writeFile(join(directory, names[index]), contents[index]);
  }

  await writeReleaseChecksums(directory, names);

  const actual = await readFile(join(directory, "SHA256SUMS.txt"), "utf8");
  const expected = names.map((name, index) => `${createHash("sha256").update(contents[index]).digest("hex")}  ${name}`).join("\n") + "\n";
  assert.equal(actual, expected);
});
