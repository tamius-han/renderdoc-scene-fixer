let table: Uint32Array | null = null;

/** Standard CRC-32 (IEEE 802.3), as required by both PNG chunks and ZIP
 * entries. */
export function crc32(bytes: Uint8Array, seed = 0): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = ~seed >>> 0;
  for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
}
