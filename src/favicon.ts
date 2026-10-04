/** Envelope mark in the design accent (--color-accent). Served for the adapter dashboard tab icon. */
export const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="7" fill="#007acc"/>
  <rect x="6" y="10" width="20" height="14" rx="1.5" fill="#fff"/>
  <path d="M6.8 11.4 16 18.2 25.2 11.4" fill="none" stroke="#007acc" stroke-width="1.7" stroke-linejoin="round"/>
</svg>`;

const SIZE = 16;
const BLUE: [number, number, number, number] = [0x00, 0x7a, 0xcc, 255];
const WHITE: [number, number, number, number] = [255, 255, 255, 255];

function pixel(x: number, y: number): [number, number, number, number] {
  if (x >= 3 && x <= 12 && y >= 4 && y <= 12) {
    const flap = 4 + Math.abs(x - 7.5) * 0.65;
    if (y >= 4 && y <= 8 && Math.abs(y - flap) < 0.85) return BLUE;
    return WHITE;
  }
  return BLUE;
}

/** 16×16 ICO so browsers that request /favicon.ico get a real icon. */
export function faviconIco(): Buffer {
  const xor = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const [r, g, b, a] = pixel(x, y);
      const row = (SIZE - 1 - y) * SIZE + x;
      const offset = row * 4;
      xor[offset] = b;
      xor[offset + 1] = g;
      xor[offset + 2] = r;
      xor[offset + 3] = a;
    }
  }
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(SIZE, 4);
  header.writeInt32LE(SIZE * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const image = Buffer.concat([header, xor, Buffer.alloc(SIZE * 4)]);
  const file = Buffer.alloc(22 + image.length);
  file.writeUInt16LE(1, 2);
  file.writeUInt16LE(1, 4);
  file[6] = SIZE;
  file[7] = SIZE;
  file.writeUInt16LE(1, 10);
  file.writeUInt16LE(32, 12);
  file.writeUInt32LE(image.length, 14);
  file.writeUInt32LE(22, 18);
  image.copy(file, 22);
  return file;
}
