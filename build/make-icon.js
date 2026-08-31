'use strict';
/* สร้างไอคอน: วงกลมสีชมพูพาสเทล มีคำว่า "toolHOSOS" อยู่ข้างใน
   ผลลัพธ์: build/icon.ico (หลายขนาด) และ build/icon.png (256px) */
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');
const pngToIco = require('png-to-ico');

function svg(size) {
  const c = size / 2;
  const r = size * 0.47;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <radialGradient id="g" cx="38%" cy="32%" r="80%">
      <stop offset="0%"  stop-color="#ffd7e8"/>
      <stop offset="55%" stop-color="#f7a8c7"/>
      <stop offset="100%" stop-color="#ec6f9e"/>
    </radialGradient>
    <linearGradient id="ring" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.95"/>
      <stop offset="100%" stop-color="#ffd9e7" stop-opacity="0.9"/>
    </linearGradient>
  </defs>
  <circle cx="${c}" cy="${c}" r="${r}" fill="url(#ring)"/>
  <circle cx="${c}" cy="${c}" r="${r - size*0.045}" fill="url(#g)"/>
  <circle cx="${c}" cy="${c}" r="${r - size*0.045}" fill="none" stroke="#ffffff" stroke-opacity="0.55" stroke-width="${size*0.012}"/>
  <text x="50%" y="50%" text-anchor="middle" dominant-baseline="central"
        font-family="Arial, 'Segoe UI', sans-serif" font-weight="700"
        font-size="${size*0.19}" fill="#ffffff"
        style="paint-order:stroke" stroke="#c4638a" stroke-width="${size*0.006}">toolHOSOS</text>
</svg>`;
}

function renderPng(size) {
  const r = new Resvg(svg(size), {
    fitTo: { mode: 'width', value: size },
    font: { loadSystemFonts: true },
    background: 'rgba(0,0,0,0)'
  });
  return r.render().asPng();
}

(function main() {
  const outDir = __dirname;
  const sizes = [256, 128, 64, 48, 32, 16];
  const pngs = sizes.map(renderPng);
  fs.writeFileSync(path.join(outDir, 'icon.png'), pngs[0]);
  pngToIco(pngs).then((ico) => {
    fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);
    console.log('สร้างไอคอนสำเร็จ: build/icon.ico (' + sizes.join(',') + ') + build/icon.png');
  }).catch((e) => { console.error('สร้าง .ico ล้มเหลว:', e); process.exit(1); });
})();
