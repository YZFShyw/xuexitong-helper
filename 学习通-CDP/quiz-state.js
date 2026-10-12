/* quiz-state.js —— 答题助手里"能离线验证的那部分"单独放这里
 *
 * 为什么单开一个文件：
 *   答题助手.js 里几个最容易出错的判断（"到底算不算保存成功"、"这个按钮能不能点"、
 *   "这道题是不是跟前面那道重复"）原来都埋在几十行的页面脚本字符串里，
 *   改一个字就可能把别的东西弄坏，而且**没法离线测**。
 *   这里把它们抽成纯函数：不碰浏览器、不碰网络、不读配置，
 *   只做"给一堆事实 → 给一个结论"。
 *
 * 这个文件的存在不改变任何对外行为：
 *   答题助手.js 照旧导出它原来那一整套；本文件只是它的内部零件。
 *
 * 三条不能破的底线（写在最上面，改代码前先读一遍）：
 *   1. 保存的"成功"只能由**平台的保存成功提示**作证。
 *      按钮文字变化只说明"点击被页面接收了"，绝不能当成功。
 *   2. 任何沾「提交 / 交卷 / submit」的按钮或函数一律拒绝，
 *      且**不因为名字里有 noSubmit 就放行** —— 要先确认它确实没有提交行为。
 *   3. 答案缓存里只有答案，没有凭据，也不代表"页面已经填好"或"平台已完成"。
 */

'use strict';

/* ============================================================================
 * 一、保存结果的状态机
 *
 * 五个状态，各自对应"能不能往下走"：
 *   SAVED      已确认保存   —— 页面上真的出现了平台的保存成功提示
 *   SAVING     保存中       —— 点击已发出 / 按钮变成"正在暂存"，还没结果
 *   UNCONFIRMED 未确认      —— 点下去了，但没看到任何成功证据（**不能当成功**）
 *   REJECTED   已拒绝       —— 页面上只有提交类按钮，安全闸门挡下，一个都没点
 *   FAILED     失败         —— 连按钮都没找到 / 页面直接抛错
 * ==========================================================================*/

const SAVE = {
  SAVED: 'saved',
  SAVING: 'saving',
  UNCONFIRMED: 'unconfirmed',
  REJECTED: 'rejected',
  FAILED: 'failed'
};

const SAVE_STATUS_NAME = {
  saved: '已确认保存',
  saving: '保存中',
  unconfirmed: '未确认保存',
  rejected: '已拒绝（只找到提交类按钮）',
  failed: '失败'
};

/* 哪些状态**不是成功**。写成一个函数而不是用 !=='saved' 硬编码，
   是为了以后加状态时不会漏。 */
function isSaveConfirmed(status) { return status === SAVE.SAVED; }

/* 【这一题能不能算"存好了"】只有已确认保存才算。
   保存中/未确认都算"待确认" —— 上层要把它们报成"待人工确认"，不是"填上了"。 */
function needsSaveConfirmation(status) {
  return status === SAVE.SAVING || status === SAVE.UNCONFIRMED;
}

/* 【能不能自动往下做会丢草稿的动作】
   除"已确认保存"以外的**一切**状态都不能自动继续。理由（这一条以前写反了）：
     · 保存中 / 未确认：平台没证实存上了，草稿可能就在页面里，翻页就没了 —— 这个原来就对。
     · 已拒绝（只找到提交类按钮）：以前写的是"本来就没写过页面，继续不会更糟"——**这是错的**。
       saveDraftResult 是在**答案已经填进页面之后**才调的；按钮被安全闸门拒绝，
       只说明"没点成保存"，跟"页面里有没有草稿"是两件事。填进去的答案还在页面上。
     · 失败（没找到按钮 / 页面抛错）：同理，填过的答案还在，翻页一样会丢。
     · 未知状态（空串 / 新加的状态忘了登记）：更不许当成成功放行 —— 保守当"没确认"。
   所以现在的判据只有一条：**不是 confirmed saved，就拦。**
   注意：这不等于"拒绝/失败算保存成功"—— isSaveConfirmed 依旧是 false，
   上层该报"待人工确认"就报，只是不许自动离开当前题页。 */
function blocksAutoContinue(status) {
  return !isSaveConfirmed(status);
}

/* 把结构化结果拼成给人看的一句话。旧调用方要的就是这一句。 */
function formatSaveOutcome(r) {
  if (!r || typeof r !== 'object') return String((r && r.message) || '');
  const head = r.message ? String(r.message) : (SAVE_STATUS_NAME[r.status] || String(r.status || '?'));
  const ev = (r.evidence && r.evidence.detail) ? String(r.evidence.detail) : '';
  let s = head;
  if (ev && head.indexOf(ev) < 0) s += '，' + ev;
  if (!/[。！]$/.test(s)) s += '。';
  /* 【口径：填进页面 ≠ 平台存上了】
     只有"已确认保存"才说得出"这是暂存草稿"这句话；
     未确认 / 保存中 / 被拒绝 / 失败，答案都可能还在页面上（填和存是两件事），
     所以一律提示"回页面自己看一眼"，绝不说成"保存成功"。 */
  if (r.status === SAVE.SAVED) s += '（这是暂存草稿，不是提交）';
  else s += '（**没能确认平台存上了** —— 答案可能已经填在页面上，请自己看一眼草稿在不在，别直接离开）';
  return s;
}

/* 构造一个保存结果。结构化字段给"记账"用，msg 给旧调用方用。 */
function makeSaveResult(status, message, extra) {
  const r = Object.assign({
    status: status,
    ok: isSaveConfirmed(status),
    confirmed: isSaveConfirmed(status),
    needConfirm: needsSaveConfirmation(status),
    blocksContinue: blocksAutoContinue(status),
    message: message || '',
    reason: 'unknown',
    evidence: null
  }, extra || {});
  r.msg = formatSaveOutcome(r);
  return r;
}

/* ============================================================================
 * 二、"这个按钮/这段 onclick 是不是提交"
 *
 * 【为什么要单独抽出来，而且这么啰嗦】
 *   平台的"暂时保存"按钮长这样：
 *       <a class="btnSave workBtnIndex" onclick="noSubmit();">暂时保存</a>
 *   名字里就带 submit。原来那句判断是先把 noSubmit 这个词整个剥掉再找 submit ——
 *   能用，但语义全押在"平台不会把别的提交函数也起名叫 noSubmit"上。
 *   更麻烦的是**兜底直调那条路**：找不到按钮时直接调 window.noSubmit()，
 *   完全不过这套判断，等于给自己开了个后门。
 *   现在改成：先白名单允许 noSubmit / saveWork 这两个名字，
 *   再**按源码内容**确认它没有提交行为（见 inspectDirectSaveSource）。
 *   证不实就不给成功证据，宁可报"待人工保存"。
 * ==========================================================================*/

/* class / onclick 里出现这些，直接判提交 */
const SUBMIT_MARK = /btnSubmit|btnBlueSubmit|submitValidate|submitWork|\bsubmit\b/i;

/* 平台保存函数的白名单。只有这两个名字享受"按源码复核"的待遇，别的一个都不给。 */
const SAVE_FN_ALLOW = ['noSubmit', 'saveWork'];

/* 按钮文字：出现这些一律拒绝 */
const TEXT_SUBMIT = /提交|交卷/;
/* 按钮文字：这些是"保存"的正名 */
const TEXT_SAVE = /^(暂时保存|保存|暂存|保存草稿|保存答案)$/;

/* 按钮文字：这些只说明"点击被接收了、正在写"，**不是成功证据** */
const TEXT_SAVING = /保存中|正在保存|暂存中|正在暂存|提交中|处理中|请稍候|载入中|loading/i;

/* 平台的保存成功提示。只有它出现在页面上，才允许报"已确认保存"。 */
const TOAST_SAVED = /保存成功|保存已成功|已保存|暂存成功|保存成/;

/* 平台的保存失败提示（有它就直接算失败，不用再等） */
const TOAST_FAILED = /保存失败|暂存失败|保存出错|提交失败|保存不了/;

/* 判一个按钮元素要拒绝还是要：
   返回 { action: 'reject'|'accept'|'skip', why } */
function classifySaveButton(f) {
  const info = f || {};
  const text = String(info.text || '').replace(/\s+/g, '');
  const oc = String(info.onclick || '');
  const cls = String(info.className || '');
  const id = String(info.id || '');

  if (TEXT_SUBMIT.test(text)) return { action: 'reject', why: '按钮文字沾「提交/交卷」：' + text };
  if (SUBMIT_MARK.test(cls + ' ' + id + ' ' + oc)) {
    return { action: 'reject', why: 'class/id/onclick 里出现提交标记：' + (cls + ' ' + oc).slice(0, 80) };
  }
  /* 名字里带 submit 但不是白名单里的 saveWork 调用 —— 一律不碰。
     这里刻意**不**把 noSubmit 剥掉再看：白名单已经单独给了 noSubmit，
     剥掉再查等于自己把闸门拆了（审查里点的就是这个）。 */
  if (/\bsubmit\b/i.test(oc) && !/noSubmit/i.test(oc) && !/saveWork/i.test(oc)) {
    return { action: 'reject', why: 'onclick 里有 submit 调用：' + oc.slice(0, 80) };
  }
  if (TEXT_SAVE.test(text)) return { action: 'accept', why: '按钮文字是保存：' + text };
  if (/btnSave/i.test(cls)) return { action: 'accept', why: 'class 是 btnSave' };
  if (/noSubmit/i.test(oc)) return { action: 'accept', why: 'onclick 是 noSubmit（平台自称不提交）' };
  if (/saveWork/i.test(oc)) return { action: 'accept', why: 'onclick 是 saveWork' };
  return { action: 'skip', why: '既不像保存也不像提交，不碰' };
}

/* ============================================================================
 * 三、兜底直调页面函数之前的"只读复核"
 *
 * 兜底（找不到按钮时直接调 window 上的函数）是全文件唯一能造成不可逆后果的动作，
 * 所以它的证据要求跟主路径一样严：
 *   · 函数名必须精确等于白名单里的名字（noSubmit / saveWork），
 *     是别的名字——哪怕内容一样——也不给成功证据；
 *   · 函数**源码**里不能出现提交行为；
 *   · 调用要能拿到"它确实跑了"的痕迹（返回值 / 没抛错），抛错要如实记下来。
 * ==========================================================================*/

/* 源码里出现这些 = 有提交行为。宁可放过一个安全函数，也不能误调一个提交。 */
const FN_SOURCE_SUBMIT = [
  /submitValidate/i, /btnBlueSubmit/i, /\.submit\s*\(/i, /form\.submit/i,
  /requestSubmit/i, /submitWork/i, /交卷/, /提交/
];

/* 判一个页面函数能不能直调。
   传 { name, source, allowed }；allowed 省略时按内置白名单。
   任何一项证不实 → verdict='unknown'，调用方必须报"待人工保存"。 */
function inspectDirectSaveSource(f) {
  const name = String((f && f.name) || '');
  const source = (f && f.source != null) ? String(f.source) : null;
  const allowed = (f && f.allowed) || SAVE_FN_ALLOW;
  if (!name) return { verdict: 'unknown', why: '函数没有名字，证不实语义' };
  if (!allowed.includes(name)) {
    return { verdict: 'unknown', why: '函数名「' + name + '」不在保存白名单（' + allowed.join('/') + '）里，证不实它不是提交' };
  }
  if (source === null) {
    return { verdict: 'unknown', why: name + ' 的源码读不到（可能是页面禁用了 toString），证不实它没有提交行为' };
  }
  for (const re of FN_SOURCE_SUBMIT) {
    if (re.test(source)) {
      return { verdict: 'submit-risk', why: name + ' 的源码里有提交行为（' + re + '），拒绝直调' };
    }
  }
  return { verdict: 'ok', why: name + ' 是白名单里的保存函数，且源码里没有提交行为' };
}

/* ============================================================================
 * 四、保存成功/失败提示的判定
 *
 * 【为什么要排掉页面上一轮遗留的那句话】
 *   "保存成功"这种提示条一般不会自己消失。上次点保存留下的那行字，
 *   会把这一次的"没存上"直接判成"存上了" —— 这是最坏的一类误报：
 *   用户据此离开页面，草稿其实是空的。
 *   做法：点保存**之前**先扫一遍页面文字，把当时就已经存在的提示记成基线；
 *   之后只认"新出现的"那句。基线里的内容一律不算证据。
 * ==========================================================================*/

function findToast(text) {
  const t = String(text == null ? '' : text);
  if (TOAST_FAILED.test(t)) return { kind: 'failed', hit: (t.match(TOAST_FAILED) || [''])[0] };
  if (TOAST_SAVED.test(t)) return { kind: 'saved', hit: (t.match(TOAST_SAVED) || [''])[0] };
  return { kind: 'none', hit: '' };
}

/* 基线：点保存之前页面上**已经**有的提示词。
   存成字符串数组，判定时只要还是同一批就算没过期。 */
function toastBaseline(text) {
  const t = String(text == null ? '' : text);
  const out = [];
  let m;
  const re = new RegExp(TOAST_SAVED.source + '|' + TOAST_FAILED.source, 'g');
  while ((m = re.exec(t)) !== null) {
    if (out.indexOf(m[0]) < 0) out.push(m[0]);
    if (m.index === re.lastIndex) re.lastIndex++;      /* 防零宽匹配死循环 */
  }
  return out;
}

/* 这次扫描到的提示里，有没有**基线里没有**的新东西？
   nowText = 现在页面全文；base = toastBaseline() 的结果。
   还要传 clickedAt = 点击发生的时刻，用来把"老提示"再挡一道：
   只有点击之后才出现的提示才算证据（由调用方在轮询里体现，这里只做文字比对）。 */
function classifyToastNow(nowText, base) {
  const now = toastBaseline(nowText);
  const old = Array.isArray(base) ? base : [];
  const fresh = now.filter((h) => old.indexOf(h) < 0);
  const t = String(nowText == null ? '' : nowText);
  if (fresh.length && TOAST_FAILED.test(fresh.join(' '))) {
    return { kind: 'failed', hit: fresh.filter((h) => TOAST_FAILED.test(h)).join('/') };
  }
  if (fresh.length && TOAST_SAVED.test(fresh.join(' '))) {
    return { kind: 'saved', hit: fresh.filter((h) => TOAST_SAVED.test(h)).join('/') };
  }
  if (TOAST_FAILED.test(t) && !fresh.length) {
    return { kind: 'none', hit: '', stale: (t.match(TOAST_FAILED) || [''])[0] };
  }
  if (TOAST_SAVED.test(t) && !fresh.length) {
    return { kind: 'none', hit: '', stale: (t.match(TOAST_SAVED) || [''])[0] };
  }
  return { kind: 'none', hit: '' };
}

/* 按钮文字能提供的唯一结论：它是不是"正在保存"。
   【这一条是审查里最关键的一处】原来"按钮文字变了"就算保存成功的证据；
   而慢网络下按钮恰恰是从「暂时保存」变成「保存中…」——
   于是"没存上"被写成了"存上了"。现在按钮文字只用来决定要不要继续等，
   永远不结案。 */
function classifyButtonText(text) {
  const t = String(text == null ? '' : String(text)).replace(/\s+/g, '');
  if (TEXT_SAVING.test(t)) return 'saving';
  if (TEXT_SAVE.test(t)) return 'idle';
  if (!t) return 'gone';
  return 'other';
}

/* ============================================================================
 * 五、题目指纹 —— 去重和缓存都用它
 *
 * 【原来那条指纹为什么不能用】
 *   `(q.stem || '').slice(0, 80) + '|' + q.options.length`
 *   三个毛病：
 *     1) 只取前 80 字。学习通的题干开头高度模板化（"下列说法正确的是"…），
 *        同一页两道题很容易前 80 字一模一样、选项数也一样 → 第二道被静默跳过；
 *     2) 用的是**解码前**的替身字，字体一换，同一个逻辑题的指纹就变了，去重形同虚设；
 *     3) 选项内容完全没进指纹，选项不同、题干开头相同就被当成同一道。
 *   现在改成：解码后的**完整题干** + **全部选项的字母与正文** + **题型**，
 *   归一化（去空白、统一标点、统一大小写）之后取 sha256 短哈希。
 *
 * 注意：算指纹要先用字体的解码表把替身字换回真字。
 * 解码函数由调用方注入（decoder），方便离线测试；缺省就是原样返回。
 * ==========================================================================*/

/* 归一化：去掉所有空白、把各种花式标点压成统一形式、全角转半角、英文转小写。
   目的只有一个 —— 让"同一道题的两种写法"落到同一个指纹上，
   同时**不**让"两道不同的题"撞到一起。 */
function normalizeForFp(s) {
  let t = String(s == null ? '' : s);
  /* 全角字符（！到～）转半角 */
  t = t.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  t = t.replace(/\u3000/g, ' ');
  /* 各种引号、括号、破折号统一 */
  t = t.replace(/[\u2018\u2019\u201C\u201D\u300C\u300D\u300E\u300F]/g, '"');
  t = t.replace(/[\u2014\u2013\u2212\uFF0D]/g, '-');
  t = t.replace(/[·・]/g, '.');
  /* 空白一律去掉（题干里的换行、空格在页面渲染里本来就不稳定） */
  t = t.replace(/\s+/g, '');
  return t.toLowerCase();
}

function makeFingerprinter(opts) {
  const o = opts || {};
  const decode = typeof o.decode === 'function' ? o.decode : (x) => x;
  const hash = typeof o.hash === 'function'
    ? o.hash
    : (s) => require('crypto').createHash('sha256').update(String(s), 'utf8').digest('hex');
  /* 短哈希多长：sha256 十六进制的前 N 位。32 位十六进制 = 128 bit，
     就算几万道题也不会撞；比这更长的对"去重/查缓存"没有任何帮助。 */
  const hexLen = Math.max(8, Math.min(64, Number(o.length) || 32));

  const fpOf = (q) => {
    const qq = q || {};
    const stem = normalizeForFp(decode(String(qq.stem == null ? '' : qq.stem)));
    const opts2 = Array.isArray(qq.options) ? qq.options : [];
    const optText = opts2.map((op) => {
      const letter = String((op && op.letter) || '').toUpperCase();
      return letter + ':' + normalizeForFp(decode(String((op && op.text) == null ? '' : op.text)));
    });
    /* 题型也要进指纹：同一个题干在"单选"和"多选"下答案是两回事 */
    const type = normalizeForFp(String(qq.type == null ? '' : qq.type));
    const payload = 'v2\n' + type + '\n' + stem + '\n' + optText.join('\n');
    return hash(payload).slice(0, hexLen);
  };

  /* 顺手给出一份"人能核对"的摘要，日志里跳过时带上它才有得查 */
  const digestOf = (q) => {
    const qq = q || {};
    const stem = String(decode(String(qq.stem == null ? '' : qq.stem)) || '').replace(/\s+/g, ' ').trim();
    const n = Array.isArray(qq.options) ? qq.options.length : 0;
    return String(qq.type || '?') + '｜' + stem.slice(0, 60) + (stem.length > 60 ? '…' : '') + '｜选项' + n + '个';
  };

  return { fpOf, digestOf, normalizeForFp };
}

/* ============================================================================
 * 六、模型答案缓存
 *
 * 【它是什么】按"题面指纹"存模型给出的答案，重跑时能省一次 API 调用。
 * 【它不是什么 —— 这几句是契约，别在别处曲解】
 *   · 不代表页面已经填好；
 *   · 不代表平台那边已经保存或完成；
 *   · 里面只有答案和指纹，**没有任何凭据**（不放 key、不放 cookie、不放页面内容）；
 *   · 复制到测试夹具时只能用虚构数据。
 *
 * 命中条件（四条全中才算命中，缺一条就重新问模型）：
 *   1. 缓存版本号一致（结构变了老缓存自动作废）
 *   2. 题型一致
 *   3. 题面指纹一致
 *   4. **模型配置一致** —— 用户换了模型/看图模型，老答案就不再算数
 * 另外还看 5. 设置里"答案缓存"开关是开的（调用方判断）。
 * ==========================================================================*/

const ANSWER_CACHE_FILE = '答题答案缓存.json';
const ANSWER_CACHE_VERSION = 2;
const ANSWER_CACHE_MAX = 800;          /* 只留最近这么多条，防止文件无限长 */

/* 模型配置的"签名"：换了任何一个都让缓存失效。
   注意这里**只**放模型名，不放 key —— key 换个新的不该让答案作废，
   而且它绝不能被写进这个文件。 */
function modelSignature(cfg) {
  const c = cfg || {};
  return String(c.model || '') + '|' + String(c.visionModel || '');
}

function emptyAnswerCache() {
  return { version: ANSWER_CACHE_VERSION, entries: {} };
}

/* 把磁盘上的那份读成缓存对象。读坏了一律当成空缓存（**不当成命中**）。 */
function parseAnswerCache(raw) {
  const empty = emptyAnswerCache();
  const txt = String(raw == null ? '' : raw).replace(/^\uFEFF/, '').trim();
  if (!txt) return empty;
  let j;
  try { j = JSON.parse(txt); } catch (e) { return empty; }
  if (!j || typeof j !== 'object' || j.version !== ANSWER_CACHE_VERSION) return empty;
  const ent = (j.entries && typeof j.entries === 'object') ? j.entries : {};
  const out = {};
  for (const k of Object.keys(ent)) {
    const e = ent[k];
    if (!e || typeof e !== 'object') continue;
    if (typeof e.answer !== 'string' || !e.answer.trim()) continue;
    if (e.fp !== k) continue;                        /* 键和指纹必须对得上 */
    out[k] = {
      fp: e.fp,
      type: String(e.type || ''),
      answer: String(e.answer),
      reason: String(e.reason || '').slice(0, 400),
      model: String(e.model || ''),
      visionModel: String(e.visionModel || ''),
      at: String(e.at || '')
    };
  }
  return { version: ANSWER_CACHE_VERSION, entries: out };
}

function cacheGet(cache, fp, type, cfg) {
  if (!cache || !fp) return null;
  const e = cache.entries ? cache.entries[fp] : null;
  if (!e) return null;
  if (String(e.type || '') !== String(type || '')) return null;
  if (e.model !== modelSignature(cfg)) return null;
  return e;
}

function cachePut(cache, fp, type, answer, reason, cfg) {
  const c = (cache && cache.entries) ? cache : emptyAnswerCache();
  if (!fp) return c;
  c.entries[fp] = {
    fp: fp,
    type: String(type || ''),
    answer: String(answer == null ? '' : answer),
    reason: String(reason || '').slice(0, 400),
    model: modelSignature(cfg),
    visionModel: String((cfg && cfg.visionModel) || ''),
    at: new Date().toLocaleString('zh-CN')
  };
  /* 超上限就按写入时间砍掉最老的。at 是本地时间字符串，直接按字符串排序即可。 */
  const keys = Object.keys(c.entries);
  if (keys.length > ANSWER_CACHE_MAX) {
    keys.sort((a, b) => String(c.entries[a].at).localeCompare(String(c.entries[b].at)));
    for (const k of keys.slice(0, keys.length - ANSWER_CACHE_MAX)) delete c.entries[k];
  }
  return c;
}

function serializeAnswerCache(cache) {
  const c = (cache && cache.entries) ? cache : emptyAnswerCache();
  return JSON.stringify({ version: ANSWER_CACHE_VERSION, entries: c.entries }, null, 2);
}

/* ============================================================================
 * 七、API 用量汇总
 *
 * 【为什么要汇总】抄录（看图）那一步原来连 usage 都不返回，
 * 一章花掉多少 token 在日志里完全看不见。这里把每一步的 usage 加起来，
 * 由 handle 在章末打一行。
 * 只报**实测数字**：不猜单价、不算钱 —— 定价会变，猜出来的"费用"只会误导人。
 * ==========================================================================*/

function emptyUsage() {
  return { calls: 0, prompt: 0, completion: 0, total: 0, withUsage: 0 };
}

function addUsage(acc, usage) {
  const a = acc || emptyUsage();
  a.calls = (a.calls || 0) + 1;
  const u = usage && typeof usage === 'object' ? usage : null;
  if (!u) return a;                       /* 有的响应不带 usage —— 只记"这次没有" */
  a.withUsage = (a.withUsage || 0) + 1;
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);
  a.prompt += num(u.prompt_tokens);
  a.completion += num(u.completion_tokens);
  a.total += num(u.total_tokens);
  return a;
}

function formatUsage(acc) {
  const a = acc || emptyUsage();
  if (!a.calls) return '本章没有调用模型。';
  if (!a.withUsage) return '本章调用模型 ' + a.calls + ' 次（接口没返回 usage，用量未知）。';
  return '本章模型用量：调用 ' + a.calls + ' 次，prompt ' + a.prompt +
    ' + completion ' + a.completion + ' = 合计 ' + a.total + ' token' +
    (a.withUsage < a.calls ? ('（其中 ' + (a.calls - a.withUsage) + ' 次接口没给 usage）') : '');
}

module.exports = {
  SAVE, SAVE_STATUS_NAME,
  isSaveConfirmed, needsSaveConfirmation, blocksAutoContinue,
  formatSaveOutcome, makeSaveResult,

  SUBMIT_MARK, SAVE_FN_ALLOW, TEXT_SUBMIT, TEXT_SAVE, TEXT_SAVING,
  TOAST_SAVED, TOAST_FAILED, FN_SOURCE_SUBMIT,
  classifySaveButton, inspectDirectSaveSource,
  findToast, toastBaseline, classifyToastNow, classifyButtonText,

  normalizeForFp, makeFingerprinter,

  ANSWER_CACHE_FILE, ANSWER_CACHE_VERSION, ANSWER_CACHE_MAX,
  modelSignature, emptyAnswerCache, parseAnswerCache, cacheGet, cachePut, serializeAnswerCache,

  emptyUsage, addUsage, formatUsage
};
