import { closeSync, openSync, opendirSync, Dirent, Dir } from "node:fs";
import { join } from "node:path";
import { Reader } from "./reader";
import { Inflater } from "./inflate";
import { applyOffsetDelta } from "./delta";
/**
 * Retrieves the commit object from a pack file, if it exists.
 *
 * @param oid
 * @param gitDir
 * @returns the commit object as a buffer, or `null` if the commit is not found
 */
export function getCommitFromPackFile(oid: string, gitDir = join(__dirname, "../../../.git")): Buffer | null {
  const packDir = join(gitDir, "objects/pack");
  // use `readSync` to iterate over all files in the pack directory
  let dir: Dir | undefined;
  try {
    dir = opendirSync(packDir);
    const oidBuffer = Buffer.from(oid, "hex");
    let dirent: Dirent | null;
    while ((dirent = dir.readSync()) !== null) {
      if (dirent.isDirectory() || !dirent.name.endsWith(".idx")) continue;

      const idxPath = join(dirent.path, dirent.name);
      const indexFd = openSync(idxPath, "r");
      try {
        const offset = searchGitIndex(indexFd, oidBuffer);
        if (offset === null) continue;

        // if we found the offset, we can read the object from the pack file
        const packFile = idxPath.replace(/\.idx$/u, ".pack");
        const packFd = openSync(packFile, "r");
        const inflater = new Inflater();
        try {
          return readFromPack(packFd, indexFd, offset, inflater).data;
        } finally {
          inflater.close();
          closeSync(packFd);
        }
      } finally {
        closeSync(indexFd);
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    dir && dir.closeSync();
  }
}

/**
 * This is the header of a git Idx file v2. Its 0xff followed by `"tOc"` plus
 * a version number (`0002`).
 */
const idxV2 = Buffer.from([0xff, 0x74, 0x4f, 0x63, 0x0, 0x0, 0x0, 0x2]);
/**
 * Searches the given git index file for the offset of a given oid.
 * Returns the offset if found, otherwise returns null.
 *
 * @param fd
 * @param oid
 * @returns
 */
function searchGitIndex(fd: number, oid: Buffer) {
  const reader = new Reader(fd, 20);
  if (!reader.read(8).equals(idxV2)) throw new Error("unsupported IDX file");

  const value = getOidFromIdx(oid, reader);
  if (value) return value;
  return null;
}

function getOidFromIdx(oid: Buffer, reader: Reader<20>) {
  // Calculate the position of the first byte of the OID in the fanout table
  const first = oid[0];
  const start = first === 0 ? 0 : reader.readUInt32BE(4 * (first - 1));
  const end = reader.readUInt32BE(0);
  const length = end - start;

  // skip over the remainder of the fanout table (255 entries * 4 bytes each)
  reader.seek(4 * (255 - first - 1));

  // record the number of entries in the hash table
  const hashTableLength = reader.readUInt32BE(0);

  // skip the start of the hash table
  reader.seek(20 * start);

  for (let i = 0; i < length; i++) {
    if (!reader.read(20).equals(oid)) continue;

    // skip over the remaining hashes (20 bytes for each hash)
    reader.seek(20 * (hashTableLength - i - start - 1));
    // we don't care about the CRCs (4 bytes for each CRC)
    reader.seek(4 * hashTableLength);
    // skip to the location of our oid's offset (4 bytes for each offset)
    reader.seek(4 * (i + start));
    // finally, read the offset value
    return reader.readUInt32BE(0);
  }
}

const types = new Map<number, string>([
  [0b0001_0000, "commit"],
  [0b0010_0000, "tree"],
  [0b0011_0000, "blob"],
  [0b0100_0000, "tag"],
  [0b0110_0000, "ofs-delta"],
  [0b0111_0000, "ref-delta"]
]);

function readFromPack(
  packFd: number,
  idxFd: number,
  offset: number,
  inflater: Inflater
): { type: string; data: Buffer } {
  const reader = new Reader(packFd, 1).seek(offset);
  const flags = reader.readUInt8(0);
  // type is encoded in bits 654
  const sixFiveFourMask = 0b0111_0000;
  let type = types.get(flags & sixFiveFourMask);
  if (!type) throw new Error(`Unsupported type ${flags & sixFiveFourMask}`);

  const byteLength = readByteLength(reader, flags);
  let base: Buffer | undefined;
  if (type === "ofs-delta") {
    const end = parseVariableLengthQuantity(reader);
    const baseOffset = offset - end;
    ({ type, data: base } = readFromPack(packFd, idxFd, baseOffset, inflater));
  }
  if (type === "ref-delta") {
    const baseOid = reader.peek(20);
    reader.seek(20);
    const baseOffset = searchGitIndex(idxFd, baseOid)!;
    ({ type, data: base } = readFromPack(packFd, idxFd, baseOffset, inflater));
  }
  const object = inflater.inflate(reader, byteLength);
  if (base) return { type, data: applyOffsetDelta(object, base) };

  return { type, data: object };
}

/**
 * Reads the length of the object from the pack file.
 *
 * @param reader
 * @param flags
 * @returns
 */
function readByteLength(reader: Reader, flags: number) {
  // extract the last four bits of length from the data
  let byteLength = flags & 0b0000_1111;
  // check if the next byte is part of the variable-length encoded number
  const multibyte = flags & 0b1000_0000;
  // if multibyte encoding is used, decode the number
  if (multibyte) {
    let shift = 4;
    let byte: number;

    for (; ; shift += 7) {
      // Read the next byte
      byte = reader.readUInt8(0);

      // Accumulate the byte into the length, excluding its most significant bit
      byteLength |= (byte & 0x7f) << shift;

      // Check if the MSB is set, indicating more bytes are part of the number
      // If not, break out of the loop
      if (!(byte & 0x80)) {
        break;
      }
    }
  }
  return byteLength;
}

/**
 * Reads a sequence of bytes from a `Reader` and interprets them as a variable-length quantity.
 * Each byte in the sequence contains 7 bits of data and 1 bit indicating if more bytes follow.
 * This function combines these 7-bit groups into a single integer.
 *
 * @param reader - The reader object used to read bytes. It must have a `readUInt8` method.
 * @returns The integer represented by the sequence of 7-bit groups.
 */
function parseVariableLengthQuantity(reader: Reader<1>): number {
  // Initialize an array to hold the 7-bit data chunks extracted from each byte.
  const dataChunks = [];

  // Temporary variables for processing.
  let currentByte: number;
  let continuationBit: number;

  do {
    // Read the next byte from the reader.
    currentByte = reader.readUInt8(0);

    // Extract the last 7 bits (data bits) and store them.
    dataChunks.push(currentByte & 0b01111111);

    // Determine if the current byte's most significant bit (MSB) is set
    // (continuation bit).
    continuationBit = currentByte & 0b10000000;
  } while (continuationBit); // Continue if the continuation bit is set.

  // Combine the 7-bit chunks into a single integer. The reduce operation
  // initializes the accumulator `a` to -1 and for each chunk, shifts the
  // accumulator left by 7 bits then performs a bitwise OR with the current
  // chunk `b`. This effectively reconstructs the original number from its 7-bit
  // segments.
  return dataChunks.reduce((a, b) => ((a + 1) << 7) | b, -1);
}
