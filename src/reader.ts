import { readSync } from "node:fs";

export class Reader<T extends number = number> {
  private fd: number;

  private buffer: Buffer;

  offset: number = 0;

  /**
   * A simple class to read data from a file descriptor.
   *
   * @param fd - The file descriptor to read from.
   * @param maxReadSize - The maximum number of bytes to read at once.
   */
  constructor(fd: number, maxReadSize: T) {
    this.fd = fd;
    this.buffer = Buffer.allocUnsafe(maxReadSize);
  }

  /**
   * Reads `bytes` from the file and returns a Buffer of the read bytes.
   *
   * @param bytes
   */
  read(bytes: number) {
    const bytesRead = readSync(this.fd, this.buffer, 0, bytes, this.offset);
    this.offset += bytesRead;
    return this.buffer.subarray(0, bytesRead);
  }

  /**
   * Allocates a new buffer of size `bytes` and reads into it without updating
   * the internal position.
   *
   * This is not as efficient as `read` and should be used sparingly.
   *
   * @param bytes
   */
  peek(bytes: number) {
    const buffer = Buffer.allocUnsafe(bytes);
    const bytesRead = readSync(this.fd, buffer, 0, bytes, this.offset);
    return buffer.subarray(0, bytesRead);
  }

  /**
   * Updates the internal position by the amount specified in `bytes`.
   *
   * @param bytes
   */
  seek(bytes: number) {
    this.offset += bytes;
    return this;
  }

  /**
   * Reads 4 bytes as a big-endian unsigned 32-bit integer.
   *
   * @param offset - The offset to read from relative to the current read
   * position.
   */
  readUInt32BE(offset: number) {
    return this.seek(offset).read(4).readUInt32BE(0);
  }

  /**
   * Reads 1 byte as an unsigned 8-bit integer.
   *
   * @param offset - The offset to read from relative to the current read
   * position.
   */
  readUInt8(offset: number) {
    return this.seek(offset).read(1).readUInt8(0);
  }
}
