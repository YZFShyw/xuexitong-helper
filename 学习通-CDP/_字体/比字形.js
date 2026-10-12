/* 比字形 —— 把替身字形跟两万个汉字的形状逐个比，找出最像的那个
 *
 * 用法：
 *   node 比字形.js              比对并写出 _字体\对照表.json
 *   node 比字形.js --top 8      每个替身多打几个候选出来看
 *   node 比字形.js --show       只打印，不写文件
 *
 * 前置：先跑 扫字形.ps1 生成 mask-参照.bin / mask-替身.bin / 扫描索引.json
 *
 * ------------------------------------------------------------------
 * 在干什么：
 *   每个字形已经被渲染成 32x32 的灰度小图（墨迹程度 0~1）。
 *   现在要问：41 个替身字形，各自跟哪一汉字最像？
 *
 *   用的是归一化互相关（Normalized Cross-Correlation）：
 *       score = Σ(aᵢ-mₐ)(bᵢ-m_b) / (‖a‖·‖b‖)
 *   1 = 完全一样，0 = 毫无关系，负数 = 明暗正好相反。
 *   它比"逐像素差值的和"好的地方是不受整体明暗/粗细偏移影响，
 *   笔画粗细不同的两支字体（这里参照字体是 Regular，替身是 Normal）
 *   也能对上。
 *
 * ------------------------------------------------------------------
 * 坑：
 *
 * 1. 必须先减均值
 *    不减均值直接算 Σaᵢbᵢ 的话，"整张图都很黑"的复杂字会拿到高分，
 *    因为它跟任何东西的乘积累加都大。减掉均值才是"形状像不像"。
 *
 * 2. 减均值的写法要化简，否则要两趟循环
 *    Σ(aᵢ-mₐ)(bᵢ-m_b) = Σaᵢbᵢ - N·mₐ·m_b
 *    这样每个参照字只需要预先算好 Σbᵢ 和 Σbᵢ²，
 *    比对时只需算一次 Σaᵢbᵢ，省掉一趟 1024 元素的循环。
 *    2 万 × 41 × 1024 ≈ 9 亿次乘加，不化简会慢一倍。
 *
 * 3. 空掩码（协方差为 0）必须挡掉，否则除零得到 NaN
 *    渲染失败的字形是整张白图，"跟谁都不像"和"跟谁都一样像"（NaN）
 *    是两回事，不能混。
 *
 * 4. 扫描索引.json 是 PowerShell 写的，带 UTF-8 BOM
 *    带 BOM 的字符串直接 JSON.parse 会抛异常。
 *    这个坑在 答题设置.json 上已经踩过一次了，这里记得先剥掉 \uFEFF。
 * ------------------------------------------------------------------ */

'use strict';

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const IDX = path.join(DIR, '扫描索引.json');
const REF_BIN = path.join(DIR, 'mask-参照.bin');
const DECOY_BIN = path.join(DIR, 'mask-替身.bin');
const OUT = path.join(DIR, '对照表.json');

const TOPN = (() => {
  const i = process.argv.indexOf('--top');
  return i >= 0 ? Number(process.argv[i + 1]) : 5;
})();
const SHOW_ONLY = process.argv.includes('--show');

for (const f of [IDX, REF_BIN, DECOY_BIN]) {
  if (!fs.existsSync(f)) {
    console.error('缺文件: ' + f);
    console.error('先跑:  powershell -ExecutionPolicy Bypass -File 扫字形.ps1');
    process.exit(1);
  }
}

/* 坑 4：Windows PowerShell 写的 UTF-8 是带 BOM 的 */
const idx = JSON.parse(fs.readFileSync(IDX, 'utf8').replace(/^\uFEFF/, ''));
const grid = idx.grid, cell = idx.cell, px = idx.px;
const N = grid * grid;
const refCps = idx.refCps;
const decoyCps = idx.decoyCps;

const refBuf = fs.readFileSync(REF_BIN);
const decoyBuf = fs.readFileSync(DECOY_BIN);

if (refBuf.length !== cell * refCps.length) {
  console.error('mask-参照.bin 大小对不上：' + refBuf.length + ' vs 应为 ' + (cell * refCps.length));
  process.exit(1);
}

console.log('替身字体: ' + idx.decoyFont);
console.log('参照字体: ' + idx.refFont);
console.log('网格 ' + grid + 'x' + grid + '   参照 ' + refCps.length + ' 字   替身 ' + decoyCps.length + ' 字');
console.log('');

/* ---------- 把每个小图的红通道抽成 0~1 的"墨迹程度" ---------- */
/* Format32bppArgb 的内存顺序是 B,G,R,A —— 红在 +2。
   注意：先统一换算成 0~1 再比。
   如果一边用 0~255 的原始字节、一边用 0~1，
   算出来的 Σaᵢbᵢ 差 255 倍，相关系数就全错了 —— 这个坑我踩过一次。
   参照字体两万多个字，转换结果直接存在一个大 Float32Array 里（约 87 MB），
   这样后面比对时读的就是最终值，不用再换算。 */
const refInk = new Float32Array(refCps.length * N);
const refMean = new Float64Array(refCps.length);
const refNorm = new Float64Array(refCps.length);

for (let i = 0; i < refCps.length; i++) {
  const base = i * cell;
  const off = i * N;
  let s = 0;
  for (let k = 0; k < N; k++) {
    const v = (255 - refBuf[base + k * px + 2]) / 255;
    refInk[off + k] = v;
    s += v;
  }
  const m = s / N;
  let ss = 0;
  for (let k = 0; k < N; k++) { const d = refInk[off + k] - m; ss += d * d; }
  refMean[i] = m;
  refNorm[i] = Math.sqrt(ss);
}

let blankRef = 0;
for (let i = 0; i < refCps.length; i++) if (refNorm[i] < 1e-9) blankRef++;
const dropped = refBuf; /* 原始字节用完即弃 */
console.log('参照字体里渲染为空白的有 ' + blankRef + ' 个（这些不参与比对）');
console.log('参照特征表: ' + (refInk.length * 4 / 1048576).toFixed(0) + ' MB');

const decoyVals = [];
for (let i = 0; i < decoyCps.length; i++) {
  const base = i * cell;
  const arr = new Float64Array(N);
  let s = 0;
  for (let k = 0; k < N; k++) {
    const v = (255 - decoyBuf[base + k * px + 2]) / 255;
    arr[k] = v;
    s += v;
  }
  const m = s / N;
  let ss = 0;
  for (let k = 0; k < N; k++) { const d = arr[k] - m; ss += d * d; }
  decoyVals.push({ arr, m, n: Math.sqrt(ss), cp: decoyCps[i] });
}
console.log('');

/* ---------- 逐个比 ---------- */
/* score = Σ(aᵢ-mₐ)(bᵢ-m_b) / (‖a‖·‖b‖)
          = (Σaᵢbᵢ - N·mₐ·m_b) / (‖a‖·‖b‖)
   Σaᵢbᵢ 用一个循环算出来，均值和模长都是预算好的，
   所以每个字只需要一趟 1024 次的乘加。 */
const t0 = Date.now();
const result = [];

for (const d of decoyVals) {
  if (d.n < 1e-9) { result.push({ decoyCp: d.cp, top: [] }); continue; }
  const a = d.arr;
  const Nmamb = N * d.m;
  const best = [];

  for (let i = 0; i < refCps.length; i++) {
    if (refNorm[i] < 1e-9) continue;
    const off = i * N;
    let dot = 0;
    let k = 0;
    for (; k + 4 <= N; k += 4) {
      dot += a[k] * refInk[off + k] + a[k + 1] * refInk[off + k + 1]
        + a[k + 2] * refInk[off + k + 2] + a[k + 3] * refInk[off + k + 3];
    }
    for (; k < N; k++) dot += a[k] * refInk[off + k];

    const score = (dot - Nmamb * refMean[i]) / (d.n * refNorm[i]);

    if (best.length < TOPN) {
      best.push({ i, score });
      best.sort((x, y) => y.score - x.score);
    } else if (score > best[best.length - 1].score) {
      best[best.length - 1] = { i, score };
      best.sort((x, y) => y.score - x.score);
    }
  }
  result.push({ decoyCp: d.cp, top: best.map((b) => ({ cp: refCps[b.i], score: b.score })) });
}

console.log('比对完成，用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒');
console.log('');

/* ---------- 打印 ---------- */
const P = (cp) => String.fromCodePoint(cp);

console.log('序号 替身  最像的字   分数    与次名差  后面几个候选');
console.log('-'.repeat(78));
const map = {};
const picks = [];
let n = 0;
for (const r of result) {
  n++;
  const ch = P(r.decoyCp);
  if (!r.top.length) { console.log(String(n).padStart(3) + '  ' + ch + '    （这个字形是空的，没法比）'); continue; }
  const t1 = r.top[0];
  const t2 = r.top[1];
  const gap = t2 ? t1.score - t2.score : NaN;
  map[ch] = P(t1.cp);
  picks.push({ decoy: ch, decoyCp: r.decoyCp, real: P(t1.cp), realCp: t1.cp, score: t1.score, gap });
  const rest = r.top.slice(1).map((x) => P(x.cp) + '=' + x.score.toFixed(2)).join(' ');
  console.log(String(n).padStart(3) + '  ' + ch + '    ' + P(t1.cp).padEnd(4, ' ') + '     ' +
    t1.score.toFixed(3).padStart(6) + '   ' +
    (isNaN(gap) ? '  -   ' : gap.toFixed(3).padStart(6)) + '    ' + rest);
}

/* ---------- 自检 1：一一对应 ---------- */
console.log('');
const rev = new Map();
for (const [k, v] of Object.entries(map)) {
  if (!rev.has(v)) rev.set(v, []);
  rev.get(v).push(k);
}
const conflict = [...rev.entries()].filter(([, v]) => v.length > 1);
if (conflict.length) {
  console.log('自检1 失败：有 ' + conflict.length + ' 个真字被重复占用，说明有认错的：');
  for (const [real, chs] of conflict) console.log('   ' + real + ' <- ' + chs.join(' '));
} else {
  console.log('自检1 通过：' + Object.keys(map).length + ' 个替身对应 ' + rev.size + ' 个互不重复的真字。');
}

/* ---------- 自检 2：跟"从上下文猜出来的"对照 ---------- */
const anchors = {
  '庘': '从', '庝': '法', '庡': '大', '庛': '国', '庨': '尼', '庥': '布',
  '庩': '楚', '庪': '条', '庤': '约', '庖': '边', '厙': '京'
};
console.log('');
console.log('自检2：拿"从句子上下文推测出来的字"对一遍（这是独立的第二种证据）');
let aOk = 0, aTot = 0;
for (const [d, want] of Object.entries(anchors)) {
  const got = map[d];
  if (got === undefined) continue;
  aTot++;
  const ok = got === want;
  if (ok) aOk++;
  console.log('   ' + (ok ? '一致 ' : '不一致') + '  ' + d + ' -> 比对结果 ' + got + '   上下文推测 ' + want);
}
console.log('   一致 ' + aOk + '/' + aTot);

/* ---------- 写出 ---------- */
if (!SHOW_ONLY) {
  const sha = require('crypto').createHash('sha256')
    .update(fs.readFileSync(path.join(DIR, 'font-01-font-cxsecret.ttf'))).digest('hex');
  fs.writeFileSync(OUT, JSON.stringify({
    sha256: sha,
    method: '字形像素比对（轮廓归一化到 ' + grid + 'x' + grid + '，归一化互相关）',
    refFont: idx.refFont,
    baseFont: idx.decoyFont,
    generated: new Date().toLocaleString('zh-CN'),
    total: decoyCps.length,
    map
  }, null, 1), 'utf8');
  console.log('');
  console.log('已写出: ' + OUT);

  const sample = '（）庘庝律上肯定了黑龙江乌苏里江厐流的广庡区域庠中庛领土，使得中庛东北庖疆获得了150年的安宁。' +
    'A.《庣庢条庤》 B.《庨庥庩庪约》 C.《庬厙条庤》';
  const fix = sample.replace(/[\u5390-\u5ecd]/gu, (c) => map[c] || c);
  console.log('');
  console.log('=== 拿记录里的乱码试一下 ===');
  console.log('  改前: ' + sample);
  console.log('  改后: ' + fix);
}
