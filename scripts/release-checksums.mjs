import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function writeReleaseChecksums(directory, archiveNames) {
  const names = [...archiveNames];
  if (!names.length || names.some(name => typeof name !== "string" || name !== basename(name) || /[\r\n]/.test(name))) {
    throw new Error("Release archive names must be safe basenames.");
  }
  const lines = [];
  for (const name of names) lines.push(`${await sha256(join(directory, name))}  ${name}`);
  const destination = join(directory, "SHA256SUMS.txt");
  const temporary = `${destination}.tmp-${process.pid}`;
  try {
    await writeFile(temporary, `${lines.join("\n")}\n`, { mode: 0o644 });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}
