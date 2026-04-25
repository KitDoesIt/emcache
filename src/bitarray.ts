import { writeFileSync } from "fs";

export class BitArray {
  private data: Buffer;
  public readonly size: number;
  private _count: number = 0;

  constructor(size: number) {
    this.size = size;
    this.data = Buffer.alloc(Math.ceil(size / 8));
  }

  get count(): number {
    return this._count;
  }

  get(index: number): number {
    if (index >= this.size) {
      throw new Error("Index out of bounds");
    }

    const byteIndex = index >> 3;
    const bitIndex = index & 7;
    return (this.data[byteIndex]! >> bitIndex) & 1;
  }

  set(index: number, value: 0 | 1 | boolean): void {
    if (index >= this.size) {
      throw new Error("Index out of bounds");
    }

    const byteIndex = index >> 3;
    const bitIndex = index & 7;
    const mask = 1 << bitIndex;
    const wasSet = (this.data[byteIndex]! & mask) !== 0;

    if (value) {
      this.data[byteIndex]! |= mask;
      if (!wasSet) this._count++;
    } else {
      this.data[byteIndex]! &= ~mask;
      if (wasSet) this._count--;
    }
  }

  static async fromFile(path: string): Promise<BitArray> {
    const buffer = await Bun.file(path).arrayBuffer();
    return BitArray.fromBuffer(Buffer.from(buffer));
  }

  static fromBuffer(buffer: Buffer): BitArray {
    const size = buffer.readUInt32LE(0);
    const dataSize = Math.ceil(size / 8);
    const data = buffer.subarray(4, 4 + dataSize);

    const bitArray = new BitArray(size);
    data.copy(bitArray.data);

    // Compute initial count
    for (let i = 0; i < data.length; i++) {
      bitArray._count += BitArray.#popcount(data[i]!);
    }
    // Handle any leftover bits in the last byte
    const remainder = size % 8;
    if (remainder !== 0 && data.length > 0) {
      const lastByte = data[data.length - 1]!;
      const validBitsMask = (1 << remainder) - 1;
      bitArray._count -= BitArray.#popcount(lastByte & ~validBitsMask);
    }

    return bitArray;
  }

  async toFile(path: string) {
    const buffer = this.toBuffer();

    await Bun.write(path, buffer);
  }

  toBuffer(): Buffer {
    const buffer = Buffer.alloc(4 + this.data.length);
    buffer.writeUInt32LE(this.size, 0);
    this.data.copy(buffer, 4);
    return buffer;
  }

  static #POPCOUNT = new Uint8Array([
    0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4, 1, 2, 2, 3, 2, 3, 3, 4, 2,
    3, 3, 4, 3, 4, 4, 5, 1, 2, 2, 3, 2, 3, 3, 4, 2, 3, 3, 4, 3, 4, 4, 5, 2, 3,
    3, 4, 3, 4, 4, 5, 3, 4, 4, 5, 4, 5, 5, 6, 1, 2, 2, 3, 2, 3, 3, 4, 2, 3, 3,
    4, 3, 4, 4, 5, 2, 3, 3, 4, 3, 4, 4, 5, 3, 4, 4, 5, 4, 5, 5, 6, 2, 3, 3, 4,
    3, 4, 4, 5, 3, 4, 4, 5, 4, 5, 5, 6, 3, 4, 4, 5, 4, 5, 5, 6, 4, 5, 5, 6, 5,
    6, 6, 7, 1, 2, 2, 3, 2, 3, 3, 4, 2, 3, 3, 4, 3, 4, 4, 5, 2, 3, 3, 4, 3, 4,
    4, 5, 3, 4, 4, 5, 4, 5, 5, 6, 2, 3, 3, 4, 3, 4, 4, 5, 3, 4, 4, 5, 4, 5, 5,
    6, 3, 4, 4, 5, 4, 5, 5, 6, 4, 5, 5, 6, 5, 6, 6, 7, 2, 3, 3, 4, 3, 4, 4, 5,
    3, 4, 4, 5, 4, 5, 5, 6, 3, 4, 4, 5, 4, 5, 5, 6, 4, 5, 5, 6, 5, 6, 6, 7, 3,
    4, 4, 5, 4, 5, 5, 6, 4, 5, 5, 6, 5, 6, 6, 7, 4, 5, 5, 6, 5, 6, 6, 7, 5, 6,
    6, 7, 6, 7, 7, 8,
  ]);

  static #popcount(byte: number): number {
    return BitArray.#POPCOUNT[byte]!;
  }
}
