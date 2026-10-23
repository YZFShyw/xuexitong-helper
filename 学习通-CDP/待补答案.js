/* 待补答案 —— 把"没做成的题"累积成清单，人工补答案后回填题库
 *
 *   node 待补答案.js --list                 看清单（按"漏了几次"排序）
 *   node 待补答案.js --set <fp前缀> <答案>   人工补答案 → 写进题库，清单标 filled
 *   node 待补答案.js --ai                   对清单批量问模型，生成"建议"（不自动入库）
 *   node 待补答案.js --ignore <fp前缀>       不再提示这道题
 *
 * 运行时由 driver.js 的 recordMiss 调 addMiss() 累积（按指纹去重、累加次数）。
 * 设计原则：AI 建议**绝不自动入库**——必须人工 --set 确认（宁漏不错）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const QS = require('./quiz-state.js');
const QB = require('./题库.js');

const FILE = process.env.PENDING_FILE || path.join(__dirname, '待补答案.jsonl');
const BANK_FILE = process.env.PENDING_BANK || path.join(__dirname, '题库.json');
const CFG_FILE = path.join(__dirname, '答题设置.json');
const fpr = QS.makeFingerprinter({});

function fpOf(rec) {
  try {
    return fpr.fpOf({ type: rec.type, stem: rec.stem, options: rec.options });
  } catch (e) { return ''; }
}

/* ---------------- 清单读写（jsonl，一行一条） ---------------- */
function loadList() {
  const out = [];
  let raw = '';
  try { raw = fs.readFileSync(FILE, 'utf8'); } catch (e) { return out; }
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try { const o = JSON.parse(s); if (o && o.fp) out.push(o); } catch (e) {}
  }
  return out;
}
function saveList(list, opts) {
  /* 【可选合并写 · 2026-10-23 codex P2】`--ai` 是"读清单 → 挨个问模型（几十秒）→ 整体写回"，
     这段窗口里驱动器可能又 addMiss 了新题；直接覆盖会把它们**静默丢掉**。
     opts.merge=true 时先读磁盘最新，把"我改过状态的那些"按 fp 合进去，磁盘多出来的新记录保留。 */
  let out = list;
  if (opts && opts.merge) {
    const disk = loadList();
    const mine = new Map((list || []).map((x) => [x.fp, x]));
    for (const d of disk) {
      const m = mine.get(d.fp);
      if (!m) mine.set(d.fp, d);
      else Object.assign(d, m);
    }
    out = Array.from(mine.values());
  }
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, out.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
  fs.renameSync(tmp, FILE);
}

/** 运行时调用：把一道没做成的题记进清单（按指纹去重，漏几次累加几次） */
function addMiss(rec) {
  if (!rec) return null;
  const fp = fpOf(rec);
  if (!fp) return null;
  const list = loadList();
  const now = new Date().toISOString();
  let hit = null;
  for (const x of list) if (x.fp === fp) { hit = x; break; }
  if (hit) {
    hit.missCount = (Number(hit.missCount) || 1) + 1;
    hit.lastAt = now;
    if (rec.why && !hit.why) hit.why = String(rec.why);
  } else {
    list.push({
      fp: fp,
      type: String(rec.type || ''),
      stem: String(rec.stem || ''),
      options: (rec.options || []).slice(0, 8),
      chapter: String(rec.chapter || ''),
      why: String(rec.why || ''),
      missCount: 1,
      firstAt: now,
      lastAt: now,
      status: 'pending',
    });
  }
  saveList(list);
  return hit || list[list.length - 1];
}

/* ---------------- 回填题库 ---------------- */
/** 把一条答案写进库（fp 精确匹配到清单记录；库里没有就新建条目） */
function applyAnswer(bank, fpKey, answer, opts) {
  const o = opts || {};
  const list = loadList();
  const item = list.filter((x) => x.fp === fpKey)[0];
  if (!item) return { ok: false, reason: '清单里没有这个指纹' };
  const ans = String(answer || '').trim();
  if (!ans) return { ok: false, reason: '答案为空' };
  const ent = (bank && bank.entries) || {};
  let e = ent[fpKey];
  if (!e) {
    e = {
      fp: fpKey, type: item.type, stem: item.stem, options: item.options || [],
      answer: '', answerText: '', why: '', src: 'manual:pending',
      picked: false, notPicked: '', at: new Date().toLocaleString('zh-CN'),
      chapter: item.chapter || '', n: 1, official: false,
      answers: [],
    };
    ent[fpKey] = e;
  }
  e.answers = e.answers || [];
  let cand = e.answers.filter((a) => String(a.answer) === ans)[0];
  if (!cand) {
    cand = {
      answer: ans, answerText: '', why: o.why || '人工补录（待补答案）', picked: false, notPicked: '',
      srcs: ['manual:pending'], at: new Date().toLocaleString('zh-CN'), n: 1,
    };
    e.answers.push(cand);
  } else {
    cand.srcs = Array.from(new Set((cand.srcs || []).concat(['manual:pending'])));
  }
  QB.applyTopAnswer(e);
  /* 【顺序不能反 · 2026-10-23 codex P2】原来是"先标 filled + 存清单，再写题库"：
     题库写失败（EISDIR / 磁盘满 / 权限）时清单已经标完成 → 这道题从待补里消失、库里又没答案，
     等于彻底丢了。现在先写库，成功了才标 filled。 */
  if (o.save !== false) {
    QB.backupBank(BANK_FILE);
    fs.writeFileSync(BANK_FILE, QB.serializeBank(bank), 'utf8');
  }
  item.status = 'filled';
  item.filledAt = new Date().toISOString();
  item.filledAnswer = ans;
  saveList(list);
  return { ok: true, fp: fpKey, answer: ans };
}

/* ---------------- 模型建议（只写进清单，不入库） ---------------- */
async function askModel(item) {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { cfg = {}; }
  if (!cfg.apiKey) throw new Error('答题设置.json 里没有 apiKey');
  const opts = (item.options || []).map((op, i) => {
    /* 兼容两种形态：新记录是 {letter,text}，历史记录是 'A. 甲' 这种字符串 */
    if (op && typeof op === 'object') return (op.letter || String.fromCharCode(65 + i)) + '. ' + (op.text == null ? '' : String(op.text));
    return String.fromCharCode(65 + i) + '. ' + String(op);
  }).join('\n');
  const prompt = [
    '你在给一道' + String(item.type || '') + '题作答，题干里可能有摘录缺失。',
    '题干：' + String(item.stem || ''),
    opts ? '选项：\n' + opts : '（没有选项）',
    '只输出一行 JSON：{"answer":"字母（多选连写）或 对/错","why":"一句话理由","guess":true 或 false（看不全就 false）}',
  ].join('\n');
  const url = cfg.apiUrl || 'https://api.deepseek.com/chat/completions';
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
    body: JSON.stringify({ model: cfg.model || 'deepseek-chat', temperature: 0, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(45000),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  const txt = String((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '');
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('模型没给 JSON');
  return JSON.parse(m[0]);
}

module.exports = { FILE, loadList, saveList, addMiss, applyAnswer, askModel, fpOf };

/* ---------------- CLI ---------------- */
if (require.main === module) {
  const args = process.argv.slice(2);
  const mode = args[0] || '--list';
  const list = loadList();

  if (mode === '--list') {
    const pend = list.filter((x) => x.status !== 'filled' && x.status !== 'ignored');
    pend.sort((a, b) => (Number(b.missCount) || 1) - (Number(a.missCount) || 1));
    console.log('待补答案: ' + pend.length + ' 条（共记录 ' + list.length + ' 条）');
    for (const x of pend) {
      console.log('  ' + x.fp.slice(0, 8) + '  ' + String(x.type || '?') + '  漏' + (x.missCount || 1) + '次  ' +
        String(x.stem || '').replace(/\s+/g, ' ').slice(0, 46) +
        (x.why ? '  〔' + String(x.why).slice(0, 30) + '〕' : '') +
        (x.aiGuess ? '  AI建议:' + x.aiGuess : ''));
    }
    console.log('\n用法：--set <fp前缀> <答案> ｜ --ai（生成建议，不自动入库）｜ --ignore <fp前缀>');
    return;
  }

  if (mode === '--ignore') {
    const fp = String(args[1] || '').toLowerCase();
    const x = list.filter((v) => v.fp.indexOf(fp) === 0)[0];
    if (!x) { console.error('清单里没有这个 fp 前缀'); process.exit(1); }
    x.status = 'ignored';
    saveList(list);
    console.log('已忽略：' + x.fp.slice(0, 8));
    return;
  }

  if (mode === '--set') {
    const fp = String(args[1] || '').toLowerCase();
    const ans = String(args[2] || '').trim();
    if (!fp || !ans) { console.error('用法：--set <fp前缀> <答案>'); process.exit(1); }
    const hits = list.filter((x) => x.fp.indexOf(fp) === 0);
    if (hits.length !== 1) { console.error('fp 前缀匹配到 ' + hits.length + ' 条（要求 1 条）'); process.exit(1); }
    const bank = QB.loadBank(BANK_FILE);
    if (!bank) { console.error('读不到 题库.json'); process.exit(1); }
    const r = applyAnswer(bank, hits[0].fp, ans);
    if (!r.ok) { console.error('写入失败：' + r.reason); process.exit(1); }
    console.log('已补录：' + r.fp.slice(0, 8) + ' → ' + r.answer + '（题库已更新，备份为 .bak）');
    return;
  }

  if (mode === '--ai') {
    (async () => {
      const pend = list.filter((x) => x.status !== 'filled' && x.status !== 'ignored' && !x.aiGuess);
      console.log('给 ' + pend.length + ' 条待补题生成 AI 建议（只写建议，不自动入库）……');
      let ok = 0, fail = 0;
      for (const x of pend) {
        try {
          const g = await askModel(x);
          if (g && g.answer) {
            x.aiGuess = String(g.answer);
            x.aiWhy = String(g.why || '');
            x.aiAt = new Date().toISOString();
            if (g.guess === false) x.aiGuess = '';   /* 模型自己说看不全 → 不给建议 */
            ok++;
            console.log('  ' + x.fp.slice(0, 8) + ' → ' + (x.aiGuess || '(看不全，未给建议)'));
          } else fail++;
        } catch (e) { fail++; console.log('  ' + x.fp.slice(0, 8) + ' 失败：' + String(e.message || e).slice(0, 50)); }
      }
      /* 【合并写 · 2026-10-23 codex P2】这一步之前是 `saveList(list)` 整体覆盖：
         问模型要几十秒，这期间驱动器可能又 addMiss 了新的漏题 —— 会被静默丢掉。
         merge 模式先读磁盘最新，只把"我改过的 aiGuess 等状态"合回去。 */
      saveList(list, { merge: true });
      console.log('完成：建议 ' + ok + ' 条，失败 ' + fail + ' 条（用 --list 查看，--set 确认入库）');
    })();
    return;
  }

  console.error('未知参数：' + mode + '\n用法：--list ｜ --set <fp前缀> <答案> ｜ --ai ｜ --ignore <fp前缀>');
  process.exit(1);
}
