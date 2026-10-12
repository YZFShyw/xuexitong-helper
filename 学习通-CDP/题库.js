/* 题库.js —— 本地题库：把「章节测验记录.txt」解析成「指纹 → 题干 + 选项 + 答案」
 *
 * 这一版只做**建库**（第一阶段）。答题链路一个字都没动：
 * 没有任何地方 require 本文件，答题时也不会来查库。
 *
 * ---------------------------------------------------------------------------
 * 为什么指纹要"原样复刻运行时看到的文本"
 *
 * 指纹是 sha256('v2\n题型\n归一化题干\n每个"字母:正文"用\n连起来') 取前 32 位
 * （见 quiz-state.js 的 makeFingerprinter）。它的输入必须**逐字等于运行时从页面
 * DOM 读到的那个字符串** —— 多一个题号、少一个【单选题】标记，算出来就是另一个
 * 指纹，而且不会报错，只会表现为"库是空的/命中很少"。
 *
 * 这一点是实测定的，不是猜的（验法见 _实验\_探指纹真形态B.js）：
 *   答题答案缓存.json 里 3 个指纹是运行时在**真实 DOM**上算出来的。把记录里
 *   那 3 道题按不同形态复算，只有这一种能逐位对上：
 *     type   : '单选'
 *     题干   : 记录里那一整块题干**原样**（含独立的题号行 "1"、含【单选题】标记）
 *     选项   : { letter: 'A', text: '《马关条约》' }（正文不带 "A. " 前缀）
 *   反例（都会算出不同指纹，实测命中 0）：
 *     · 把【单选题】标记剥掉
 *     · 把题号行 "1" 丢掉
 *     · 选项 text 里带上 "A. " 前缀
 *   ★ 所以"题干不要带【单选题】前缀"那条规则**只对假章节那种干净样本成立**，
 *     对真实 DOM 块必须原样保留 —— 因为运行时读到的就是带标记的那串字。
 *
 * ---------------------------------------------------------------------------
 * 三种来源，各自怎么处理（都不静默丢，全部计数）
 *   1. 新格式 [N] 题型 块（运行时从 DOM 读的）→ 原样复刻，**能命中**运行时的指纹
 *   2. 旧格式 模型抄录 段（截图 + 模型抄写的）→ 剥掉【题型】标记后算指纹；
 *      这类题目运行时**根本没算过指纹**，抄得一字不差才可能命中，抄歪的只是
 *      永远命不中的死条目（零风险，白赚）
 *   3. 乱码块（⚠正文字体被混淆）→ **排除**：那是替身字，运行时的指纹是解码后
 *      算的，拿它建库等于往库里倒垃圾
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const QS = require('./quiz-state.js');

const BANK_FILE = '题库.json';
const BANK_VERSION = 1;
const RECORD_FILE = '章节测验记录.txt';
const ANSWER_CACHE_FILE = QS.ANSWER_CACHE_FILE;

/* 【题型必须归一成中文短型】指针里的 type 参与哈希：运行时给的是 '单选'/'判断'，
   不是 '单选题'/'判断题'。带上"题"字就是另一个指纹。 */
const TYPE_MAP = {
  单选题: '单选', 多选题: '多选', 判断题: '判断', 填空题: '填空',
  简答题: '简答', 问答题: '简答', 其他: '未知'
};
const TYPE_SHORT = ['单选', '多选', '判断', '填空', '简答'];
/* 【两种写法都要收】[N] 块头写的是短的（"单选"），【…】标记里写的是长的（"单选题"）。
   少写一个"题"字，正则就整段失配 —— 上一版就是栽在这里（旧格式一道题都没解析出来）。 */
const TYPE_FULL = '单选题|多选题|判断题|填空题|简答题|问答题|其他题|单选|多选|判断|填空|简答|其他';

const RE = {
  chapter: /^\[(\d{4}\/\d{1,2}\/\d{1,2} \d{1,2}:\d{2}:\d{2})\]\s*(.*)$/,       /* 章节头，顶格 */
  course: /^ {0,2}课程[：:]\s*(.+)$/,                                          /* 课程名（2026-10-12 起有） */
  domHead: /^ {2}\[(\d{1,3})\]\s*(单选|多选|判断|填空|简答)/,                  /* 新格式题块头 */
  transHead: /^ {2}────\s*模型抄录/,                                          /* 旧格式：抄录段开始 */
  ansHead: /^ {2}────\s*答案（模型生成/,                                      /* 旧格式：答案段开始 */
  rule: /^ {2}─{6,}\s*$/,                                                     /* 段分隔线 */
  domAns: /^ {6}→\s*答案(?:[（(][^）)]*[）)])?\s*[：:]\s*(.+)$/,
  domPicked: /^ {6}→\s*已选中[：:]\s*([A-Za-z]+)/,
  domNotPicked: /^ {6}→\s*点了但没选中[：:]\s*([A-Za-z]+)/,
  domWhy: /^ {8}理由[：:]\s*(.*)$/,
  domImgs: /^ {6}→\s*图片\s*\d+\s*张[：:]\s*(.+)$/,          /* → 图片 2 张：url1 | url2 */
  domImgIds: /^ {6}→\s*图片指纹[：:]\s*(.+)$/,               /* → 图片指纹：a1b2c3d4 | e5f6a7b8（像素指纹的短 id） */
  domStem: /^ {6,7}(\S.*)$/,                                                  /* 题干行：6 空格（日志缩进）或 7（DOM 自带前导空格） */
  domOpt: /^ {8}([A-Za-z?])[.、)）]\s*(.*)$/,
  transQ: new RegExp('^ {2}【(' + TYPE_FULL + ')】\\s*(.*)$'),
  transOpt: /^ {2}([A-Za-z?])[.、)）]\s*(.*)$/,
  transAns: /^ {2}(\d{1,3})\s*[.、)）]\s*(.+)$/,
  mark: /[（(]指纹\s+([0-9a-f]{8})[）)]/g,                                    /* 运行时自己写下的指纹 */
  garbage: /正文字体被混淆/                                                   /* 乱码块标记（两种后缀都算） */
};

/* ============================ 一、解析 ============================ */

/* 答案行上会带注解，解析前必须剥掉，否则答案就不是干净的了：
     → 答案（题库·aria 确认过）：B　【尼布楚条约】
   （括号里是来源，方括号里是答案对应的选项正文 —— 都是给人看的可追溯信息。）
   实测踩过：不剥注解的话，这行算出来的"答案"是 "B【尼布楚条约】"，
   归一化之后既不是字母也不是对错 → 整条答案被当成"不可用"丢掉。 */
function cleanAnswerValue(s) {
  return String(s == null ? '' : s)
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/【[^】]*】/g, '')
    .trim();
}

/* 答案归一：字母答案统一大写；判断类答案原样保留；其余（"不确定"之类）当没有 */
function normalizeAnswer(s) {
  const t = String(s == null ? '' : s).trim().replace(/\s+/g, '');
  if (/^[A-Ha-h]{1,6}$/.test(t)) return t.toUpperCase();
  if (/^(对|错|正确|错误|是|否|T|F)$/i.test(t)) return t;
  return '';
}

/* 【判断题的答案口径统一：A→对、B→错】2026-10-12 别人测出来的（缺陷 3）：
   判断题的选项就是 A.对 / B.错 —— 所以 `answer=B` 和 `answer=错` **语义完全一样**，
   可库里出现过两种写法（全库 195 条写"对/错"、只有 6 条写字母），于是：
     · 冲突检测把它们当成两个不同答案 ⇒ 控制台挂**假冲突** ✗
     · 更麻烦的是运行时：页面上选项写的是「对/错」，库里存 "B"，
       拿 "B" 去点「对/错」能不能对上，全看实现 —— 属于潜在隐患。
   统一口径：判断题的 answer **一律存正文（对/错）**，字母只在选择题里用。
   answerText 有值时优先用它（那是人看得到的文字，最可信）。 */
function normalizeJudgmentAnswer(type, answer, answerText) {
  if (String(type || '').indexOf('判断') < 0) return { answer: answer, answerText: answerText || '', changed: false };
  const rawAns = String(answer == null ? '' : answer).trim().replace(/\s+/g, '');
  const txt = String(answerText == null ? '' : answerText).trim().replace(/\s+/g, '');
  const done = (a, t) => ({ answer: a, answerText: t || a, changed: String(a) !== rawAns });
  if (/^(对|错|正确|错误)$/.test(txt)) return done(txt, txt);
  const a = rawAns.toUpperCase();
  if (a === 'A') return done('对', txt || '对');
  if (a === 'B') return done('错', txt || '错');
  if (/^(对|错|正确|错误)$/.test(a)) return done(a, a);
  return { answer: answer, answerText: answerText || '', changed: false };   /* 认不出的原样留着，别硬改 */
}

/* 选项字母：记录里那种没字母的会打成 '?'（运行时 o.letter 是空串）——
   空字母要**原样算成空串**，因为运行时算指纹时也是空串。 */
function normalizeLetter(s) {
  const t = String(s == null ? '' : s).trim();
  return /^[A-Ha-h]$/.test(t) ? t.toUpperCase() : '';
}

/* 【顺序无关键】同一道题，选项顺序/字母可能被别人那边打乱 ——
   这把键把"选项正文"按归一化后**排序**再进指纹，并且不带字母、不带题号。
   命中它只能说明"同一道题、同一套选项"，**字母不一定还对得上** ——
   所以走这把键时要按**正文**重新定位该点哪个选项（见运行时的 remapAnswerByText）。
   建库端和运行端必须用同一套算法（同一个 normalizeForFp + 同样的排序）。 */
function orderFreeFp(fpr, type, stem, options) {
  const texts = (options || []).map((o) => QS.normalizeForFp(String((o && o.text) == null ? '' : o.text))).sort();
  return fpr.fpOf({ type: type, stem: stem, options: texts.map((t) => ({ letter: '', text: t })) });
}

/* 别名题干：把"整行只是题号"的行删掉、把【题型】/(题型) 标记删掉。
   只做这两条 —— 它是**弱键**（跨来源合并、诊断用），不参与"命中标记"的判定。
   刻意不做更激进的清洗，免得把两道不同的题并到一起。 */
function aliasStem(stem) {
  return String(stem == null ? '' : stem)
    .replace(/^[ \t]*\d{1,3}[ \t]*[.、)）]?[ \t]*(\r?\n|$)/g, '$1')
    .replace(new RegExp('[【(（]\\s*(?:' + TYPE_FULL + ')\\s*[】)）]', 'g'), '')
    .trim();
}

/* 抄录段里的噪声行（截图失败之类的说明），别当成题干续行 */
const NOISE = /^(图片为空白|当前截图里没有|重开：|重拍|⚠|→|（|\(|下面已经|解码表|已核对|截图读题|把浏览器|这一次拿到|本次|本章|【跳过】)/;

function parseRecord(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  const questions = [];
  const marks = [];
  const excluded = { garbage: 0, noStem: 0, noOptions: 0, noAnswer: 0, badAnswer: 0, transNoQuestion: 0 };
  let chapterAt = '', chapter = '', chapters = 0, course = '';
  let dom = null;          /* 当前 DOM 块 */
  let trans = null;        /* 当前抄录段 { stems: [], answers: [] } */
  let zone = 'idle';       /* idle | dom | trans-stem | trans-answer */

  const pushDom = () => {
    if (!dom) return;
    zone = 'idle';
    if (dom.garbage) { excluded.garbage++; dom = null; return; }
    if (!dom.stem.length) { excluded.noStem++; dom = null; return; }
    if (!dom.options.length) excluded.noOptions++;        /* 填空/简答本来就没选项，不算错 */
    if (!dom.answer) excluded.noAnswer++;
    /* 【字母丢了就按顺序补 A/B/C/D】实测（2026-10-12）：记录里 **700 行**选项字母是 `?.`
       （那会儿替身字还没解开 —— 字母本身也是替身字，读出来就成了 `?`）。
       平台渲染选项永远按顺序，所以顺序 = A/B/C/D；不补的话指纹里是 `?:正文`，
       跟页面上的 `A:正文` 对不上 ⇒ 那些题等于没入库（作业那份 175 道，库里查到 **0** 道就栽在这）。
       补完标一个 `lettersFromOrder`，让人知道这字母是**推出来的**、不是读出来的。 */
    if (dom.options.some((o) => !o.letter)) {
      dom.options.forEach((o, i) => { if (!o.letter) o.letter = String.fromCharCode(65 + i); });
      dom.lettersFromOrder = true;
    }
    questions.push(dom);
    dom = null;
  };
  const pushTrans = () => {
    if (!trans) return;
    zone = 'idle';
    const t = trans; trans = null;
    if (!t.stems.length) { excluded.transNoQuestion++; return; }
    t.stems.forEach((q, i) => {
      const a = t.answers[i] || null;
      if (!q.stem) { excluded.noStem++; return; }
      if (!q.options.length) excluded.noOptions++;
      if (!a || !a.answer) excluded.noAnswer++;
      questions.push({
        src: 'transcribe', no: i + 1, type: q.type, stem: q.stem, options: q.options,
        answer: a ? a.answer : '', why: a ? a.why : '', picked: false, pickedLetter: '',
        notPicked: '', at: t.at, chapter: t.chapter, course: t.course || '', undecoded: true
      });
    });
  };

  for (const line of lines) {
    let m;
    /* 章节头（顶格）—— 它同时是"上一章结束"的信号 */
    if ((m = line.match(RE.chapter))) {
      pushDom(); pushTrans();
      chapterAt = m[1]; chapter = m[2].trim(); chapters++;
      course = '';        /* 【课程名不能粘到下一章】新章节头一来就清空 —— 用例抓过这个 bug */
      continue;
    }
    /* 【课程头】块头下面一行 `课程：军事理论`（2026-10-12 起运行时才写）。
       有了它才能"按课程分库"—— 老记录没有这一行 ⇒ course 为空 ⇒ 那些条目仍旧进主库（不迁移）。 */
    if ((m = line.match(RE.course))) {
      course = m[1].trim();
      continue;
    }
    /* 运行时留下的指纹标记（在章节头之后、题块之内） */
    if (RE.mark.test(line)) {
      RE.mark.lastIndex = 0;
      let mm;
      while ((mm = RE.mark.exec(line)) !== null) marks.push({ fp8: mm[1], chapter, at: chapterAt, line });
      RE.mark.lastIndex = 0;
    }
    /* 新格式题块头 */
    if ((m = line.match(RE.domHead))) {
      pushDom(); pushTrans();
      zone = 'dom';
      dom = {
        src: 'dom', no: +m[1], type: m[2], stem: [], options: [], answer: '', why: '',
        picked: false, pickedLetter: '', notPicked: '',
        at: chapterAt, chapter, course, garbage: RE.garbage.test(line)
      };
      continue;
    }
    /* 旧格式段落标题 */
    if (RE.transHead.test(line)) { pushDom(); pushTrans(); zone = 'trans-stem'; trans = { stems: [], answers: [], at: chapterAt, chapter, course }; continue; }
    if (RE.ansHead.test(line)) { pushDom(); zone = 'trans-answer'; continue; }
    if (RE.rule.test(line)) { pushDom(); if (zone === 'trans-stem' || zone === 'trans-answer') zone = 'idle'; continue; }

    if (zone === 'dom' && dom) {
      /* 顶格/浅缩进（<6 空格）的非空行 = 块外内容：章节说明、⚠ 提示、本章小结… */
      if (line.trim() && !/^ {6}/.test(line)) { pushDom(); continue; }
      if ((m = line.match(RE.domAns))) { if (!dom.answer) dom.answer = cleanAnswerValue(m[1]); continue; }
      if ((m = line.match(RE.domPicked))) { dom.picked = true; dom.pickedLetter = m[1]; continue; }
      if ((m = line.match(RE.domNotPicked))) { dom.notPicked = m[1]; continue; }
      if ((m = line.match(RE.domWhy))) { dom.why = m[1].trim(); continue; }
      if ((m = line.match(RE.domImgs))) {
        /* 图片身份（URL）。**不进指纹**，只用来核对"是不是同一道题"，以及给人看。 */
        dom.imgs = m[1].split('|').map((s) => s.trim()).filter(Boolean);
        continue;
      }
      if ((m = line.match(RE.domImgIds))) {
        /* 【图片指纹的短 id】由像素算出来（去边 → 16×16 灰度 → sha256 前 8 位）。
           和 URL 不同：URL 会变、会换域名，这个 id 换编码/换域名都不变。
           现在**只存不用**；等匹配键升 v3 时，带图的题就靠它跟页面上的图对上。 */
        dom.imgIds = m[1].split('|').map((s) => s.trim()).filter((s) => /^[0-9a-f]{8,64}$/.test(s));
        continue;
      }
      if (/^ {6}→/.test(line)) continue;                       /* 其它 → 行 */
      if ((m = line.match(RE.domOpt))) { dom.options.push({ letter: normalizeLetter(m[1]), text: m[2].trim() }); continue; }
      if ((m = line.match(RE.domStem))) { dom.stem.push(m[1].trim()); continue; }
      continue;
    }
    if (zone === 'trans-stem' && trans) {
      if ((m = line.match(RE.transQ))) {
        const from = m[1];
        trans.stems.push({
          type: TYPE_MAP[from] || '未知', stem: m[2].trim(), options: []
        });
        continue;
      }
      if ((m = line.match(RE.transOpt))) {
        const cur = trans.stems[trans.stems.length - 1];
        if (cur) cur.options.push({ letter: normalizeLetter(m[1]), text: m[2].trim() });
        continue;
      }
      if (!line.trim() || NOISE.test(line.trim())) continue;
      const cur = trans.stems[trans.stems.length - 1];
      if (cur) cur.stem = cur.stem ? (cur.stem + ' ' + line.trim()) : line.trim();
      continue;
    }
    if (zone === 'trans-answer' && trans) {
      if ((m = line.match(RE.transAns))) {
        const rest = m[2];
        const parts = rest.split(/\s*——\s*/);
        const ans = normalizeAnswer(parts[0]);
        if (!ans) excluded.badAnswer++;
        trans.answers.push({ n: +m[1], answer: ans, why: (parts[1] || '').trim() });
        continue;
      }
      continue;
    }
  }
  pushDom(); pushTrans();
  return { questions, marks, chapters, excluded };
}

/* ============================ 二、建库 ============================ */

function makeEntryBuilder(opts) {
  const o = opts || {};
  const fpr = QS.makeFingerprinter(o.fingerprinter || {});
  const entries = {};
  const stats = {
    fromDom: 0, fromTranscribe: 0, dropped: 0,
    aliasOnly: 0, noLetterOptions: 0, merged: 0, conflicts: 0, pickedConfirmed: 0
  };

  const put = (q) => {
    const isDom = q.src === 'dom';
    /* DOM 块：题干**原样**（含题号行/【题型】标记）—— 运行时看到的就是这串字。
       抄录块：把【题型】标记剥掉（那是模型自己加的，不是页面文字）。 */
    const stem = isDom ? String(q.stem.join('\n')).trim() : aliasStem(String(q.stem));
    const options = (q.options || []).map((x) => ({ letter: x.letter || '', text: x.text || '' }));
    const type = q.type;
    if (!stem) { stats.dropped++; return null; }
    if (options.some((x) => !x.letter)) stats.noLetterOptions++;

    const fp = fpr.fpOf({ type, stem, options });
    const altStem = isDom ? aliasStem(stem) : stem;
    const fpAlt = altStem && altStem !== stem ? fpr.fpOf({ type, stem: altStem, options }) : '';
    const fpOrder = orderFreeFp(fpr, type, altStem || stem, options);

    let e = entries[fp];
    if (!e) {
      e = entries[fp] = {
        fp, type, stem, options,
        answer: '', answerText: '', why: '', src: '', picked: false, notPicked: '',
        at: q.at || '', chapter: q.chapter || '', n: 0, answers: []
      };
      if (fpAlt) e.fpAlt = fpAlt;
      if (fpOrder) e.fpOrder = fpOrder;
      if (isDom) stats.fromDom++; else stats.fromTranscribe++;
    } else {
      stats.merged++;
    }
    if (q.obfNoLetter || options.some((x) => !x.letter)) e.noLetter = true;
    /* 旧格式那批是"解码能力上线之前"记进日志的，来源和可信度都跟新格式不同，
       留个标记，以后想按来源清理或重新解码时有得筛。 */
    if (!isDom) e.undecoded = true;
    /* 【图片身份】题干里的公式常常是一张图（文字里缺一块）。
       记下 URL：给人看 + 运行时核对"是不是同一道题"（对不上就不用库里的答案）。
       它**不参与指纹** —— 指纹一动，所有键都要重算，运行时要同步改，不值当。 */
    if (isDom && q.imgs && q.imgs.length) {
      const im = (e.images = e.images || []);
      for (const s of q.imgs) if (im.indexOf(s) < 0 && im.length < 8) im.push(s);
      e.hasImage = true;
    }
    /* 【图片的像素指纹 id】比 URL 稳：URL 会换域名/重编码，id 是"这张图长什么样"算出来的。
       运行时核对图片时**优先用它**（库里这条没 id 的老条目才退回按 URL 比）。
       现在也只是记下来 —— 它**不进指纹**，只当护栏。 */
    if (isDom && q.imgIds && q.imgIds.length) {
      const ids = (e.imgIds = e.imgIds || []);
      for (const s of q.imgIds) if (ids.indexOf(s) < 0 && ids.length < 8) ids.push(s);
      e.hasImage = true;
    }

    /* 答案证据（同指纹不同答案**不覆盖**，一条一条留着） */
    const ans = normalizeAnswer(q.answer);
    const srcTag = (isDom ? 'self' : 'transcribe') + ':' + (q.chapter || '?');
    if (ans) {
      const letter = ans;
      const hit = e.options.filter((x) => x.letter === letter);
      const c = e.answers.filter((x) => x.answer === ans)[0];
      if (c) {
        c.n++;
        if (q.picked) c.picked = true;
        if (q.notPicked) c.notPicked = q.notPicked;
        if (!c.why && q.why) c.why = q.why;
        if (sourceList(c).indexOf(srcTag) < 0 && c.srcs.length < 8) c.srcs.push(srcTag);
        if (!c.answerText && hit.length === 1) c.answerText = hit[0].text;
      } else {
        e.answers.push({
          answer: ans, answerText: hit.length === 1 ? hit[0].text : '', why: q.why || '',
          picked: !!q.picked, notPicked: q.notPicked || '', srcs: [srcTag], at: q.at || '', n: 1
        });
      }
    }
    e.n++;
    if (!e.why && q.why) e.why = q.why;
    if (!e.at) e.at = q.at || '';
    if (!e.chapter) e.chapter = q.chapter || '';
    return e;
  };

  const sourceList = (c) => (c.srcs = c.srcs || []);

  const finalize = () => {
    for (const k of Object.keys(entries)) {
      const e = entries[k];
      /* 排序：平台官方 > aria-checked 确认过 > 出现次数多的 > 早的（统一走 rankAnswers）。
         注意这只是"给个默认答案"，**冲突本身照样留在 answers 里**。 */
      applyTopAnswer(e);
      e.src = (e.answers[0] && e.answers[0].srcs && e.answers[0].srcs[0]) || e.src || '';
      if (e.answers.length > 1) { stats.conflicts++; }
      if (e.picked) stats.pickedConfirmed++;
      if (e.fpAlt && !entries[e.fpAlt]) stats.aliasOnly++;
    }
    return entries;
  };

  return { put, finalize, stats };
}

function buildBank(parsed, meta) {
  const b = makeEntryBuilder({ fingerprinter: (meta && meta.fingerprinter) || {} });
  /* 【建库时就把"证明是垃圾"的挡在外面】见 isJunkQuestion：
     光清一次库没用 —— 驱动器每隔几分钟从记录重建，清掉的会被带回来。
     opts.keepJunk：给"评测解析/指纹"这类用途留的口子（离线测试的样本恰好用了
     「测验 · 假章节」这种名字，那些用例测的是别的东西，不该被去杂规则连坐）。 */
  const junk = { 'test-chapter': 0, 'test-stem': 0, 'empty-shell': 0, unreadable: 0 };
  const keepJunk = !!(meta && meta.keepJunk);
  for (const q of parsed.questions) {
    const why = keepJunk ? '' : isJunkQuestion(q);
    if (why) { junk[why] = (junk[why] || 0) + 1; continue; }
    b.put(q);
  }
  const entries = b.finalize();
  const keys = Object.keys(entries);
  const stat = b.stats;
  const bank = {
    version: BANK_VERSION,
    builtAt: new Date().toISOString(),
    source: (meta && meta.source) || RECORD_FILE,
    stats: {
      chapters: parsed.chapters,
      parsed: parsed.questions.length,
      parsedDom: parsed.questions.filter((q) => q.src === 'dom').length,
      parsedTranscribe: parsed.questions.filter((q) => q.src !== 'dom').length,
      excluded: parsed.excluded,
    junkSkipped: junk,
      entries: keys.length,
      fingerprints: keys.length,
      aliasKeys: keys.filter((k) => entries[k].fpAlt).length,
      noLetterOptions: stat.noLetterOptions,
      mergedSameFp: stat.merged,
      conflicts: stat.conflicts,
      pickedConfirmed: stat.pickedConfirmed,
      withAnswer: keys.filter((k) => entries[k].answer).length,
      marks: null
    },
    entries
  };
  bank.stats.marks = verifyMarks(bank, parsed.marks);
  return bank;
}

/* ============================ 三、金标准自检 ============================ */

/* 记录里那些「（指纹 xxxxxxxx）」是运行时**自己写下的**指纹。
   两种口径都要报：
     inBank       —— 库里存在任意一个指纹以这 8 位开头（弱）
     sameChapter  —— **同一章**里就有题目的指纹以这 8 位开头（强，能定位形态错误） */
function verifyMarks(bank, marks) {
  const keys = Object.keys(bank.entries || {});
  const byPrefix = {};
  for (const k of keys) { const p = k.slice(0, 8); byPrefix[p] = (byPrefix[p] || 0) + 1; }
  const chapterPrefix = {};
  for (const k of keys) {
    const e = bank.entries[k];
    const key = (e.chapter || '') + '|' + k.slice(0, 8);
    chapterPrefix[key] = (chapterPrefix[key] || 0) + 1;
  }
  const list = Array.isArray(marks) ? marks : [];
  let inBank = 0, sameChapter = 0;
  const miss = [];
  for (const m of list) {
    const a = !!byPrefix[m.fp8];
    const b = !!chapterPrefix[(m.chapter || '') + '|' + m.fp8];
    if (a) inBank++;
    if (b) sameChapter++;
    if (!a || !b) miss.push({ fp8: m.fp8, chapter: m.chapter, inBank: a, sameChapter: b });
  }
  return { total: list.length, inBank, sameChapter, missed: miss.length, missSample: miss.slice(0, 5) };
}

/* ============================ 四、读写 ============================ */

/* 【把派生索引从 entries 重算出来 —— 唯一实现，parseBank 和写文件前都用它】
   为什么单独提出来：2026-10-12 别人测出来一个大坑 —— 导入（added 分支）改了 entries，
   可内存里那两张反查表还是**解析时**建的老表，`serializeBank` 又只是裸的 JSON.stringify ⇒
   落盘的 alias/order 是旧的（实测 alias 1 vs 条目里 54、order 12 vs 440）：
   数据进去了，可"按别名查""按顺序无关查"两条路走不通，**全程不报错**，
   只表现为命中率低 —— 这种最难查。现在：**写文件之前无条件重算一次**，落盘的永远自洽。 */
function rebuildDerived(bank) {
  const ent = (bank && bank.entries) || {};
  const alias = {}, aliasDup = {}, order = {}, orderDup = {};
  for (const k of Object.keys(ent)) {
    const e = ent[k];
    if (!e || typeof e !== 'object') continue;
    const alt = e.fpAlt;
    if (alt && alt !== k) {
      if (alias[alt] && alias[alt] !== k) aliasDup[alt] = true;
      else alias[alt] = k;
    }
  }
  for (const k of Object.keys(ent)) {
    for (const a of ((ent[k] || {}).aliases || [])) {
      if (!a || a === k || !/^[0-9a-f]{8,64}$/.test(String(a))) continue;
      if (alias[a] && alias[a] !== k) aliasDup[a] = true;
      else alias[a] = k;
    }
  }
  for (const alt of Object.keys(aliasDup)) delete alias[alt];
  for (const k of Object.keys(ent)) {
    const od = (ent[k] || {}).fpOrder;
    if (!od || od === k) continue;
    if (order[od] && order[od] !== k) orderDup[od] = true;
    else order[od] = k;
  }
  for (const od of Object.keys(orderDup)) delete order[od];
  bank.alias = alias;
  bank.order = order;
  return bank;
}

/* 【整库的判断题口径归一】读库、写库两个口子都跑一遍（缺陷 3 的根治）：
   只在导入端归一不够 —— 本地老条目里那条 `answer=B` 还在，跟"错"一比还是假冲突 ✗
   （实测：归一单边 ⇒ conflicted=1）。所以：load 进来的、写出去的都是同一种口径。 */
function normalizeBankJudgments(bank) {
  const ent = (bank && bank.entries) || {};
  let n = 0;
  for (const k of Object.keys(ent)) {
    const e = ent[k];
    if (!e || typeof e !== 'object') continue;
    if (String(e.type || '').indexOf('判断') < 0) continue;
    const has = ((e.answers || []).length ? (e.answers || []) : [e]).some((a) => a && a.answer);
    if (!has) continue;
    let changed = false;
    const j0 = normalizeJudgmentAnswer(e.type, e.answer, e.answerText);
    if (j0.changed) { e.answer = j0.answer; e.answerText = j0.answerText; changed = true; }
    for (const a of (e.answers || [])) {
      if (!a || !a.answer) continue;
      const j = normalizeJudgmentAnswer(e.type, a.answer, a.answerText);
      if (j.changed) { a.answer = j.answer; a.answerText = j.answerText; changed = true; }
    }
    if (changed) n++;
    /* 归一之后可能"两个候选变成同一个答案" ⇒ 该合并的合并（不然还是挂着假冲突） */
    if (e.answers && e.answers.length > 1) {
      const seen = {};
      const merged = [];
      for (const a of e.answers) {
        const key = String(a.answer);
        if (seen[key]) {
          const into = seen[key];
          for (const s of (a.srcs || [])) if ((into.srcs || []).indexOf(s) < 0 && (into.srcs || []).length < 8) into.srcs.push(s);
          if (!into.answerText && a.answerText) into.answerText = a.answerText;
          if (!into.why && a.why) into.why = a.why;
          if (a.picked) into.picked = true;
          if (a.official) into.official = true;
        } else { seen[key] = a; merged.push(a); }
      }
      if (merged.length !== e.answers.length) { e.answers = merged; changed = true; }
    }
    if (changed && e.answers && e.answers.length === 1 && e.conflict && (e.answers || []).length < 2) {
      /* 归一后只剩一个答案 ⇒ 那条"冲突"标记是假的，摘掉 */
      const uniq = new Set(e.answers.map((a) => String(a.answer))).size;
      if (uniq < 2) delete e.conflict;
    }
  }
  return n;
}

/* 把题库序列化。**写之前：重算派生索引 + 判断题口径归一** ——
   这是"内存 entries"和"磁盘文件"唯一的对账点，落盘的永远自洽。 */
function serializeBank(bank) {
  rebuildDerived(bank);
  normalizeBankJudgments(bank);
  rebuildDerived(bank);          /* 归一可能合并候选 ⇒ 再算一次更稳（很便宜） */
  return JSON.stringify(bank, null, 1);
}

/* 读回磁盘上的题库。读坏了当空库（**不当成命中**），与 parseAnswerCache 一个口径。 */
function parseBank(raw) {
  const empty = { version: BANK_VERSION, builtAt: '', source: '', stats: {}, entries: {} };
  const txt = String(raw == null ? '' : raw).replace(/^\uFEFF/, '').trim();
  if (!txt) return empty;
  let j;
  try { j = JSON.parse(txt); } catch (e) { return empty; }
  if (!j || typeof j !== 'object' || j.version !== BANK_VERSION) return empty;
  const ent = (j.entries && typeof j.entries === 'object') ? j.entries : {};
  const out = {};
  /* 【别名索引】条目上带 fpAlt 的（"去掉题号与题型标记"的那把键），
     在内存里建一张 fpAlt → 主键 的反查表。有了它，同一个问题的两种题号写法能互相对上。
     冲突（两个条目抢同一个别名键）就**整条不用** —— 宁可查不中，也别挂到错题上。 */
  const alias = {};
  const aliasDup = {};
  const order = {};
  const orderDup = {};
  for (const k of Object.keys(ent)) {
    const e = ent[k];
    if (!e || typeof e !== 'object') continue;
    if (e.fp !== k) continue;                       /* 键和指纹必须对得上 */
    /* 【没有题干也收】题库码（共享形态）里只有"键 + 答案"，没有题面原文 ——
       那是刻意的（题面有版权）。只要指纹自洽、有答案，就是一条能用的条目。 */
    if (!e.stem && !e.answer) continue;
    out[k] = e;
  }
  for (const k of Object.keys(out)) {
    const alt = out[k].fpAlt;
    if (!alt || alt === k) continue;
    if (alias[alt] && alias[alt] !== k) { aliasDup[alt] = true; continue; }
    alias[alt] = k;
  }
  /* 去重复时被并掉的**旧主键**也进索引 —— 不然"以前记过这个键"的查询会落空 */
  for (const k of Object.keys(out)) {
    for (const a of (out[k].aliases || [])) {
      if (!a || a === k || !/^[0-9a-f]{8,64}$/.test(String(a))) continue;
      if (alias[a] && alias[a] !== k) { aliasDup[a] = true; continue; }
      alias[a] = k;
    }
  }
  for (const alt of Object.keys(aliasDup)) delete alias[alt];
  for (const k of Object.keys(out)) {
    const od = out[k].fpOrder;
    if (!od || od === k) continue;
    if (order[od] && order[od] !== k) { orderDup[od] = true; continue; }
    order[od] = k;
  }
  for (const od of Object.keys(orderDup)) delete order[od];
  const bankOut = {
    version: BANK_VERSION, builtAt: String(j.builtAt || ''), source: String(j.source || ''),
    stats: (j.stats && typeof j.stats === 'object') ? j.stats : {}, entries: out,
    alias: alias, order: order
  };
  /* 【读进来就统一判断题口径】本地老条目里可能还是 `answer=B`（选项 A.对/B.错）——
     不归一的话，跟"别人码里的 错"一比就是**假冲突**（实测过）。见 normalizeBankJudgments。 */
  normalizeBankJudgments(bankOut);
  return bankOut;
}

/* 从记录文件建库。dst 为 null 时只算不写（自检用）。 */
function buildFromFile(srcPath, dstPath) {
  const text = fs.readFileSync(srcPath, 'utf8');
  const parsed = parseRecord(text);
  const bank = buildBank(parsed, { source: path.basename(srcPath) });
  if (dstPath) fs.writeFileSync(dstPath, serializeBank(bank), 'utf8');
  return { bank, parsed };
}

/* 拿运行时的答案缓存当第二道自检：那些指纹是它在真实 DOM 上算出来的。
   命中率高 = 库真能被运行时用上；不命中也不影响建库，只如实报出来。 */
function crossCheckCache(bank, cachePath) {
  if (!fs.existsSync(cachePath)) return null;
  let keys = [];
  try {
    keys = Object.keys(JSON.parse(fs.readFileSync(cachePath, 'utf8')).entries || {});
  } catch (e) { return null; }
  const hit = keys.filter((k) => !!bank.entries[k]);
  return { total: keys.length, hit: hit.length };
}

/* 【"谁的答案算数"只允许有一个地方说了算】
   优先级：平台官方答案 > aria-checked 确认过 > 票数多 > 早先记下的。
   为什么必须统一：建库、合并（导入题库码/别人的导出）、读已完成页面，三处各自排过一遍 ——
   结果是"**官方答案在合并时会被一个票数更多的草稿答案顶掉**"。这不是理论问题：
   题库码是**别人给的**，只要他那份票数够，就能把你库里平台写的正确答案挤下去。
   现在三处都调这一个函数。 */
function rankAnswers(list) {
  const bit = (v) => (v ? 1 : 0);
  (list || []).sort((a, b) =>
    (bit(b.official) - bit(a.official)) ||
    (bit(b.picked) - bit(a.picked)) ||
    ((b.n || 0) - (a.n || 0)) ||
    String(a.at || '').localeCompare(String(b.at || '')));
  return list || [];
}

/* 条目里"默认答案"跟着排序结果走（冲突本身照样留在 answers 里，一条都不丢）。 */
function applyTopAnswer(e) {
  if (!e || !(e.answers || []).length) return e;
  rankAnswers(e.answers);
  const top = e.answers[0];
  e.answer = top.answer;
  e.answerText = top.answerText || '';
  e.picked = !!top.picked;
  if (top.notPicked !== undefined) e.notPicked = top.notPicked || '';
  if (!e.why && top.why) e.why = top.why;
  e.official = !!top.official;
  if (e.answers.length > 1) e.conflict = true;
  return e;
}

/* ============================ 五、导出 / 导入 / 查库 ============================ */

/* 可信度分级（交接文档 4.3 的判据，按优先级）：
     confirmed —— 有「→ 已选中：X（按 aria-checked 确认过）」：页面上真的选中过
     multi     —— 同一答案在记录里出现 ≥2 次（多份来源一致）
     single    —— 单来源、没确认过：**仍可用，但要标注**
  另有 conflict：同一指纹下存在不同答案（不覆盖、全留着），命中时要额外提示。 */
/* 【"多来源一致"必须真的是**多个来源**】
   实测（2026-10-12）：把本地库自己导入自己一次，票数从 977 涨到 1349 ——
   因为码里带着发送方的票数 n，接收方又把它当成"自己的新证据"重数了一遍。
   而 n 的本意是"本地见过几次"，来源是谁看 srcs —— 两件事不能混。
   现在：① 合并**不动 n**（n 只统计本地观察）；② 这一档改成看**来源集合**有几个。
   效果：同一个来源无论导入/记录多少次，都还是"单来源"；真来了第二个来源才升档。 */
function trustOf(e) {
  if (!e) return 'none';
  if (e.official) return 'official';
  if (e.picked) return 'confirmed';
  const srcs = new Set();
  for (const a of (e.answers || [])) for (const s of (a.srcs || [])) srcs.add(s);
  for (const s of (e.srcs || [])) srcs.add(s);
  if (srcs.size >= 2) return 'multi';
  return 'single';
}
const TRUST_LABEL = {
  official: '平台正确答案', confirmed: 'aria 确认过',
  multi: '多来源一致', single: '单来源未确认', none: '无'
};

/* 查库：指纹 + 题型必须都对上（题型也进指纹，但不放心，再核一次）。
   没答案的条目不算命中 —— 命中一个空答案等于把 AI 那一步白省了还填不上。
   【两把键都要试】主键是"页面原文"的指纹；别名键是"去掉题号与题型标记"的指纹。
   为什么要别名键：同一道题在这份卷子里是第 3 题、在别人那份里可能是第 7 题，
   而题号是页面文字的一部分 —— 只认主键的话，库带到别的机器/别的课程就全查不中。
   别名键的剥离规则在建库端和运行端是**同一个函数**（aliasStem），两边必须一致。 */
function lookup(bank, fpKey, type) {
  if (!bank || !fpKey) return null;
  const ent = (bank && bank.entries) || {};
  const idx = (bank && bank.alias) || null;
  const ord = (bank && bank.order) || null;
  let key = fpKey;
  let e = ent[key] || null;
  let viaAlias = false, viaOrder = false;
  if (!e && idx) {
    /* 库里可能只有"另一种题号"的那一份 —— 通过别名索引倒着找回来 */
    const back = idx[fpKey];
    if (back && ent[back]) { e = ent[back]; key = back; viaAlias = true; }
  }
  if (!e && ord) {
    /* 再退一步：题号 + 选项顺序都可能不一样，只剩"题干 + 选项正文集合"能对上 */
    const back = ord[fpKey];
    if (back && ent[back]) { e = ent[back]; key = back; viaOrder = true; }
  }
  if (!e) return null;
  if (String(e.type || '') !== String(type || '')) return null;
  if (!e.answer) return null;
  const trust = trustOf(e);
  return {
    fp: key, entry: e, viaAlias: viaAlias, viaOrder: viaOrder,
    answer: e.answer, answerText: e.answerText || '', why: e.why || '',
    picked: !!e.picked, trust: trust, trustLabel: TRUST_LABEL[trust] || trust,
    conflict: !!e.conflict,
    conflictNote: e.conflict ? ('同指纹有 ' + ((e.answers || []).length) + ' 个不同答案，用的是证据最强的那个') : ''
  };
}

/* 可靠 = 至少有证据说明"库里的题干和页面上读出来的是一套字"：
     · 页面 DOM 来源（srcs 以 self: 开头）—— 建库时逐字复刻页面原文，指纹能对上；
     · 或平台官方答案（official）—— 那是平台自己写出来的。
   抄录来源（AI 照着截图抄的）**不可靠**：文本形态跟页面不一样，永远命不中，
   混进导出件只会让人以为"库里有这道题"（这是实测过的：10 道已完成题里 9 道对不上）。 */
function isReliable(e) {
  return !!(e && (e.official || (e.answers || []).some((a) => a.official || (a.srcs || []).some((s) => /^self:/.test(s)))));
}

/* 导出（**脱敏**）：只留"题 + 答案"必需的东西。
   课程名 / 章节 / 时间 / 来源标记一律不带走 —— 那些是学习轨迹（交接文档第 9 节第 4 条）。
   默认只导**可靠**的条目（能命中页面的）；抄录来源的要显式加 withUnverified 才带走。
   没答案的条目不导出：别人拿了也没用。 */
function exportBank(bank, opts) {
  const o = opts || {};
  const withUnverified = !!o.withUnverified;
  const src = (bank && bank.entries) || {};
  const entries = {};
  let skipped = 0, skippedUnverified = 0, withImages = 0;
  for (const k of Object.keys(src)) {
    const e = src[k];
    if (!e || !e.answer || !e.stem) { skipped++; continue; }
    if (!withUnverified && !isReliable(e)) { skippedUnverified++; continue; }
    entries[k] = {
      fp: k, type: e.type, stem: e.stem, options: e.options || [],
      answer: e.answer, answerText: e.answerText || '', why: e.why || '',
      picked: !!e.picked, official: !!e.official, n: e.n || 1,
      conflict: !!e.conflict,
      answers: (e.answers || []).map((a) => ({
        answer: a.answer, answerText: a.answerText || '', why: a.why || '', picked: !!a.picked,
        official: !!a.official, n: a.n || 1
      }))
    };
    /* 【别名键要跟着走】不然导到别的机器上，"题号不同"的那道题就查不中了 */
    if (e.fpAlt && e.fpAlt !== k) entries[k].fpAlt = e.fpAlt;
    if (e.fpOrder && e.fpOrder !== k) entries[k].fpOrder = e.fpOrder;
    if (e.images && e.images.length) { entries[k].images = e.images.slice(0, 8); entries[k].hasImage = true; withImages++; }
    if (e.imgIds && e.imgIds.length) { entries[k].imgIds = e.imgIds.slice(0, 8); entries[k].hasImage = true; }
    if (e.undecoded) entries[k].undecoded = true;
  }
  return {
    version: BANK_VERSION,
    kind: '题库-导出',
    builtAt: new Date().toISOString(),
    note: '已经去掉课程名/章节/时间/来源标记（脱敏）。拷到别的机器放进工程根，答题时会被自动用上。'
      + (withUnverified ? '（含未验证条目）' : '（只含"题干与页面一致、能命中"的条目）'),
    stats: {
      entries: Object.keys(entries).length,
      skippedNoAnswer: skipped,
      skippedUnverified: skippedUnverified,
      withImages: withImages,
      from: String((o.from != null ? o.from : (bank && bank.source) || ''))
    },
    entries: entries
  };
}

/* 导入（合并）：别人的库并进我的库。
   规则（交接文档 4.2）：同指纹同答案 → 合并（票数 +1）；同指纹不同答案 → **两份都留**并标冲突。
   导入的条目来源标记写成 import:<文件名>，自己的来源标记不动 —— 以后想按来源清理时有得筛。 */
function mergeBank(base, incoming, opts) {
  const o = opts || {};
  const tag = 'import:' + String(o.from || '?');
  const out = base && base.entries ? base : { version: BANK_VERSION, builtAt: new Date().toISOString(), source: '', stats: {}, entries: {} };
  const rep = { added: 0, merged: 0, conflicted: 0, skippedNoAnswer: 0, skippedBad: 0, sameSource: 0,
    normalized: 0 };   /* 判断题答案被归一的条数（A→对 / B→错）—— 单独计一档，别混进 conflicted */
  const inc = (incoming && incoming.entries) || {};
  for (const k of Object.keys(inc)) {
    const e = inc[k];
    /* 【没有题干也要收】题库码就是这种形态（只有键 + 答案，题面有版权不带走）。
       原来这一行写的是 `|| !e.stem` —— 结果是**整段题库码一条都进不来**，
       而且不报错（只把 skippedBad 加一，界面上看不出来）。 */
    if (!e || typeof e !== 'object') { rep.skippedBad++; continue; }
    if (!e.answer) { rep.skippedNoAnswer++; continue; }
    /* 【判断题答案先归一：A→对 / B→错】见 normalizeJudgmentAnswer 的注释（缺陷 3）。
       归一在这里做（**合并这条唯一入口**），这样从哪儿来的数据口径都一致。 */
    const jz = normalizeJudgmentAnswer(e.type, e.answer, e.answerText);
    if (jz.changed) rep.normalized++;
    const inAns = jz.answer, inTxt = jz.answerText;
    const cur = out.entries[k];
    let contributed = false;      /* 这次导入**有没有带来新来源**（决定条目级票数加不加） */
    if (!cur) {
      out.entries[k] = {
        fp: k, type: e.type, stem: e.stem || '', options: e.options || [],
        answer: inAns, answerText: inTxt, why: e.why || '',
        picked: !!e.picked, notPicked: '', at: '', chapter: '', n: e.n || 1,
        answers: [{ answer: inAns, answerText: inTxt, why: e.why || '', picked: !!e.picked, notPicked: '', srcs: [tag], at: '', n: e.n || 1 }]
      };
      if (e.conflict) out.entries[k].conflict = true;
      if (e.images && e.images.length) { out.entries[k].images = e.images.slice(0, 8); out.entries[k].hasImage = true; }
      if (e.imgIds && e.imgIds.length) { out.entries[k].imgIds = e.imgIds.slice(0, 8); out.entries[k].hasImage = true; }
      if (e.fpAlt && e.fpAlt !== k) out.entries[k].fpAlt = e.fpAlt;
      if (e.fpOrder && e.fpOrder !== k) out.entries[k].fpOrder = e.fpOrder;
      /* 【官方的标记必须跟着进】2026-10-12 别人测出来的（缺陷 1 的一半）：
         这一段（新条目）原来**没调 applyTopAnswer**，于是"别人给的码"里 437 条的 official
         全丢了 —— 只有第二次导入（走 merged 分支）才会被 applyTopAnswer 补上 ✗。
         所以这里补齐：先把 official 传到候选答案上，再让 applyTopAnswer 统一定档。 */
      if (e.official) out.entries[k].answers[0].official = true;
      applyTopAnswer(out.entries[k]);
      rep.added++;
      continue;
    }
    /* 已存在：按答案合并（拿**归一后**的答案比 —— 判断题 B 与「错」本来是一回事，见缺陷 3） */
    const hit = (cur.answers || []).filter((a) => a.answer === inAns)[0];
    if (hit) {
      /* 【同一个来源再来一次，不许再把票数加上去】
         实测（2026-10-12）：把本地库**自己导入自己**一次，条目数和冲突数都没变（✓ 幂等），
         可票数从 977 涨到 1349 —— 因为这里无条件 `hit.n += e.n`，而 n 是**发送方**的观察次数，
         被当成"接收方的证据"重数了一遍。
         现在：**合并一律不动 n**（n 只统计本地观察），来源记在 srcs 里；
         档位（多来源/单来源）改看 srcs 有几个 —— 同一个来源导入多少次都是"单来源"。
         opts.preserveSources：记录 → 子库 这种"同一个来源搬家"的合并，**连来源都不加**
         （不然自己搬一次家，就凭空多出"第二个来源"，档位虚高）。 */
      if (!o.preserveSources) {
        const isNewSource = (hit.srcs || []).indexOf(tag) < 0;
        if (isNewSource && (hit.srcs || []).length < 8) hit.srcs.push(tag);
        else if (!isNewSource) rep.sameSource++;
      }
      if (e.picked) hit.picked = true;
      if (!hit.why && e.why) hit.why = e.why;
      if (!hit.answerText && inTxt) hit.answerText = inTxt;
      rep.merged++;
    } else {
      cur.answers.push({
        answer: inAns, answerText: inTxt, why: e.why || '', picked: !!e.picked,
        notPicked: '', srcs: [tag], at: '', n: 1
      });
      rep.conflicted++;
    }
    /* 条目级票数也一样：合并**不加**（n 只统计本地观察） */
    if (e.fpAlt && !cur.fpAlt && e.fpAlt !== k) cur.fpAlt = e.fpAlt;   /* 别名键：有就补上 */
    if (e.fpOrder && !cur.fpOrder && e.fpOrder !== k) cur.fpOrder = e.fpOrder;
    if (e.images && e.images.length) {
      const im = (cur.images = cur.images || []);
      for (const s of e.images) if (im.indexOf(s) < 0 && im.length < 8) im.push(s);
      cur.hasImage = true;
    }
    if (e.imgIds && e.imgIds.length) {          /* 图片指纹 id：并进来（老条目靠它升级） */
      const ids = (cur.imgIds = cur.imgIds || []);
      for (const s of e.imgIds) if (ids.indexOf(s) < 0 && ids.length < 8) ids.push(s);
      cur.hasImage = true;
    }
    /* 重新定"默认答案"：统一走 rankAnswers（官方 > aria 确认 > 票数 > 早）。
       ★ 这里原来少算了 official —— 于是"别人给的码"只要票数够，就能把
         平台官方答案顶下去。导入是别人的数据，这一条必须挡住。 */
    applyTopAnswer(cur);
  }
  out.stats = Object.assign({}, out.stats || {}, {
    entries: Object.keys(out.entries).length,
    importedAt: new Date().toISOString(),
    importReport: rep
  });
  return { bank: out, report: rep };
}

/* ============================ 六、已完成页面：读平台写出来的正确答案 ============================ */

/* 【为什么单开一节】
   平台在"交过的测验"页面上会自己把答案写出来（2026-10-11 实测真实页面）：
       .correctAnswer .answerCon  ← 正确答案（判断题是"对/错"，单选题待验）
       .myAnswer .answerCon       ← 我的答案
       .answerScore .scoreNum     ← 得分
       .CorrectOrNot > span       ← marking_dui / marking_cuo
   ★ 硬约束：那一页的**选项被平台删掉了**（实测 .answerBg / li[role=radio] /
     input[type=radio] / .answer_p 全是 0 个）。而指纹把选项正文算进去了 ——
     所以在已完成页面上**算不出指纹**，没法直接给出"指纹 → 正确答案"。
   唯一的桥是**题干**：把已完成页的题干（同一套 .Zy_TItle、同样要过字体解码）
   归一化后，去库里找已有的题目。找不到的不丢，存进 gradedUnmatched 等以后对上。 */

/* 题干的"人眼键"：归一化后的 题型 + 题干。只用它做桥，**不用它当主键** ——
   主键永远是指纹。同键撞多道题（题库里真有这种）时一律判歧义、不猜。 */
function stemKeyOf(type, stem) {
  return QS.normalizeForFp(String(type || '') + '\n' + String(stem || ''));
}

/* 【两套键，先严后宽】
     exact —— 归一化(题型 + 题干原样)。题库里"从页面 DOM 读来"的条目就是这一档；
     alias —— 再把"整行只是题号"的行和【题型】标记剥掉。
              为什么要它：同一道题在库里可能只有"模型抄录版"（题干没有题号），
              而已完成页面上的题干是**带题号**的 —— 差这一截就永远对不上。
   两边都必须用同一套规则（都走 QS.normalizeForFp + aliasStem），否则桥是断的。 */
function stemIndexOf(bank) {
  const exact = {}, alias = {};
  const push = (m, key, fp) => { if (key) (m[key] = m[key] || []).push(fp); };
  for (const k of Object.keys((bank && bank.entries) || {})) {
    const e = bank.entries[k];
    push(exact, stemKeyOf(e.type, e.stem), k);
    /* 【两套索引都要建，而且要**无条件**建】
       抄录来的条目，存进库的题干本身就已经是"去掉题号与标记"的样子
       （建库时对 transcribe 走的 aliasStem）—— 我第一版只在"剥完不一样"时才建别名索引，
       于是这类条目在两套索引里都没有对应键，桥永远断。实测就是这么断的。 */
    push(alias, stemKeyOf(e.type, aliasStem(String(e.stem == null ? '' : e.stem))), k);
  }
  return { exact: exact, alias: alias };
}

/* 从题干里认出题型（已完成页面的题干里带【判断题】这种标记）。
   认不出就 '未知' —— 那会把答案挂到"未知"的条目上，所以宁可不挂。 */
function typeFromStem(stem) {
  const m = String(stem == null ? '' : stem).match(new RegExp('[【(（]\\s*(' + TYPE_FULL + ')\\s*[】)）]'));
  if (!m) return '';
  return TYPE_MAP[m[1]] || '未知';
}

/* 把"已完成页面"读到的答案并进库（纯函数，不碰网络、不碰磁盘，方便离线测）。
   items: [{ stem, correctAnswer, myAnswer, score, marking, qid, url }]
   规则：
     · 题干在库里唯一对上 → 挂成官方答案（official），**冲突两份都留**；
     · 对不上 → 进 gradedUnmatched（不丢，等以后有指纹/qid 再挂）；
     · 撞多道题 → 计歧义，宁可不动。 */
function ingestGraded(bank, items, opts) {
  const o = opts || {};
  const tag = 'platform:' + String(o.from || '已完成页面');
  const out = bank && bank.entries ? bank : { version: BANK_VERSION, builtAt: new Date().toISOString(), source: '', stats: {}, entries: {} };
  const idx = stemIndexOf(out);
  const rep = { read: 0, attached: 0, byExact: 0, byAlias: 0, alreadySame: 0, conflicted: 0, unmatched: 0, ambiguous: 0, badItem: 0, imgMismatch: 0 };
  const un = Array.isArray(out.gradedUnmatched) ? out.gradedUnmatched : [];
  for (const it of (Array.isArray(items) ? items : [])) {
    rep.read++;
    const stem = String((it && it.stem) || '').trim();
    const ans = normalizeAnswer(it && it.correctAnswer) || String((it && it.correctAnswer) || '').trim();
    if (!stem || !ans) { rep.badItem++; continue; }
    const type = typeFromStem(stem) || (it && it.type) || '';
    let fps = idx.exact[stemKeyOf(type, stem)] || [];
    let how = 'exact';
    if (!fps.length) {
      const a = aliasStem(stem);
      fps = a ? (idx.alias[stemKeyOf(type, a)] || []) : [];
      how = 'alias';
    }
    if (fps.length === 0) {
      rep.unmatched++;
      if (un.length < 500) {
        un.push({ stem: stem.slice(0, 300), type: type, answer: ans, myAnswer: String((it && it.myAnswer) || ''), score: String((it && it.score) || ''), qid: String((it && it.qid) || ''), at: new Date().toLocaleString('zh-CN'), src: tag });
      }
      continue;
    }
    if (fps.length > 1) { rep.ambiguous++; continue; }     /* 撞多道题：不猜 */
    const e = out.entries[fps[0]];
    /* 【图片也得对得上】库里记了图、页面上也有图 → 不一致就不挂（怕挂到"只有图不同"的另一道题上）。
       库里没记图而页面上有 → 顺手把图补进去（下次核对就有依据了）。 */
    const eImgs = e.images || [], iImgs = (it && it.imgs) || [];
    if (eImgs.length && iImgs.length && eImgs.slice().sort().join('|') !== iImgs.slice().sort().join('|')) {
      rep.imgMismatch++;
      continue;
    }
    if (!eImgs.length && iImgs.length) { e.images = iImgs.slice(0, 8); e.hasImage = true; }
    const hit = (e.answers || []).filter((a) => a.answer === ans)[0];
    if (hit) {
      hit.official = true;
      if (hit.srcs.indexOf(tag) < 0 && hit.srcs.length < 8) hit.srcs.push(tag);
      if (!hit.answerText) hit.answerText = String((it && it.correctAnswer) || '');
      rep.alreadySame++;
    } else {
      (e.answers = e.answers || []).push({
        answer: ans, answerText: String((it && it.correctAnswer) || ''), why: '',
        picked: false, notPicked: '', official: true,
        myAnswer: String((it && it.myAnswer) || ''), score: String((it && it.score) || ''),
        srcs: [tag], at: new Date().toLocaleString('zh-CN'), n: 1
      });
      rep.conflicted++;
    }
    if (how === 'exact') rep.byExact++; else rep.byAlias++;
    /* 官方答案优先：platform 正确答案 > aria 确认过 > 票数 > 早（与建库、导入三处口径一致，
       统一走 rankAnswers；这里原来自己排了一遍，NaN 那个坑就是这么踩出来的）。 */
    applyTopAnswer(e);
    rep.attached++;
  }
  out.gradedUnmatched = un;
  out.stats = Object.assign({}, out.stats || {}, { entries: Object.keys(out.entries).length, gradedReport: rep, gradedAt: new Date().toISOString() });
  return { bank: out, report: rep };
}

/* ---- 读"已完成页面"：只读 CDP，不点、不填、不改 ---- */

const CDP_PORT = 9222;

/* 在页面里跑只读检查。题干用与答题助手 withMath() **同一套**规则处理公式图
   （img.ans-latex-moudle / img[data] → $latex$；其它 img 不带文字，等效丢弃）——
   两边规则必须一致，否则题干对不上、桥就断了。改这里时同步看 答题助手.js 的 withMath。 */
const SCAN_EXPR = `(function(){
  function docsOf(root, depth) {
    var r = [root]; if (!depth) return r;
    var fs = []; try { fs = root.querySelectorAll('iframe'); } catch (e) { return r; }
    for (var i = 0; i < fs.length && i < 8; i++) {
      try { var cd = fs[i].contentDocument || (fs[i].contentWindow && fs[i].contentWindow.document);
        if (cd) { var s = docsOf(cd, depth - 1); for (var j = 0; j < s.length; j++) r.push(s[j]); } } catch (e) {}
    }
    return r;
  }
  function stemOf(el) {
    var box = el.querySelector('.Zy_TItle, .mark_name, .question-title, h3, h4, .stem') || el;
    var clone = box.cloneNode(true);
    var imgs = clone.querySelectorAll('img.ans-latex-moudle, img[data]');
    for (var i = 0; i < imgs.length; i++) {
      var raw = imgs[i].getAttribute('data') || imgs[i].getAttribute('data-original') || '';
      var latex = raw; try { latex = decodeURIComponent(raw); } catch (e) {}
      latex = latex.replace(/^"+|"+$/g, '').replace(/^%22+|%22+$/g, '');
      var sp = document.createElement('span'); sp.textContent = latex ? ('$' + latex + '$') : '';
      if (imgs[i].parentNode) imgs[i].parentNode.replaceChild(sp, imgs[i]);
    }
    return String(clone.innerText || '').replace(/\\u00a0/g, ' ');
  }
  function t2(el, sel) { var x = el.querySelector(sel); return x ? String(x.innerText || '').replace(/\\s+/g, ' ').trim() : ''; }
  function imgsOf(el) {
    var out = [];
    if (!el || !el.querySelectorAll) return out;
    var g = el.querySelectorAll('img');
    for (var i = 0; i < g.length; i++) { var s = String(g[i].getAttribute('src') || ''); if (s && out.indexOf(s) < 0) out.push(s); if (out.length >= 8) break; }
    return out;
  }
  var docs = docsOf(document, 3), items = [], counts = {};
  for (var d = 0; d < docs.length; d++) {
    var ts = [];
    try { ts = docs[d].querySelectorAll('.TiMu, .questionLi'); } catch (e) { ts = []; }
    counts.questions = (counts.questions || 0) + ts.length;
    for (var i = 0; i < ts.length && items.length < 200; i++) {
      var t = ts[i];
      if (!t.querySelector('.correctAnswer')) continue;          /* 只收"已公布答案"的题 */
      var mk = t.querySelector('.CorrectOrNot > span, .CorrectOrNot span');
      items.push({
        stem: stemOf(t),
        imgs: imgsOf(t),
        correctAnswer: t2(t, '.correctAnswer .answerCon'),
        myAnswer: t2(t, '.myAnswer .answerCon'),
        score: t2(t, '.scoreNum'),
        marking: mk ? String(mk.className || '') : '',
        qid: String(t.getAttribute('data') || (String(t.id || '').match(/(\\d{5,})/) || [''])[0])
      });
    }
  }
  return JSON.stringify({ url: location.href, items: items, counts: counts });
})()`;

/* 连助手浏览器的调试端口，把"已完成页面"读一遍。**只读**：不点、不填、不改。 */
async function scanGradedPage(opts) {
  const o = opts || {};
  const port = Number(o.port || CDP_PORT);
  const timeoutMs = Number(o.timeoutMs || 20000);
  if (typeof WebSocket !== 'function') return { ok: false, error: '这个 Node 没有内置 WebSocket（要 Node 22 以上）' };
  const withTimeout = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('超时 ' + timeoutMs + 'ms')), timeoutMs))]);
  let list;
  try {
    list = await withTimeout(fetch('http://127.0.0.1:' + port + '/json/list').then((r) => r.json()));
  } catch (e) {
    return { ok: false, error: '连不上调试端口 ' + port + '（浏览器没开着？）：' + ((e && e.message) || e) };
  }
  const pages = (list || []).filter((t) => t.type === 'page');
  const pick = pages.filter((t) => (/studentstudy|work|exam|ans/i).test(t.url || ''))[0] || (o.anyPage ? pages[0] : null);
  if (!pick) return { ok: false, error: '没有像"做题页"的标签页', pages: pages.map((p) => String(p.url).slice(0, 90)) };
  let val = '';
  try {
    val = await withTimeout(new Promise((res, rej) => {
      const ws = new WebSocket(pick.webSocketDebuggerUrl);
      ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')));
      ws.addEventListener('open', () => ws.send(JSON.stringify({
        id: 1, method: 'Runtime.evaluate', params: { expression: SCAN_EXPR, returnByValue: true }
      })));
      ws.addEventListener('message', (e) => {
        const m = JSON.parse(e.data);
        if (m && m.id === 1) { try { ws.close(); } catch (e2) {} res(m.result && m.result.result && m.result.result.value); }
      });
    }));
  } catch (e) {
    return { ok: false, error: '读取页面失败：' + ((e && e.message) || e), url: pick.url };
  }
  if (!val) return { ok: false, error: '页面没返回结果', url: pick.url };
  let j;
  try { j = JSON.parse(val); } catch (e) { return { ok: false, error: '返回的不是 JSON', url: pick.url }; }
  return { ok: true, url: j.url || pick.url, items: j.items || [], counts: j.counts || {} };
}

/* ============================ 七、题库码（给控制台"粘贴即用"）============================ */

/* 【为什么要有"码"】
   导出一个 json 文件，用户得会找文件、会放位置；而"复制一段文本、粘进网页控制台"是零门槛的。
   码里装的是**只有匹配和填答必需**的东西：
       三把键 + 题型 + 答案 + **答案正文** + 可信度/票数
   **不带题干、不带选项全文、不带课程/章节/时间** ——
     · 题面原文有版权（交接文档第 9 节），能不带就不带；
     · 而"答案正文"是填对位置的最小信息：走"顺序无关"那把键时，要靠它才能在页面上
       找到该点哪个选项（没有它就只能按字母填，而字母在别人卷子上可能是错的）。
   格式：`TIKU1:` + gzip(JSON) 的 base64url —— 前缀是用来"认身份"的（粘错东西当场说清）。 */
const CODE_PREFIX = 'TIKU1:';

function keysOnlyEntries(bank, opts) {
  const o = opts || {};
  const src = (bank && bank.entries) || {};
  const out = {};
  for (const k of Object.keys(src)) {
    const e = src[k];
    if (!e || !e.answer) continue;                       /* 没答案的带了也没用 */
    if (!o.withUnverified && !isReliable(e)) continue;   /* 默认只带"能命中页面"的 */
    const one = { fp: k, type: e.type, answer: e.answer, answerText: e.answerText || '', n: e.n || 1 };
    if (e.fpAlt) one.fpAlt = e.fpAlt;
    if (e.fpOrder) one.fpOrder = e.fpOrder;
    if (e.picked) one.picked = true;
    if (e.official) one.official = true;
    if (e.conflict) one.conflict = true;
    /* 【图片身份也要跟着走】运行时护栏是拿"页面的图片指纹"去比**条目自带的 imgIds**；
       条目里没带 ⇒ 对方拿到码也用不上图片判同（只能靠 URL）✗。
       实测（2026-10-12）：漏了这一条，导出会变成"把整张表的向量都带上"（码随图数膨胀 ✗）。
       带上之后：① 护栏在对方那边也能生效；② 导出只带被引用的那几张图的向量。 */
    if (e.imgIds && e.imgIds.length) one.imgIds = e.imgIds.slice(0, 8);
    out[k] = one;
  }
  return out;
}

function encodeCode(bank, opts) {
  const o = opts || {};
  const entries = keysOnlyEntries(bank, o);
  const payload = { version: BANK_VERSION, kind: '题库码', at: new Date().toISOString(), entries: entries };
  /* 【图片指纹表跟着码走】图片表存的是"id → 16×16 向量的 base64"，**不带任何原图**。
     ★ 2026-10-12 补：只带"**这次导出的条目真正引用的**"那几张图。
       为什么必须带 **向量本身**（而不只是 id）：对方机器如果从没"见过"这张图（表里没这个向量），
       它算出来的是个**新 id** ✗，跟码里的 id 对不上 ⇒ 护栏（页面的 id 必须能在条目里找到）会拒
       ⇒ 白漏一次免答。带上向量之后，对方能拿图跟向量比出相似度 ⇒ **归到码里那个 id** ✓。
       为什么只带引用的：整表带的话会随"表里历史图"线性膨胀（一千张图 ≈ +340 KB ✗）；
       只带这次用得到的，码就基本不长（实测这次导出只多几 KB）。
       老解码端不认识多出来的字段也不要紧 —— 它只读 ids/urls，结构没变 ✓。 */
  if (o.images && o.images.ids && Object.keys(o.images.ids).length) {
    const used = new Set();
    for (const k of Object.keys(entries)) {
      const e = entries[k];
      if (!e) continue;
      for (const id of (e.imgIds || [])) used.add(id);
    }
    const ids = {}, urls = {};
    for (const id of Object.keys(o.images.ids)) {
      if (used.size && !used.has(id)) continue;          /* 只带这次用得上的 */
      ids[id] = o.images.ids[id];
    }
    for (const u of Object.keys(o.images.urls || {})) {
      if (ids[o.images.urls[u]]) urls[u] = o.images.urls[u];
    }
    payload.images = { ids: ids, urls: urls };
  }
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'), { level: 9 });
  return CODE_PREFIX + gz.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* 解一段题库码。**任何一步坏掉都要说清是哪一步**，绝不半信半疑地用一半。 */
function decodeCode(code) {
  const raw = String(code == null ? '' : code).trim().replace(/\s+/g, '');
  if (!raw) return { ok: false, error: '题库码是空的' };
  if (raw.indexOf(CODE_PREFIX) !== 0) return { ok: false, error: '这不像题库码（开头应该是 ' + CODE_PREFIX + '…）' };
  let buf;
  try {
    const b64 = raw.slice(CODE_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/');
    buf = Buffer.from(b64 + '='.repeat((4 - (b64.length % 4)) % 4), 'base64');
    if (!buf.length) throw new Error('空内容');
  } catch (e) {
    return { ok: false, error: '题库码内容读不出来（base64 坏了）' };
  }
  let j;
  try { j = JSON.parse(zlib.gunzipSync(buf).toString('utf8')); }
  catch (e) { return { ok: false, error: '题库码解压失败（多半是被截断或复制漏了尾巴）' }; }
  if (!j || j.kind !== '题库码' || !j.entries || typeof j.entries !== 'object') {
    return { ok: false, error: '解出来的东西不是题库码（或版本不认识）' };
  }
  const entries = {};
  let bad = 0, noAns = 0;
  for (const k of Object.keys(j.entries)) {
    const e = j.entries[k];
    if (!e || typeof e !== 'object' || String(e.fp) !== k || !/^[0-9a-f]{8,64}$/.test(k)) { bad++; continue; }
    const ans = normalizeAnswer(e.answer) || String(e.answer || '').trim();
    if (!ans) { noAns++; continue; }
    const one = {
      fp: k, type: String(e.type || ''), answer: ans, answerText: String(e.answerText || ''),
      n: Number(e.n) > 0 ? Number(e.n) : 1, src: 'code',
      answers: [{
        answer: ans, answerText: String(e.answerText || ''), picked: !!e.picked,
        official: !!e.official, srcs: ['code'], n: Number(e.n) > 0 ? Number(e.n) : 1
      }]
    };
    if (e.fpAlt) one.fpAlt = String(e.fpAlt);
    if (e.fpOrder) one.fpOrder = String(e.fpOrder);
    if (e.picked) one.picked = true;
    if (e.official) one.official = true;
    if (e.conflict) one.conflict = true;
    /* 【图片身份必须原样带过来】护栏靠"页面的指纹 vs 条目自带的 imgIds"判同 ——
       解码端把这一条丢了的话，对方拿到码也用不上图片判同 ✗（实测就这样：编码端带了 8 张图的向量，
       解码出来的条目光秃秃的一个 imgIds 都没有，自相矛盾才发现的）。 */
    if (Array.isArray(e.imgIds) && e.imgIds.length) {
      const ids = e.imgIds.filter((x) => /^[0-9a-f]{8,64}$/.test(String(x))).slice(0, 8);
      if (ids.length) one.imgIds = ids;
    }
    entries[k] = one;
  }
  /* 图片指纹表：有就带上（可选段，老码没有） */
  let images = null;
  if (j.images && j.images.ids && typeof j.images.ids === 'object') {
    const ids = {};
    for (const k of Object.keys(j.images.ids)) {
      if (!/^[0-9a-f]{8,64}$/.test(k)) continue;
      const v = Buffer.from(String(j.images.ids[k] || ''), 'base64');
      if (v.length !== 256) continue;                 /* 16×16 灰度：长度不对的丢掉 */
      ids[k] = v.toString('base64');
    }
    if (Object.keys(ids).length) images = { ids: ids, urls: (j.images.urls && typeof j.images.urls === 'object') ? j.images.urls : {} };
  }
  return {
    ok: true, entries: Object.keys(entries).length, bad: bad, noAns: noAns, images: images,
    bank: { version: BANK_VERSION, builtAt: String(j.at || ''), source: '题库码', stats: {}, entries: entries }
  };
}

/* ============================ 八、一键去重复 ============================ */

/*
 * 【为什么需要】同一道题会因为**题号不同**被记成两条（第 3 题 / 第 7 题），
 * 或者因为**选项顺序不同**记成两条 —— 主键（页面原文指纹）不一样，但在"人"看来是同一道题。
 * 而且带图的题一旦进了库，"同一题不同题号"的两条会各自带着自己的图片指纹，
 * 查的时候只能命中其中一条。
 *
 * 判据：**顺序无关键**（去题号题干 + 排序后的选项正文）相同 ⇒ 同一道题。
 *        没有 fpOrder 的老条目退回用"去掉题号的题干"（fpAlt）判。
 * 做法：每组留一条"最好的"当主条目（平台官方 > aria 确认过 > DOM 来源 > 票数多），
 *        其余条目的答案**并进 answers**（冲突照样留着），
 *        并把**被并掉的那些主键记进 aliases** —— 这样"以前记过的键"照样查得到（一个字都不丢）。
 * 就这一条判据，绝不按"看着像"去合并 —— 合错了比重复更糟。
 */
/* 【图片能不能用来"判同"？】—— 分两个用法，结论完全不同：
     · 当**键**（把图片指纹并进指纹）：✗ 不行。图片指纹不是稳定的（同一道题不同访问可能算出不同 id），
       当键会把同一道题拆成好几条、每条都不完整；而且老条目根本没有图片信息。
     · 当**合并闸门**（只决定"两条要不要并成一条"）：✓ 该用。
       因为"文字和选项一模一样、只有图不同"的两道题（求下图极限 → 选项 A.0 B.1 C.2）会算出**同一个顺序无关键**，
       今天会被并成一条：两个答案并排、两个图片指纹并排 —— **"哪个答案配哪张图"的对应关系当场就丢了** ✗，
       事后无法恢复；运行时面对其中一张图的页面就可能拿到另一张图的答案。
       ⇒ 所以合并前先看图片：**两边都有图且不重叠 ⇒ 不并**（宁可留两条）。
       判错的最坏后果只是"没并成"（多留一条，不影响正确性）。
  兼容规则：两边都没图 → 兼容；有交集 → 兼容（同一张图的两次不同渲染）；其余 → 不兼容。 */
function imgCompatible(a, b) {
  const ai = (a && a.imgIds) || [], bi = (b && b.imgIds) || [];
  if (ai.length && bi.length) return ai.some((x) => bi.indexOf(x) >= 0);
  const au = (a && a.images) || [], bu = (b && b.images) || [];
  if (au.length && bu.length) return au.some((x) => bu.indexOf(x) >= 0);
  if (!ai.length && !bi.length && !au.length && !bu.length) return true;   /* 两边都没图 */
  /* 一边有图一边没有（或 id 与 URL 混着）→ 说不清，保守：不并 */
  return false;
}

function dedupeBank(bank, opts) {
  const o = opts || {};
  const src = (bank && bank.entries) || {};
  const groups = {};
  const keyOf = (e) => e.fpOrder || e.fpAlt || '';
  for (const k of Object.keys(src)) {
    const e = src[k];
    if (!e || !e.answer) continue;
    const g = keyOf(e);
    if (!g) continue;                       /* 没这把键的老条目不敢并（宁可留着） */
    (groups[g] = groups[g] || []).push(e);
  }
  const out = { version: BANK_VERSION, builtAt: (bank && bank.builtAt) || '', source: (bank && bank.source) || '', stats: Object.assign({}, (bank && bank.stats) || {}), entries: {}, gradedUnmatched: (bank && bank.gradedUnmatched) || [] };
  const rep = { groups: 0, merged: 0, aliasesKept: 0, answersKept: 0 };
  const rank = (e) => {
    const official = (e.answers || []).some((a) => a.official) || e.official ? 1 : 0;
    const picked = (e.answers || []).some((a) => a.picked) || e.picked ? 1 : 0;
    const dom = (e.answers || []).some((a) => (a.srcs || []).some((s) => /^self:/.test(s))) ? 1 : 0;
    return official * 1000 + picked * 100 + dom * 10 + Math.min(9, (e.n || 1));
  };
  const taken = {};
  const droppedKeys = {};          /* 被并掉的那些主键：最后拷贝时**必须跳过**（第一版忘了，512→512 白干一场） */
  for (const g of Object.keys(groups)) {
    let list = groups[g];
    if (list.length < 2) continue;
    rep.groups++;
    /* 【先按图片把这一组再切一刀】文字/选项一样但**图不同**的，绝不并成一条
       （并了就会丢掉"哪个答案配哪张图"，运行时可能拿错答案）。见 imgCompatible 的说明。 */
    if (list.length > 2 || !imgCompatible(list[0], list[1])) {
      const clusters = [];
      for (const e of list) {
        let placed = false;
        for (const c of clusters) {
          if (c.every((x) => imgCompatible(x, e))) { c.push(e); placed = true; break; }
        }
        if (!placed) clusters.push([e]);
      }
      if (clusters.length > 1) {
        rep.splitByImage = (rep.splitByImage || 0) + (clusters.length - 1);
        rep.groups += clusters.length - 1;
        list = clusters.filter((c) => c.length > 1).sort((a, b) => b.length - a.length)[0] || [];
        for (const c of clusters) {
          if (c === list || c.length < 2) continue;
          /* 这些簇里的条目这次不并（各自留着）—— 它们稍后会被"没进任何重复组"那段原样拷回去 */
          for (const e of c) rep.keptApartByImage = (rep.keptApartByImage || 0) + 1;
        }
        if (!list.length) continue;
      }
    }
    const sorted = list.slice().sort((a, b) => rank(b) - rank(a));
    const keep = sorted[0];
    const drop = sorted.slice(1);
    for (const e of drop) droppedKeys[e.fp] = true;
    /* 合并答案：同一条答案 → 票数与来源并起来；不同的 → 都留着（会标冲突） */
    const answers = (keep.answers || []).map((a) => Object.assign({}, a, { srcs: (a.srcs || []).slice() }));
    for (const e of drop) {
      const imgs = [];
      let idsU = keep.imgIds ? keep.imgIds.slice() : [];
      for (const cand of (e.answers || [{ answer: e.answer, answerText: e.answerText || '', picked: !!e.picked, official: !!e.official, n: e.n || 1, srcs: [] }])) {
        const hit = answers.filter((a) => a.answer === cand.answer)[0];
        if (hit) {
          hit.n = (hit.n || 1) + (cand.n || 1);
          if (cand.picked) hit.picked = true;
          if (cand.official) hit.official = true;
          for (const s of (cand.srcs || [])) if ((hit.srcs || []).indexOf(s) < 0 && (hit.srcs || []).length < 8) hit.srcs.push(s);
          rep.answersKept++;
        } else {
          answers.push(Object.assign({}, cand, { srcs: (cand.srcs || []).slice() }));
          rep.answersKept++;
        }
      }
      if (e.images && e.images.length) for (const s of e.images) if (imgs.indexOf(s) < 0 && imgs.length < 8) imgs.push(s);
      if (e.imgIds && e.imgIds.length) for (const s of e.imgIds) if (idsU.indexOf(s) < 0 && idsU.length < 8) idsU.push(s);
      if (imgs.length) keep.images = (keep.images || []).concat(imgs.filter((s) => (keep.images || []).indexOf(s) < 0)).slice(0, 8);
      if (idsU.length) keep.imgIds = idsU;
      /* 【被并掉的那个主键要留着当别名】不然"以前记过这个键"的查询会落空 */
      keep.aliases = (keep.aliases || []).slice();
      if (drop.indexOf(e) >= 0 && e.fp !== keep.fp && keep.aliases.indexOf(e.fp) < 0 && keep.aliases.length < 16) {
        keep.aliases.push(e.fp);
        rep.aliasesKept++;
      }
      rep.merged++;
    }
    answers.sort((a, b) => ((b.official ? 1 : 0) - (a.official ? 1 : 0)) || ((b.picked ? 1 : 0) - (a.picked ? 1 : 0)) || ((b.n || 0) - (a.n || 0)));
    keep.answers = answers;
    applyTopAnswer(keep);
    taken[keep.fp] = keep;
  }
  /* 没进任何重复组、也没被并掉的条目原样留着 */
  for (const k of Object.keys(src)) {
    if (taken[k] || droppedKeys[k]) continue;
    out.entries[k] = src[k];
  }
  for (const k of Object.keys(taken)) out.entries[k] = taken[k];
  out.stats = Object.assign({}, out.stats, {
    entries: Object.keys(out.entries).length, dedupedAt: new Date().toISOString(), dedupeReport: rep
  });
  return { bank: out, report: rep };
}

/* 【写库前先留一份备份】去重复 / 导入题库码这类"会改你数据"的动作，先把原来的库复制成
   `题库.json.bak`。库本身能从记录重建（记录才是原始账本），但多一份"动手之前的样子"更稳。 */
function backupBank(bankPath) {
  try {
    const p = bankPath || path.join(__dirname, BANK_FILE);
    if (!fs.existsSync(p)) return '';
    const bak = p + '.bak';
    fs.copyFileSync(p, bak);
    return bak;
  } catch (e) { return ''; }
}

/* ============================ 八、库管理（主库 + 子库） ============================ */

/*
 * 【为什么这么放】主库还是原来那个 `题库.json`（在工程根）—— **不迁移**，
 * 因为它是运行时、驱动器、打包规则、几十条用例共同认的路径，动它等于一次大搬家。
 * 子库放在 `题库\` 目录里（一个文件一个库，文件名就是库名）。
 * 这样"总库"= 主库 + 子库目录，两种库都能：单独启用/停用、单独导入、单独导出成码。
 */
const SUB_DIR = '题库';

function subDirOf(dir) { return path.join(dir || __dirname, SUB_DIR); }

/* 列出所有库（主库在前）。**只读**：读不出来就当 0 条，不抛错、不创建。 */
function listBanks(opts) {
  const o = opts || {};
  const base = o.dir || path.dirname(String(o.bankFile || path.join(__dirname, BANK_FILE)));
  const mainPath = o.bankFile || path.join(base, BANK_FILE);
  const countOf = (p) => {
    try {
      if (!fs.existsSync(p)) return 0;
      const j = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
      return Object.keys((j && j.entries) || {}).length;
    } catch (e) { return 0; }
  };
  const out = [];
  out.push({
    name: o.mainName || '主库', file: path.relative(base, mainPath) || BANK_FILE,
    path: mainPath, entries: countOf(mainPath), main: true,
    exists: fs.existsSync(mainPath), size: fs.existsSync(mainPath) ? fs.statSync(mainPath).size : 0
  });
  const sd = subDirOf(base);
  let files = [];
  try { files = fs.readdirSync(sd); } catch (e) { files = []; }
  const seenPaths = new Set([path.resolve(mainPath)]);
  for (const f of files) {
    if (!/\.json$/i.test(f)) continue;
    const p = path.join(sd, f);
    /* 同一个文件别列两次（万一主库就在子库目录里，或者有重复项） */
    if (seenPaths.has(path.resolve(p))) continue;
    seenPaths.add(path.resolve(p));
    let st = 0;
    try { st = fs.statSync(p).size; } catch (e) { st = 0; }
    out.push({
      name: f.replace(/\.json$/i, ''), file: path.join(SUB_DIR, f),
      path: p, entries: countOf(p), main: false, exists: true, size: st
    });
  }
  return out;
}

/* 按"库名或文件名"找库（找不到就返回 null）。主库用 '主库' / '题库.json' 都认。 */
function findBank(nameOrFile, opts) {
  const list = listBanks(opts);
  const want = String(nameOrFile || '').trim();
  if (!want) return list[0] || null;
  for (const b of list) {
    if (b.name === want) return b;
    if (b.file === want) return b;
    if (path.basename(b.file) === want) return b;
    if (path.basename(b.file, '.json') === want) return b;
  }
  return null;
}

/* 读一个库文件成内存库（读不出来返回 null）。 */
function loadBank(libPath) {
  try {
    if (!fs.existsSync(libPath)) return null;
    const b = parseBank(fs.readFileSync(libPath, 'utf8'));
    return Object.keys(b.entries || {}).length ? b : null;
  } catch (e) { return null; }
}

/* 【按课程分流】记录里带课程名的条目 → 按课程归到各自的库；没有课程名的（老记录）→ 主库。
   为什么要有：法师要求"题库录入按课程名自动建库，同一个课程必须进同一个库，不要起同名库"。
   同名只认一个库：先把课程名**规范化**（去空白/去首尾点/去路径分隔符/统一大小写比较），
   已有同名库就并进去，没有才新建 —— 这样"军事理论"和"军事理论 "不会变成两个库。 */
function libNameOf(course) {
  /* 【只认字符串】实测（2026-10-12）：某处调用把**对象**当课程名传进来了 ⇒
     String(obj) = "[object Object]" ⇒ 真的写出了一个 `题库\[object Object].json` ✗。
     库名是拿来当文件名的，宁可不认（退回主库）也不能写出这种文件。 */
  if (typeof course !== 'string') return '';
  const raw = String(course).replace(/[\r\n\t]+/g, ' ').trim();
  if (!raw || raw === '[object Object]') return '';
  const safe = raw
    .replace(/[\\\/:*?"<>|]/g, '_')      /* 文件名里不许有的字符 */
    .replace(/[.\s]+$/g, '')             /* Windows 上结尾的点和空格会出问题 */
    .replace(/\s+/g, ' ')
    .slice(0, 60)
    .trim();
  return safe;
}

/* 把记录解析出来的题按课程分组：{ 课程名: [题…] }（没有课程名的放在 '' 这一组） */
function splitByCourse(parsed) {
  const groups = {};
  for (const q of ((parsed && parsed.questions) || [])) {
    const k = libNameOf(q.course);
    (groups[k] = groups[k] || []).push(q);
  }
  return groups;
}

/* 从记录建库（**按课程分流**）：返回 { libs: { 课程名: bank }, main: bank, stats }
   - 有课程名的 → 各自一个库
   - 没课程名的 → 主库（老记录不迁移，行为跟以前一样）
   opts: { buildBank, source } */
function buildSplitFromFile(srcPath, opts) {
  const o = opts || {};
  const text = fs.readFileSync(srcPath, 'utf8');
  const parsed = parseRecord(text);
  const groups = splitByCourse(parsed);
  const libs = {};
  let mainParsed = { questions: [], marks: (parsed.marks || []) };
  for (const k of Object.keys(groups)) {
    if (!k) { mainParsed.questions = groups[k]; continue; }
    libs[k] = buildBank({ questions: groups[k], marks: [] }, { source: path.basename(srcPath) });
  }
  const main = buildBank(mainParsed, { source: path.basename(srcPath) });
  return { libs: libs, main: main, parsed: parsed, groups: groups };
}

/* 【建库时就该把"证明是垃圾"的挡在外面】2026-10-12：光"清库"没用 ——
   驱动器每隔几分钟会从记录**重建**主库，清掉的垃圾会被重建带回来 ✗。
   所以同一条规矩放在建库这条路上（跟 cleanBank 保持一致，改一处要改两处）：
     · 测试章节（「测验 · 假章节」那种）→ 不收
     · 没答案又没选项的空壳 → 不收（答不了也认不出）
     · 选项正文全空/全问号、而且没有任何图片身份 → 不收 */
function isJunkQuestion(q) {
  const chapter = String((q && q.chapter) || '');
  const stem = String(q && q.stem == null ? '' : q.stem);
  if (/假章节/.test(chapter)) return 'test-chapter';
  if (/(同一道题|库里的理由|p\.example)/.test(stem)) return 'test-stem';
  const opts = (q && q.options) || [];
  if (!q.answer && !opts.length) return 'empty-shell';
  const texts = opts.map((o) => String(o.text == null ? '' : o.text));
  if (texts.length >= 2 && texts.every((t) => !t.trim() || /^[?？\s]+$/.test(t))) {
    const hasImg = ((q.imgIds || []).length > 0) || ((q.imgs || []).length > 0);
    if (!hasImg) return 'unreadable';
  }
  return '';
}



/*
 * 【只删"能证明是垃圾"的，宁可不删】2026-10-12 体检 + 法师要求"去除非法脏数据"。
 * 一开始我想按"答案与题型矛盾"删，可体检发现那类全是**没答案**的条目（不是非法答案 ✗），
 * 而"判断题答案=B"这种是**完全正常**的（选项就是 A.对 B.错）—— 差点误删 30 条。
 * 所以规则收敛成下面三条，每条都能证明"它永远不可能有用"：
 *   R1 测试数据：章节名带「假章节」，或题干是测试专属串（同一道题 / 库里的理由 / p.example）
 *   R2 空壳：既没有答案、也没有选项 —— 答不了、也认不出
 *   R3 认不出：选项正文全空或全是问号，**而且**没有任何图片身份（既没文字也没图）
 * 报告每类删了几条、抽样长什么样；`--dry` 只报不删。删之前照例先写一份 `题库.json.bak`。
 */
function cleanBank(bank, opts) {
  const o = opts || {};
  const src = (bank && bank.entries) || {};
  const out = { version: BANK_VERSION, builtAt: (bank && bank.builtAt) || '', source: (bank && bank.source) || '', stats: Object.assign({}, (bank && bank.stats) || {}), entries: {}, gradedUnmatched: (bank && bank.gradedUnmatched) || [] };
  const rep = { total: 0, kept: 0, r1: [], r2: [], r3: [] };
  const TEST_CHAPTER = /假章节/;
  const TEST_STEM = /(同一道题|库里的理由|p\.example)/;
  for (const k of Object.keys(src)) {
    const e = src[k];
    rep.total++;
    if (!e) { rep.r2.push(k); continue; }
    const stem = String(e.stem == null ? '' : e.stem);
    const chapter = String(e.chapter || '');
    const opts2 = (e.options || []).map((x) => String(x.text == null ? '' : x.text));
    const blankOpts = opts2.length >= 2 && opts2.every((t) => !t.trim() || /^[?？\s]+$/.test(t));
    const hasImg = ((e.imgIds || []).length > 0) || ((e.images || []).length > 0);
    if (TEST_CHAPTER.test(chapter) || TEST_STEM.test(stem)) { rep.r1.push(k); continue; }
    if (!e.answer && !(e.options || []).length) { rep.r2.push(k); continue; }
    if (blankOpts && !hasImg) { rep.r3.push(k); continue; }
    out.entries[k] = e;
    rep.kept++;
  }
  out.stats = Object.assign({}, out.stats, { cleanedAt: new Date().toISOString(), cleanReport: { r1: rep.r1.length, r2: rep.r2.length, r3: rep.r3.length, kept: rep.kept } });
  return { bank: out, report: rep };
}

/* ============================ 八点六、按标签导出 ============================ */

/*
 * 【标签导出】2026-10-12 法师要求：不只是冲突，官方/多来源/带图……都能挑着导。
 * 每个标签对应一条"**能证明**"的判据（不是猜的），定义都在下面 TAGS 里 —— 加标签只改这一处。
 * 导出的每一行都会带一列「标签」，所以混着导也看得清。
 */
const TAGS = [
  { id: 'conflict', name: '冲突（同题不同答案）', hit: (e, x) => !!e.conflict || x.uniq > 1 },
  { id: 'official', name: '官方答案', hit: (e, x) => !!e.official || x.cands.some((c) => c.official) },
  { id: 'picked', name: '平台已选（aria 确认）', hit: (e, x) => !!e.picked || x.cands.some((c) => c.picked) },
  { id: 'multi', name: '多来源（≥2 个不同来源）', hit: (e, x) => x.srcCount >= 2 },
  { id: 'single', name: '单来源', hit: (e, x) => x.cands.length === 1 },
  { id: 'image', name: '带图片', hit: (e) => ((e.imgIds || []).length > 0) },
  { id: 'noanswer', name: '没答案（占位）', hit: (e) => !e.answer },
  /* 【名字要对得上】这个字段叫 undecoded，但它真正的含义是"**旧格式那批**"——
     建库时对 `!isDom`（也就是模型抄录、不是从 DOM 结构化读到的）打的标记（见 buildBank 里那行）。
     不是"替身字没解开"，别标错（一开始我就标错了，量出来 446 条才发现）。 */
  { id: 'legacy', name: '旧格式·模型抄录（解码能力之前记的）', hit: (e) => !!e.undecoded },
  { id: 'alias', name: '有别名键（题干变体）', hit: (e) => !!e.fpAlt },
  { id: 'order', name: '有顺序无关键（选项顺序变过）', hit: (e) => !!e.fpOrder }
];
const TAG_NAME = (() => { const m = {}; for (const t of TAGS) m[t.id] = t.name; return m; })();

function tagHit(id, e, x) {
  const t = TAGS.filter((z) => z.id === id)[0];
  return t ? !!t.hit(e, x) : false;
}
/* 把 "all" / 逗号分隔的标签串 解析成合法 id 列表（未知的丢出去并在返回里说明）。
   除了 id，也认**中文名**（含部分匹配）—— 命令行上写 --export-tags 冲突,官方 也能用。 */
function parseTags(spec) {
  const raw = Array.isArray(spec) ? spec : String(spec == null ? '' : spec).split(/[,、\s]+/);
  const want = raw.map((s) => String(s).trim()).filter(Boolean);
  const ids = [], bad = [];
  for (const w of want) {
    const low = w.toLowerCase();
    if (low === 'all' || w === '全部' || w === '*') return { ids: TAGS.map((t) => t.id), bad: bad };
    if (TAG_NAME[low]) { if (ids.indexOf(low) < 0) ids.push(low); continue; }
    const byName = TAGS.filter((t) => t.name === w || t.name.indexOf(w) >= 0)[0];
    if (byName) { if (ids.indexOf(byName.id) < 0) ids.push(byName.id); continue; }
    bad.push(w);
  }
  return { ids: ids, bad: bad };
}

/*
 * 按标签导出。opts:
 *   tags        标签 id 数组（默认 ['conflict']，保持和以前 --conflicts 一样的行为）
 *   includeAgree 仅对 conflict 有用：把"多候选但答案一致"的也列进冲突
 *   type        只要某个题型（'单选'/'多选'/'判断'…，空=全部）
 *   limit       最多导多少条（0=不限）
 * 返回 { count, rows, csv, text, byTag, badTags }
 */
function exportBankByTags(bank, opts) {
  const o = opts || {};
  const want = parseTags(o.tags == null ? ['conflict'] : o.tags);
  const onlyConflict = want.ids.length === 1 && want.ids[0] === 'conflict';
  const src = (bank && bank.entries) || {};
  const rows = [];
  const byTag = {};
  for (const id of want.ids) byTag[id] = 0;
  for (const k of Object.keys(src)) {
    const e = src[k];
    if (!e) continue;
    if (o.type && String(e.type || '') !== String(o.type)) continue;
    const ans = (e.answers || []).filter((a) => a && a.answer);
    const uniq = Array.from(new Set(ans.map((a) => String(a.answer))));
    const srcsAll = new Set();
    for (const a of ans) for (const s of (a.srcs || [])) srcsAll.add(String(s));
    const cands = (ans.length ? ans : [{ answer: e.answer, answerText: e.answerText, srcs: ['(无来源记录)'], n: e.n }])
      .slice()
      .sort((a, b) => (Number(b.n) || 0) - (Number(a.n) || 0))
      .map((a) => ({
        answer: String(a.answer == null ? '' : a.answer),
        text: String(a.answerText == null ? '' : a.answerText),
        n: Number(a.n) || 0,
        picked: !!a.picked,
        official: !!a.official,
        why: String(a.why == null ? '' : a.why),
        srcs: (a.srcs || []).map(String),
        at: String(a.at || '')
      }));
    const x = { uniq: uniq.length, cands: cands, srcCount: srcsAll.size };
    /* 逐个标签判：
       冲突 = 不同答案 >1；若开了 includeAgree，则"多个候选但答案一致"的也算（仍要求 ≥2 个候选）。
       其余标签走 TAGS 里各自的判据。 */
    const hitIds = want.ids.filter((id) => {
      if (id === 'conflict') return x.uniq > 1 || !!(o.includeAgree && cands.length >= 2);
      return tagHit(id, e, x);
    });
    if (!hitIds.length) continue;
    hitIds.forEach((id) => { byTag[id] = (byTag[id] || 0) + 1; });
    rows.push({
      fp: k, type: String(e.type || ''),
      tags: hitIds,
      tagsName: hitIds.map((id) => TAG_NAME[id] || id).join('、'),
      stem: String(e.stem == null ? '' : e.stem).replace(/\s+/g, ' ').trim(),
      options: (e.options || []).map((q2) => String(q2.letter || '') + '.' + String(q2.text == null ? '' : q2.text)).join(' ｜ '),
      picked: String(e.answer == null ? '' : e.answer),
      pickedText: String(e.answerText == null ? '' : e.answerText),
      conflict: !!e.conflict || x.uniq > 1,
      候选数: cands.length, 不同答案数: x.uniq, 来源数: x.srcCount,
      chapter: String(e.chapter || ''), 图片: (e.imgIds || []).length, 课: String(e.course || ''),
      cands: cands
    });
  }
  rows.sort((a, b) => (b.不同答案数 - a.不同答案数) || (b.候选数 - a.候选数) || (a.type < b.type ? -1 : 1));
  if (o.limit > 0) rows.length = Math.min(rows.length, o.limit);

  const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const head = ['题目指纹', '题型', '标签', '题干', '选项', '库里现在用的答案', '答案正文', '不同答案数', '候选条数', '来源数', '章节', '图片张数', '课程', '候选明细（答案｜票数｜来源｜理由）'];
  const lines = [head.map(q).join(',')];
  for (const r of rows) {
    const detail = r.cands.map((c) => c.answer + (c.text ? ('(' + c.text + ')') : '') + '｜' + c.n + ' 票｜' +
      (c.srcs.length ? c.srcs.join(';') : '(无)') + (c.picked ? '｜平台已选' : '') + (c.official ? '｜官方' : '') +
      (c.why ? ('｜理由:' + c.why) : '')).join('  //  ');
    lines.push([r.fp, r.type, r.tagsName, r.stem, r.options, r.picked, r.pickedText, r.不同答案数, r.候选数, r.来源数, r.chapter, r.图片, r.课, detail].map(q).join(','));
  }
  const csv = '\uFEFF' + lines.join('\r\n') + '\r\n';

  const t = [];
  t.push('题库导出 —— 共 ' + rows.length + ' 条');
  t.push('标签：' + want.ids.map((id) => (TAG_NAME[id] || id) + '(' + (byTag[id] || 0) + ')').join('、') +
    (o.type ? ('　题型限：' + o.type) : ''));
  if (want.bad.length) t.push('（不认识的标签已忽略：' + want.bad.join('、') + '）');
  t.push('');
  rows.forEach((r, i) => {
    t.push('── [' + (i + 1) + '] ' + (r.conflict ? '⚠ 冲突  ' : '') + r.type + '  [' + r.tagsName + ']' +
      '  不同答案 ' + r.不同答案数 + ' 个 / 候选 ' + r.候选数 + ' 条' + (r.课 ? ('  课程：' + r.课) : ''));
    t.push('   题干：' + r.stem);
    if (r.options) t.push('   选项：' + r.options);
    t.push('   现在用：' + (r.picked || '(没答案)') + (r.pickedText ? ('（' + r.pickedText + '）') : ''));
    r.cands.forEach((c) => {
      t.push('     · ' + (c.answer || '(空)') + (c.text ? ('（' + c.text + '）') : '') + '   ' + c.n + ' 票' +
        (c.picked ? '   [平台已选]' : '') + (c.official ? '   [官方]' : ''));
      t.push('       来源：' + (c.srcs.length ? c.srcs.join(' ; ') : '(无)'));
      if (c.why) t.push('       理由：' + c.why);
    });
    t.push('   指纹：' + r.fp + (r.chapter ? ('   章节：' + r.chapter) : '') + (r.图片 ? ('   带图 ' + r.图片 + ' 张') : ''));
    t.push('');
  });
  return { count: rows.length, rows: rows, csv: csv, text: t.join('\r\n'), byTag: byTag, badTags: want.bad, tags: want.ids };
}

/* 老名字保留：就是"只导冲突"那一种（--conflicts 走它，行为跟以前完全一样） */
function exportConflicts(bank, opts) {
  const o = Object.assign({ tags: ['conflict'] }, opts || {});
  return exportBankByTags(bank, o);
}

/* 当前有哪些标签可以用（给界面和命令行列出来用） */
function listTags() {
  return TAGS.map((t) => ({ id: t.id, name: t.name }));
}

/*
 * 【挑出一部分条目做成"子库"】2026-10-12 法师要：按标签导的应该是**可导入的题库码**，
 * 不是那份人看的报告。做法：按标签筛出条目 → 拼成一个跟正常库同构的对象（entries 结构原样带走，
 * 别名键/顺序键/图片身份都不动）→ 交给 encodeCode 就行（编解码只有一套，别在这儿另写）。
 *   opts.tags        标签（同 exportBankByTags 的写法，支持 all/中文名）
 *   opts.includeAgree 冲突那条的老规矩
 *   opts.type        只挑某个题型
 * 返回 { bank, count, byTag, tags, badTags }
 */
function bankFromTags(bank, opts) {
  const o = opts || {};
  const want = parseTags(o.tags == null ? ['all'] : o.tags);
  const src = (bank && bank.entries) || {};
  const out = {
    version: (bank && bank.version) || BANK_VERSION,
    builtAt: (bank && bank.builtAt) || '',
    source: ((bank && bank.source) || '') + '（按标签导出：' + want.ids.join('+') + '）',
    stats: Object.assign({}, (bank && bank.stats) || {}),
    entries: {}
  };
  const byTag = {};
  for (const id of want.ids) byTag[id] = 0;
  for (const k of Object.keys(src)) {
    const e = src[k];
    if (!e) continue;
    if (o.type && String(e.type || '') !== String(o.type)) continue;
    const ans = (e.answers || []).filter((a) => a && a.answer);
    const uniq = new Set(ans.map((a) => String(a.answer))).size;
    const srcsAll = new Set();
    for (const a of ans) for (const s of (a.srcs || [])) srcsAll.add(String(s));
    const x = { uniq: uniq, cands: ans, srcCount: srcsAll.size };
    const hit = want.ids.filter((id) => {
      if (id === 'conflict') return x.uniq > 1 || !!(o.includeAgree && ans.length >= 2);
      return tagHit(id, e, x);
    });
    if (!hit.length) continue;
    hit.forEach((id) => { byTag[id] = (byTag[id] || 0) + 1; });
    out.entries[k] = e;
  }
  return { bank: out, count: Object.keys(out.entries).length, byTag: byTag, tags: want.ids, badTags: want.bad };
}

/* ============================ 九、命令行 ============================ */


/* ============================ 九、命令行 ============================ */

async function main(argv) {
  const args = argv.slice(2);
  const takeVal = (name) => {
    const i = args.indexOf(name);
    if (i < 0) return '';
    const v = args[i + 1] || '';
    args.splice(i, 2);
    return v;
  };
  const dry = args.indexOf('--dry') >= 0;
  const scanPage = args.indexOf('--scan-page') >= 0;      /* 读"已完成页面"上的正确答案（只读） */
  const impFile = takeVal('--import');
  const expFile = takeVal('--export');
  const withUnverified = args.indexOf('--with-unverified') >= 0;   /* 连"命不中页面"的抄录条目一起导 */
  const wantCode = args.indexOf('--code') >= 0;                     /* 输出"题库码"（一段文本，控制台粘贴即用） */
  const impCode = takeVal('--import-code');                          /* 把一段题库码并进本地库 */
  const wantDedupe = args.indexOf('--dedupe') >= 0;                  /* 一键去重复 */
  const wantClean = args.indexOf('--clean') >= 0;                    /* 去杂（清非法脏数据） */
  /* 【按标签导出】--export-tags conflict,official ／ --export-tags all
     老写法 --conflicts 仍然能用（= 冲突 那个标签），行为跟以前一模一样。
     还能加 --type 多选 只导某个题型、--with-agree 把"多候选但答案一致"也算作冲突。
     ★ 别用 --export 当开关：它是**"导出题库文件"的取值参数**（--export 文件），
       takeVal 会把它和后面那个词一起吃下去 —— 今天就是这么把 --tags 吃没了，只导出一条。 */
  const exportTagsArg = takeVal('--export-tags');
  const wantConflicts = args.indexOf('--conflicts') >= 0;
  const wantExport = !!exportTagsArg || wantConflicts;
  const tagsArg = exportTagsArg || (wantConflicts ? 'conflict' : '');
  const typeArg = takeVal('--type') || '';
  const pos = args.filter((a) => a[0] !== '-');
  const src = path.resolve(pos[0] || RECORD_FILE);
  const dst = dry ? null : path.resolve(pos[1] || BANK_FILE);
  if (!fs.existsSync(src)) {
    console.error('× 找不到记录文件：' + src);
    process.exit(2);
  }
  const t0 = Date.now();
  const built = buildFromFile(src, null);
  let bank = built.bank;
  const s = bank.stats;

  /* ---- 导入（别人的库）：合并，不覆盖 ---- */
  let impRep = null;
  if (impFile) {
    const p = path.resolve(impFile);
    if (!fs.existsSync(p)) { console.error('× 找不到要导入的题库文件：' + p); process.exit(2); }
    const incoming = parseBank(fs.readFileSync(p, 'utf8'));
    if (!Object.keys(incoming.entries).length) { console.error('× 要导入的文件读不出条目（版本不对？）：' + p); process.exit(2); }
    impRep = mergeBank(bank, incoming, { from: path.basename(p) });
    bank = impRep.bank;
  }

  /* ---- 导入题库码（控制台里粘的那种一段文本）---- */
  let codeRep = null;
  if (impCode) {
    const d = decodeCode(impCode);
    if (!d.ok) { console.error('× 题库码读不出来：' + d.error); process.exit(2); }
    const m = mergeBank(bank, d.bank, { from: '题库码' });
    bank = m.bank;
    codeRep = { read: d.entries, bad: d.bad, noAns: d.noAns, report: m.report };
  }

  /* ---- 已完成页面：读平台写出来的正确答案（只读；连不上就如实报，不假装成功）---- */
  let scanRep = null, scanErr = '';
  if (scanPage) {
    const sc = await scanGradedPage({});
    if (!sc.ok) scanErr = sc.error + (sc.pages ? ('（打开的标签：' + sc.pages.join(' ｜ ') + '）') : '');
    else if (!sc.items.length) scanErr = '那个页面上没有"已公布答案"的题（没交过的页面读不到正确答案）';
    else {
      const g = ingestGraded(bank, sc.items, { from: 'page:' + String(sc.url).replace(/^https?:\/\/[^/]+/, '').slice(0, 60) });
      bank = g.bank;
      scanRep = { url: sc.url, report: g.report, counts: sc.counts };
    }
  }

  /* ---- 导出（脱敏）：给别的机器用。**必须放在最后** —— 导出的要是"最终那份库"，
          导入的东西、已完成页面读到的官方答案都得已经在里面
          （顺序错了导出会少东西，实测踩过：先导后扫，官方答案一条都没带出去）。---- */
  let expStats = null;
  if (expFile) {
    const p = path.resolve(expFile);
    const ex = exportBank(bank, { from: path.basename(src), withUnverified: withUnverified });
    fs.writeFileSync(p, JSON.stringify(ex, null, 1), 'utf8');
    expStats = { path: p, stats: ex.stats };
  }

  let codeTxt = '';
  if (wantCode) codeTxt = encodeCode(bank, { withUnverified: withUnverified });

  /* ---- 去杂（写成文件之前做）---- */
  let cleanRep = null;
  if (wantClean) {
    const before = Object.keys(bank.entries).length;
    const c = cleanBank(bank, {});
    bank = c.bank;
    cleanRep = {
      before: before, after: Object.keys(bank.entries).length,
      r1: c.report.r1.length, r2: c.report.r2.length, r3: c.report.r3.length,
      sample: c.report.r1.concat(c.report.r2, c.report.r3).slice(0, 5)
    };
  }

  /* ---- 去重复（写成文件之前做，写下去的就是去过重的）---- */
  let dedupRep = null;
  if (wantDedupe) {
    const before = Object.keys(bank.entries).length;
    const d = dedupeBank(bank, {});
    bank = d.bank;
    dedupRep = Object.assign({ before: before, after: Object.keys(bank.entries).length }, d.report);
  }

  if (dst) fs.writeFileSync(dst, serializeBank(bank), 'utf8');

  /* 【导出冲突答案】默认写到 学习通-CDP\_导出\冲突答案-<时间戳>\ 下的两个文件：
       冲突答案.csv（Excel 直接打开，带 BOM）与 冲突答案.txt（人读的，一条一段）。 */
  let conflictRep = null;
  if (wantExport) {
    const ex = exportBankByTags(bank, {
      tags: tagsArg || 'conflict',
      includeAgree: args.indexOf('--with-agree') >= 0,
      type: typeArg
    });
    /* 时间戳用**本地时间**（用 toISOString 会写成 UTC，看着差 8 小时，今天已经栽过一次） */
    const now = new Date();
    const p2 = (x) => String(x).padStart(2, '0');
    const stamp = now.getFullYear() + p2(now.getMonth() + 1) + p2(now.getDate()) + '-' + p2(now.getHours()) + p2(now.getMinutes()) + p2(now.getSeconds());
    const tagInName = (ex.tags || []).join('+') || 'export';
    const outDir = takeVal('--out') || path.join(__dirname, '_导出', '题库导出-' + tagInName + '-' + stamp);
    try {
      fs.mkdirSync(outDir, { recursive: true });
      const csvP = path.join(outDir, '题库导出.csv');
      const txtP = path.join(outDir, '题库导出.txt');
      fs.writeFileSync(csvP, ex.csv, 'utf8');
      fs.writeFileSync(txtP, ex.text, 'utf8');
      conflictRep = { count: ex.count, dir: outDir, csv: csvP, txt: txtP, byTag: ex.byTag, tags: ex.tags, badTags: ex.badTags };
    } catch (e) {
      conflictRep = { count: ex.count, error: (e && e.message) || String(e) };
    }
  }

  const m = s.marks;
  console.log('题库 · ' + (dry ? '（--dry：只算不写）' : (expFile ? '建库 + 导出' : '建库')));
  console.log('--------------------------------------------------------------------------------');
  console.log('记录文件 : ' + src);
  console.log('  章节块 ' + s.chapters + ' 个｜解析出题目 ' + s.parsed + ' 道' +
    '（新格式 ' + s.parsedDom + ' / 旧格式 ' + s.parsedTranscribe + '）');
  console.log('  被排除 : 乱码块 ' + s.excluded.garbage + ' 道' +
    '｜无题干 ' + s.excluded.noStem + '｜无答案 ' + s.excluded.noAnswer +
    '｜答案不可用 ' + s.excluded.badAnswer + '｜无选题目 ' + s.excluded.noOptions);
  console.log('指纹     : 唯一指纹 ' + s.fingerprints + ' 个（带别名键 ' + s.aliasKeys + ' 个）');
  console.log('  有答案 ' + s.withAnswer + ' 条｜aria-checked 确认过 ' + s.pickedConfirmed + ' 条' +
    '｜同指纹合并 ' + s.mergedSameFp + ' 次｜答案冲突 ' + s.conflicts + ' 条');
  console.log('金标准   : 记录里 ' + m.total + ' 处「（指纹 xxxxxxxx）」标记 —— 库内命中 ' + m.inBank +
    '，同章命中 ' + m.sameChapter);
  const cc = dry ? null : crossCheckCache(bank, path.join(path.dirname(src), ANSWER_CACHE_FILE));
  if (cc) console.log('第二道自检: 答题答案缓存.json 的 ' + cc.total + ' 个运行时指纹 —— 命中 ' + cc.hit + ' 个');
  if (m.inBank < m.total) {
    console.log('  ✗ 有 ' + (m.total - m.inBank) + ' 处标记在库里找不到 —— 指纹形态可能错了');
    m.missSample.forEach((x) => console.log('      ' + x.fp8 + '  章=' + x.chapter + '  库内=' + x.inBank + ' 同章=' + x.sameChapter));
  } else {
    console.log('  ✓ ' + m.total + '/' + m.total + ' 全部命中 —— 指纹形态与运行时一致');
  }
  if (impRep) {
    const r = impRep.report;
    console.log('导入     : ' + path.basename(path.resolve(impFile)) +
      ' → 新增 ' + r.added + ' 条｜合并 ' + r.merged + ' 条｜**答案冲突** ' + r.conflicted +
      ' 条（两份都留着）｜没答案跳过 ' + r.skippedNoAnswer + ' 条');
  }
  if (codeRep) {
    const r = codeRep.report;
    console.log('导入题库码: 码里 ' + codeRep.read + ' 条（坏 ' + codeRep.bad + ' / 没答案 ' + codeRep.noAns + '）' +
      ' → 新增 ' + r.added + ' 条｜合并 ' + r.merged + ' 条｜**答案冲突** ' + r.conflicted + ' 条（两份都留着）');
  }
  if (expStats) {
    const st = expStats.stats;
    console.log('导出     : ' + expStats.path + '（' + st.entries + ' 条，已脱敏：不含课程名/章节/时间）');
    console.log('           只导"能命中页面"的条目 —— 跳过的：抄录来源（命不中）' + st.skippedUnverified +
      ' 条｜没答案 ' + st.skippedNoAnswer + ' 条；其中带图片的 ' + st.withImages + ' 条' +
      (withUnverified ? '（本次带了 --with-unverified：抄录条目也在里面）' : '（想连抄录的一起导：--with-unverified）'));
  }
  if (scanPage) {
    if (scanRep) {
      const r = scanRep.report;
      console.log('已完成页面: ' + String(scanRep.url).slice(0, 70));
      console.log('           读到 ' + r.read + ' 道题的官方答案 → 挂上 ' + r.attached +
        ' 条（按题干精确对上 ' + r.byExact + '｜按"去掉题号"对上 ' + r.byAlias + '；' +
        '其中和草稿一致的 ' + r.alreadySame + '，**和草稿不同的 ' + r.conflicted + '**）' +
        '｜库里没有的 ' + r.unmatched + ' 条（已存进 gradedUnmatched）' +
        '｜图片对不上的 ' + r.imgMismatch + ' 条（不挂，怕挂错）' +
        '｜撞多道题不敢猜的 ' + r.ambiguous + '｜读数不对的 ' + r.badItem);
    } else {
      console.log('已完成页面: ✗ 没读到 —— ' + scanErr);
      console.log('           （这一步是只读的；要浏览器开着、并停在"交过的测验"页面上）');
    }
  }
  console.log('--------------------------------------------------------------------------------');
  if (conflictRep) {
    if (conflictRep.error) {
      console.log('导出     : 有 ' + conflictRep.count + ' 条，但写文件失败（' + conflictRep.error + '）');
    } else {
      console.log('导出     : ' + conflictRep.count + ' 条 → ' + conflictRep.dir);
      console.log('           标签：' + (conflictRep.tags || []).map((id) => (TAG_NAME[id] || id) + '(' + ((conflictRep.byTag || {})[id] || 0) + ')').join('、') +
        (typeArg ? ('　题型限：' + typeArg) : ''));
      if ((conflictRep.badTags || []).length) console.log('           （不认识的标签已忽略：' + conflictRep.badTags.join('、') + '）');
      console.log('           题库导出.csv（Excel 直接开）｜题库导出.txt（人读的）');
    }
  }
  if (cleanRep) {
    console.log('去杂     : ' + cleanRep.before + ' 条 → ' + cleanRep.after + ' 条（删掉 ' +
      (cleanRep.r1 + cleanRep.r2 + cleanRep.r3) + ' 条：测试数据 ' + cleanRep.r1 + '｜空壳 ' + cleanRep.r2 +
      '｜认不出 ' + cleanRep.r3 + '）');
  }
  if (dedupRep) {
    console.log('去重复   : ' + dedupRep.before + ' 条 → ' + dedupRep.after + ' 条（并掉 ' + dedupRep.merged +
      ' 条｜涉及 ' + dedupRep.groups + ' 组同题异号｜保留的旧键 ' + dedupRep.aliasesKept + ' 个｜并回的答案 ' + dedupRep.answersKept + ' 条' +
      (dedupRep.splitByImage ? ('｜**因为图不同而没并** ' + dedupRep.splitByImage + ' 组') : '') + '）');
  }
  console.log(dst ? ('已写入 : ' + dst) : '（--dry，没有写文件）');
  if (wantCode) {
    console.log('');
    console.log('题库码（' + codeTxt.length + ' 字符）：粘进网页控制台的「题库」那一栏即可用');
    console.log('----------------------------------------------------------------');
    console.log(codeTxt);
    console.log('----------------------------------------------------------------');
  }
  console.log('用时 : ' + ((Date.now() - t0) / 1000).toFixed(2) + ' 秒');
  return bank;
}

module.exports = {
  BANK_FILE, BANK_VERSION, RECORD_FILE, ANSWER_CACHE_FILE,
  TYPE_MAP, normalizeAnswer, normalizeLetter, cleanAnswerValue, aliasStem, orderFreeFp,
  parseRecord, buildBank, makeEntryBuilder, verifyMarks, dedupeBank, backupBank, cleanBank, isJunkQuestion,
  exportConflicts, exportBankByTags, bankFromTags, rebuildDerived, normalizeJudgmentAnswer, normalizeBankJudgments, TAGS, TAG_NAME, parseTags, listTags,
  SUB_DIR, subDirOf, listBanks, findBank, loadBank,
  libNameOf, splitByCourse, buildSplitFromFile,
  serializeBank, parseBank, buildFromFile, crossCheckCache,
  /* 导出 / 导入 / 查库（答题链路用 parseBank + lookup） */
  exportBank, mergeBank, lookup, trustOf, TRUST_LABEL,
  /* 已完成页面：读平台写出来的正确答案（stemKey 是"题干桥"，只做对应，不当主键） */
  stemKeyOf, stemIndexOf, typeFromStem, ingestGraded, scanGradedPage,
  CODE_PREFIX, keysOnlyEntries, encodeCode, decodeCode,
  main
};

if (require.main === module) {
  Promise.resolve(main(process.argv)).catch((e) => {
    console.error('× 出错了：' + ((e && e.stack) || e));
    process.exit(1);
  });
}
