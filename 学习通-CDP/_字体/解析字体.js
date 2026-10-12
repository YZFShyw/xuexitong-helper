/* TrueType 解析器 —— 看懂那支反爬字体里到底装了什么
 *
 * 用法：
 *   node 解析字体.js                解 _字体\font-01-font-cxsecret.ttf
 *   node 解析字体.js <另一个.ttf>    解指定的字体（也支持 .ttc 字体集）
 *   node 解析字体.js --json         另外把字形轮廓导出成 _字体\轮廓.json
 *
 * ------------------------------------------------------------------
 * 这段代码在干什么、坑在哪：
 *
 * 1. TrueType 就是一棵带索引的树
 *    文件开头是"表目录"：每个表有 4 字节标签 + 偏移 + 长度。
 *    要什么就按标签去查表，不用从头顺序读。需要的表：
 *      head  字体全局参数（其中 indexToLocFormat 决定 loca 用短格式还是长格式）
 *      maxp  有多少个字形 numGlyphs
 *      cmap  码位 -> 字形编号（glyph id）的映射
 *      loca  每个字形在 glyf 表里的位置（numGlyphs+1 个偏移）
 *      glyf  字形轮廓本体
 *      post  字形名字。反爬字体常常**忘了删**，名字里直接写着真字
 *
 * 2. 为什么 post 表是第一个要看的
 *    post 2.0 格式里每个字形带一个名字，子集化时如果没重建名字表，
 *    名字会保留原始字体的命名，比如 uni5C3C 就是"尼"。
 *    有名字就等于白送一份对照表，一个像素都不用比对。
 *
 * 3. cmap 有 4/6/12 三种常见格式，必须都支持
 *    format 4 是最老的 16 位格式，也是中文字体最常用的一种；
 *    format 12 是 32 位的，用于大字库；format 6 是连续区间的小表。
 *
 * 4. 千万别用有符号数读无符号字段
 *    Node 的 Buffer.readUInt16BE 和 readInt16BE 就差一个字母，
 *    换错了会读出负数或者 65535 这种鬼数字。
 *    偏移量（loca/glyf 里的）一律无符号，坐标一律有符号。
 * ------------------------------------------------------------------ */

'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const WANT_JSON = process.argv.includes('--json');
const FONT = args[0] || path.join(__dirname, 'font-01-font-cxsecret.ttf');

const buf = fs.readFileSync(FONT);
const u8 = (o) => buf.readUInt8(o);
const u16 = (o) => buf.readUInt16BE(o);
const i16 = (o) => buf.readInt16BE(o);
const u32 = (o) => buf.readUInt32BE(o);
const tag = (o) => buf.toString('latin1', o, o + 4);

/* ---------- 表目录（含 .ttc 字体集） ---------- */
function findSfnt(base) {
  if (tag(base) === 'ttcf') {
    const n = u32(base + 8);
    const offs = [];
    for (let i = 0; i < n; i++) offs.push(u32(base + 12 + i * 4));
    return offs;
  }
  return [base];
}

function readTables(base) {
  const ver = u32(base);
  const n = u16(base + 4);
  const t = {};
  for (let i = 0; i < n; i++) {
    const r = base + 12 + i * 16;
    t[tag(r)] = { off: u32(r + 8), len: u32(r + 12) };
  }
  return { ver, tables: t };
}

const sfnts = findSfnt(0);
console.log('文件: ' + path.basename(FONT) + '   ' + buf.length + ' 字节');
if (sfnts.length > 1) console.log('这是一个字体集(.ttc)，里面有 ' + sfnts.length + ' 支字体');
console.log('');

const ALL = [];
for (let si = 0; si < sfnts.length; si++) {
  const base = sfnts[si];
  const { ver, tables } = readTables(base);
  const T = (name) => (tables[name] ? base + tables[name].off : 0);

  console.log('──── 第 ' + (si + 1) + ' 支  version=0x' + ver.toString(16));
  console.log('     表: ' + Object.keys(tables).sort().join(' '));

  const headO = T('head'), maxpO = T('maxp');
  const unitsPerEm = headO ? u16(headO + 18) : 1000;
  const locFormat = headO ? i16(headO + 50) : 0;
  const numGlyphs = maxpO ? u16(maxpO + 4) : 0;
  console.log('     unitsPerEm=' + unitsPerEm + '  indexToLocFormat=' + locFormat + '  numGlyphs=' + numGlyphs);

  /* ---- cmap ---- */
  const cmapO = T('cmap');
  const cmapMap = [];   /* {cp, gid} */
  let cmapFmt = [];
  if (cmapO) {
    const nSub = u16(cmapO + 2);
    const tried = new Set();
    for (let s = 0; s < nSub; s++) {
      const r = cmapO + 4 + s * 8;
      const pid = u16(r), eid = u16(r + 2), subO = cmapO + u32(r + 4);
      const fmt = u16(subO);
      if (tried.has(fmt)) continue;
      tried.add(fmt);
      cmapFmt.push('pid' + pid + '/eid' + eid + ':fmt' + fmt);
      if (fmt === 4) {
        const segX2 = u16(subO + 6), seg = segX2 / 2;
        const endO = subO + 14, startO = endO + segX2 + 2;
        const deltaO = startO + segX2, rangeO = deltaO + segX2;
        for (let g = 0; g < seg; g++) {
          const end = u16(endO + g * 2), start = u16(startO + g * 2);
          const delta = i16(deltaO + g * 2), ro = u16(rangeO + g * 2);
          if (start === 0xffff) continue;
          for (let cp = start; cp <= end && cp !== 0x10000; cp++) {
            let gid;
            if (ro === 0) gid = (cp + delta) & 0xffff;
            else {
              const gi = rangeO + g * 2 + ro + (cp - start) * 2;
              if (gi + 1 >= buf.length) continue;
              gid = u16(gi);
              if (gid !== 0) gid = (gid + delta) & 0xffff;
            }
            if (gid) cmapMap.push({ cp, gid });
          }
        }
      } else if (fmt === 12) {
        const nG = u32(subO + 12);
        for (let g = 0; g < nG; g++) {
          const r2 = subO + 16 + g * 12;
          const sc = u32(r2), ec = u32(r2 + 4), sg = u32(r2 + 8);
          for (let cp = sc; cp <= ec; cp++) cmapMap.push({ cp, gid: sg + (cp - sc) });
        }
      } else if (fmt === 6) {
        const first = u16(subO + 6), cnt = u16(subO + 8);
        for (let i = 0; i < cnt; i++) cmapMap.push({ cp: first + i, gid: u16(subO + 10 + i * 2) });
      }
    }
  }

  /* ---- loca ---- */
  let loca = null;
  if (T('loca') && locFormat >= 0) {
    loca = new Uint32Array(numGlyphs + 1);
    for (let i = 0; i <= numGlyphs; i++) {
      loca[i] = locFormat === 0 ? u16(T('loca') + i * 2) * 2 : u32(T('loca') + i * 4);
    }
  }

  /* ---- glyf：取轮廓点数 ---- */
  const glyphs = new Map();
  const glyfO = T('glyf');
  if (glyfO && loca) {
    for (let gid = 0; gid < numGlyphs; gid++) {
      const s = loca[gid], e = loca[gid + 1];
      if (e <= s) { glyphs.set(gid, { empty: true }); continue; }
      const o = glyfO + s;
      const nc = i16(o);
      if (nc < 0) { glyphs.set(gid, { composite: true }); continue; }
      const ends = [];
      for (let c = 0; c < nc; c++) ends.push(u16(o + 10 + c * 2));
      const nPts = nc ? ends[nc - 1] + 1 : 0;
      glyphs.set(gid, {
        contours: nc, points: nPts,
        bbox: [i16(o + 2), i16(o + 4), i16(o + 6), i16(o + 8)],
        ends: ends, glyphOff: s
      });
    }
  }

  /* ---- post 字形名 ---- */
  let names = null, postVer = 0;
  const postO = T('post');
  if (postO) {
    postVer = u32(postO);
    if (postVer === 0x20000) {
      const n = u16(postO + 32);
      const idx = [];
      for (let i = 0; i < n; i++) idx.push(u16(postO + 34 + i * 2));
      const strO = postO + 34 + n * 2;
      const strs = [];
      let p = strO;
      const MAC = ['mac0', 'mac1', 'mac2', 'mac3', 'mac4', 'mac5', 'mac6', 'mac7', 'mac8', 'mac9'];
      for (let i = 0; i < n; i++) {
        if (idx[i] < 258) { strs.push('<标准名#' + idx[i] + '>'); continue; }
        if (p >= buf.length) break;
        const L = u8(p); p++;
        strs.push(buf.toString('latin1', p, p + L)); p += L;
      }
      names = strs;
    }
  }

  console.log('     cmap 子表: ' + cmapFmt.join(', ') + '   映射出 ' + cmapMap.length + ' 个码位');
  console.log('     post 版本: ' + (postVer ? '0x' + postVer.toString(16) : '无') +
    (names ? '   字形名 ' + names.length + ' 个' : ''));

  /* ---- 最有价值的输出：码位 -> 字形名/点数 ---- */
  if (cmapMap.length) {
    console.log('');
    console.log('     码位      字符      字形号  轮廓  点数    post 名字');
    console.log('     ' + '-'.repeat(62));
    const byGid = new Map();
    for (const { cp, gid } of cmapMap) {
      if (!byGid.has(gid)) byGid.set(gid, []);
      byGid.get(gid).push(cp);
    }
    for (const { cp, gid } of cmapMap.slice(0, 200)) {
      const gl = glyphs.get(gid) || {};
      const nm = names && names[gid] ? names[gid] : '';
      console.log('     U+' + cp.toString(16).toUpperCase().padStart(4, '0') +
        '   ' + String.fromCodePoint(cp).padEnd(4, ' ') +
        '   ' + String(gid).padStart(6) +
        '   ' + String(gl.contours == null ? '-' : gl.contours).padStart(4) +
        '   ' + String(gl.points == null ? '-' : gl.points).padStart(5) +
        '   ' + nm);
    }
    if (cmapMap.length > 200) console.log('     ...（还有 ' + (cmapMap.length - 200) + ' 个）');

    const dup = [...byGid.entries()].filter(([, v]) => v.length > 1);
    console.log('');
    console.log('     多个码位共用同一字形的: ' + dup.length + ' 组' +
      (dup.length ? '   <-- 说明同一个真字会随机换成不同的替身字' : ''));
    for (const [gid, cps] of dup.slice(0, 6)) {
      console.log('       字形 ' + gid + ' <- ' + cps.map((c) => String.fromCodePoint(c)).join(' '));
    }
  }

  if (WANT_JSON && loca && glyfO) {
    const out = { unitsPerEm, numGlyphs, glyphs: {}, cmap: cmapMap, names };
    for (let gid = 0; gid < numGlyphs; gid++) {
      const gl = glyphs.get(gid);
      if (!gl || gl.empty || gl.composite || !gl.points) continue;
      const o = glyfO + gl.glyphOff;
      const nc = gl.contours;
      const instrLen = u16(o + 10 + nc * 2);
      let p = o + 10 + nc * 2 + 2 + instrLen;
      const flags = [];
      for (let i = 0; i < gl.points;) {
        const f = u8(p); p++;
        flags.push(f);
        i++;
        if (f & 8) { const r = u8(p); p++; for (let k = 0; k < r; k++) { flags.push(f); i++; } }
      }
      const xs = []; let x = 0;
      for (let i = 0; i < gl.points; i++) {
        const f = flags[i];
        if (f & 2) { const d = u8(p); p++; x += (f & 16) ? d : -d; }
        else if (!(f & 16)) { x += i16(p); p += 2; }
        xs.push(x);
      }
      const ys = []; let y = 0;
      for (let i = 0; i < gl.points; i++) {
        const f = flags[i];
        if (f & 4) { const d = u8(p); p++; y += (f & 32) ? d : -d; }
        else if (!(f & 32)) { y += i16(p); p += 2; }
        ys.push(y);
      }
      out.glyphs[gid] = { ends: gl.ends, xs, ys, bbox: gl.bbox, onCurve: flags.map((f) => (f & 1) ? 1 : 0) };
    }
    const jp = path.join(path.dirname(FONT), '轮廓.json');
    fs.writeFileSync(jp, JSON.stringify(out), 'utf8');
    console.log('');
    console.log('     轮廓已导出: ' + jp + '  (' + Math.round(fs.statSync(jp).size / 1024) + ' KB)');
  }

  ALL.push({ unitsPerEm, numGlyphs, cmapMap, glyphs, names });
  console.log('');
}
