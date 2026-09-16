import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { Resvg } from '@resvg/resvg-js';

const directory = new URL('../build/', import.meta.url);
const source = await readFile(new URL('icon.svg', directory));
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const images = new Map();
await mkdir(new URL('icons/', directory), { recursive: true });
for (const size of sizes) {
  const png = new Resvg(source, { fitTo: { mode: 'width', value: size }, font: { loadSystemFonts: false } }).render().asPng();
  images.set(size, png);
  await writeFile(new URL(`icons/${size}x${size}.png`, directory), png);
}
await writeFile(new URL('icon.png', directory), images.get(512));

// Windows Vista and later accept PNG payloads in ICO image entries.
const windowsSizes = sizes.filter(size => size <= 256);
const icoHeader = Buffer.alloc(6 + windowsSizes.length * 16);
icoHeader.writeUInt16LE(1, 2);
icoHeader.writeUInt16LE(windowsSizes.length, 4);
let offset = icoHeader.length;
for (const [index, size] of windowsSizes.entries()) {
  const entry = 6 + index * 16;
  const png = images.get(size);
  icoHeader[entry] = size === 256 ? 0 : size;
  icoHeader[entry + 1] = size === 256 ? 0 : size;
  icoHeader.writeUInt16LE(1, entry + 4);
  icoHeader.writeUInt16LE(32, entry + 6);
  icoHeader.writeUInt32LE(png.length, entry + 8);
  icoHeader.writeUInt32LE(offset, entry + 12);
  offset += png.length;
}
await writeFile(new URL('icon.ico', directory), Buffer.concat([icoHeader, ...windowsSizes.map(size => images.get(size))]));

// Modern ICNS chunks contain PNGs; include normal and Retina representations.
const macTypes = [['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024], ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]];
const chunks = macTypes.map(([type, size]) => {
  const png = images.get(size);
  const header = Buffer.alloc(8);
  header.write(type, 0, 4, 'ascii');
  header.writeUInt32BE(8 + png.length, 4);
  return Buffer.concat([header, png]);
});
const icnsHeader = Buffer.alloc(8);
icnsHeader.write('icns', 0, 4, 'ascii');
icnsHeader.writeUInt32BE(8 + chunks.reduce((length, chunk) => length + chunk.length, 0), 4);
await writeFile(new URL('icon.icns', directory), Buffer.concat([icnsHeader, ...chunks]));
console.log('Generated PNG (16–1024 px), Windows ICO and macOS ICNS from build/icon.svg.');
