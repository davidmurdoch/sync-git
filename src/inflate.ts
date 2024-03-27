import { constants } from "node:zlib";
import { Reader } from "./reader";
const noop = () => {};

const { Zlib } = (process as any).binding("zlib");
// `Z_BLOCK` will process the zlib header and then return. The next time
// it runs it will "inflate" up to the end of the input data, or the end
// of the deflate block (which ever comes first) then return. It will
// *not* continue to the next block of compressed data.
// Memory level doesn't really matter for inflation, but it's required for
// initialization so we just use `Z_DEFAULT_MEMLEVEL`.
const { Z_BLOCK, Z_DEFAULT_MEMLEVEL } = constants;

/**
 * A wrapper around the zlib binding to provide incremental inflate
 * functionality for synchronous operations. This functionality is not exposed
 * by Node.js's zlib module.
 */
export class Inflater {
  /**
   * The zlib instance for inflation operations.
   */
  private zlib: Zlib | null;

  /**
   * Holds internal state for inflation operations.
   */
  private state: Uint32Array;

  constructor() {
    const zlib: Zlib = (this.zlib = new Zlib(constants.INFLATE));
    this.state = new Uint32Array(2);
    zlib.init(null, null, Z_DEFAULT_MEMLEVEL, null, this.state, noop, null);
  }

  /**
   * Inflates the data read from the given reader up to the specified output
   * size.
   *
   * Data from the Reader must be well-formed.
   *
   * @param reader - The reader instance from which to read the data.
   * @param outSize - The exact output size after inflation.
   * @returns The inflated data.
   * @throws If the inflater has been closed.
   */
  inflate(reader: Reader<number>, outSize: number): Buffer {
    if (!this.zlib) throw new Error("Inflater has been closed");

    const chunkSize = Math.max(constants.Z_MIN_CHUNK, outSize);
    const output = Buffer.allocUnsafe(outSize);

    let totalInflated = 0;
    let outOffset = 0;

    while (totalInflated < outSize) {
      const chunk = reader.peek(chunkSize);
      reader.seek(chunk.byteLength);

      let inOffset = 0;
      let availInBefore = chunk.byteLength;
      let availOutBefore = outSize - outOffset;

      // continue running while there is still data to process
      while (availInBefore > 0 && availOutBefore > 0) {
        this.zlib.writeSync(Z_BLOCK, chunk, inOffset, availInBefore, output, outOffset, availOutBefore);

        const [availOutAfter, availInAfter] = this.state;
        const inBytesRead = availInBefore - availInAfter;
        const outBytesWritten = availOutBefore - availOutAfter;

        inOffset += inBytesRead;
        outOffset += outBytesWritten;
        totalInflated += outBytesWritten;
        availInBefore = availInAfter;
        availOutBefore = availOutAfter;
      }
    }

    // get ready for more calls
    this.zlib.reset();

    return output;
  }

  /**
   * Closes the inflater, freeing any resources associated with it.
   */
  close(): void {
    if (this.zlib) {
      this.zlib.close();
      this.zlib = null;
    }
  }
}

/**
 * A simplified helper type for the zlib binding.
 */
type Zlib = {
  init: (
    windowBits: number | null,
    level: number | null,
    memLevel: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | number,
    strategy: number | null,
    state: Uint32Array,
    process: (
      flush: number,
      input: Buffer,
      inOff: number,
      inLen: number,
      output: Buffer,
      outOff: number,
      outLen: number
    ) => void,
    end: (() => void) | null
  ) => void;
  writeSync: (
    flush: number,
    input: Buffer,
    inOff: number,
    inLen: number,
    output: Buffer,
    outOff: number,
    outLen: number
  ) => void;
  close: () => void;
  reset: () => void;
};
