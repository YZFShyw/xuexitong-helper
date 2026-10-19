/* 题图指纹 —— 把"题目截图"本身当身份
 *
 *  为什么：公式题的文本有三五种形态（替身字 / 解码真字 / LaTeX / 纯文本），
 *  文本指纹（sha256）对不上；而屏幕上的字形像素是同一种 —— 同一题渲染出来就是同一张图。
 *  实测（518 题块）：同题 NCC 0.996–0.999（2x）/ 0.76–0.84（窄屏），不同题 ≤0.49。
 *
 *  存什么：条目的 shotFp = 16×16 灰度向量（base64），可选 shotRow = 64 维行投影。
 *  怎么用：
 *    fpOfPng(pngBuf)            → { w,h,whole,row } | null
 *    match(bank, fp, opts)      → { entry, score, second } | null（score≥0.70 且领先 second≥0.05）
 *    store(entry, fp)           → 写进条目（不写库，调用方保存）
 */
'use strict';
const zlib = require('zlib');
const IMGFP = require('./图片指纹.js');

/* ---------- 最小 PNG 解码（8bit RGB/RGBA，非隔行） ---------- */
function decodePng(buf) {
  if (!buf || buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not png');
  let off = 8, w = 0, h = 0, color = 6, bit = 8, inter = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bit = data[8]; color = data[9]; inter = data[12]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bit !== 8 || inter !== 0) throw new Error('unsupported png bit/inter');
  const bpp = color === 6 ? 4 : color === 2 ? 3 : color === 0 ? 1 : 0;
  if (!bpp) throw new Error('unsupported color type ' + color);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let p = 0;
  const paeth = (a, b, c) => { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  for (let y = 0; y < h; y++) {
    const ft = raw[p++];
    for (let x = 0; x < stride; x++) {
      const v = raw[p++];
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = (x >= bpp && y > 0) ? out[(y - 1) * stride + x - bpp] : 0;
      let r = v;
      if (ft === 1) r = v + a; else if (ft === 2) r = v + b; else if (ft === 3) r = v + ((a + b) >> 1); else if (ft === 4) r = v + paeth(a, b, c);
      out[y * stride + x] = r & 0xff;
    }
  }
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = Math.round(0.299 * out[i * bpp] + 0.587 * out[i * bpp + 1] + 0.114 * out[i * bpp + 2]);
  return { w, h, gray };
}

/* 行投影：二值化后每行黑像素密度，重采样到 bins（64） */
function rowVec(g, bins) {
  const bg = (g.gray[0] + g.gray[g.w - 1] + g.gray[(g.h - 1) * g.w] + g.gray[(g.h - 1) * g.w + g.w - 1]) / 4;
  const th = Math.min(bg - 25, 200);
  const prof = new Float64Array(g.h);
  for (let y = 0; y < g.h; y++) {
    let c = 0;
    for (let x = 0; x < g.w; x++) if (g.gray[y * g.w + x] < th) c++;
    prof[y] = c / g.w;
  }
  const out = new Float64Array(bins);
  for (let b = 0; b < bins; b++) {
    const y0 = Math.floor(b * g.h / bins), y1 = Math.max(y0 + 1, Math.floor((b + 1) * g.h / bins));
    let s = 0, n = 0;
    for (let y = y0; y < Math.min(y1, g.h); y++) { s += prof[y]; n++; }
    /* 【必须落到 0–255】toB64 是按字节编码的 —— 0–1 的浮点会被四舍五入成 0，
       整条行投影变全零，NCC 恒为 0，match 永远过不了行投影闸门（2026-10-19 实测：同题两次
       整图 NCC=1.000 却 0/10 命中，就是这里）。 */
    out[b] = n ? Math.round((s / n) * 255) : 0;
  }
  return out;
}

const toB64 = (arr) => Buffer.from(Uint8Array.from(Array.from(arr).map((v) => Math.max(0, Math.min(255, Math.round(v)))))).toString('base64');
const fromB64 = (s) => { const b = Buffer.from(String(s || ''), 'base64'); return new Uint8Array(b.buffer, b.byteOffset, b.length); };

/** PNG buffer → 指纹（16×16 整图 + 64 维行投影） */
function fpOfPng(buf) {
  const g = decodePng(buf);
  const whole = IMGFP.fingerprintOfGray(g.gray, g.w, g.h, 16);
  if (!whole) return null;
  return { w: g.w, h: g.h, whole, row: rowVec(g, 64) };
}

/** 任意图片 dataURL（JPEG/PNG）→ 指纹：在**页面里**用 canvas 解码（Node 不引 JPEG 库）。
 *  ev 是驱动器的页面求值函数（支持 await 表达式）。 */
async function fpOfDataUrl(ev, dataUrl) {
  if (typeof ev !== 'function' || !dataUrl) return null;
  let r = null;
  try { r = await ev(IMGFP.decodeScript(dataUrl)); } catch (e) { return null; }
  if (!r || !r.ok || !r.gray) return null;
  const buf = Buffer.from(String(r.gray), 'base64');
  const gray = new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
  const whole = IMGFP.fingerprintOfGray(gray, r.w, r.h, 16);
  if (!whole) return null;
  return { w: r.w, h: r.h, whole, row: rowVec({ gray, w: r.w, h: r.h }, 64) };
}

/** 库里找最像的一题：整图 NCC（阈值 0.70 + 领先 0.05）；可选行投影辅助 */
function match(bank, fp, opts) {
  const o = opts || {};
  const minScore = typeof o.minScore === 'number' ? o.minScore : 0.70;
  const minGap = typeof o.minGap === 'number' ? o.minGap : 0.02;
  const minRow = typeof o.minRow === 'number' ? o.minRow : 0;   /* >0 时 row 也要过 */
  let best = null, second = null;
  for (const k of Object.keys((bank && bank.entries) || {})) {
    const e = bank.entries[k];
    if (!e || !e.shotFp) continue;
    /* 【只比有答案的条目】同一题可能被重复入库（验证脚本 + 运行时各一条），
       空答案那条同分时会挤掉有答案的 → 命中却用不了。 */
    if (!e.answer) continue;
    let v;
    try { v = fromB64(e.shotFp); } catch (err) { continue; }
    const score = IMGFP.ncc(fp.whole, v);
    if (!best || score > best.score) { second = best; best = { entry: e, score }; }
    else if (!second || score > second.score) { second = { entry: e, score }; }
  }
  if (!best || best.score < minScore) return null;
  /* 【同分不算竞争】同一题可能被重复入库（验证脚本 + 运行时各一条），像素完全相同、score 都是 1.000。
     只有"第二名更差、但差距很小"才按歧义拒绝；同分说明是同一张图，直接用。 */
  if (second && second.score < best.score && (best.score - second.score) < minGap) return null;
  if (minRow > 0 && best.entry.shotRow) {
    const rv = fromB64(best.entry.shotRow);
    /* 【兼容旧数据】旧版 rowVec 是 0–1 浮点、被按字节编码成全 0 —— 全 0 时跳过行投影闸门
       （整图 NCC 已经够严：同题 1.000 / 不同题 0.805）；新条目会带上 0–255 的行投影。 */
    let nonZero = false;
    for (let i = 0; i < rv.length; i++) if (rv[i] !== 0) { nonZero = true; break; }
    if (nonZero && IMGFP.ncc(fp.row, rv) < minRow) return null;
  }
  return { entry: best.entry, score: best.score, second: second ? second.score : 0 };
}

/** 把指纹写进条目（不落盘；调用方负责 save） */
function store(entry, fp) {
  if (!entry || !fp || !fp.whole) return false;
  entry.shotFp = toB64(fp.whole);
  if (fp.row) entry.shotRow = toB64(fp.row);
  entry.shotAt = new Date().toISOString();
  return true;
}

/** 条目是否已有指纹 */
function has(entry) { return !!(entry && entry.shotFp); }

/** 只看"最像多少分"（诊断用，不套阈值） */
function peek(bank, fp) {
  let best = 0;
  for (const k of Object.keys((bank && bank.entries) || {})) {
    const e = bank.entries[k];
    if (!e || !e.shotFp) continue;
    try { best = Math.max(best, IMGFP.ncc(fp.whole, fromB64(e.shotFp))); } catch (err) {}
  }
  return best;
}

module.exports = { decodePng, fpOfPng, fpOfDataUrl, match, peek, store, has, toB64, fromB64 };
