/**
 * Applies a git OFS-delta to a source buffer and returns the resulting buffer.
 *
 * The function initializes a cursor for reading through the delta buffer, reads
 * the base and target sizes, then applies a series of operations (as specified
 * in the delta) to reconstruct the target data from the source data.
 *
 * @param delta - The OFS-delta data as a Buffer.
 * @param source - The source data to which the delta is applied.
 * @returns A Buffer representing the target data after applying the delta.
 */
export function applyOffsetDelta(delta: Buffer, source: Buffer): Buffer {
  const readCursor = new Cursor(delta);
  readVariableLengthInt(readCursor); // skip over the base size
  const targetSize = readVariableLengthInt(readCursor);

  const operation = readDeltaOperation(readCursor, source);
  // if the first operation would fill the target buffer, we can return early
  if (operation.byteLength === targetSize) return operation;

  const targetCursor = new Cursor(Buffer.allocUnsafe(targetSize));
  targetCursor.copyFrom(operation);
  while (targetCursor.copyFrom(readDeltaOperation(readCursor, source)));
  return targetCursor.buffer;
}

/**
 * A utility class for reading/write data to/from a buffer with an internal
 * cursor to track the current position.
 */
class Cursor {
  private position = 0;

  private byteLength: number;

  public buffer: Buffer;

  constructor(buffer: Buffer) {
    this.buffer = buffer;
    this.byteLength = buffer.byteLength;
  }

  /**
   * Copies data from the `source` buffer to the cursor's buffer, starting at
   * this current position.
   *
   * @param source
   * @returns `true` if the Buffer has been filled, otherwise `false`.
   */
  copyFrom(source: Buffer): boolean {
    const bytesCopied = source.copy(this.buffer, this.position);
    this.position += bytesCopied;
    return this.position < this.byteLength;
  }

  /**
   * Reads the next byte from the buffer and advances the position by 1.
   */
  readByte(): number {
    return this.buffer[this.position++];
  }

  /**
   * Returns a slice of the buffer from the current position, advancing the
   * position by `offset`.
   *
   * @param offset
   */
  slice(offset: number): Buffer {
    const slice = this.buffer.subarray(this.position, this.position + offset);
    this.position += offset;
    return slice;
  }
}

/**
 * Decodes a variable-length integer encoded in Little Endian format from the
 * cursor. This format encodes integers using one or more bytes, where the most
 * significant bit (MSB) of each byte indicates whether more bytes follow. The
 * remaining 7 bits of each byte are used to store the integer's value in a
 * compact form. This method reads bytes until a byte with MSB = 0 is
 * encountered, indicating the end of the encoded integer.
 *
 * @param cursor - The cursor from which to read the encoded integer.
 * @returns The decoded integer.
 */
function readVariableLengthInt(cursor: Cursor): number {
  let result = 0;
  let shift = 0;
  let byte = cursor.readByte();
  // loop until a byte with its most significant bit set to 0 is found
  for (; byte & 0b1000_0000; byte = cursor.readByte()) {
    // accumulate the integer's value, ignoring the MSB of each byte
    result |= (byte & 0b0111_1111) << shift;
    shift += 7;
  }
  // handle the last byte (with MSB = 0)
  result |= (byte & 0b0111_1111) << shift;

  return result;
}

/**
 * Reads and returns the next operation from the cursor's position, leveraging
 * the `source` buffer for copy operations.
 *
 * Operations are encoded in the first byte read from the cursor, determining
 * whether to copy data from the `source` buffer or to slice data directly from
 * the delta buffer. Copy operations include an offset and size, both compactly
 * encoded, indicating the portion of the `source` buffer to copy. Direct slice
 * operations simply use the remaining part of the first byte as the size for
 * the slice from the delta buffer.
 *
 * @param cursor - The cursor from which to read the operation.
 * @param source - The source buffer to apply copy operations to.
 * @returns A buffer representing the result of the operation (either a slice of
 * the source or a slice of the delta).
 */
function readDeltaOperation(cursor: Cursor, source: Buffer): Buffer {
  const opCode = cursor.readByte();
  const COPY_FLAG = 0b100_00000;
  if (opCode & COPY_FLAG) {
    // opcode specifies a copy operation
    const OFFSET_MASK = 0b000_01111;
    const SIZE_MASK = 0b011_10000;
    // calculate the offset from the source buffer.
    const offset = readCompactNumber(cursor, opCode & OFFSET_MASK, 4);
    // calculate the size of the copy.
    let size = readCompactNumber(cursor, (opCode & SIZE_MASK) >> 4, 3);
    // special case: size encoded as 0 represents 65536 bytes
    if (size === 0) size = 65536;
    // finally, perform the copy operation from the source buffer
    return source.subarray(offset, offset + size);
  }
  // direct slice operation from the delta buffer, using the opCode's lower 7
  // bits as the size.
  return cursor.slice(opCode);
}

/**
 * Decodes a compactly encoded little-endian number from the cursor's current
 * position, using the provided flags to determine which bytes contribute to the
 * final number. This function is used to decode variable-length fields where
 * certain bits in an initial byte indicate the presence of subsequent bytes in
 * the final value.
 *
 * @param cursor - The cursor from which to read the encoded number.
 * @param flagMask - A bitmask indicating which bytes of the encoded number are present.
 * @param maxBytes - The maximum number of bytes to read for decoding the number.
 * @returns The decoded number from the encoded bytes.
 */
function readCompactNumber(cursor: Cursor, flagMask: number, maxBytes: number): number {
  let decodedNumber = 0;
  let shiftAmount = 0;
  while (maxBytes--) {
    // check if the current least-significant bit is set
    if (flagMask & 1) {
      decodedNumber |= cursor.readByte() << shiftAmount;
    }
    // move to the next bit in the flag mask
    flagMask >>= 1;
    // prepare for the next byte, if present.
    shiftAmount += 8;
  }
  return decodedNumber;
}
