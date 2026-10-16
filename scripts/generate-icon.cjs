const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const scale = 4
const sourceSize = 256 * scale
const pixels = Buffer.alloc(sourceSize * sourceSize * 4)

function insideRoundedRect(x, y, left, top, right, bottom, radius) {
  const cx = Math.max(left + radius, Math.min(x, right - radius))
  const cy = Math.max(top + radius, Math.min(y, bottom - radius))
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2
}

function putPixel(x, y, color) {
  if (x < 0 || y < 0 || x >= sourceSize || y >= sourceSize) return
  const index = (y * sourceSize + x) * 4
  pixels[index] = color[0]; pixels[index + 1] = color[1]; pixels[index + 2] = color[2]; pixels[index + 3] = color[3]
}

const navy = [0, 0, 0, 255]
for (let y = 0; y < sourceSize; y++) for (let x = 0; x < sourceSize; x++) {
  putPixel(x, y, navy)
}

function circle(cx, cy, radius, color) {
  const r2 = radius * radius
  for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
    if ((x - cx) ** 2 + (y - cy) ** 2 <= r2) putPixel(x, y, color)
  }
}

function line(x1, y1, x2, y2, width, color) {
  x1 *= scale; y1 *= scale; x2 *= scale; y2 *= scale; width *= scale
  const dx = x2 - x1, dy = y2 - y1, steps = Math.max(Math.abs(dx), Math.abs(dy))
  for (let i = 0; i <= steps; i++) circle(x1 + dx * i / steps, y1 + dy * i / steps, width / 2, color)
}

const white = [245, 247, 248, 255]
function glyphB(x, y) {
  line(x,y,x+62,y,5,white);line(x,y,x,y+60,5,white)
  line(x,y+22,x+50,y+22,5,white);line(x,y+60,x+51,y+60,5,white)
  line(x+50,y+22,x+59,y+29,5,white);line(x+59,y+29,x+59,y+52,5,white);line(x+59,y+52,x+51,y+60,5,white)
}
function glyphO(x, y) {
  line(x+10,y,x+52,y,5,white);line(x+52,y,x+61,y+9,5,white);line(x+61,y+9,x+61,y+51,5,white)
  line(x+61,y+51,x+52,y+60,5,white);line(x+52,y+60,x+10,y+60,5,white)
  line(x+10,y+60,x,y+50,5,white);line(x,y+50,x,y+10,5,white);line(x,y+10,x+10,y,5,white)
}
function glyphC(x, y) {
  line(x+60,y,x+10,y,5,white);line(x+10,y,x,y+10,5,white);line(x,y+10,x,y+50,5,white)
  line(x,y+50,x+10,y+60,5,white);line(x+10,y+60,x+60,y+60,5,white)
}
glyphB(37,44);glyphO(149,44);glyphC(37,133);glyphC(149,133)

const size = 256
const raw = Buffer.alloc((size * 4 + 1) * size)
for (let y = 0; y < size; y++) {
  const row = y * (size * 4 + 1); raw[row] = 0
  for (let x = 0; x < size; x++) for (let channel = 0; channel < 4; channel++) {
    let total = 0
    for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) total += pixels[(((y * scale + sy) * sourceSize + x * scale + sx) * 4) + channel]
    raw[row + 1 + x * 4 + channel] = Math.round(total / (scale * scale))
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c=n;for(let k=0;k<8;k++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;return c>>>0 })
function crc32(buffer){let c=0xffffffff;for(const byte of buffer)c=crcTable[(c^byte)&255]^(c>>>8);return(c^0xffffffff)>>>0}
function chunk(type,data){const t=Buffer.from(type);const out=Buffer.alloc(12+data.length);out.writeUInt32BE(data.length,0);t.copy(out,4);data.copy(out,8);out.writeUInt32BE(crc32(Buffer.concat([t,data])),8+data.length);return out}
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(size,0);ihdr.writeUInt32BE(size,4);ihdr[8]=8;ihdr[9]=6
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw,{level:9})),chunk('IEND',Buffer.alloc(0))])
const icoHeader=Buffer.alloc(22);icoHeader.writeUInt16LE(0,0);icoHeader.writeUInt16LE(1,2);icoHeader.writeUInt16LE(1,4);icoHeader[6]=0;icoHeader[7]=0;icoHeader.writeUInt16LE(1,10);icoHeader.writeUInt16LE(32,12);icoHeader.writeUInt32LE(png.length,14);icoHeader.writeUInt32LE(22,18)
const buildDir=path.join(__dirname,'..','build');fs.mkdirSync(buildDir,{recursive:true});fs.writeFileSync(path.join(buildDir,'icon.png'),png);fs.writeFileSync(path.join(buildDir,'icon.ico'),Buffer.concat([icoHeader,png]))
console.log('Generated build/icon.png and build/icon.ico')
