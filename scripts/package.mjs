import { readFile, writeFile } from "node:fs/promises";
import { deflateRawSync, crc32 } from "node:zlib";
import { createHash } from "node:crypto";
// The complete artifact allowlist. Never zip a repository or working directory.
const names = [
  "api",
  "relay",
  "intake",
  "migrate",
  "coordination",
  "channel-send",
  "channel-receive",
  "agent",
  "result",
  "reconcile",
];
const filename = Buffer.from("index.cjs");
for (const name of names) {
  const data = await readFile(`dist/${name}/index.cjs`),
    compressed = deflateRawSync(data, { level: 9 }),
    checksum = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(33, 12);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE((3 << 8) | 20, 4); // Unix creator, fixed file permissions.
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(33, 14);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(filename.length, 28);
  central.writeUInt32LE((0o100644 * 65536) >>> 0, 38);
  const end = Buffer.alloc(22),
    directoryOffset = local.length + filename.length + compressed.length;
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12);
  end.writeUInt32LE(directoryOffset, 16);
  const archive = Buffer.concat([
    local,
    filename,
    compressed,
    central,
    filename,
    end,
  ]);
  await writeFile(`dist/${name}.zip`, archive);
  console.log(`${name}: ${createHash("sha256").update(archive).digest("hex")}`);
}
