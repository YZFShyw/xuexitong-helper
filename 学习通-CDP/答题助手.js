/* 答题助手 —— 给 driver.js 用的模块
 *
 * 做三件事：
 *   1. 从页面上认出"这里有测验"并把题干选项抠出来
 *   2. （可选）把题目发给 DeepSeek，拿回答案和理由
 *   3. 把结果写进 章节测验记录.txt，同时打印到日志
 *
 * 不做的事：不往页面上填任何东西，不点提交。这两步留空。
 *
 * 配置存在 答题设置.json，用 控制台.cmd → 4 → 4 改，或者直接编辑那个文件。
 *   {
 *     "mode": 0,              0=关 1=只提示 2=提示+问AI
 *     "apiKey": "",
 *     "model": "deepseek-chat",
 *     "maxPerChapter": 30     每章最多问多少题（防止一页几十题把额度烧完）
 *   }
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
/* 那些"给一堆事实 → 给一个结论"的纯判断放在 quiz-state.js 里：
   保存结果的状态机、按钮判定、题目指纹、模型答案缓存、用量汇总。
   抽出去的原因很实在 —— 它们原来埋在这一坨页面脚本字符串里，既改不动也测不了。 */
const QS = require('./quiz-state.js');
/* 本地题库：从「章节测验记录.txt」建出来的"指纹 → 题干 + 选项 + 答案"。
   纯数据 + 只读；没有 题库.json 时，下面所有相关分支都不生效（验收标准之一）。 */
const QB = require('./题库.js');
/* 字体识别：平台的替身字体是**每份卷子现生成**的（码位随机、sha 每次都变），
   老对照表只覆盖它诞生的那一支。这个模块负责在运行时"逐字认字形"（本地渲染 + 比对，不花 AI），
   按字体 sha 缓存成 对照表-<sha前8>.json —— 认不准就不解码（走截图），绝不猜。 */
const FI = require('./字体识别.js');
/* 图片指纹：题干里的插图/公式图 —— **不看内容，只看像素**（去边 → 16×16 灰度 → 短 id）。
   现在只"顺手攒"：算出来的 id 写进记录单独一行，供以后把"图片身份"并进匹配键（v3）。
   攒的时候顺手查表（URL 缓存），同一张图第二次遇到不再下载解码。 */
const IMGFP = require('./图片指纹.js');

/* 配置文件在哪。用 let 而不是 const：离线测试要把它指到临时目录，
   绝不能碰到工作区里那份真配置（里面有 key）。 */
let CFG_FILE = path.join(__dirname, '答题设置.json');/* 章节测验记录（运行期产物）。同样是 let：离线测试要把它指到临时目录，
   **绝不能让测试往工作区那份真记录里追加内容**（那是用户的数据）。
   生产路径没人改它，行为一个字没变。 */
let OUT_FILE = path.join(__dirname, '章节测验记录.txt');
/* 模型答案缓存：按题面指纹存"模型给过的答案"，重跑时省一次 API 调用。
   **只有答案**，没有任何凭据；也不代表页面已填好、平台已完成。
   位置可以改（测试指到临时目录），所以用 let 而不是 const。 */
/* 答案缓存文件。**默认就在程序目录**；只允许**读**一个环境变量来改默认值 ——
   那是给离线测试用的（让测试子进程把默认路径指到临时文件，这样万一哪条路径
   绕过测试自己的隔离，也不会碰到用户的真实文件）。产品绝不写这个变量。 */
let ANSWER_CACHE_FILE = (process.env.DSH_ANSWER_CACHE_FILE && String(process.env.DSH_ANSWER_CACHE_FILE).trim())
  || path.join(__dirname, QS.ANSWER_CACHE_FILE);
/* 本地题库文件（用户数据，**不进分发包**）。同样是 let：离线测试要把它指到临时目录，
   绝不能拿工作区那份真库去跑测试。生产路径没人改它。 */
let BANK_FILE = path.join(__dirname, QB.BANK_FILE);
const API_URL = 'https://api.deepseek.com/chat/completions';

/* 【API 网关地址做成可配置的，默认还是 DeepSeek】2026-10-12 法师要求。
   为什么要"整条 URL"可配（而不只是域名）：中转/网关常把路径写成 `/v1/chat/completions`，
   只给域名拼不出对方要的路径。
   规则（都在 apiUrlOf 里，别处不要自己拼）：
     · 配了就按配的走；没配 / 空的 / 不是 http(s) 开头 → 一律回落到 DeepSeek 默认地址；
     · 只去掉首尾空白，不做别的加工（路径、查询串都由用户说了算）。
   显示/打印时请用 maskApiUrl()（把查询串藏掉 —— 有些网关会把 token 写在 URL 里）。 */
function apiUrlOf(cfg) {
  const raw = String((cfg && cfg.apiUrl) == null ? '' : cfg.apiUrl).trim();
  if (!raw) return API_URL;
  if (!/^https?:\/\//i.test(raw)) return API_URL;
  return raw;
}
function maskApiUrl(u) {
  const s = String(u == null ? '' : u);
  const i = s.indexOf('?');
  return i < 0 ? s : (s.slice(0, i) + '?…（查询串已隐藏）');
}

const DEFAULT_CFG = {
  mode: 0,
  apiKey: '',
  /* 网关地址（整条 URL）。默认 DeepSeek 官方；换中转就填对方给的完整地址，例如
     https://your-gateway.example/v1/chat/completions —— 没填 / 填错（不是 http(s) 开头）
     一律回落到默认，不会因为写错而"报一个看不懂的错"。 */
  apiUrl: API_URL,
  /* 2026-07-24 起 deepseek-chat / deepseek-reasoner 这两个模型名已经停用。
     现在官方只有两个模型名：
       deepseek-flash     DeepSeek-V4.1-Flash，1M 上下文，支持看图，便宜
       deepseek-v4-pro    DeepSeek-V4-Pro，更强更贵，不支持看图
     答题用 flash 就够，而且它还能兼任"截图读题"那个看图模型。 */
  model: 'deepseek-flash',
  maxPerChapter: 30,
  stopAtQuiz: false,
  /* 读题方式 —— 三种：
       table = 只用字体解码表。字符串替换，快、免费、零误差。
               缺点：只在这支持定字体有效，字体一换整张表就作废。
       shot  = 只用截图 + 看图模型（deepseek-flash）。
               慢一点、要花钱，但不依赖字体 ——
               字体换了、题目干脆是图片，它照样能读。
       auto  = 默认。先验解码表（拿页面上的字体跟表里的指纹对一下），
               对得上就用表；对不上、或者表不存在，就自动改用截图。
     auto 的意义是：绝大多数时候走"快且免费"的路，
     真的被反爬更新了也不至于读不出题。 */
  readMode: 'auto',
  /* 【两条腿，可以随便组合】2026-10-12 按法师的要求细分：
       useBank = 用本地题库答题（命中就填，不问 AI）
       useAI   = 问模型答题
     两个都开（默认）= 先查库、库里没有才问 AI（跟以前一个样）；
     只开题库 = 库里没有的就留着不填（一分钱不花）；
     只开 AI  = 完全不碰题库（想重新问一遍时用）。
     `mode` 仍然是总开关：0=不做题，1=只记题，2=答题（答题才轮到这两个开关）。 */
  useBank: true,
  useAI: true,
  /* 启用哪些库（库名列表）。**空数组 = 全部启用**（这样以后新增子库会自动生效，不用回来改配置）。 */
  bankEnabled: [],
  visionModel: 'deepseek-flash',
  maxShots: 3,
  /* 把 AI 给的答案自动填进页面（只填，不交）。
     默认关 —— 这是个"会动页面"的动作，该由人明确打开。
     打开后：选择题/判断题会被点上，填空和简答不填（要打字）。
     代码里没有任何提交逻辑，提交永远是你自己按。 */
  autoFill: false,
  /* 【模型答案缓存】按"题面指纹"存模型给过的答案，重跑/重启时能省一次 API 调用。
     默认开。命中条件很严：题面指纹一致 + 题型一致 + 模型配置一致 + 缓存版本一致；
     用户换了模型（model / visionModel）老答案自动失效。
     文件是 答题答案缓存.json，里面**只有答案和指纹，没有任何凭据**，
     也不代表页面已经填好、平台那边已经完成。
     想每次都重新问（比如怀疑缓存里的答案不对）就把它设成 false。 */
  useAnswerCache: true
};

/* 已经停用的模型名 -> 现在该用哪个。

   官方更新日志（2026-04-24）写着：deepseek-chat 与 deepseek-reasoner
   这两个模型名于 2026-07-24 停止使用；过渡期里它们分别指向
   deepseek-v4-flash 的非思考模式与思考模式。
   旧配置里存着这两个名字的话，现在每次请求都会直接失败，
   所以在读配置这一步就换掉，不留给后面去报一个看不懂的错。 */
const DEAD_MODELS = {
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-flash',
  'deepseek-v4-flash': 'deepseek-flash'      /* 旧名，官方说仍会被路由，但统一换成新名更干净 */
};
let MODEL_MIGRATED = '';

/* 【空正文要给出确切的死因，不能只留一个空块】
   实测（2026/9/26 16:25，军事理论 1.10）：日志里"答案（模型生成）"那一块**完全是空的**，
   紧接着就是"没能从模型那段答案里认出第几题选什么" —— 看起来像"模型答非所问"，
   实际上模型**一个字都没返回**。
   原因：请求是开着思考模式的（thinking + reasoning_effort:'max'），
   而 max_tokens 是"思考 + 正文"共用的额度（这里 8000）。
   题目一多、思维链一长，整份额度被思考吃光，正文就是空的 ——
   HTTP 还是 200，没有异常，所以一路静默。
   这里把这个情况**说清楚**，别让人对着空块猜。 */
/* 注意：这里**不能**写成 const EMPTY_NOTE = '…' + MAX_TOKENS + '…'。
   MAX_TOKENS 在本文件后面才声明（第 390 行附近），而 const 有暂时性死区 ——
   在模块顶层、声明之前引用它会直接抛 "Cannot access 'MAX_TOKENS' before initialization"，
   整个答题助手加载失败、驱动器一起起不来（我自己踩的）。所以改成函数，用的时候才求值。 */
function emptyNote() {
  return '\u26a0 模型没有返回正文：思考模式的思维链把 max_tokens(' + MAX_TOKENS +
    ') 整个吃光了（HTTP 是成功的，所以不报错）。\n' +
    '    这一章的题这次**一道都没做**，不是"答非所问"。\n' +
    '    想少碰到：把「每章最多问几题」调小，或者改用不带思考模式的模型。';
}
function pickText(j) {
  const text = j?.choices?.[0]?.message?.content;
  if (text && String(text).trim()) return { text: String(text), empty: false };
  const u = j && j.usage;
  return {
    text: '', empty: true,
    note: emptyNote() + (u ? ('\n    （本次用量：' + JSON.stringify(u) + '）') : '')
  };
}

/* 【配置读坏了要说出来，不能装作"一切正常"】
   原来这里 JSON.parse 失败是**静默**返回默认配置。后果很恶劣：
   用户看到的是"配置全丢了、变回默认值"，而真正发生的是"文件坏了"；
   更坏的是下一步 saveConfig 会把这份默认值写回去，把原文件**真的**覆盖掉
   （API key 一起没）。
   所以：
     · 返回值照旧是默认配置（driver.js 依赖这条，不能改成抛异常）；
     · 但把"为什么"记在 lastConfigError() 里，让 配置.js / 控制台 能打印出来；
     · saveConfig 看到文件坏着会**拒绝写**（见下面）。 */
let CFG_ERROR = '';
function lastConfigError() { return CFG_ERROR; }

function loadConfig() {
  CFG_ERROR = '';
  try {
    if (!fs.existsSync(CFG_FILE)) return { ...DEFAULT_CFG };
    /* 注意：PowerShell 的 Set-Content -Encoding UTF8 会写 UTF-8 BOM。
       带着 BOM 的字符串丢给 JSON.parse 会直接抛错，所以先剥掉。
       （这个坑害我调了一轮：文件里明明是 mode 1，读出来却是 0） */
    const raw = fs.readFileSync(CFG_FILE, 'utf8').replace(/^\uFEFF/, '').trim();
    if (!raw) {
      CFG_ERROR = '配置文件是空的，按默认值运行（没有覆盖原文件）。';
      return { ...DEFAULT_CFG };
    }
    let j;
    try {
      j = JSON.parse(raw);
    } catch (pe) {
      CFG_ERROR = '配置文件不是合法 JSON（' + ((pe && pe.message) || pe) + '）—— 已按默认值运行，' +
        '**没有动原文件**。要保住里面的 API key，请先手工修好这个文件再改配置。';
      return { ...DEFAULT_CFG };
    }
    if (!j || typeof j !== 'object' || Array.isArray(j)) {
      CFG_ERROR = '配置文件的内容不是一个 JSON 对象 —— 已按默认值运行，没有动原文件。';
      return { ...DEFAULT_CFG };
    }
    const merged = { ...DEFAULT_CFG, ...j };
    if (DEAD_MODELS[merged.model]) {
      MODEL_MIGRATED = merged.model + ' 已停用，自动改用 ' + DEAD_MODELS[merged.model];
      merged.model = DEAD_MODELS[merged.model];
    }
    return merged;
  } catch (e) {
    CFG_ERROR = '配置文件读不出来（' + ((e && e.message) || e) + '）—— 已按默认值运行，没有动原文件。';
    return { ...DEFAULT_CFG };
  }
}

/* 上一步有没有换过模型名？给控制台和 配置.js 用来提示 */
function modelMigrationNote() { return MODEL_MIGRATED; }

/* ------------------------------------------------------------------
 * 字体反爬的解码表
 *
 * 学习通的题干和选项用了 font-cxsecret 这支字体做反爬：
 * DOM 里存的是"替身字"，靠内嵌字体把字形画回真字。
 * 比如"从法律上"在 DOM 里其实是"庘庝律上" ——
 * 屏幕上看着完全正常，innerText 读出来是乱码。
 *
 * 这支字体是固定的：两次从页面抠出来的 SHA-256 完全一样
 * （ddfc75f9…），不是每次请求随机生成的。
 * 所以对照表做一次就能一直用，不用每个页面重新算。
 *
 * 对照表由 同目录 _字体\ 里这几个脚本生成：
 *   看字体.js --dump      把内嵌字体抠出来
 *   解析字体.js --json    解出 41 个字形
 *   扫字形.ps1            把两万多个汉字渲染成形状位图
 *   比字形.js             字形比对，定出替身 -> 真字
 * ------------------------------------------------------------------ */
const FONT_TABLE = path.join(__dirname, '_字体', '对照表.json');

let FONT_MAP = null;
let FONT_RE = null;
let FONT_SHA = '';
let FONT_TRIED = false;

function loadFontTable() {
  if (FONT_TRIED) return FONT_MAP;
  FONT_TRIED = true;
  try {
    if (!fs.existsSync(FONT_TABLE)) return null;
    const j = JSON.parse(fs.readFileSync(FONT_TABLE, 'utf8').replace(/^\uFEFF/, ''));
    FONT_MAP = j.map || null;
    FONT_SHA = j.sha256 || '';
    if (FONT_MAP && !Object.keys(FONT_MAP).length) FONT_MAP = null;
    if (FONT_MAP) {
      /* 字符类只由对照表里真实存在的替身码位组成。
         不能图省事写成 /[\u5390-\u5ecd]/：
         这个区间里的 厏、厑 之类根本不在字体里，
         按区间替换会把本来正常的字也改掉。 */
      const keys = Object.keys(FONT_MAP);
      FONT_RE = new RegExp(
        '[' + keys.map((c) => '\\u{' + c.codePointAt(0).toString(16) + '}').join('') + ']', 'gu');
    }
    return FONT_MAP;
  } catch (e) {
    return null;
  }
}

/* 把替身字换回真字。返回替换了多少处，
   一处都没替换上说明表不对，调用方要能分辨这种"假成功"。 */
function decodeObf(s) {
  let text = String(s), hits = 0;
  if (!loadFontTable() || !FONT_RE) {
    /* 老表没有就看当前页面的表（认出来的那张） */
    if (EXTRA_TABLE) {
      const r = FI.decodeWith(EXTRA_TABLE, text);
      DECODE_UNCERTAIN += r.uncertain;
      return { text: r.text, hits: r.hits };
    }
    return { text: text, hits: 0 };
  }
  text = text.replace(FONT_RE, (c) => {
    const r = FONT_MAP[c];
    if (!r) return c;
    hits++;
    return r;
  });
  /* 老表管不了的那些码位，交给"当前页面的表"（两份表的码位集合实测是**交集 0**，
     所以先后顺序不影响结果 —— 但顺序固定下来更省心）。 */
  if (EXTRA_TABLE) {
    const r2 = FI.decodeWith(EXTRA_TABLE, text);
    DECODE_UNCERTAIN += r2.uncertain;
    text = r2.text;
    hits += r2.hits;
  }
  return { text: text, hits: hits };
}

function hasFontTable() { return !!loadFontTable(); }

/* 【当前页面临时用的表】平台每份卷子换一支替身字体，所以"这一页能用哪张表"是**每页**决定的：
   老表（_字体\对照表.json）管它诞生的那一支；其余的在运行时逐字认出来，按 sha 缓存。
   这里存的是"当前这一页认出来的那张表"（一章开头顶一次，跨章会覆盖）。 */
let EXTRA_TABLE = null;
function setExtraTable(t) { EXTRA_TABLE = (t && t.map) ? t : null; }
function extraTable() { return EXTRA_TABLE; }
let DECODE_UNCERTAIN = 0;          /* 这一页解码时碰到过几个"拿不准"的替身字 */

/* 页面上的那支字体，跟解码表里记录的是不是同一支？
   传空字符串（页面里没找到字体）时返回 false ——
   宁可退到截图，也不要拿一张可能过期的表去硬套。 */
function fontTableMatches(b64) {
  if (!b64) return false;
  loadFontTable();
  if (!FONT_SHA) return false;
  try {
    const sha = crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');
    return sha === FONT_SHA;
  } catch (e) {
    return false;
  }
}

/* ------------------------------------------------------------------
 * 写配置 —— 原子写 + 备份上一份 + 拒绝覆盖坏文件
 *
 * 【为什么要原子写】
 *   原来是 writeFileSync 直接覆盖。写到一半断电 / 进程被杀，
 *   磁盘上就留一份半截 JSON —— 下次 loadConfig 读不出来，
 *   而旧版的 loadConfig 会静默给默认值，用户看到的是"配置全没了"。
 *   现在改成老规矩：同目录写一个随机名的临时文件 → fsync → rename 覆盖。
 *   rename 在同一分区上是原子的，所以任何时刻磁盘上的那份都是**完整的**。
 *   失败时只清掉自己刚建的那个临时文件（按名字里的随机后缀认，绝不删别人的）。
 *
 * 【为什么要备份】
 *   rename 之前把旧文件复制一份成 .bak。改错了还能捞回来。
 *
 * 【为什么坏文件要拒写】
 *   文件坏着、我们手里又是"默认值 + 这次改动"，写下去等于把原来的 key 抹了。
 *   网页控制台自己已经有一道这样的闸门（saveConfigPatch 里的 readConfigStrict），
 *   但 配置.js 那条命令行没有 —— 审查里点的就是它。闸门放在这里，
 *   两个入口就都挡得住，也不用改控制台。
 * ------------------------------------------------------------------ */
function readConfigRawStrict() {
  /* 返回 { exists, ok, why }：只有 ok=true 时 saveConfig 才动文件 */
  let exists = false;
  try { exists = fs.existsSync(CFG_FILE); } catch (e) { exists = false; }
  if (!exists) return { exists: false, ok: true, why: '' };
  let raw;
  try { raw = fs.readFileSync(CFG_FILE, 'utf8'); } catch (e) {
    return { exists: true, ok: false, why: '读不出来：' + ((e && e.message) || e) };
  }
  const t = String(raw).replace(/^\uFEFF/, '').trim();
  if (!t) return { exists: true, ok: false, why: '文件是空的（0 字节或只有空白）' };
  try {
    const j = JSON.parse(t);
    if (!j || typeof j !== 'object' || Array.isArray(j)) {
      return { exists: true, ok: false, why: '内容不是 JSON 对象' };
    }
    return { exists: true, ok: true, why: '' };
  } catch (e) {
    return { exists: true, ok: false, why: '不是合法 JSON：' + ((e && e.message) || e) };
  }
}

/* 上一份配置的备份文件名。就是 .bak，不带时间戳 ——
   带时间戳会在目录里堆一大串文件，而"上一份"永远只有一个。
   写成函数而不是常量：调用方可能为了测试把 CFG_FILE 指到临时目录，
   常量在这里求值会指回工作区里那个真文件。 */
function cfgBakFile() { return CFG_FILE + '.bak'; }

function saveConfig(cfg) {
  const guard = readConfigRawStrict();
  if (guard.exists && !guard.ok) {
    const err = new Error('答题设置.json 现在读不出来（' + guard.why + '）。' +
      '为了不把里面的 API key 一起写没，这次**一个字节都没写**。请先手工修好那个文件。');
    err.code = 'ECFGCORRUPT';
    throw err;
  }

  const text = JSON.stringify(cfg, null, 2);
  /* 临时文件必须跟目标**同目录**（跨分区 rename 不是原子操作，
     而且可能直接 EXDEV 失败）。名字里带 pid + 随机数：
     两个进程同时写也不会互相踩到对方的临时文件。 */
  const tmp = CFG_FILE + '.tmp-' + process.pid + '-' +
    crypto.randomBytes(6).toString('hex');
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);          /* wx：绝不覆盖已存在的文件 */
    fs.writeFileSync(fd, text, 'utf8');
    try { fs.fsyncSync(fd); } catch (e) { /* 某些文件系统不支持，忽略 */ }
    fs.closeSync(fd);
    fd = null;
    /* 备份上一份：只备份**读得懂**的那份（坏文件没有备份价值，
       而且上面已经因为坏文件抛错了，走不到这里）。 */
    try {
      if (guard.exists) fs.copyFileSync(CFG_FILE, cfgBakFile());
    } catch (e) { /* 备份失败不该挡住写配置 */ }
    fs.renameSync(tmp, CFG_FILE);
    return { ok: true, file: CFG_FILE, backup: guard.exists ? cfgBakFile() : '', bytes: Buffer.byteLength(text, 'utf8') };
  } catch (e) {
    /* 【只清自己的临时文件】名字是我们自己起的，里面带着 pid 和随机后缀；
       不按通配符删目录里别的东西。 */
    if (fd !== null) { try { fs.closeSync(fd); } catch (e2) {} }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e2) {}
    throw e;
  }
}

/* 给控制台/CLI 用：上一份备份还在吗、什么时候的 */
function configBackupInfo() {
  const bak = cfgBakFile();
  try {
    if (!fs.existsSync(bak)) return null;
    const st = fs.statSync(bak);
    return { file: bak, at: st.mtime.toLocaleString('zh-CN'), size: st.size };
  } catch (e) { return null; }
}

/* ------------------------------------------------------------------
 * 在页面里找出测验题目。
 *
 * 注意：不用 CDP 的多上下文，而是自己顺着 contentDocument 往下钻 ——
 * 因为学习通的框架全是同源的，这条路更简单，而且 driver.js 里
 * 已经在用同一招穿透到视频播放器了，可靠。
 *
 * 三个坑照旧：
 *   1. 题目可能在多层 iframe 里 -> 递归收集所有同源 document
 *   2. 选项是 li.before-after 不是 input -> 按 class 找
 *   3. 公式在 img.ans-latex-moudle 的 data 属性里且 URL 编码 -> 解码
 * ------------------------------------------------------------------ */
const EXTRACT = `(function () {
  function txt(el) {
    if (!el) return '';
    return String(el.innerText || el.textContent || '')
      .replace(/\\u00a0/g, ' ').replace(/[ \\t]+/g, ' ')
      .replace(/\\n{2,}/g, '\\n').trim();
  }
  function withMath(root) {
    if (!root) return '';
    var clone = root.cloneNode(true);
    var imgs = clone.querySelectorAll('img.ans-latex-moudle, img[data]');
    for (var i = 0; i < imgs.length; i++) {
      var raw = imgs[i].getAttribute('data') || imgs[i].getAttribute('data-original') || '';
      var latex = raw;
      try { latex = decodeURIComponent(raw); } catch (e) {}
      latex = latex.replace(/^"+|"+$/g, '').replace(/^%22+|%22+$/g, '');
      var sp = document.createElement('span');
      sp.textContent = latex ? ('$' + latex + '$') : '';
      if (imgs[i].parentNode) imgs[i].parentNode.replaceChild(sp, imgs[i]);
    }
    return txt(clone);
  }

  /* 递归收集所有同源 document */
  function allDocs() {
    var out = [document], seen = [document];
    function walk(d, depth) {
      if (depth > 4) return;
      var fs = d.querySelectorAll('iframe');
      for (var i = 0; i < fs.length; i++) {
        var cd = null;
        try { cd = fs[i].contentDocument; } catch (e) {}
        if (cd && seen.indexOf(cd) < 0 && cd.body) { seen.push(cd); out.push(cd); walk(cd, depth + 1); }
      }
    }
    walk(document, 0);
    return out;
  }

  /* 【选择器顺序：'.questionLi' 必须排在 '.TiMu' 前面】
     这两个在两种页面上的含义刚好相反 ——
       学习页 / 章节测验：整块题目区叫 .TiMu，里面每题一个 .questionLi
       作业作答页        ：同理，但 .TiMu 只有 **1 个**（包着"第二讲 作业（共25题）"整块），
                          .questionLi 才是 25 个（每题一个）
     这段逻辑是「从前往后挑第一个非空的」，.TiMu 排前面就会在作业页上先命中那 1 个容器，
     于是 25 道题只报「认出 1 道」（2026-10-10 实测就是这个数）。
     两个名字都是"每题一个"的语义，.questionLi 更贴，所以把它提前；
     页面上没有 .questionLi 时照样落到 .TiMu，学习页的行为一点不变。 */
  var ROOT_SELS = ['.question-item', '.test-item', '.questionLi', '.TiMu', '.queBox',
                   '.exam-question', '[class*="question-item"]', '[class*="TiMu"]'];
  var LETTER_SELS = ['span.num_option', 'span.num_option_dx', 'span.check_answer', 'span.check_answer_dx'];
  var OPT_SELS = ['li.before-after', "li[role='radio']", "li[role='checkbox']", '.answer_p', '.option-item'];

  /* 题干/选项里的图片：只记 **src**（图片的身份），不记内容、不碰 AI、不参与指纹。
     为什么要它：页面上的公式常常是**一张图**（实测：p.ananas.chaoxing.com/star3/origin/xxx.png，
     连 data 属性都没有），题干文字里等于缺了一块。
     拿它当"这道题长什么样"的凭据 —— 题库给答案前会核对两边图片是否一致，
     不一致就不用库里的答案（宁可不答，也不拿错题的答案去填）。 */
  function imgsOf(el) {
    var out = [];
    if (!el || !el.querySelectorAll) return out;
    var g = el.querySelectorAll('img');
    for (var i = 0; i < g.length; i++) {
      var s = String(g[i].getAttribute('src') || '');
      if (s && out.indexOf(s) < 0) out.push(s);
      if (out.length >= 8) break;
    }
    return out;
  }

  var questions = [];
  var docs = allDocs();
  var usedSel = null;

  /* 顺便把页面上那支 font-cxsecret 字体带回去。
     用途：拿它的指纹跟解码表里记录的对比 ——
     对得上说明表还有效；对不上说明字体换过了，表作废，得改用截图。 */
  var fontB64 = '';
  for (var fi = 0; fi < docs.length && !fontB64; fi++) {
    var sheets = null;
    try { sheets = docs[fi].styleSheets; } catch (e) { sheets = null; }
    if (!sheets) continue;
    for (var si = 0; si < sheets.length && !fontB64; si++) {
      var rules = null;
      try { rules = sheets[si].cssRules; } catch (e) { rules = null; }
      if (!rules) continue;
      for (var ri = 0; ri < rules.length; ri++) {
        var rr = rules[ri];
        if (!rr || rr.type !== 5) continue;      /* 5 = FONT_FACE_RULE */
        var fam2 = (rr.style.getPropertyValue('font-family') || '').replace(/["']/g, '');
        if (fam2 !== 'font-cxsecret') continue;
        var src2 = rr.style.getPropertyValue('src') || '';
        var mm2 = src2.match(/base64,([A-Za-z0-9+/=\\s]+)/);
        if (mm2) { fontB64 = mm2[1].replace(/\\s/g, ''); break; }
      }
    }
  }

  for (var di = 0; di < docs.length; di++) {
    var doc = docs[di], roots = null, sel = null;
    for (var s = 0; s < ROOT_SELS.length; s++) {
      var got = doc.querySelectorAll(ROOT_SELS[s]);
      if (got.length > 0) { roots = got; sel = ROOT_SELS[s]; break; }
    }
    if (!roots) continue;
    if (!usedSel) usedSel = sel;

    for (var qi = 0; qi < roots.length; qi++) {
      var q = roots[qi];
      var stemEl = q.querySelector('.Zy_TItle, .mark_name, .question-title, h3, h4, .stem') || q;
      var stem = withMath(stemEl);
      var qimgs = imgsOf(stemEl);            /* 题干的图片 */

      var opts = [], seen2 = [];
      for (var t = 0; t < OPT_SELS.length; t++) {
        var lis = q.querySelectorAll(OPT_SELS[t]);
        for (var k = 0; k < lis.length; k++) {
          if (seen2.indexOf(lis[k]) >= 0) continue;
          seen2.push(lis[k]);
          var body = withMath(lis[k]), letter = '';
          for (var L = 0; L < LETTER_SELS.length; L++) {
            var le = lis[k].querySelector(LETTER_SELS[L]);
            if (le) { var ls = txt(le).replace(/[.．、:：\\s]/g, ''); if (ls) { letter = ls; break; } }
          }
          if (!letter) { var mm = body.match(/^([A-Ha-h])[.．、:：)\\s]/); if (mm) letter = mm[1].toUpperCase(); }
          if (letter && body.indexOf(letter) === 0) body = body.slice(letter.length).trim();
          opts.push({ letter: letter, text: body });
          var oim = imgsOf(lis[k]);          /* 选项里也可能有图 */
          for (var oz = 0; oz < oim.length; oz++) if (qimgs.indexOf(oim[oz]) < 0) qimgs.push(oim[oz]);
        }
        if (opts.length) break;
      }
      /* 【字母没读出来就按顺序补 A/B/C/D】实测（2026-10-12）：字母本身也在替身字体里，
         字体没解开时读出来就是空 ⇒ 记录里写成「?. 正文」（全记录 700 行！），
         指纹就成了「?:正文」，跟库里的「A:正文」对不上 ⇒ 作业那 175 道全部查不到（实测 175/175 落空）。
         平台渲染选项永远按顺序，所以顺序 = A/B/C/D；补完标一个 lettersFromOrder，
         让日志和记录都能看出"这字母是推出来的"。
         ★ 这段注释里**一个反引号都不能有**（这是模板字符串，反引号会把脚本截断 —— 今天第三次了）。 */
      if (opts.length > 1 && opts.some(function (o) { return !o.letter; })) {
        for (var oi = 0; oi < opts.length; oi++) if (!opts[oi].letter) opts[oi].letter = String.fromCharCode(65 + oi);
      }

      var type = '未知';
      if (q.querySelector('textarea, [contenteditable="true"], iframe[id^="ueditor"]')) type = '简答';
      else if (q.querySelector('.blankItemDiv')) type = '填空';
      else if (q.querySelector("input[type='checkbox'], li[role='checkbox']")) type = '多选';
      else if (opts.length && opts.every(function (o) { return /^(对|错|正确|错误|是|否|T|F)$/i.test(o.text.trim()); })) type = '判断';
      else if (opts.length) type = '单选';

      if (stem || opts.length) {
        /* font-cxsecret 是超星的字体反爬：DOM 里存的是替换字符，
           靠内嵌的 base64 字体把字形映射回真字。
           眼睛看着对，读出来是乱码。认出它才能不把乱码喂给 AI。 */
        questions.push({ type: type, stem: stem, options: opts, obf: !!q.querySelector('.font-cxsecret'), imgs: qimgs });
      }
    }
  }

  /* 去掉重复（有些容器会被父子各抓一次） */
  var uniq = [], keys = {};
  for (var u = 0; u < questions.length; u++) {
    var key = (questions[u].stem || '').slice(0, 60) + '|' + questions[u].options.length;
    if (keys[key]) continue;
    keys[key] = 1; uniq.push(questions[u]);
  }

  /* 顺便看看页面上是不是已经在显示"我的答案 / 正确答案"（说明交过了） */
  var body = txt(document.body);
  var obfN = 0;
  for (var z = 0; z < uniq.length; z++) if (uniq[z].obf) obfN++;
  return {
    found: uniq.length,
    rootSelector: usedSel,
    docCount: docs.length,
    obfCount: obfN,
    fontB64: fontB64,
    graded: /我的答案|正确答案/.test(body),
    questions: uniq
  };
})()`;

/* ------------------------------------------------------------------
 * 解析模型输出。
 * 模型答应"只输出字母"但它经常不照做，所以这里必须容错。
 * 解析不出来就返回 null —— 绝不瞎猜一个。
 * ------------------------------------------------------------------ */
function parseAnswer(text, type) {
  if (!text) return { answer: null, reason: '' };
  const lines = String(text).trim().split(/\r?\n/);
  const first = (lines[0] || '').trim();
  const reason = lines.slice(1).join(' ').trim();
  if (/不确定/.test(first)) return { answer: null, reason: reason || first };

  if (type === '判断') {
    if (/^(对|正确|是|真|T|TRUE|√|1)/i.test(first)) return { answer: '对', reason };
    if (/^(错|错误|否|假|F|FALSE|×|0)/i.test(first)) return { answer: '错', reason };
  }
  const letters = [...new Set((first.toUpperCase().match(/[A-H]/g) || []))].sort();
  if (letters.length === 0) {
    if (type === '填空' || type === '简答') return { answer: first, reason };
    return { answer: null, reason: reason || '（模型第一行没有可识别的答案）' };
  }
  return { answer: type === '多选' ? letters.join('') : letters[0], reason };
}

const SYSTEM = [
  '你是一个严谨的答题助手。',
  '规则：',
  '1. 只做判断，不要写客套话。',
  '2. 单选题：第一行只输出一个大写字母，例如 B',
  '3. 多选题：第一行只输出字母，按字母序，不加分隔符，例如 ABD',
  '4. 判断题：第一行只输出「对」或「错」',
  '5. 填空题/简答题：第一行只输出答案正文，多个空用 ||| 分隔',
  '6. 从第二行开始，用一到两句话说明理由。',
  '7. 如果不确定，第一行输出「不确定」，然后说明卡在哪。'
].join('\n');

function buildUser(q) {
  const parts = ['题型：' + q.type, '题干：' + q.stem];
  if (q.options && q.options.length) {
    parts.push('选项：');
    for (const o of q.options) parts.push('  ' + (o.letter || '?') + '. ' + o.text);
  }
  return parts.join('\n');
}

/* 输出长度上限。
   为什么必须显式给：实测"函数的求导法则 漏了一道题"——
   同一批 5 道题、同样 5 张截图，模型有时给 5 条答案、有时只给 4 条，
   答案段永远停在"4. C ——"那里。查下来是两个原因叠在一起：
     1) 没传 max_tokens，走的是服务端默认值；
     2) 思考模式开着、档位 max，思维链本身要吃掉一截输出配额。
   配额一紧，正文就被截在中途 —— 而截掉的那条答案**看日志是看不出来的**
   （以前既不算填上、也不算没填上，静默消失）。
   【2026-10-07 实测：8000 正卡在临界点上，思考链会把它整个吃光】
   同一组参数（thinking + reasoning_effort:'max'）连跑几次，思考量在 7.7K~15K 之间浮动：
     8000  → completion=7723 / reasoning=7715，正文只剩 8 个 token，侥幸写出 9 个字；
             下一次 completion=8000 / reasoning=8000、finish_reason=length，正文 0 字。
     → "整章 10 道题一道都没做"就是这么来的：不是模型答非所问，是正文根本没生成，
       日志里那句「模型没有返回正文：思考模式的思维链把 max_tokens 整个吃光了」才是现场。
   给到 32000 → completion=14914 / reasoning=14906，正文正常出。
   max_tokens 只是上限，不改变模型"想多久"，所以调大不会平白多花钱 ——
   它只消除"思考把配额吃光、正文被挤没"这一种故障。 */
const MAX_TOKENS = 32000;

/* 【给每次 API 调用加超时】
   实测踩坑：驱动器在"视频播完 → 处理题目卡"那一步冻了 6 分钟 ——
   日志不再写、CPU 也不动，原因就是 fetch 没设超时：
   对端一旦不返回（网络抖动 / 服务端卡住），这个 await 会永远等下去，
   而驱动器是单线程串行的，整条流程就此停摆。
   现在给每次请求上限，超时就抛错 —— 上层会把它记进"没做的题"并继续往下走。 */
const API_TIMEOUT_MS = 90000;

/* 【超时要给两次机会，但绝不能给三次】
   为什么单开一个大限：思考模式 + 多图抄录本来就是慢活。
   实测一整套（thinking + reasoning_effort:'max' + 最多 20 张 92 质量的图）
   90 秒并不宽裕。而超时这件事有个残酷的性质 ——
   **客户端 abort 了，服务端那边还在算，这笔输出照样计费。**
   所以超时的重试必须比连接故障少得多：
     · 连接类故障（socket 还没建起来 / 被 RST）：请求根本没送达，重试是白赚的，
       快速重试 2 次（1.2s、3s）；
     · 响应超时：请求已经送达、很可能已经在计费，**最多再试 1 次**，
       而且这一次给足 180 秒（第一次 90 秒没回来，说明它真的慢）。
   原来那把 TRANSIENT 正则把「超时」和「ECONNRESET」写在一起、共用 API_RETRIES=2，
   等于一次长请求无脑重发三遍（最坏 270 秒 + 2~3 倍费用），而且用户要等 4.5 分钟。 */
const API_TIMEOUT_MS_LONG = 180000;     /* 超时后那一次重试用的大限 */
const API_RETRIES_CONN = 2;             /* 连接类故障：最多再试 2 次 */
const API_RETRIES_TIMEOUT = 1;          /* 响应超时：最多再试 1 次 */
const RETRY_WAIT_MS = [1200, 3000];
/* 只有**连接层面**的临时故障才算这一类。刻意把「超时」排除在外 ——
   它走另一条更保守的路（见上面）。 */
const CONN_TRANSIENT = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|network|fetch failed|连接被重置|连接中断/i;

/* 这次失败是"根本没连上"还是"连上了但对方没回"？ */
function classifyApiFailure(e) {
  const raw = String((e && e.message) || e || '');
  if (e && e.name === 'AbortError') return 'timeout';
  if (/abort/i.test(raw)) return 'timeout';
  if (/超时|timed?\s*out/i.test(raw) && !/ETIMEDOUT/i.test(raw)) return 'timeout';
  if (CONN_TRANSIENT.test(raw)) return 'conn';
  return 'other';
}

/* 【签名保持原样】fetchWithTimeout(url, opts) —— 老的调用点一个都不用改。
   第三个参数是可选的大限覆盖，只有本文件里"我知道这一次特别慢"的地方才会用。
   返回值上多带两个字段，方便上层如实记账：
     attempts —— 这次一共发了几次请求
     retried  —— 重试了几次（0 表示一次就成） */
async function fetchWithTimeout(url, opts, over) {
  const timeoutFirst = (over && typeof over.timeoutMs === 'number' && over.timeoutMs > 0)
    ? over.timeoutMs : API_TIMEOUT_MS;
  if (typeof AbortController === 'undefined') return fetch(url, opts);
  let lastErr = null;
  let connTries = 0, timeoutTries = 0, attempts = 0;
  for (;;) {
    const isTimeoutRetry = timeoutTries > 0;
    const limit = isTimeoutRetry ? Math.max(API_TIMEOUT_MS_LONG, timeoutFirst) : timeoutFirst;
    const ac = new AbortController();
    const timer = setTimeout(() => { try { ac.abort(); } catch (e) {} }, limit);
    attempts++;
    try {
      const r = await fetch(url, Object.assign({}, opts, { signal: ac.signal }));
      if (r && typeof r === 'object') {
        try {
          Object.defineProperty(r, '__apiAttempts', { value: attempts, enumerable: false });
          Object.defineProperty(r, '__apiRetried', { value: attempts - 1, enumerable: false });
        } catch (e) { /* 响应对象被冻结就算了，不影响主流程 */ }
      }
      return r;
    } catch (e) {
      const kind = classifyApiFailure(e);
      const msg = kind === 'timeout'
        ? ('API 请求超时（' + Math.round(limit / 1000) + ' 秒没响应）')
        : String((e && e.message) || e);
      const err = new Error(msg);
      err.kind = kind;
      err.attempts = attempts;
      lastErr = err;
      if (kind === 'timeout') {
        /* 超时只给一次重试机会，而且下一次用更大的大限（180 秒） */
        if (timeoutTries < API_RETRIES_TIMEOUT) {
          timeoutTries++;
          await new Promise((r) => setTimeout(r, RETRY_WAIT_MS[timeoutTries - 1] || 1200));
          continue;
        }
        throw err;
      }
      if (kind === 'conn' && connTries < API_RETRIES_CONN) {
        const wait = RETRY_WAIT_MS[connTries] || 3000;
        connTries++;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  /* 不可达，仅为让 linter 安心 */
  throw lastErr || new Error('API 请求失败');
}

async function askOne(q, cfg) {
  const r = await fetchWithTimeout(apiUrlOf(cfg), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: MAX_TOKENS,
      /* 思考模式：开，档位 max —— 答题这一步要的就是准确率，慢一点贵一点认了。
         注意：思考模式不支持 temperature，官方原话是「设置参数不会报错，但也不会生效」。
         所以这里干脆不传 —— 留一个不生效的参数只会误导人（原来那行 temperature: 0
         看着像在保证答案稳定，其实一点用都没有）。 */
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: buildUser(q) }
      ]
    })
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error('API ' + r.status + ' ' + t.slice(0, 200));
  }
  const j = await r.json();
  const pt = pickText(j);
  return { text: pt.text, empty: pt.empty, note: pt.note, usage: j.usage, attempts: r.__apiAttempts || 1 };
}

/* 直接拿一段文字去问（截图读题那条路用它：
   题目是模型抄录出来的文字，不是从网页结构化抠出来的） */
async function askRaw(userText, cfg) {
  const r = await fetchWithTimeout(apiUrlOf(cfg), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: MAX_TOKENS,
      /* 思考模式：开，档位 max（和 askOne 保持一致 —— 这是真正出答案的那一步）
         同样必须给 max_tokens：题多的时候（5 道以上）思维链一长，
         正文就容易被截断，表现就是"最后一道题没有答案"。 */
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: userText }
      ]
    })
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error('API ' + r.status + ' ' + t.slice(0, 200));
  }
  const j = await r.json();
  const pt = pickText(j);
  /* 【usage 必须带出去】原来 pickText 的结果直接返回，usage 就在这一层丢了 ——
     截图读题那条路一章花掉多少 token，日志里一个字都看不到。
     现在原样带回 usage 和"发了几次"，由 handle 累计成章末那一行。 */
  pt.usage = j && j.usage;
  pt.attempts = r.__apiAttempts || 1;
  return pt;
}

/* ------------------------------------------------------------------
 * 截图读题 —— 反爬的兜底方案
 *
 * 为什么要有这条路：
 *   字体解码表本质上是"赌字体不变"。它很准、很便宜，但对方一旦更新字体，
 *   整张表就作废，题目重新变回乱码。
 *   截图读题不依赖字体 —— 它读的是屏幕像素，所以字体怎么换都拦不住它；
 *   哪天题目干脆画成图片，它也一样能读。
 *
 * 代价是慢一点、要花一点钱，所以默认只当兜底（readMode=auto）：
 * 解码表还有效时根本不走这条路。
 * ------------------------------------------------------------------ */

/* 把第 idx 道题滚到屏幕中间。
   是在最里层那个 document 上滚 —— 浏览器会连带把外层 iframe 一起滚，
   这样顶层窗口截出来的画面里才看得见这道题。

   【顺序必须和 questionShotPlan 一样】
   原来这里是"一层一层地把所有根节点收进来"（广度优先），
   而 questionShotPlan 是深度优先往下走。题目分布在多层 iframe 里时，
   两边算出来的"第 i 道"根本不是同一道 —— 结果是"滚的是这道、截的是那道"。
   现在两边都用同一套 walk（深度优先、逐层累加 iframe 偏移），
   顺序才对得上；顺带把根节点的矩形尺寸带回去，
   让调用方能自检"滚完复算的矩形"和"滚之前那个"是不是同一道题。 */
function scrollToQuestion(idx) {
  return '(function () {\n' +
    '  var SELS = [".TiMu", ".questionLi", ".question-item", ".test-item", ".queBox", ".exam-question"];\n' +
    '  function rootsIn(doc) {\n' +
    '    for (var s = 0; s < SELS.length; s++) {\n' +
    '      var g = null;\n' +
    '      try { g = doc.querySelectorAll(SELS[s]); } catch (e) { continue; }\n' +
    '      if (g && g.length) { var a = []; for (var k = 0; k < g.length; k++) a.push(g[k]); return a; }\n' +
    '    }\n' +
    '    return [];\n' +
    '  }\n' +
    '  var flat = [], seen = [document];\n' +
    '  function walk(doc, depth) {\n' +
    '    if (depth > 4) return;\n' +
    '    var rs = rootsIn(doc);\n' +
    '    for (var i = 0; i < rs.length; i++) flat.push(rs[i]);\n' +
    '    var fs = null; try { fs = doc.querySelectorAll("iframe"); } catch (e) { return; }\n' +
    '    for (var f = 0; f < fs.length; f++) {\n' +
    '      var cd = null;\n' +
    '      try { cd = fs[f].contentDocument; } catch (e) { cd = null; }\n' +
    '      if (cd && cd.body && seen.indexOf(cd) < 0) { seen.push(cd); walk(cd, depth + 1); }\n' +
    '    }\n' +
    '  }\n' +
    '  walk(document, 0);\n' +
    '  var el = flat[' + idx + '];\n' +
    '  if (!el) return { ok: false, n: flat.length };\n' +
    '  var r = null; try { r = el.getBoundingClientRect(); } catch (e) { r = null; }\n' +
    '  try { el.scrollIntoView({ block: "center", inline: "center" }); }\n' +
    '  catch (e) { try { el.scrollIntoView(); } catch (e2) {} }\n' +
    '  return { ok: true, n: flat.length,\n' +
    '           w: r ? Math.round(r.width) : 0, h: r ? Math.round(r.height) : 0 };\n' +
    '})()';
}

const VISION_PROMPT = [
  '这是一组学习通答题页的截图，可能有多张（同一页往下滚的连续画面，内容有重叠）。',
  '请把里面的题目原样抄录成文字。规则：',
  '1. 按题目顺序输出，每道题写成：',
  '   【题型】题干',
  '   A. 选项',
  '   B. 选项',
  '2. 只抄题目和选项，不要作答，不要解释，不要写任何额外的话。',
  '3. 多张截图里重复出现的同一道题，只输出一次。',
  '4. 认不准的字用「□」代替，不要猜。'
].join('\n');

/* ------------------------------------------------------------------
 * 每道题在"顶层文档"里的坐标（给定向截图用）
 *
 * 为什么要有它：原来是 scrollToQuestion 把题滚进视口、然后**整屏截图**。两个毛病：
 *   1) 整屏是 2217x1439 这种大图，交给视觉模型会被缩小，字变小、认字变差；
 *   2) 滚动/切栏只要有一瞬间没落定，拍到的就是别的卡片 ——
 *      实测（2026/9/26 16:44、16:47）模型回的就是"截图中只有课程章节页/视频播放页"，
 *      整章白丢。这是今天最耗钱、最难查的一类失败。
 * 改成只拍"这道题那一小块"之后，这两个毛病一起没了：区域小 → 不缩放 → 字清楚；
 * 区域是按元素算出来的 → 不可能拍到别的卡。
 *
 * 【坐标必须一层层累加，不能直接拿元素的 getBoundingClientRect()】
 *   iframe 里元素的 rect 是**相对它自己那个 frame** 的。
 *   视频那边就被这个坑过：视频卡在 cards 里位于 y=969，如果只取它自己的 rect，
 *   算出来的点击坐标会整整差一张卡片的高度、点到页面外面去。
 *   所以这里从顶层开始往下走，把每层 iframe 的位置一层层加上去。
 * ------------------------------------------------------------------ */
function questionShotPlan() {
  return '(function () {\n' +
    '  var SELS = [".TiMu", ".questionLi", ".question-item", ".test-item", ".queBox", ".exam-question"];\n' +
    '  var out = [], docsSeen = 0;\n' +
    '  function rootsIn(doc) {\n' +
    '    for (var s = 0; s < SELS.length; s++) {\n' +
    '      var g = null;\n' +
    '      try { g = doc.querySelectorAll(SELS[s]); } catch (e) { continue; }\n' +
    '      if (g && g.length) { var a = []; for (var k = 0; k < g.length; k++) a.push(g[k]); return a; }\n' +
    '    }\n' +
    '    return [];\n' +
    '  }\n' +
    '  function walk(doc, ox, oy, depth) {\n' +
    '    if (depth > 4) return;\n' +
    '    docsSeen++;\n' +
    '    var rs = rootsIn(doc);\n' +
    '    for (var i = 0; i < rs.length; i++) {\n' +
    '      var el = rs[i];\n' +
    '      var r; try { r = el.getBoundingClientRect(); } catch (e) { continue; }\n' +
    '      if (!r || r.width < 40 || r.height < 16) continue;\n' +
    '      /* 【坐标要把"每一层 iframe 自己的滚动量"也算进去】\n' +
    '         实测踩坑（2026/9/26 17:22）：work 卡那个 iframe 内部滚动过，\n' +
    '         题目元素的视口坐标算出来是 y=-451（在视口上方），拍出来一张全白图 ——\n' +
    '         模型回的就是"图片内容为空白"，整章白丢。\n' +
    '         光加顶层的 pageYOffset 不够（试过，仍然 -451），因为滚动发生在**里面那层**。\n' +
    '         所以每往下一层就把那一层文档自己的滚动量加进累计偏移。 */\n' +
    '      var sx = 0, sy = 0;\n' +
    '      try { sx = doc.defaultView.pageXOffset || 0; sy = doc.defaultView.pageYOffset || 0; } catch (e) {}\n' +
    /* 【这里原来 push 两条矩形，是错的】
       一条含本层文档的滚动量、一条不含；只有当页面 scrollY>0 时两条才不同，
       而下面 ±12px 的"几乎重叠"去重又会把第二条当成第一条的副本丢掉。
       结果留下的到底是哪条，取决于滚动量为不为 0 —— 而 grabShots 之后
       还要再加一次顶层滚动量。两层加成叠在一起，坐标能偏出一整屏。
       现在只留一条（含本层滚动量），语义明确：**顶层视口坐标**。 */
    '      out.push({ i: out.length, x: Math.round(r.left + ox + sx), y: Math.round(r.top + oy + sy),\n' +
    '                 w: Math.round(r.width), h: Math.round(r.height), docDepth: depth });\n' +
    '    }\n' +
    '    var fs = null; try { fs = doc.querySelectorAll("iframe"); } catch (e) { return; }\n' +
    '    for (var f = 0; f < fs.length; f++) {\n' +
    '      var cd = null, cf = null;\n' +
    '      try { cd = fs[f].contentDocument; } catch (e) { cd = null; }\n' +
    '      if (!cd || !cd.body) continue;\n' +
    '      try { cf = fs[f].getBoundingClientRect(); } catch (e) { continue; }\n' +
    '      /* 这一层 iframe 相对**上一层文档**的位置，再加进累计偏移 */\n' +
    '      walk(cd, ox + cf.left, oy + cf.top, depth + 1);\n' +
    '    }\n' +
    '  }\n' +
    '  walk(document, 0, 0, 0);\n' +
    '  var dpr = window.devicePixelRatio || 1;\n' +
    '  /* 【去重：同一个元素可能被两组选择器各命中一次】\n' +
    '     实测（2026/9/26 17:26）：一页明明只有 2 道题，这里却算出 4 个矩形 ——\n' +
    '     `.TiMu` 和 `.questionLi` 套在同一批节点上，于是同一道题被截两张，\n' +
    '     白花一次 API 钱、也让模型看到重复内容。按"矩形几乎重叠"去重。 */\n' +
    '  var uniq = [];\n' +
    '  for (var u = 0; u < out.length; u++) {\n' +
    '    var a = out[u], dup = false;\n' +
    '    for (var v = 0; v < uniq.length; v++) {\n' +
    '      var b = uniq[v];\n' +
    '      if (Math.abs(a.x - b.x) <= 12 && Math.abs(a.y - b.y) <= 12 &&\n' +
    '          Math.abs(a.w - b.w) <= 24 && Math.abs(a.h - b.h) <= 24) { dup = true; break; }\n' +
    '    }\n' +
    '    if (!dup) uniq.push(a);\n' +
    '  }\n' +
    '  for (var q = 0; q < uniq.length; q++) uniq[q].i = q;\n' +
    '  return { ok: true, n: uniq.length, raw: out.length, dpr: dpr, docs: docsSeen,\n' +
    '           cw: window.innerWidth, ch: window.innerHeight, rects: uniq };\n' +
    '})()';
}

/* 这一页有几道题的根节点？（用来决定截几张图） */
function countQuestions() {
  return '(function () {\n' +
    '  function allDocs() {\n' +
    '    var out = [document], seen = [document];\n' +
    '    function walk(d, depth) {\n' +
    '      if (depth > 4) return;\n' +
    '      var fs = d.querySelectorAll("iframe");\n' +
    '      for (var i = 0; i < fs.length; i++) {\n' +
    '        var cd = null;\n' +
    '        try { cd = fs[i].contentDocument; } catch (e) {}\n' +
    '        if (cd && seen.indexOf(cd) < 0 && cd.body) { seen.push(cd); out.push(cd); walk(cd, depth + 1); }\n' +
    '      }\n' +
    '    }\n' +
    '    walk(document, 0);\n' +
    '    return out;\n' +
    '  }\n' +
    '  var SELS = [".TiMu", ".questionLi", ".question-item", ".test-item", ".queBox", ".exam-question"];\n' +
    '  var roots = [], docs = allDocs();\n' +
    '  for (var d = 0; d < docs.length; d++) {\n' +
    '    for (var s = 0; s < SELS.length; s++) {\n' +
    '      var g = docs[d].querySelectorAll(SELS[s]);\n' +
    '      if (g.length) {\n' +
    '        for (var k = 0; k < g.length; k++) if (roots.indexOf(g[k]) < 0) roots.push(g[k]);\n' +
    '        break;\n' +
    '      }\n' +
    '    }\n' +
    '  }\n' +
    '  return roots.length;\n' +
    '})()';
}

/* 一题一题截图。
 *
 * 【以前这里写死最多 3 张，实测漏题】
 *   两个重要极限 那一章有 5 道题、一题一屏 —— 只截了 3 张，模型就只抄到 4 道，
 *   后面那道**从头到尾没被看见**，于是"5 题只填了 4 题"。
 *   看着像"有一题没做"，其实是根本没拍到。
 * 现在改成：先问页面"这一页有几个题目根节点"，有几个就截几张
 * （上限 20 张兜底，防跑飞）。maxShots 只当上限用，不再当固定张数。
 *
 * 【shot 必须实现 setViewport/clearViewport 契约】
 *   注进来的 shot 除了可调用，还要能挂 setViewport(w,h) / clearViewport()。
 *   driver.js 就是这么给的。**少挂了不会被发现** ——
 *   `await shot.setViewport && ...` 这种写法在属性不存在时恒为假，
 *   视口撑不起来、截图全是空白条，而日志一个字都不报（审查里点的就是这条）。
 *   现在：撑不起来就记进 diag，由 handle 如实写进日志，并把"抄录不可信"标出来。
 *
 * diag（可选）：调用方传一个对象，这里把"截图期间到底发生了什么"写进去。
 *   { smallViewport, triedExpand, expanded, expandError, emptyShots, captureErrors, note }
 */
async function grabShots(ev, shot, maxShots, diag, opts) {
  const D = diag || {};
  D.note = D.note || [];
  D.captureErrors = D.captureErrors || [];
  /* 【只拍指定的那几道题】opts.only = 页面题目序号（0 起）的数组。
     用途：题库已经答掉一部分题时，只把"库里没有的"送进截图。
     不传就是"全拍"（老行为，一个字节不变）。 */
  const only = (opts && Array.isArray(opts.only) && opts.only.length) ? opts.only.slice() : null;
  /* 【先把视口保证成正常大小 —— 今天最"冤"的一个 bug】
     实测（2026/9/26 17:23）：模型一直回"图片内容为空白""截图中没有题目"，
     我照着坐标查了半天，最后发现根本不是坐标问题：
       页面 iw=781, ih=**156**, scrollY=3241
       浏览器窗口 top=833 height=1051 —— 窗口被拖到屏幕下沿，可视区压成一条 156 像素的缝。
     于是整屏截图就是一条空白带；题目元素算出 y=-451 也是**对的**（156 高的视口里它确实在上方）。
     所以：截图期间用 Emulation.setDeviceMetricsOverride 把视口临时撑成 1280x900，
     拍完立刻还原 —— 还原很重要，否则页面的点击坐标全变，驱动器的鼠标事件就会点错地方。 */
  const shotOnce = async (opts) => {
    try {
      const r = await shot(opts);
      if (r) return r;
      D.captureErrors.push('截图返回了空图');
      return '';
    } catch (e) {
      D.captureErrors.push('截图抛错：' + ((e && e.message) || e));
      return '';
    }
  };

  const capture = async () => {
    const out = [];
    let small = false;
    try {
      const j = await ev('JSON.stringify({w:window.innerWidth,h:window.innerHeight})');
      const o = JSON.parse(j);
      small = (o.w < 900 || o.h < 500);
      D.viewport = { w: o.w, h: o.h };
    } catch (e) {
      D.captureErrors.push('读视口大小失败：' + ((e && e.message) || e));
    }
    D.smallViewport = small;

    if (small) {
      /* 【这里原来是一句 `await shot.setViewport && ...`】
         属性不存在时它是 undefined，整个表达式恒为假 —— 视口撑不起来，
         日志里却什么都没有，看起来跟"撑成功了"一模一样。
         现在分开判：有没有这个方法、调用成不成功，都留痕。 */
      D.triedExpand = true;
      if (typeof shot.setViewport !== 'function') {
        D.expanded = false;
        D.expandError = '截图函数没有 setViewport（浏览器窗口被压小了也撑不回来）';
        D.note.push('⚠ 视口只有 ' + (D.viewport ? (D.viewport.w + 'x' + D.viewport.h) : '?') +
          '，而这边的截图函数没有 setViewport —— 拍出来很可能是空白条。');
      } else {
        try {
          const okv = await shot.setViewport(1280, 900);
          await new Promise((r) => setTimeout(r, 400));   /* 等重排 */
          D.expanded = okv !== false;
          if (!D.expanded) D.expandError = 'setViewport 返回了 false';
          if (D.expanded) D.note.push('视口被压小了，已临时撑到 1280x900 再拍。');
        } catch (e) {
          D.expanded = false;
          D.expandError = (e && e.message) || String(e);
          D.note.push('⚠ 想把视口撑到 1280x900 但失败了：' + D.expandError);
        }
      }
    } else {
      D.expanded = false;
    }

    /* ---- 首选：按每道题的坐标定向截图（坐标在撑大视口之后重新算） ---- */
    let plan = null;
    try { plan = await ev(questionShotPlan()); } catch (e) { plan = null; }
    /* captureBeyondViewport 的 clip 要的是**文档坐标**，而 plan 给的是**视口坐标**
       （plan.y 可以是负数 —— 那说明题目在视口上方）。所以这里要把页面滚动量加回去。
       实测（2026/9/26 17:24）：直接用 plan 的视口坐标当 clip，y 被夹到 0，
       拍出来是一条空白带；模型回"图片内容为空白"。 */
    let scX = 0, scY = 0;
    try {
      const sj = await ev('JSON.stringify({x:window.scrollX||0,y:window.scrollY||0})');
      const so = JSON.parse(sj); scX = so.x || 0; scY = so.y || 0;
    } catch (e) {}
    if (plan && plan.ok && plan.rects && plan.rects.length) {
      const cap2 = Math.max(1, Math.min(20, maxShots && maxShots > 0 ? Math.max(maxShots, plan.n) : plan.n));
      const idxs = only || plan.rects.map((_, i) => i);
      for (let kk = 0; kk < idxs.length && kk < cap2; kk++) {
        const i = idxs[kk];
        if (i < 0 || i >= plan.rects.length) continue;
        const pad = 8;
        /* 每次现算：滚动/重排之后旧坐标会失效 */
        let scrolled = null;
        try { scrolled = await ev(scrollToQuestion(i)); } catch (e) { scrolled = null; }
        await new Promise((r) => setTimeout(r, 300));
        let r = null;
        try {
          const again = await ev(questionShotPlan());
          if (again && again.rects && again.rects[i]) r = again.rects[i];
          const sj2 = await ev('JSON.stringify({x:window.scrollX||0,y:window.scrollY||0})');
          const so2 = JSON.parse(sj2); scX = so2.x || 0; scY = so2.y || 0;
        } catch (e) {}
        if (!r) r = plan.rects[i];
        /* 【自检：滚完之后复算出来的矩形，跟滚之前那一块是不是同一道题】
           题目分布在多层 iframe 里时，两边的顺序算法只要有一点不一样，
           就会出现"滚的是第 3 题、截的是第 4 题" —— 截到的图对不上滚的位置，
           模型照样能抄出题，但抄出来的顺序是错的，答案也就填到错位的题上了。
           尺寸差得太大就**放弃这一张定向截图**（宁可不拍，也别拍错位置的），
           让下面的整屏退路去兜。 */
        const before = plan.rects[i];
        if (scrolled && scrolled.ok && before && r &&
            (Math.abs((r.w || 0) - (before.w || 0)) > Math.max(40, (before.w || 0) * 0.5) ||
             Math.abs((r.h || 0) - (before.h || 0)) > Math.max(40, (before.h || 0) * 0.5))) {
          D.note.push('⚠ 第 ' + (i + 1) + ' 题滚完复算的尺寸（' + r.w + 'x' + r.h + '）与滚动前（' +
            before.w + 'x' + before.h + '）差太多，怀疑顺序对不上，跳过这一张。');
          continue;
        }
        const clip = {
          x: Math.max(0, r.x + scX - pad), y: Math.max(0, r.y + scY - pad),
          width: Math.min(r.w + pad * 2, 4000), height: Math.min(r.h + pad * 2, 4000), scale: 1
        };
        if (clip.width < 30 || clip.height < 20) continue;
        /* 图小了就敢用好画质：区域小、张数少，质量提到 92 也不会把请求体撑大。
           captureBeyondViewport：让 CDP 自己滚到那块去拍。 */
        const b64 = await shotOnce({ clip: clip, quality: 92, captureBeyondViewport: true });
        if (b64) out.push(b64);
      }
    }

    /* ---- 退路：滚到每道题再整屏截（拍歪的概率高，但总比没有强） ---- */
    if (!out.length) {
      let total = 0;
      try {
        const c = await ev(countQuestions());
        if (typeof c === 'number' && c > 0) total = c;
      } catch (e) { total = 0; }
      const want = Math.max(total, maxShots && maxShots > 0 ? maxShots : 3);
      const cap = Math.max(1, Math.min(20, want));
      const idxs2 = only || Array.from({ length: cap }, (_, i) => i);
      for (let kk = 0; kk < idxs2.length && kk < cap; kk++) {
        const info = await ev(scrollToQuestion(idxs2[kk]));
        if (!info || !info.ok) break;
        await new Promise((r) => setTimeout(r, 500));
        const b64 = await shotOnce({ quality: 90 });
        if (b64) out.push(b64);
        if (info.n <= idxs2[kk] + 1) break;
      }
    }
    if (!out.length) D.emptyShots = true;
    return out;
  };

  let out = [];
  try {
    out = await capture();
  } finally {
    /* 无论成败都要还原视口 —— 不还原的话，后面驱动器的点击坐标会全错。
       撑过才还原：没撑过还去 clear，等于白抹一次别人设的视口。 */
    if (D.triedExpand && D.expanded) {
      if (typeof shot.clearViewport === 'function') {
        try {
          const okc = await shot.clearViewport();
          if (okc === false) D.note.push('⚠ clearViewport 返回 false，视口可能没还原，后面点击坐标会偏。');
        } catch (e) {
          D.note.push('⚠ 还原视口失败：' + ((e && e.message) || e) + '（后面点击坐标会偏，建议重开浏览器）');
        }
      } else {
        D.note.push('⚠ 撑大过视口但没有 clearViewport，视口还原不了，后面点击坐标会偏。');
      }
    }
  }
  return out;
}

/* 【抄录这条路把大限放到 180 秒】
   这一步是一次请求带最多 20 张 92 质量的图 + 思考模式 high，
   90 秒本来就紧；而超时的代价是"客户端放弃了、服务端这笔输出照样计费"，
   重发一遍等于同一次抄录付两遍钱。
   所以第一次就直接给 180 秒：慢就慢，别用重试去赌。 */
const VISION_TIMEOUT_MS = 180000;

async function transcribeShots(cfg, shots) {
  const content = [{ type: 'text', text: VISION_PROMPT }];
  for (const b of shots) {
    content.push({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b } });
  }
  const r = await fetchWithTimeout(apiUrlOf(cfg), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
    body: JSON.stringify({
      model: cfg.visionModel || 'deepseek-flash',
      /* 抄录也要给足输出配额：一张截图一道题，题目多了正文就长，
         配额一紧会被截在最后一道题上（"截图里明明有 5 道，抄出来只有 4 道"）。 */
      max_tokens: MAX_TOKENS,
      /* 思考模式：开，档位 high。
         这一步是「认字」不是「解题」，不需要 max —— 认错一个字是像素问题，多想也没用；
         但降到 disabled 又实测会漏认题目里的小字，所以维持 high。 */
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
      messages: [{ role: 'user', content }]
    })
  }, { timeoutMs: VISION_TIMEOUT_MS });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error('看图 API ' + r.status + ' ' + t.slice(0, 200));
  }
  const j = await r.json();
  const pt2 = pickText(j);
  if (pt2.empty) pt2.note = pt2.note.replace('这一章的题这次**一道都没做**', '这次连题目都没抄出来');
  /* 【抄录也要记账】原来这一层连 usage 都不返回，整章花掉多少 token 看不见。
     注意：不索引思考 token，接口没返回的字段我们不猜。 */
  pt2.usage = j && j.usage;
  pt2.attempts = r.__apiAttempts || 1;
  return pt2;
}

const ANSWER_FROM_TEXT = [
  '下面是一份题目抄录（个别字可能是「□」，表示抄的人认不准）。',
  '请逐题给出答案，格式：',
  '  题号. 答案 —— 一句话理由',
  '单选给一个大写字母；判断给「对」或「错」；多选给字母串（如 ABD）。',
  '拿不准就写「不确定」并说明卡在哪，不要硬猜。'
].join('\n');

/* ==================================================================
 * 把 AI 给的答案填进页面 —— 【只填，不交】
 *
 * 边界（这是代码的实际约束，不是客套话）：
 *   这里只做一件事：让题目里对应的选项被选中。
 *   全文件没有一处会去点提交按钮，也没有任何提交逻辑。
 *   提交永远由你自己按。
 *
 * 做法是抄来的，不是我自己想的，两处证据：
 *   1) 拆他程序拿到的代码里有个函数叫 fill_and_click_smart，
 *      里面嵌着 parse_option_letter（用 alphabet + /[^A-F]/ 过滤字母）。
 *   2) 我早先给他写的油猴脚本（_旧版与归档\学习通助手.user.js）里的
 *      qFill() / realClick() 就是照这个思路写的，在真页面上跑过。
 *      那段代码的注释写着「填入（必须人工点）」—— 跟他一样：自动填，提交留给人。
 *
 * 点击方式（这一段是踩出来的，别乱改）：
 *   要发完整的指针事件序列 mouseover → mousedown → mouseup → click，
 *   只发一个 click 页面可能不认。
 *   而且 **只能发一遍**。油猴脚本 v2.6.5 修过一个 bug：
 *   原来 dispatchEvent('click') 之后又补了一次 el.click()，等于点两下。
 *   对"下一节"那种一次性按钮无所谓，但对**开关型**控件是致命的 ——
 *   单选框点两下等于又取消了，看着填了其实是空的。
 *
 * 判断题的特殊情况：
 *   有些判断题的 li 上没有字母，只有两个选项。
 *   那就按位置来：A = 第 1 个，B = 第 2 个（charCodeAt(0) - 65）。
 *
 * 怎么确认真的选上了：
 *   点之前、点之后各读一次那个选项的 outerHTML。平台选中后一定会加 class
 *   或改属性，HTML 必然会变。没变就如实报告失败，不假装成功。
 *   报告里还会带上 class 名，方便以后认出"选中"长什么样。
 *
 * 怎么定位"是哪一道题"：
 *   不能靠序号 —— 抠题那一步有去重，序号会错位。
 *   改成拿题干原文去页面里找（题干本来就是从 DOM 读出来的），从长到短试几个前缀。
 * ================================================================== */

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/* 判断题的答案是一个汉字，但选项上可能写成各种说法 */
const JUDGE_SYN = {
  '对': ['对', '正确', '是', '真', '√', 'T'],
  '错': ['错', '错误', '否', '假', '×', 'F']
};

/* 在页面里把答案点上。只碰选项元素，不碰任何提交按钮。 */
function fillAct(hint, spec) {
  return [
    '(function () {',
    '  var HINT = ' + JSON.stringify(hint) + ';',
    '  var BY = ' + JSON.stringify(spec.by) + ';',
    '  var V = ' + JSON.stringify(spec.v) + ';',
    '  function norm(s) { return String(s == null ? "" : s).replace(/\\s+/g, ""); }',
    '  function allDocs() {',
    '    var out = [document];',
    '    function walk(d, depth) {',
    '      if (depth > 4) return;',
    '      var fs = d.querySelectorAll("iframe");',
    '      for (var i = 0; i < fs.length; i++) {',
    '        var cd = null;',
    '        try { cd = fs[i].contentDocument; } catch (e) {}',
    '        if (cd && cd.body && out.indexOf(cd) < 0) { out.push(cd); walk(cd, depth + 1); }',
    '      }',
    '    }',
    '    walk(document, 0);',
    '    return out;',
    '  }',
    '  function snap(el) { try { return String(el.outerHTML || ""); } catch (e) { return ""; } }',
    '  function cls(el) { try { return String(el.className || ""); } catch (e) { return ""; } }',
    /* 怎么才算"选中"？这是从真页面上看出来的：
         li[aria-checked="true"] / aria-pressed="true"，
         或者子元素上有 .check_answer / .check_answer_dx。
       **不是** li 自己的 class —— 之前我就是只看 li 的 class，
       所以既没认出来已经选中的，也没发现重复点击会取消。

       【2026-10-10 补：要连着往上找几层】
       作业作答页的 DOM 长这样，选中的标记打在**父元素**上：
           <div class="clearfix answerBg workTextWrap" aria-checked="true">   ← 标记在这层
             <div class="fl answer_p" aria-hidden="true"><p>…</p></div>      ← 我们拿到的却是这层
       只查 el 自己就永远读到 null，于是每一道都误报「点了但没选中」，
       而页面上其实早就选好了（截图能看见蓝圈）。
       往上找 4 层足够覆盖这两种结构。 */
    '  function isOn(el) {',
    '    try {',
    '      var n = el;',
    '      for (var up = 0; up < 4 && n; up++) {',
    '        if (String(n.getAttribute("aria-checked")) === "true") return true;',
    '        if (String(n.getAttribute("aria-pressed")) === "true") return true;',
    '        if (n.querySelector && n.querySelector(".check_answer, .check_answer_dx")) return true;',
    '        n = n.parentElement;',
    '      }',
    '    } catch (e) {}',
    '    return false;',
    '  }',
    /* 【改走可信点击（2026-10-07 实测）】
       原来这里是 dispatchEvent 手造 mouseover/mousedown/mouseup/click —— 合成事件
       isTrusted=false，学习通的 addChoice() 不认，10 道题全部报"点了没选中"、一道都填不上。
       驱动那边翻页和起播早就在用 CDP Input.dispatchMouseEvent（真鼠标事件、isTrusted=true，
       见 driver.js 的 clickTop），只有选项点击漏了这一处。
       现在这个函数只负责把坐标算出来（先滚进可视区，再逐层累加 iframe 偏移得到顶层视口坐标），
       真正点下去由驱动侧用 CDP 发；点完由调用方回来复查 selected，不假设成功。 */
    '  function topCoord(el) {',
    '    if (!el) return null;',
    '    try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (e) {}',
    '    var r = el.getBoundingClientRect();',
    '    var x = r.left + r.width / 2, y = r.top + r.height / 2;',
    '    var win = null;',
    '    try { win = el.ownerDocument.defaultView; } catch (e) { win = null; }',
    '    while (win && win !== window) {',
    '      var fe = null;',
    '      try { fe = win.frameElement; } catch (e) { fe = null; }',
    '      if (!fe) break;',
    '      var fr = fe.getBoundingClientRect();',
    '      x += fr.left; y += fr.top;',
    '      win = win.parent;',
    '    }',
    '    return { x: Math.round(x), y: Math.round(y),',
    '             inView: (x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight) };',
    '  }',
    '  var SELS = [".TiMu", ".questionLi", ".question-item", ".test-item", ".queBox", ".exam-question"];',
    /* 【候选选项的选择器要够宽 —— 只认 li.before-after 会在换版/换题型时整章丢题】
       li[qid] 和 [onclick*=addChoice] 是实测抓到的本题真实属性
       （qid="406033888"、onclick="addChoice(this);"）：比 class 稳，
       class 会随字体反爬和版本变（实测见过 font-cxsecret 被写成 font-cx ecret），
       qid / onclick 不会。放在最前面当主判据。 */
    '  var OPT = "li[qid], li[onclick*=addChoice], li.before-after, li[role=radio], li[role=checkbox], .answer_p, .option-item, .Zy_ulTop > li";',
    '  var NUM = "span.num_option, span.num_option_dx, span.check_answer, span.check_answer_dx";',
    '  var roots = [], docs = allDocs();',
    '  for (var d2 = 0; d2 < docs.length; d2++) {',
    '    for (var s = 0; s < SELS.length; s++) {',
    '      var g = docs[d2].querySelectorAll(SELS[s]);',
    '      if (g.length) { for (var k = 0; k < g.length; k++) if (roots.indexOf(g[k]) < 0) roots.push(g[k]); break; }',
    '    }',
    '  }',
    '  var el = null, how = "";',
    /* 【只读预检】只数"页面上现在有几道题"，绝不点任何东西。
       为什么要它：填答案时 DOM 可能还没把题目渲染出来（实测：读题时探针看到 3 题，
       几秒后轮到填，报"页面上共 0 题"，3 道全丢）。
       有了它就能"先等题目回来，再动手" —— 而不是拿一次会点选项的调用来当探针，
       那种探针会顺手把第 1 题点成 A，等于凭空写进一个假答案。 */
    '  if (BY === "probe") {',
    /* 数出 0 题时，光说"0 题"没法查。这里把"看过哪几层、各层有什么"一并带回去：
       —— 实测（2026/9/26 16:33，军事理论 1.14）预检等了 7 秒仍然是 0 题，
          而随后同一门课的选择器实测能找到 .TiMu=3，所以问题是"那一刻题不在可及层里"。
          到底是哪一层缺、work 卡在不在，只有把这些数字带出来才知道。 */
    '    var detail = [];',
    '    for (var di = 0; di < docs.length; di++) {',
    '      var u = ""; try { u = String(docs[di].location && docs[di].location.href || "").slice(0, 60); } catch (e) { u = "(跨源)"; }',
    '      var n1 = 0, n2 = 0, nf = 0;',
    '      try { n1 = docs[di].querySelectorAll(".TiMu").length; } catch (e) {}',
    '      try { n2 = docs[di].querySelectorAll("li.before-after, li[role=radio]").length; } catch (e) {}',
    '      try { nf = docs[di].querySelectorAll("iframe").length; } catch (e) {}',
    '      detail.push(u + " [TiMu=" + n1 + " 选项=" + n2 + " iframe=" + nf + "]");',
    '    }',
    '    var workHere = 0;',
    '    try { workHere = document.querySelectorAll("iframe[src*=modules/work], iframe[src*=work]").length; } catch (e) {}',
    /* 【还要数"看得见几道题"】
       实测（2026/9/26 16:44，军事理论 3.4）：题目**在 DOM 里**（roots=3），
       但切栏没真正切过去（或切过去又被切回来），页面上显示的还是视频卡 ——
       整屏截图拍到的就是视频播放页，模型只能回答"未提供任何题目"。
       光数 DOM 里的条数拦不住这种情况，得数"有尺寸、真的画出来了"的条数。 */
    '    var vis = 0;',
    '    for (var vi = 0; vi < roots.length; vi++) {',
    '      try { var rr = roots[vi].getBoundingClientRect(); if (rr.width > 4 && rr.height > 4) vis++; } catch (e) {}',
    '    }',
    '    return { ok: true, n: roots.length, vis: vis, probe: true, docs: docs.length, workIframe: workHere, detail: detail };',
    '  }',
    '  if (typeof HINT === "number") {',
    '    el = roots[HINT] || null;',
    '    how = "按顺序第 " + (HINT + 1) + " 题";',
    '    if (!el) return { ok: false, why: "按顺序找不到第 " + (HINT + 1) + " 题（页面上共 " + roots.length + " 题）", n: roots.length };',
    '  } else {',
    '    var lens = [40, 24, 16, 10, 6];',
    '    for (var li = 0; li < lens.length && !el; li++) {',
    '      if (HINT.length < lens[li]) continue;',
    '      var h = HINT.slice(0, lens[li]);',
    '      for (var ri = 0; ri < roots.length; ri++) {',
    '        var rt = norm(roots[ri].innerText || roots[ri].textContent || "");',
    '        if (rt.indexOf(h) >= 0) { el = roots[ri]; how = "题干前 " + lens[li] + " 字"; break; }',
    '      }',
    '    }',
    '    if (!el) return { ok: false, why: "定位不到这道题（题干在页面上找不到）", n: roots.length };',
    '  }',
    /* ---------------- 填空题/简答题：把答案打进输入框 ----------------
       选择题那套是"在选项里找一个匹配的点上去"，填空题没有选项，得往框里写。
       页面上这类框有三种长相（照抄对照报告里那套选择器）：
         .blankItemDiv 里的 input、input.blank_input / input[id^=answer]、contenteditable、textarea
       写值不能只设 .value —— 页面靠 input 事件同步内部状态，
       所以填完要派发 input + change。 */
    '  if (BY === "input") {',
    '    var boxSel = ".blankItemDiv input, .blankItemDiv textarea, input.blank_input, input[id^=\'answer\'], textarea[id^=\'answer\'], .blankItemDiv [contenteditable=\'true\'], [contenteditable=\'true\'][data-placeholder], textarea";',
    '    var boxes = [];',
    '    try { boxes = el.querySelectorAll(boxSel); } catch (e) { boxes = []; }',
    '    var vis = [];',
    '    for (var bi = 0; bi < boxes.length; bi++) {',
    '      var bx = boxes[bi];',
    '      try { if (bx.getClientRects && bx.getClientRects().length) vis.push(bx); } catch (e) {}',
    '    }',
    '    if (!vis.length) return { ok: false, why: "这道填空/简答题里没找到可见的输入框", n: roots.length };',
    '    function setVal(node, val) {',
    '      var W2 = window; try { W2 = node.ownerDocument.defaultView || window; } catch (e) {}',
    '      try {',
    '        if (String(node.getAttribute("contenteditable")) === "true") {',
    '          node.focus();',
    '          try { node.innerText = val; } catch (e) { node.textContent = val; }',
    '        } else {',
    '          var proto = node.tagName === "TEXTAREA" ? W2.HTMLTextAreaElement.prototype : W2.HTMLInputElement.prototype;',
    '          var dsc = null;',
    '          try { dsc = Object.getOwnPropertyDescriptor(proto, "value"); } catch (e) { dsc = null; }',
    '          if (dsc && dsc.set) dsc.set.call(node, val); else node.value = val;',
    '          node.focus();',
    '        }',
    '        function ev2(t) { try { node.dispatchEvent(new W2.Event(t, { bubbles: true })); } catch (e) {} }',
    '        ev2("input"); ev2("change"); ev2("keyup"); ev2("blur");',
    '        return true;',
    '      } catch (e) { return false; }',
    '    }',
    '    var tv = (V && V.length) ? String(V[0]) : "";',
    '    var reps = [], anyOk = false;',
    /* 多个空格的填法：按顿号/分号/竖线拆，逐个填；只有一个值就都填成一样 */
    '    var parts = tv.split(/[；;、|]/).map(function (x) { return x.trim(); }).filter(Boolean);',
    '    if (!parts.length) parts = [tv];',
    '    for (var vi2 = 0; vi2 < vis.length; vi2++) {',
    '      var vv2 = parts.length > 1 ? (parts[vi2] !== undefined ? parts[vi2] : parts[parts.length - 1]) : parts[0];',
    '      var was2 = String(vis[vi2].value != null ? vis[vi2].value : (vis[vi2].innerText || ""));',
    '      var ok2 = setVal(vis[vi2], vv2);',
    '      var now2 = String(vis[vi2].value != null ? vis[vi2].value : (vis[vi2].innerText || ""));',
    '      var good = ok2 && now2.indexOf(vv2) >= 0;',
    '      if (good) anyOk = true;',
    '      reps.push({ letter: "#" + (vi2 + 1), clicked: ok2, already: was2 === vv2, selected: good,',
    '                  cls: cls(vis[vi2]), wrote: vv2.slice(0, 30) });',
    '    }',
    '    if (!anyOk) return { ok: false, why: "输入框没写进去（页面不认）", picks: reps, n: roots.length };',
    '    return { ok: true, picks: reps, how: how + "（填空，写了 " + reps.length + " 个空）", n: roots.length, typed: true };',
    '  }',
    '  var cands = el.querySelectorAll(OPT), picks = [];',
    '  for (var i2 = 0; i2 < cands.length; i2++) {',
    '    var sp = cands[i2].querySelector(NUM);',
    '    var lt = sp ? norm(sp.getAttribute("data") || sp.textContent).replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase() : "";',
    '    var t = norm(cands[i2].innerText || cands[i2].textContent || "");',
    '    var body = t.replace(/^[A-Za-z][\\.、．\\)）:：]?/, "");',
    '    var hit = false;',
    /* 【判断题认 data 属性 —— 数据属性，字体换不掉】
       true=对、false=错。文本兜底也先看 aria-label（同样不是屏幕字形），
       最后才轮到比文字，而那段只在 BY 既不是 bool 也不是 letter 时才走。 */
    '    if (BY === "bool") {',
    '      var dv = "";',
    '      try { dv = sp ? String(sp.getAttribute("data") || "").toLowerCase() : ""; } catch (e) { dv = ""; }',
    '      var al = "";',
    '      try { al = String(cands[i2].getAttribute("aria-label") || "").toLowerCase(); } catch (e) { al = ""; }',
    '      if (dv && V.indexOf(dv) >= 0) { hit = true; }',
    '      else if (V[0] === "true" && /对|true|✓|√/.test(al)) { hit = true; }',
    '      else if (V[0] === "false" && /错|false|×|✗/.test(al)) { hit = true; }',
    '    }',
    '    else if (BY === "letter") { hit = !!lt && V.indexOf(lt) >= 0; }',
    /* 【按文字匹配要"双向包含"，不能只判前缀】
       原来这里只判 indexOf(vv) === 0（必须以答案开头）。
       实测会误判：平台把选项写成「A. 错（错误）」时，要点的「错」并不是前缀，
       于是匹配不上、报"没填上"，题就白丢。
       这个改法是照成熟开源项目（Samueli924/chaoxing 的 _validate_text_match）来的：
         p_norm = 去掉开头的字母前缀 → 两边都 strip().lower()
         if item in p_norm or p_norm in item:  匹配
       注意方向有两个：答案可能是选项的一部分，选项也可能是答案的一部分
       （模型只答了"错"，而页面写「错误」）。 */
    '    else { for (var vi = 0; vi < V.length; vi++) {',
    '      var vv = String(V[vi]).toLowerCase(), bb = body.toLowerCase(), tt = t.toLowerCase();',
    '      if (!vv) continue;',
    '      if (bb.indexOf(vv) >= 0 || tt.indexOf(vv) >= 0 || vv.indexOf(bb) >= 0) { hit = true; break; }',
    '    } }',
    '    if (hit) picks.push({ el: cands[i2], letter: lt || ("#" + (i2 + 1)), byPos: false });',
    '  }',
    '  if (!picks.length && BY === "letter" && cands.length) {',
    '    for (var lj = 0; lj < V.length; lj++) {',
    '      var ix = V[lj].charCodeAt(0) - 65;',
    '      if (ix >= 0 && ix < cands.length) picks.push({ el: cands[ix], letter: V[lj], byPos: true });',
    '    }',
    '  }',
    '  if (!picks.length) return { ok: false, why: "这道题里没找到匹配的选项元素", n: roots.length };',
    '  var rep = [];',
    '  for (var p = 0; p < picks.length; p++) {',
    '    var was = isOn(picks[p].el);',
    '    var pos = topCoord(picks[p].el);',
    /* 这里不再自己点。
       已选中的不碰（这个平台点已选中的选项是"取消"）；
       没选中的把顶层坐标交出去，由驱动用 CDP 的真实鼠标事件点，点完再回来复查。 */
    '    rep.push({ letter: picks[p].letter, clicked: false, already: was,',
    '               selected: was,',
    '               cls: cls(picks[p].el), byPos: picks[p].byPos,',
    '               x: pos ? pos.x : null, y: pos ? pos.y : null,',
    '               inView: pos ? pos.inView : false });',
    '  }',
    '  return { ok: true, picks: rep, how: how, n: roots.length, viaCdp: true };',
    '})()'
  ].join('\n');
}

/* 截图读题那条路拿到的是"一大段文字"（形如 1. C —— 理由），不是每题的字母。
   这里把它拆开、按题号顺序填进去。

   为什么用"第几题"而不是题干定位：
   抄录出来的是真字，而页面上存的是替身字 —— 两边文字对不上，没法拿题干匹配。
   所以只能按顺序对位（抄录顺序就是页面顺序）。

   每条仍会检查"点完页面变了没有"，没变就如实报失败。 */
async function fillFromText(ev, text, domCount, deps) {
  const picks = [];
  const skipped = [];          /* 认出来了但填不了的，一条都不许悄悄丢 */
  /* 等待题目出现期间要说的话（比如"重新叫了一次卡片"）——最后并进结论里，
     这样日志里能看出它为了把卡片叫回来做了什么，而不是只报一句"0 题"。 */
  const note = [];
  const reopenQuiz = (deps && deps.reopenQuiz) || null;
  /* 可信点击的通道（驱动注入）。缺了就退化成"只报坐标"，不会炸。 */
  const clickAt = (deps && deps.clickAt) || null;
  /* 【答案解析要能认两种写法 —— 只认一种会整章白丢】
     实测（2026/9/26 23:42，军事理论 9.14 习近平强军思想的核心内容）：
     模型这次没按提示词写 "1. A —— 理由"，而是把答案单独放一行、理由放下一行：
         A
         党对军队的绝对领导是人民军队的建军之本、强军之魂。
         (空行)
         B
         创新是引领发展的第一动力。
         (空行)
         ABCD
         新时代强军事业坚持政治建军、改革强军、科技兴军、依法治军。
     而这里原来只认"带题号的行"，于是一条都认不出来 → 报"没能认出第几题选什么" →
     整章的题一道没填（当晚 6.x、8.x、9.x 全是这个症状，而且题越多越容易触发 ——
     因为题多时模型更容易偷懒不写题号）。
     现在两套规则并存：
       带题号的行 —— 题号本身就是强信号，后面跟什么都认（分隔符是破折号也认）；
       纯答案行   —— 必须"整行只有答案"，而且排除选项行（"A. 积极防御"），
                    否则普通句子里以字母开头的词（"A股…"、"Dr. …"）会被误当成答案。 */
  const OPT_LINE = /^\s*[A-Ha-h]\s*[.、)）]\s*\S/;
  const seenNums = new Set();
  let bareSeq = 0;
  for (const L of String(text || '').split(/\r?\n/)) {
    const mn = L.match(/^\s*(\d{1,2})\s*[.、)）]\s*(?:答案\s*[:：]?\s*)?([A-Fa-f]{1,6}|对|错|正确|错误)/);
    if (mn) {
      const n = Number(mn[1]);
      if (n >= 1) { picks.push({ idx: n - 1, raw: mn[2], n: n }); seenNums.add(n); }
      continue;
    }
    /* 纯答案行：整行只有答案（允许尾部标点/破折号），且不是选项行 */
    const mb = L.match(/^\s*([A-Fa-f]{1,6}|对|错|正确|错误)\s*[.。!！—\-]*\s*$/);
    if (mb && !OPT_LINE.test(L)) {
      /* 按出现顺序对位；但如果这个位置已经被"带题号"的答案占了，就往后找空位 */
      let idx = bareSeq;
      while (seenNums.has(idx + 1)) idx++;
      bareSeq = idx + 1;
      picks.push({ idx: idx, raw: mb[1], n: idx + 1, bare: true });
    }
  }
  /* 【一道都没认出时，也要把"欠了几道"说清楚】
     以前这里只返回一句"没能从模型那段答案里认出第几题选什么，所以没填"就完事，
     账目那边只认"没填上：…"这个格式（见 handle 里那个正则），于是这句被忽略、
     一道题都没记进欠账 —— 上层拿到 missNow=0，就把"全部填上"写进了计数文件。
     实测 2026/9/26 16:24（军事理论 1.10 中国国防历史的主要启示【上】）：
     日志写着"没能认出…所以没填"，计数文件却写着"3 道题 填上 3 欠 0"，两句话互相打架。
     现在把题目数原样带出去，让上层能如实记账。 */
  if (!picks.length) {
    if (deps && typeof deps.onResult === 'function') {
      try { deps.onResult({ filled: 0, failed: 0, skipped: 0, answers: 0, why: 'no_answers_parsed' }); } catch (e) {}
    }
    return '没能从模型那段答案里认出"第几题选什么"，所以一道都没填' +
           (domCount ? ('（页面共 ' + domCount + ' 道）') : '');
  }

  /* 【为什么这里不能再按 domCount 一刀切】
     实测（函数的求导法则）：页面 5 道题、模型给了 5 条答案，可只填上 4 道。
     原因就是 `n > domCount` 那条判断 —— 只要"页面题数"比答案条数少一点，
     后面的答案就被当成"不存在"直接 continue，而且因为既不算 done 也不算 fail，
     日志里连"没填上"都不报，事后根本查不出漏了哪一道。
     现在改成：题号超过 domCount 时**照样去填**（fillAct 自己会报"按顺序找不到第 N 题"），
     并且所有填不上的都记进 skipped，由上层如实报告 + 记进"没做的题"清单。 */
  const done = [], fail = [], skippedMsg = [];

  /* 【部分命中：把"第 k 条答案"换算成页面上真正的第几个题】
     截图只拍"库里没有的"那几道时，模型给的序号是**那一批里的第几道**，
     而 fillAct 要的是"页面上第几个题目元素"。indexMap 由调用方给：
       indexMap[k] = 第 k 条答案（0 起）对应页面上第几个题（0 起）。
     缺省不映射 —— 老行为一个字节不变。
     模型多给的答案（映射不到的）**不填**，并如实记进"跳过"。 */
  const idxMap = (deps && Array.isArray(deps.indexMap) && deps.indexMap.length) ? deps.indexMap : null;
  if (idxMap) {
    for (let i = picks.length - 1; i >= 0; i--) {
      const p = picks[i];
      const real = idxMap[p.idx];
      if (real == null) {
        skippedMsg.push('第' + (p.idx + 1) + '条答案=「' + p.raw + '」（这次只截了 ' + idxMap.length + ' 道题，多出来的答案没填）');
        picks.splice(i, 1);
        continue;
      }
      p.idx = real;
      p.n = real + 1;
    }
  }

  /* 【填之前先确认题目还在，不在就等它回来】
     实测（2026/9/26 16:28，军事理论 1.12 现代国防观）：
     探针明明读到了 3 道题、截图也拍到了、模型也答出来了（BCD / 错 / 错），
     可轮到填的时候，fillAct 报"按顺序找不到第 1 题（页面上共 0 题）" —— 3 道全丢。
     原因不是选择器写错（事后只读实测：同一套选择器能找到 .TiMu=3、li选项=6），
     而是**这几秒里 work 卡的内容被卸载/重载了**：
     读题 → 截图 → 问模型（几秒）→ 填，填的时候 DOM 已经不是读题时那个了。
     所以这里等它回来：数出 0 题就先别急着报失败。 */
  const ready = (n) => (n && typeof n.n === 'number' && n.n > 0);
  /* 【什么叫"能填"】两道关：
       ① 题目在 DOM 里（n>0）——  否则 fillAct 会报"页面上共 0 题"；
       ② 题目**画出来了**（vis>0）—— 否则整屏截图拍到的是别的卡（实测拍到过视频播放页），
          模型看不到题、只能回"未提供任何题目"，答案就是空的。 */
  const fillable = (x) => !!(x && x.n > 0 && (typeof x.vis !== 'number' || x.vis > 0));
  if (picks.length) {
    let peek = null;
    try { peek = await ev(fillAct(0, { by: 'probe', v: [] })); } catch (e) { peek = null; }
    let waitTries = 0, reopened = 0;
    /* 【干等不够，得把卡片叫回来】
       实测（2026/9/26 16:36，军事理论 2.1）：切到「章节测验」栏之后，
       装题目的 work 卡 iframe 会先被卸载、过一会才挂回来；填答案时正好落在"不在"的窗口，
       数出 0 题，3 道答案全丢（层诊断显示 work 卡 iframe=0）。
       干等 7 秒没用 —— 等的是一个不会自己回来的东西。
       所以每隔几轮就重新点一次标签，把卡片叫回来。 */
    while (!fillable(peek) && waitTries < 8) {
      waitTries++;
      await new Promise((r) => setTimeout(r, 1200));
      /* 第 3、6 轮各叫一次（别每轮都点，点太频自己也来不及加载） */
      if (reopenQuiz && (waitTries === 3 || waitTries === 6)) {
        const rr = await reopenQuiz();
        reopened++;
        note.push('（第 ' + waitTries + ' 轮重新打开测验栏叫卡片：' + rr + '）');
      }
      try { peek = await ev(fillAct(0, { by: 'probe', v: [] })); } catch (e) { peek = null; }
    }
    if (waitTries) {
      skippedMsg.push('（题目当时' + (peek && peek.n > 0 ? '在 DOM 里但没显示出来' : '还没渲染出来') +
        '，等了约 ' + Math.round(waitTries * 1.2) + ' 秒' +
        (reopened ? ('、重新叫卡片 ' + reopened + ' 次') : '') +
        (fillable(peek) ? '，回来了）' : '，还是不行）') +
        (peek && typeof peek.vis === 'number' ? ('（DOM ' + peek.n + ' 道 / 可见 ' + peek.vis + ' 道）') : ''));
    }
    /* 还是 0 题就把"看过哪几层"写进日志 —— 否则事后完全无法定位是 work 卡没加载，
       还是页面只加载了部分层。 */
    if (!fillable(peek) && peek && peek.detail) {
      skippedMsg.push('（当时可及文档 ' + peek.docs + ' 层，work 卡 iframe=' + peek.workIframe + '：' +
        String(peek.detail).replace(/https?:\/\//g, '').slice(0, 300) + '）');
    }
  }

  for (const p of picks) {
    let ans = p.raw.toUpperCase();
    if (/^(对|正确)$/.test(p.raw)) ans = '对';
    else if (/^(错|错误)$/.test(p.raw)) ans = '错';

    let spec;
    if (ans === '对' || ans === '错') {
      /* 【判断题改走 data 属性，不看屏幕上的字】
         实测抓到的真实结构（2026-10-07，映射那章 1.1.1）：
             <li class="font-cxsecret before-after" onclick="addChoice(this);" qid="406033888" role="radio">
               <span class="num_option choice406033888" data="true">A</span>
               <a class="fl after">对</a>
         判断题每题就是 A/B 两个 li，值挂在 span.num_option 的 data 上：true=对、false=错。
         这是数据属性 —— 字体反爬（font-cxsecret）换的是字形，换不掉它。
         原来这里走 by:'text' 纯比屏幕文字，在替身字章节里必然全落空
         （实测：数列极限那章 10 道全丢，报"这道题里没找到匹配的选项元素"）。
         vText 只作为 data 取不到时的兜底。 */
      spec = { by: 'bool', v: [ans === '对' ? 'true' : 'false'], vText: JUDGE_SYN[ans] };
    } else {
      const letters = ans.replace(/[^A-F]/g, '').split('').filter(Boolean);
      if (!letters.length) {
        skippedMsg.push('第' + p.n + '题=「' + p.raw + '」（认不出可选字母，没填）');
        continue;
      }
      spec = { by: 'letter', v: letters };
    }
    /* 【点之前先喘口气 —— 按人的节奏来】
       学习通那边的判断依据，从成熟开源项目里能看到明证：
       他们把"上报进度"单独限速成 2 秒一次，注释原话是
         「上报进度极其容易卡验证码，限制2s一次」，
       并且所有请求都带 0~0.2 秒随机抖动。
       我们这边原来是一道题一次 fillAct 连着发 —— 点选项是爆发式的，一眼就是机器。
       所以这里每题之间隔一下，并加随机量，让节奏不整齐。 */
    await new Promise((r) => setTimeout(r, 220 + Math.random() * 260));
    const rr = await clickPicksByCdp(ev, clickAt, p.idx, spec, await ev(fillAct(p.idx, spec)));
    const okAll = rr && rr.ok && rr.picks && rr.picks.length && rr.picks.every((x) => x.selected);
    if (okAll) done.push('第' + (p.idx + 1) + '题=' + ans);
    else fail.push('第' + (p.idx + 1) + '题=' + ans + (rr && rr.why ? '（' + rr.why + '）' : '（点了没选中）'));
  }
  /* 末尾再点一次题数：答案条数比"页面题数"多，说明有题没填到 —— 明确写出来 */
  if (domCount && picks.length > domCount) {
    skippedMsg.push('（模型给了 ' + picks.length + ' 条答案，页面只认到 ' + domCount + ' 道题）');
  }
  /* 【结构化结果 —— 给记账用，不改变返回值】
     deps.onResult 是可选回调：把"填了几道 / 没填上几道 / 跳过几道"用数字报给调用方。
     原来上层只能拿返回的字符串再正则去数，或者更糟 —— 用 found-missed 反推，
     那个数字会把"没填上"也算成填上了。 */
  const report = { filled: done.length, failed: fail.length, skipped: skippedMsg.length, answers: picks.length };
  if (deps && typeof deps.onResult === 'function') {
    try { deps.onResult(report); } catch (e) { /* 记账回调抛错不该打断填充 */ }
  }
  if (!done.length && !fail.length && !skippedMsg.length) return '（答案里没有可填的选择题）';
  let s = '';
  if (done.length) s += '已按顺序填进页面：' + done.join('，');
  if (fail.length) s += (s ? '；' : '') + '没填上：' + fail.join('，');
  if (note.length) s += (s ? '；' : '') + '过程：' + note.join('，');
  if (skippedMsg.length) s += (s ? '；' : '') + '跳过：' + skippedMsg.join('，');
  return s;
}
/* 【用 CDP 的真实鼠标事件点选项】
   合成事件（isTrusted=false）平台不认 —— 见 fillAct 里 topCoord 的注释。
   所以流程变成：fillAct 只算出"要点哪个、在顶层视口的哪个坐标"，
   这里把坐标交给驱动（deps.clickAt → driver.js 的 clickTop，走 Input.dispatchMouseEvent），
   点完再调一次 fillAct 复查 selected。点不上就如实返回，不假装成功。

   clickAt 没注入时（比如单独跑测试）原样返回，退化成"只报坐标"，不会炸。 */
async function clickPicksByCdp(ev, clickAt, hint, spec, rr) {
  if (!rr || !rr.picks || !rr.picks.length || !clickAt) return rr;
  const pending = rr.picks.filter((p) => !p.selected && p.inView &&
    typeof p.x === 'number' && typeof p.y === 'number');
  if (!pending.length) return rr;
  for (const p of pending) {
    try { await clickAt(p.x, p.y); } catch (e) {}
    /* 和 fillAct 里那个"按人的节奏来"保持一致：别连着爆发式点。 */
    await sleepMs(150 + Math.random() * 120);
  }
  const again = await ev(fillAct(hint, spec));
  if (again && again.picks && again.picks.length === rr.picks.length) {
    rr.picks = again.picks.map((x, i) => Object.assign({}, rr.picks[i], { selected: x.selected, cls: x.cls }));
  }
  return rr;
}

/* 返回一句可以直接打进日志的结论。绝不假装成功。 */
async function tryFill(ev, rawStem, answer, type, clickAt) {
  const hint = String(rawStem || '').replace(/\s+/g, '');
  if (!hint) return '（题干是空的，定位不了，没填）';

  let spec;
  if (type === '判断') {
    const syn = JUDGE_SYN[String(answer).trim()];
    if (!syn) return '（判断题答案「' + answer + '」不认识，没填）';
    spec = { by: 'text', v: syn };
  } else if (type === '单选' || type === '多选') {
    const letters = String(answer).toUpperCase().replace(/[^A-F]/g, '').split('').filter(Boolean);
    if (!letters.length) return '（答案「' + answer + '」里没有 A-F 的字母，没填）';
    spec = { by: 'letter', v: letters };
  } else {
    /* 填空题/简答题：答案是文字，往输入框里写。
       注意这里用 by:'input' —— 不能复用 by:'text'，
       那个值在判断题里表示"按选项文字匹配"（对/错、正确/错误…），
       两者混用会让判断题跑去写文本框。 */
    const txt = String(answer).trim();
    if (!txt) return '（' + type + '题答案是空的，没填）';
    spec = { by: 'input', v: [txt] };
  }

  const r = await clickPicksByCdp(ev, clickAt, hint, spec, await ev(fillAct(hint, spec)));
  if (r && r.ok && r.typed && r.picks && r.picks.length) {
    const wrote = r.picks.filter((x) => x.selected).length;
    return '（填空）已写进 ' + wrote + ' 个空：' + r.picks.map((x) => String(x.wrote || '').slice(0, 20)).join(' | ');
  }
  if (!r || !r.ok) return '（没填上：' + ((r && r.why) || '页面没响应') + '）';

  const sel = r.picks.filter((p) => p.selected).map((p) => p.letter);
  const un = r.picks.filter((p) => !p.selected).map((p) => p.letter);
  const pre = r.picks.filter((p) => p.already).map((p) => p.letter);
  const posNote = r.picks.some((p) => p.byPos) ? '（这几个选项没字母，是按位置点的）' : '';

  if (!un.length) {
    return '已选中：' + sel.join('') + posNote +
      (pre.length ? '（' + pre.join('') + ' 本来就已经选着，没重复点）' : '') +
      '（按 aria-checked 确认过）';
  }
  if (!sel.length) {
    return '点了但没选中：' + un.join('') + '（aria-checked 还是 false，得手动点一下）';
  }
  return '部分选中：' + sel.join('') + ' 成功；' + un.join('') + ' 没选中';
}

/* ==================================================================
 * 点「暂时保存」—— 存草稿，**不是提交**
 *
 * 页面上的原样（在答题那个 iframe 里，index.html 里第 4 个文档）：
 *     <a class="btnSave   workBtnIndex" onclick="noSubmit();">暂时保存</a>
 *     <a class="btnSubmit workBtnIndex" onclick="btnBlueSubmit();">提交</a>
 *
 * 注意那个函数名：平台自己把它叫 noSubmit —— 就是"不提交"。
 *
 * 为什么需要它：
 *   光把选项点上、不保存，一离开这一页草稿就没了；下次进来还是空的。
 *   点一下「暂时保存」，答案存在平台那侧，驱动器就能接着往下走。
 *
 * 安全闸（先挡提交，再谈保存 —— 顺序不能反）：
 *   只要文字里有「提交」「交卷」，或者 class/id/onclick 里出现 submit 标记，
 *   一律拒绝并如实报告。**不因为名字里有 noSubmit 就直接放行** ——
 *   noSubmit 只是"已知的保存函数名"，还要按源码复核。
 *   宁可保存不上，也不许点错。全文件除了这里，没有第二处点按钮的地方。
 *
 * 【兜底直调那条路一样过闸】
 *   原来"找不到按钮"时会直接调 window.noSubmit()，完全不过上面这套判断 ——
 *   等于主闸门拒掉的候选，在这里变成了"页面上没有按钮"的理由被绕过。
 *   现在直调之前先做只读复核（见 quiz-state.js 的 inspectDirectSaveSource），
 *   复核不过就**不调**，改成明确报"待人工保存"。
 * ================================================================== */
function saveProbe() {
  return [
    '(function () {',
    '  function norm(s) { return String(s == null ? "" : s).replace(/\\s+/g, "").trim(); }',
    '  function allDocs() {',
    '    var out = [document];',
    '    function walk(d, depth) {',
    '      if (depth > 4) return;',
    '      var fs = d.querySelectorAll("iframe");',
    '      for (var i = 0; i < fs.length; i++) {',
    '        var cd = null; try { cd = fs[i].contentDocument; } catch (e) {}',
    '        if (cd && cd.body && out.indexOf(cd) < 0) { out.push(cd); walk(cd, depth + 1); }',
    '      }',
    '    }',
    '    walk(document, 0); return out;',
    '  }',
    '  function vis(el) {',
    '    try { var r = el.getBoundingClientRect();',
    '      if (r.width < 2 || r.height < 2) return false;',
    '      var st = (el.ownerDocument.defaultView || window).getComputedStyle(el);',
    '      if (!st || st.display === "none" || st.visibility === "hidden") return false;',
    '      return true; } catch (e) { return false; }',
    '  }',
    /* 基线的取法：
       ① 页面上**已经存在**的提示词（"保存成功"这类提示条不会自己消失，
          上一轮遗留的那句会把这一次的"没存上"判成"存上了"）；
       ② 保存按钮现在的"状态指纹"（文字 + class + disabled）——
          之后只看**新出现**的状态，不去相信"文字变了"本身。 */
    '  function toastList(t) {',
    '    var out = [];',
    '    var re = /保存成功|保存已成功|已保存|暂存成功|保存成|保存失败|暂存失败|保存出错|提交失败|保存不了/g;',
    '    var m;',
    '    while ((m = re.exec(String(t || ""))) !== null) { if (out.indexOf(m[0]) < 0) out.push(m[0]); if (m.index === re.lastIndex) re.lastIndex++; }',
    '    return out;',
    '  }',
    '  function textOf(el) { try { return String(el.innerText || el.textContent || ""); } catch (e) { return ""; } }',
    '  var docs = allDocs(), cands = [], rejected = [], seenReject = [];',
    '  for (var d = 0; d < docs.length; d++) {',
    '    var list = docs[d].querySelectorAll("a.btnSave, .btnSave, [onclick*=noSubmit], [onclick*=saveWork]");',
    '    for (var i = 0; i < list.length; i++) {',
    '      var el = list[i];',
    '      var tx = norm(textOf(el));',
    '      var oc = String(el.getAttribute("onclick") || "");',
    '      var cl = String(el.className || "");',
    '      var id = String(el.getAttribute("id") || "");',
    /* ---- 硬闸门：先挡提交 ---- */
    /* 判"是不是提交"不能只看有没有 submit 这个词 ——
       保存按钮的 onclick 就是 noSubmit(); 里面就有 submit。
       白名单允许 noSubmit / saveWork 这两个已知名字；
       除此之外，oc 里出现 submit 就算提交。
       剥掉 noSubmit 再看的写法太宽：它把"noSubmit_fake()"这类也放过去了。 */
    '      var ocSubmit = /\\bsubmit\\b/i.test(oc) && !/^\\s*(window\\.)?(noSubmit|saveWork)\\s*\\(/i.test(oc);',
    '      var isSubmit = /提交|交卷/.test(tx) || /btnSubmit|btnBlueSubmit|submitValidate|submitWork/i.test(cl + " " + id + " " + oc) || ocSubmit;',
    '      if (isSubmit) { rejected.push((tx || oc || cl).slice(0, 40)); continue; }',
    '      var okText = /^(暂时保存|保存|暂存|保存草稿|保存答案)$/.test(tx);',
    '      if (!(okText || /btnSave/i.test(cl) || /noSubmit|saveWork/i.test(oc))) continue;',
    /* 看得见但没有尺寸的（比如隐藏的备用按钮）跳过，并说明原因 */
    '      if (!vis(el)) { seenReject.push("（有个保存类元素但不可见：" + (tx || cl || oc).slice(0, 30) + "）"); continue; }',
    '      cands.push({ el: el, text: tx, cls: cl, id: id, onclick: oc });',
    '    }',
    '  }',
    '  var btnBefore = [];',
    '  for (var b = 0; b < cands.length; b++) {',
    '    var be = cands[b].el;',
    '    var st2 = "";',
    '    try { st2 = String(be.getAttribute("disabled")) + "|" + String(be.className || ""); } catch (e) {}',
    '    btnBefore.push({ text: norm(textOf(be)), cls: String(cands[b].cls || ""), state: st2 });',
    '  }',
    '  var baseToasts = [];',
    '  for (var d4 = 0; d4 < docs.length; d4++) {',
    '    var tl = toastList(docs[d4].body ? String(docs[d4].body.innerText || "") : "");',
    '    for (var t4 = 0; t4 < tl.length; t4++) if (baseToasts.indexOf(tl[t4]) < 0) baseToasts.push(tl[t4]);',
    '  }',
    /* 【找不到按钮：先只读复核，通过了才敢直调】 */
    '  function srcOf(f) { try { return String(f.toString()); } catch (e) { return ""; } }',
    '  if (!cands.length) {',
    '    var direct = null;',
    '    for (var d2 = 0; d2 < docs.length && !direct; d2++) {',
    '      var w3 = null;',
    '      try { w3 = docs[d2].defaultView || window; } catch (e) { w3 = null; }',
    '      if (!w3) continue;',
    '      var names = ["saveWork", "noSubmit"];',
    '      for (var n2 = 0; n2 < names.length && !direct; n2++) {',
    '        var nm = names[n2], fn = null;',
    '        try { fn = w3[nm]; } catch (e) { fn = null; }',
    '        if (typeof fn !== "function") continue;',
    '        var src = srcOf(fn);',
    '        direct = {',
    '          name: nm,',
    '          source: src,',
    '          sourceLen: src.length,',
    '          sourceHasSubmit: /submitValidate|btnBlueSubmit|requestSubmit|submitWork|\\.submit\\s*\\(|form\\.submit|交卷|提交/i.test(src),',
    '          sourceLooksLikeSave: /ajax|XMLHttpRequest|fetch|\\$\\.(post|ajax)|save|保存|暂存/i.test(src),',
    '          sourceHasNoSubmitName: /noSubmit|saveWork/.test(src)',
    '        };',
    '      }',
    '    }',
    '    if (!direct) {',
    /* 退路二：页面上有 [onclick*=noSubmit] 的元素但不可见/不在候选里 —— 也不许 .click()。
       .click() 会真按下去，而它一样没过闸门，风险跟直调页面函数是同一类。
       这里只把它作为"线索"报出去，让上层报"待人工保存"。 */
    '      var alt = null;',
    '      for (var d3 = 0; d3 < docs.length && !alt; d3++) {',
    '        try { alt = docs[d3].querySelector("[onclick*=noSubmit], [onclick*=saveWork]"); } catch (e) { alt = null; }',
    '      }',
    /* 【日志要能分清两种失败】"一个保存类元素都没有"和"只有提交类按钮、已拒绝"
       是两件事：前者可能是页面还没渲染好，后者是安全闸门真的挡下了一次点击。 */
    '      var why;',
    '      if (rejected.length) {',
    '        why = "只找到提交类按钮，已拒绝：" + rejected.join("/");',
    '      } else if (alt) {',
    '        why = "有 onclick=noSubmit/saveWork 的元素，但它不可见、也没通过闸门，不敢点（待人工保存）";',
    '      } else {',
    '        why = "页面上既没有「暂时保存」按钮，也没有可复核的保存函数（待人工保存）";',
    '      }',
    '      return { ok: false, kind: "none", why: why, rejected: rejected, notes: seenReject, baseToasts: baseToasts, btnBefore: btnBefore, direct: null };',
    '    }',
    '    var dcall = null, derr = "", dres = null;',
    /* 【复核不过就不调】判据在 quiz-state.js 的 inspectDirectSaveSource 里，
       这里只把事实（名字 / 源码 / 有没有提交字样）带回去。 */
    '    var risky = direct.sourceHasSubmit;',
    '    if (risky) {',
    '      return { ok: false, kind: "direct_refused", direct: direct,',
    '               why: direct.name + "() 的源码里出现提交行为，已拒绝直调（待人工保存）",',
    '               rejected: rejected, notes: seenReject, baseToasts: baseToasts, btnBefore: btnBefore };',
    '    }',
    '    try {',
    '      var w4 = null;',
    '      for (var d5 = 0; d5 < docs.length && !w4; d5++) { try { if (typeof (docs[d5].defaultView || {})[direct.name] === "function") w4 = docs[d5].defaultView; } catch (e) {} }',
    '      var target = w4 || window;',
    '      dres = target[direct.name]();',
    '      dcall = true;',
    '    } catch (e) {',
    /* 【空 catch 改成可追踪】原来这里是 `catch (e) {}` ——
       "页面抛错"和"调用成功"在日志里长得一模一样，等于把失败吞掉了。 */
    '      dcall = false; derr = String((e && e.message) || e).slice(0, 160);',
    '    }',
    '    var b4 = [];',
    '    try {',
    '      var bt4 = String(document.body ? document.body.innerText || "" : "");',
    '      b4 = toastList(bt4);',
    '    } catch (e) {}',
    '    var txtAfter = "";',
    '    try {',
    '      var wsel = "a.btnSave, .btnSave, [onclick*=saveWork], [onclick*=noSubmit]";',
    '      for (var d6 = 0; d6 < docs.length && !txtAfter; d6++) {',
    '        var e6 = null; try { e6 = docs[d6].querySelector(wsel); } catch (e) { e6 = null; }',
    '        if (e6) txtAfter = norm(textOf(e6));',
    '      }',
    '    } catch (e) {}',
    '    return { ok: true, direct: true, how: direct, callOk: dcall, callError: derr, result: (dres === undefined ? "" : String(dres).slice(0, 120)),',
    '             baseToasts: baseToasts, btnBefore: btnBefore, btnAfter: txtAfter, btnText: txtAfter };',
    '  }',
    '  var el2 = cands[0].el;',
    '  try { el2.scrollIntoView({ block: "center", inline: "center" }); } catch (e) {}',
    '  var w2 = (el2.ownerDocument && el2.ownerDocument.defaultView) || window;',
    '  var r2 = el2.getBoundingClientRect();',
    '  var cx = r2.left + r2.width / 2, cy = r2.top + r2.height / 2;',
    '  function mk(t2) { try { return new w2.MouseEvent(t2, { bubbles: true, cancelable: true, view: w2, clientX: cx, clientY: cy, button: 0 }); } catch (e) { return null; } }',
    '  var evs = [mk("mouseover"), mk("mousedown"), mk("mouseup"), mk("click")];',
    '  var clickErr = "";',
    '  try { for (var k = 0; k < evs.length; k++) if (evs[k]) el2.dispatchEvent(evs[k]); }',
    '  catch (e) { clickErr = String((e && e.message) || e).slice(0, 120); }',
    '  return { ok: true, text: cands[0].text, cls: String(el2.className || ""), id: String(el2.getAttribute("id") || ""),',
    '           onclick: String(el2.getAttribute("onclick") || ""), clickError: clickErr,',
    '           cands: cands.length, rejected: rejected, notes: seenReject,',
    '           baseToasts: baseToasts, btnBefore: btnBefore };',
    '})()'
  ].join('\n');
}

/* 扫一遍页面上"现在"有哪些保存提示，以及保存按钮的"状态指纹"。
   不做任何点击 —— 纯只读，轮询时反复调用它。 */
const SAVE_STATE = `(function () {
  function allDocs() {
    var out = [document];
    function walk(d, depth) {
      if (depth > 4) return;
      var fs = d.querySelectorAll('iframe');
      for (var i = 0; i < fs.length; i++) {
        var cd = null; try { cd = fs[i].contentDocument; } catch (e) {}
        if (cd && cd.body && out.indexOf(cd) < 0) { out.push(cd); walk(cd, depth + 1); }
      }
    }
    walk(document, 0); return out;
  }
  function norm(s) { return String(s == null ? '' : s).replace(/\\s+/g, '').trim(); }
  var docs = allDocs(), toasts = [], btns = [], texts = [];
  var re = /保存成功|保存已成功|已保存|暂存成功|保存成|保存失败|暂存失败|保存出错|提交失败|保存不了/g;
  for (var d = 0; d < docs.length; d++) {
    var doc = docs[d];
    var t = doc.body ? String(doc.body.innerText || '') : '';
    /* 整页文字也带回去：判定"是不是**新**出现的提示"要用它跟点之前的基线比，
       光比命中词列表分不清"同一句话还在那儿"和"又冒出来一句"。 */
    if (t && texts.length < 6) texts.push(t.slice(0, 4000));
    var m;
    while ((m = re.exec(t)) !== null) { if (toasts.indexOf(m[0]) < 0) toasts.push(m[0]); if (m.index === re.lastIndex) re.lastIndex++; }
    var list = null;
    try { list = doc.querySelectorAll('a.btnSave, .btnSave, [onclick*=noSubmit], [onclick*=saveWork]'); } catch (e) { list = null; }
    if (!list) continue;
    for (var i = 0; i < list.length; i++) {
      var el = list[i], st = '', tx = '';
      try { tx = norm(el.innerText || el.textContent || ''); } catch (e) {}
      try { st = String(el.getAttribute('disabled')) + '|' + String(el.className || ''); } catch (e) {}
      btns.push({ text: tx, state: st });
    }
  }
  /* 有没有"正在保存"的遮罩/转圈 —— 同样是只读，只是拿来决定要不要继续等 */
  var busy = 0;
  for (var d2 = 0; d2 < docs.length; d2++) {
    try {
      var bl = docs[d2].querySelectorAll('.loading, .layui-layer-loading, .mask, .blockUI, .el-loading-mask, .weui-loading, [class*=loading], [class*=Loading]');
      for (var b2 = 0; b2 < bl.length; b2++) {
        var r2 = bl[b2].getBoundingClientRect();
        if (r2.width > 4 && r2.height > 4) { busy++; break; }
      }
    } catch (e) {}
  }
  return { toasts: toasts, btns: btns, busy: busy, text: texts.join('\\n') };
})()`;

/* 把"点完之后新出现的状态"给人话化。注意这里面**没有**任何一条能证明保存成功
   —— 按钮文字/转圈只能说明"点击被页面接收了"。 */
function describeSaveProgress(now, prev, clickedAt) {
  const bits = [];
  const before = Array.isArray(prev) ? prev : [];
  const list = (now && now.btns) || [];
  const seenSaving = [];
  for (let i = 0; i < list.length; i++) {
    const b = list[i] || {};
    const old = before[i] || null;
    const textKind = QS.classifyButtonText(b.text);
    const stateChanged = !old || old.state !== b.state;
    if (textKind === 'saving') seenSaving.push('按钮文字变成「' + b.text + '」');
    else if (stateChanged && old && /disabled/i.test(String(b.state)) && !/^true/.test(String(b.state))) {
      seenSaving.push('按钮被禁用');
    } else if (stateChanged && old) {
      seenSaving.push('按钮状态变了（' + String(b.state).replace(/\|/g, ' ') + '）');
    }
  }
  if (now && now.busy > 0) seenSaving.push('页面上出现了加载遮罩');
  if (clickedAt) { /* 时间戳只用来在日志里对齐，不参与判定 */ }
  if (seenSaving.length) bits.push('看到' + [...new Set(seenSaving)].join('、'));
  return bits;
}

/* 【返回一句可以直接打进日志的结论】
   老接口：返回**字符串**。driver.js / 网页控制台 都是这么用的，不能改。
   新接口：saveDraftResult(ev) 返回结构化结果（saveDraft 就是它的 msg）。
   状态机在 quiz-state.js 里，四条铁律：
     · 只有页面上出现**新的**保存成功提示，才算"已确认保存"；
     · 按钮文字变化只说明点击被接收（"保存中"），**绝不结案**；
     · 点保存**之前**就已经在页面上的那句提示，一律不算证据；
     · 未确认保存时明确告诉调用方"别接着做会丢草稿的事"。 */
async function saveDraftResult(ev, waitOpt) {
  /* 轮询节奏。
     默认：先 4×700ms 看有没有出现"保存中"；真出现了再把等待拉长到 6×1200ms
     （总共约 10 秒）—— 原先是死等 6×700ms（约 4.2 秒）就下结论，慢网络下必然误判。
     waitOpt 只是给离线测试用的（把间隔压到几毫秒），**生产路径不传**，
     所以真实等待时间不受影响。 */
  const W = waitOpt || {};
  const FAST_ROUNDS = Number(W.fastRounds) > 0 ? Number(W.fastRounds) : 4;
  const FAST_MS = Number(W.fastMs) > 0 ? Number(W.fastMs) : 700;
  const SLOW_ROUNDS = Number(W.slowRounds) >= 0 ? Number(W.slowRounds) : 6;
  const SLOW_MS = Number(W.slowMs) > 0 ? Number(W.slowMs) : 1200;
  let r = null;
  try {
    r = await ev(saveProbe());
  } catch (e) {
    return QS.makeSaveResult(QS.SAVE.FAILED, '没保存：探测保存按钮时页面报错（' + ((e && e.message) || e) + '）',
      { reason: 'probe_error', evidence: { kind: 'error', detail: (e && e.message) || String(e) } });
  }
  if (!r) {
    return QS.makeSaveResult(QS.SAVE.FAILED, '没保存：拿不到保存按钮的状态（页面没响应）',
      { reason: 'probe_empty' });
  }
  if (!r.ok) {
    const rejected = Array.isArray(r.rejected) ? r.rejected : [];
    const directRefused = r.kind === 'direct_refused';
    const status = rejected.length || directRefused ? QS.SAVE.REJECTED : QS.SAVE.FAILED;
    const reason = rejected.length ? 'submit_button_only'
      : (directRefused ? 'direct_call_refused' : 'no_save_button');
    /* 拒绝和"根本找不到按钮"必须能在日志里分开 —— 前者是闸门真的挡了一次点击，
       后者多半是页面还没渲染好。 */
    const msg = (rejected.length
      ? '没保存：只找到提交类按钮，已拒绝（' + rejected.join('/') + '）'
      : (directRefused
        ? '没保存：' + (r.why || '兜底直调没通过复核')
        : ('没保存：' + ((r.why) || '拿不到按钮')))) +
      '（页面上的答案可能会丢，自己瞄一眼）';
    const res = QS.makeSaveResult(status, msg, {
      reason: reason,
      evidence: {
        kind: rejected.length ? 'submit_rejected' : 'no_button',
        detail: r.why || '',
        rejected: rejected,
        notes: r.notes || []
      }
    });
    res.needManualSave = true;
    return res;
  }

  /* ---------- 从这一刻开始：点击已经发出去了 ---------- */
  const baseToasts = Array.isArray(r.baseToasts) ? r.baseToasts : [];
  const btnBefore = Array.isArray(r.btnBefore) ? r.btnBefore : [];
  const clickedAt = Date.now();
  const howText = r.direct
    ? (r.how && r.how.name ? (r.how.name + '()（页面函数直调，源码复核通过）') : '页面函数直调')
    : ('「' + (r.text || '') + '」(' + (r.onclick || '') + ')');
  const origin = r.direct ? 'direct_fn' : 'button';

  /* 直调那一步自己就抛错了 —— 这不是"未确认"，这是明确的失败，而且要说清死因 */
  if (r.direct && r.callOk === false) {
    const res = QS.makeSaveResult(QS.SAVE.FAILED,
      '调用了 ' + howText + ' 但页面抛错：' + (r.callError || '（没给出原因）') + ' —— 这次没能保存',
      { reason: 'direct_call_threw', origin: origin, evidence: { kind: 'error', detail: r.callError || '' } });
    res.needManualSave = true;
    return res;
  }

  let sawSaving = [];
  let latest = null;
  let savedHit = '';
  let failedHit = '';
  let roundsRun = 0;
  const pollOnce = async () => {
    let st = null;
    try { st = await ev(SAVE_STATE); } catch (e) { st = null; }
    roundsRun++;
    if (!st) return false;
    latest = st;
    /* 【只认基线里没有的新提示】—— 上一轮遗留的"保存成功"不算数。
       这一步用的是 quiz-state.js 里那份**有测试覆盖**的判定：
       它同时看"命中词列表"和"整页文字"，能分清"老提示还在"和"新提示出现"。
       实测踩过的坑：提示条不会自己消失，上次那句会把这次的"没存上"判成"存上了"。 */
    const cls = QS.classifyToastNow(st.text != null ? st.text : (st.toasts || []).join(' '), baseToasts);
    if (cls.kind === 'failed') { failedHit = cls.hit || '保存失败'; return true; }
    if (cls.kind === 'saved') { savedHit = cls.hit || '保存成功'; return true; }
    const prog = describeSaveProgress(st, btnBefore, clickedAt);
    if (prog.length) for (const p of prog) if (sawSaving.indexOf(p) < 0) sawSaving.push(p);
    return false;
  };

  let done = false;
  for (let i = 0; i < FAST_ROUNDS && !done; i++) {
    await sleepMs(FAST_MS);
    done = await pollOnce();
  }
  if (!done && sawSaving.length) {
    /* 有"正在保存"的迹象 → 值得多等一会 */
    for (let i = 0; i < SLOW_ROUNDS && !done; i++) {
      await sleepMs(SLOW_MS);
      done = await pollOnce();
    }
  }
  const waitedMs = roundsRun >= FAST_ROUNDS && sawSaving.length
    ? FAST_ROUNDS * FAST_MS + (roundsRun - FAST_ROUNDS) * SLOW_MS
    : roundsRun * FAST_MS;
  const waitedNote = '（轮询 ' + roundsRun + ' 次，约 ' + Math.round(waitedMs / 1000) + ' 秒）';

  /* 直调那条路连"点了哪个按钮"都没有 —— 只有函数调用的返回值可查 */
  if (savedHit) {
    return QS.makeSaveResult(QS.SAVE.SAVED,
      '已点 ' + howText + '，页面出现「' + savedHit + '」' + waitedNote,
      { reason: 'toast_saved', origin: origin, evidence: { kind: 'toast', detail: '页面新增提示：' + savedHit, at: clickedAt, rounds: roundsRun } });
  }
  if (failedHit) {
    const res = QS.makeSaveResult(QS.SAVE.UNCONFIRMED,
      '已点 ' + howText + '，但页面出现「' + failedHit + '」' + waitedNote + ' —— 草稿很可能没存上',
      { reason: 'toast_failed', origin: origin, evidence: { kind: 'toast', detail: '页面新增提示：' + failedHit, at: clickedAt, rounds: roundsRun } });
    res.needManualSave = true;
    return res;
  }
  if (r.clickError) {
    const res = QS.makeSaveResult(QS.SAVE.UNCONFIRMED,
      '点了 ' + howText + '，但派发点击时页面抛错（' + r.clickError + '）—— 没能确认保存',
      { reason: 'click_threw', origin: origin, evidence: { kind: 'error', detail: r.clickError } });
    res.needManualSave = true;
    return res;
  }
  const middle = sawSaving.length ? ('，期间' + sawSaving.join('，') + '（但这只是"正在保存"，不是存好了）') : '';
  const res = QS.makeSaveResult(QS.SAVE.UNCONFIRMED,
    '已点 ' + howText + '，但' + waitedNote + '内没看到平台的保存成功提示' + middle +
    ' —— **没能确认已保存**，请自己回页面看一眼草稿在不在',
    { reason: 'no_proof', origin: origin,
      evidence: { kind: 'none', detail: sawSaving.join('；'), at: clickedAt, rounds: roundsRun,
        baseToasts: baseToasts, latestToasts: (latest && latest.toasts) || [] } });
  res.needManualSave = true;
  return res;
}

/* 旧接口：返回一句人话。driver.js 与控制台都按字符串用。 */
async function saveDraft(ev) {
  const r = await saveDraftResult(ev);
  return r.msg;
}
/* ------------------------------------------------------------------
 * 给 driver.js 调的总入口。
 * 返回一段可以直接打到日志里的文字（数组）。
 *
 * deps.shot 是驱动传进来的截图函数，截图读题那条路才用得到。
 * ------------------------------------------------------------------ */
function makeHelper(cfg, deps) {
  const shot = (deps && deps.shot) || (async () => '');
  const evFn = (deps && deps.ev) || (async () => undefined);
  const reopenQuiz = (deps && deps.reopenQuiz) || null;
  /* 【可信点击通道】驱动注入的 CDP 鼠标点击（driver.js 的 clickTop）。
     选项点击原来用合成事件，平台不认 —— 现在统一走这里。 */
  const clickAt = (deps && deps.clickAt) || null;
  /* 【第 3 条的护栏】同一章里同一道题只处理一次。
     指纹从"题干前 80 字 + 选项个数"换成了"解码后完整题干 + 全部选项 + 题型"的短哈希
     （见 quiz-state.js 的 makeFingerprinter）—— 原来那道指纹会让同一页两道
     前 80 字相同的题里的第二道被**静默**丢掉。 */
  const fp = QS.makeFingerprinter({
    decode: (s) => (loadFontTable() ? decodeObf(s).text : String(s))
  });
  const done = new Set();
  const doneWhy = new Map();   /* 指纹 -> "在哪被处理过"，被跳过时要说得出原因 */
  /* 【跨运行复用模型答案】只缓存答案，不缓存"页面已填好/平台已完成"这种假信息。 */
  let answerCache = null;
  /* 上一道题保存的结果。未确认保存时上层不该接着做会丢草稿的动作。 */
  let lastSave = null;
  /* 【结构化保存结果的存放处 —— 必须在 makeHelper 作用域里】
     它原来只声明在 handle() 内部（`let saveResult = null;`），
     而 lastSaveResult() 是挂在返回对象上的公开方法、活在 handle 之外 ——
     于是 `helper.lastSaveResult()` 会直接 ReferenceError，
     调用方（填作业.js）的 try/catch 把它吞掉，看起来"没结果"。
     现在放到这里：初始 null，每次 handle 开头清空，noteSave 时和 lastSave 一起更新。 */
  let saveResult = null;
  /* 这一章的模型用量（含抄录那一步） */
  let usage = QS.emptyUsage();

  /* 缓存文件读一次就够；写的时候合并。 */
  const cacheLoad = () => {
    if (answerCache) return answerCache;
    try {
      answerCache = QS.parseAnswerCache(fs.existsSync(ANSWER_CACHE_FILE)
        ? fs.readFileSync(ANSWER_CACHE_FILE, 'utf8') : '');
    } catch (e) {
      answerCache = QS.emptyAnswerCache();
    }
    return answerCache;
  };
  const cacheStore = () => {
    if (!answerCache) return;
    try {
      fs.writeFileSync(ANSWER_CACHE_FILE, QS.serializeAnswerCache(answerCache), 'utf8');
    } catch (e) { /* 缓存写不了不该影响答题 */ }
  };
  /* 【缓存命中要严】指纹 + 题型 + 模型配置（model|visionModel）+ 结构版本，
     四条全中才算命中；任何一条不中就当没有，重新问模型。
     用户换了模型 → 老答案自动失效（缓存里记着签名，不用人工清）。 */
  const cacheGet = (fpKey, type) => QS.cacheGet(cacheLoad(), fpKey, type, cfg);
  const cachePut = (fpKey, type, answer, reason) => {
    answerCache = QS.cachePut(cacheLoad(), fpKey, type, answer, reason, cfg);
  };

  /* 【本地题库】命中就省一次模型调用。优先级：
       模型答案缓存（同一个模型、自己跑出来的，更贴近当前配置）
         → 本地题库（可能是别人记录建的库）
         → 问模型
     没有 题库.json / 读坏了 / 指纹或题型对不上 → 一律当没命中，走原路。
     ★ 库是**用户数据**：没装库时这几行一行都不执行，答题行为与以前完全一致。 */
  let bankObj = null;
  let bankTried = false;
  let bankBuiltAt = 0;      /* 现在这份库是什么时候读进来的（用来判"记录是不是更新了"） */
  let bankBuiltAtFor = 0;   /* 上一次自动重建的**记录**时间戳（防抖：别每章都重建一遍） */
  const BANK_REBUILD_GAP_MS = 3 * 60 * 1000;
  let bankHits = 0;         /* 这一章有几道题是"靠库答的"（= 省下的模型调用） */
  let bankSkipped = 0;      /* 库里有、但因为图片对不上而不敢用的题数 */
  let bankLastNote = '';    /* 自动重建库的说明（打一次进日志，让人知道库变了） */
  let courseMap = null, courseMapTried = false;   /* 课程id → 课程名（学习页上没有名字，靠 _课程名.json 翻） */
  const COURSE_MAP_FILE = '_课程名.json';

  /* 【自动入库】记录文件比库新 → 自己重建一次库，不用人再去跑 题库.js。
     为什么要防抖：每答完一章记录都会变，不加节流就变成"每章重建一次"（每次 1~2 秒，纯浪费）。
     所以：最多每 3 分钟重建一次；任何一步失败都**退回用旧库**，绝不打断答题。 */
  const bankAutoRebuild = () => {
    try {
      const rec = OUT_FILE;
      if (!fs.existsSync(rec)) return '';
      const recAt = fs.statSync(rec).mtimeMs;
      const bankAt = fs.existsSync(BANK_FILE) ? fs.statSync(BANK_FILE).mtimeMs : 0;
      if (bankAt && bankAt >= recAt) return '';                     /* 库不比记录旧，不用重建 */
      if (Date.now() - bankBuiltAtFor < BANK_REBUILD_GAP_MS) return ''; /* 刚重建过，等一会 */
      bankBuiltAtFor = Date.now();
      /* 【按课程分流】有课程名的条目 → `题库\<课程>.json`，没有的（老记录）→ 主库。
         每一处都是**合并**（不是覆盖）：所以别的机器导进来的、你在控制台手工加的，都不会被冲掉；
         而且合并是幂等的（同一个来源重复合并不动票数、不涨档位）。 */
      const sp = QB.buildSplitFromFile(rec, {});
      const dir = path.dirname(BANK_FILE);
      const sub = path.join(dir, QB.SUB_DIR);
      let moved = 0, libs = 0;
      for (const courseName of Object.keys(sp.libs)) {
        const bank = sp.libs[courseName];
        const n = Object.keys(bank.entries || {}).length;
        if (!n) continue;
        const p = path.join(sub, QB.libNameOf(courseName) + '.json');
        let cur = QB.loadBank(p) || QB.parseBank('');
        const m = QB.mergeBank(cur, bank, { from: '记录', preserveSources: true });
        try {
          fs.mkdirSync(sub, { recursive: true });
          fs.writeFileSync(p, QB.serializeBank(m.bank), 'utf8');
          moved += n; libs++;
        } catch (e) { /* 这个课程写不进去就跳过，别影响别的 */ }
      }
      /* 主库：一样用**合并**，不是覆盖 —— 你手工导进主库的东西不许被冲掉。
         （以前这里是直接写，等于"主库不承载手工数据"；现在统一成"合并"，语义更稳。）
         合并是幂等的：同一个来源重复合并不动票数、不涨档位。 */
      let mainTotal = 0;
      try {
        const curMain = QB.loadBank(BANK_FILE) || QB.parseBank('');
        const mm = QB.mergeBank(curMain, sp.main, { from: '记录', preserveSources: true });
        fs.writeFileSync(BANK_FILE, QB.serializeBank(mm.bank), 'utf8');
        mainTotal = Object.keys(mm.bank.entries || {}).length;
      } catch (e) {
        /* 主库合并失败 → 退回"覆盖式重建"（记录是原始账本，覆盖也是安全的） */
        fs.writeFileSync(BANK_FILE, QB.serializeBank(sp.main), 'utf8');
        mainTotal = Object.keys(sp.main.entries || {}).length;
      }
      bankTried = false; bankObj = null; bankListCache = null;       /* 让下一句读新库 */
      return '（记录比库新 → 自动重建了一次：主库 ' + mainTotal + ' 条' +
        (moved ? ('，另按课程分流 ' + moved + ' 条到 ' + libs + ' 个课程库') : '') + '）';
    } catch (e) {
      return '';   /* 重建失败就用旧库，不吵 */
    }
  };

  /* 【库管理：主库 + 子库】主库是 题库.json；子库在 题库\ 目录里（一个文件一个库）。
     可以只启用其中几个（配置里 `bankEnabled` 列库名；不写 = 全部启用）。
     子库目录跟着 BANK_FILE 走 —— 测试把 BANK_FILE 指到临时目录时，子库也一起被隔离。 */
  let bankListCache = null;
  const bankLoadAll = () => {
    if (bankListCache) return bankListCache;
    const note = bankAutoRebuild();
    if (note) bankLastNote = note;
    const dir = path.dirname(BANK_FILE);
    const all = QB.listBanks({ dir: dir, bankFile: BANK_FILE });
    const enabled = (Array.isArray(cfg.bankEnabled) && cfg.bankEnabled.length) ? cfg.bankEnabled : null;
    const out = [];
    for (const b of all) {
      if (!b.entries) continue;                                   /* 空库/没有这个文件 */
      if (enabled && enabled.indexOf(b.name) < 0) continue;        /* 用户把它关了 */
      const bk = QB.loadBank(b.path);
      if (bk) out.push({ name: b.name, file: b.file, bank: bk });
    }
    bankListCache = out;
    return out;
  };
  const bankLoad = () => {
    if (bankTried) return bankObj;
    bankTried = true;
    try {
      const list = bankLoadAll();
      bankObj = list.length ? list[0].bank : null;    /* 主库（没有主库时退回第一个可用库） */
      bankLibs = list;
      bankBuiltAt = Date.now();
    } catch (e) { bankObj = null; }
    return bankObj;
  };
  let bankLibs = [];               /* 这次实际查的库（日志里要说清答案来自哪个库） */
  const bankLibNames = () => bankLibs.map((x) => x.name).join('+');
  const bankGet = (fpKey, type, imgs, altKey, orderKey, pageImgIds) => {
    const libs = bankLoadAll();
    if (!libs.length) return null;

    /* 【逐个库查，全都过一遍】同一个问题可能主库没有、子库有；也可能两个库都有。
       图片核对（见下）在**每个库各自**做：某个库的图对不上，不该连累另一个库。 */
    const passed = [], misses = [];
    for (const L of libs) {
      /* 【三把键依次试】主键 = 页面原文的指纹；altKey = 去掉题号；orderKey = 连选项顺序也不管。
         为什么要后两把：同一道题在这份卷子里是第 3 题、在别人那份里可能是第 7 题，
         题号和选项顺序都是别人卷子说了算的 —— 只认主键的话，库带过去就全查不中。
         注意：走 orderKey 命中的，字母**不能信**（顺序可能变了），调用方要按正文重新定位。 */
      const hit = QB.lookup(L.bank, fpKey, type)
        || (altKey ? QB.lookup(L.bank, altKey, type) : null)
        || (orderKey ? QB.lookup(L.bank, orderKey, type) : null);
      if (!hit) continue;
      /* 【没答案的条目当没命中】那些是"占位"条目（题面在、答案还没采到），
         拿来用只会打出"答案（题库）："这种空壳日志。留着它们是为了以后合并答案，不是现在用。 */
      if (!hit.answer) continue;
      /* 【图片必须对得上才敢用】
         优先比**像素指纹的短 id**（URL 会换域名/重编码，id 不会）；库里那条是老条目（只有 URL）
         就退回按 URL 比。两边都空（纯文字题）→ 放行；对不上 → **这个库的答案不用**。
         理由：题面文字缺了图之后，两道"只有图不同"的题会算出同一个指纹，
         这时候拿库里的答案去填就是**填错题**。宁可不答。
         ★ 判据是"**页面的每个指纹都能在库里找到**"（子集），不是"两边列表完全相等" ——
           因为去重复时会把同一道题的图片指纹**并集**起来（库里可能有 {id1,id2}），
           页面这次只算出 {id1}。以前拿拼串比相等 ⇒ 并过集的条目**一律被拒**（实测踩到）。
           反过来：页面出现了库里没有的图 ⇒ 这题多半是另一个变体 ⇒ 照样拒（宁可不答）。 */
      const hitIds = (hit.entry.imgIds || []);
      const pageIdsList = (Array.isArray(pageImgIds) ? pageImgIds : []).filter(Boolean);
      const idsCovered = pageIdsList.length
        ? pageIdsList.every((x) => hitIds.indexOf(x) >= 0)
        : false;
      if (hitIds.length && pageIdsList.length) {
        if (!idsCovered) {
          misses.push('图片指纹对不上（' + L.name + '：库里 ' + hitIds.length + ' 个／页面 ' +
            pageIdsList.length + ' 个，页面的图在库里找不到）');
          continue;
        }
      } else {
        const hitUrls = (hit.entry.images || []);
        const pageUrls = (Array.isArray(imgs) ? imgs : []).filter(Boolean);
        const urlsCovered = pageUrls.length ? pageUrls.every((x) => hitUrls.indexOf(x) >= 0) : false;
        if (hitUrls.length && pageUrls.length) {
          if (!urlsCovered) { misses.push('图片对不上（' + L.name + '）'); continue; }
        } else if (hitUrls.length !== pageUrls.length) {
          /* 一边有图、一边没有（或数量对不上）→ 老实拒掉：没法核对，就宁可不答 */
          misses.push('图片对不上（' + L.name + '：库里 ' + hitUrls.length + ' 张／页面 ' + pageUrls.length + ' 张）');
          continue;
        }
      }
      passed.push({ lib: L.name, hit: hit });
    }
    if (!passed.length) {
      return misses.length ? { miss: misses.join('；') } : null;
    }
    /* 【多个库都说有这道题】答案一致 → 照用（并标明哪几个库一致）；
       不一致 → 按证据强弱取（官方 > aria 确认 > 单来源）；**强弱也分不出 → 不用**（宁可走原路）。 */
    const rank = { official: 3, confirmed: 2, multi: 1, single: 0, none: -1 };
    const byAnswer = {};
    for (const x of passed) (byAnswer[x.hit.answer] = byAnswer[x.hit.answer] || []).push(x);
    const groups = Object.keys(byAnswer).map((a) => ({ answer: a, items: byAnswer[a] }));
    groups.sort((A, B) => {
      const ra = Math.max.apply(null, A.items.map((x) => rank[x.hit.trust] || 0));
      const rb = Math.max.apply(null, B.items.map((x) => rank[x.hit.trust] || 0));
      return (rb - ra) || (B.items.length - A.items.length);
    });
    const top = groups[0];
    if (groups.length > 1) {
      const r0 = Math.max.apply(null, top.items.map((x) => rank[x.hit.trust] || 0));
      const r1 = Math.max.apply(null, groups[1].items.map((x) => rank[x.hit.trust] || 0));
      if (r0 <= r1) {
        return { miss: '两个库的答案不一致（' + groups.map((g) => g.items.map((x) => x.lib).join('/') + '=' + g.answer).join('，') + '），证据也分不出高低 → 不用' };
      }
    }
    const best = top.items.slice().sort((x, y) => (rank[y.hit.trust] || 0) - (rank[x.hit.trust] || 0))[0];
    const libsTxt = top.items.map((x) => x.lib).join('+');
    return {
      hit: Object.assign({}, best.hit, {
        lib: libsTxt,
        libMulti: top.items.length > 1 || groups.length > 1,
        libNote: (passed.length > 1 || misses.length) ? ('库：' + libsTxt + (misses.length ? ('（另外 ' + misses.join('；') + '）') : '')) : ''
      })
    };
  };

  return {
    mode: cfg.mode,

    /* 【给调用方看的"待确认保存"标记】
       保存没被确认时，别接着做会丢草稿的动作（翻页、下一章、关页面）。
       driver.js 现在还没用这个 —— 它用的是旧统计字段，
       但 handle 的日志里会如实说"未确认"，绝不假装保存成功。 */
    pendingSave() {
      return lastSave ? {
        needConfirm: !!lastSave.needConfirm,
        blocksContinue: !!lastSave.blocksContinue,
        status: lastSave.status,
        origin: lastSave.origin || '',
        message: lastSave.msg || ''
      } : { needConfirm: false, blocksContinue: false, status: '', origin: '', message: '' };
    },
    lastUsage() { return usage; },
    /* 这一章最后一次保存的**结构化结果**（driver.js 暂时用不到，
       但填作业.js 和以后想按状态办事的调用方需要它）。
       契约（有集成测试盯着，别再让它跑回 handle 内部去）：
         · 还没跑过 handle / 这一章还没走到保存那一步 → 返回 null（不是抛错）；
         · 跑过之后 → 返回**本次最后一次真实保存**的结构化结果（同一个对象
           也放在 lastSave 里，pendingSave() 就是从它派生的，两者永远一致）；
         · 注意：这里有结果 ≠ 保存成功，看 status / confirmed / needConfirm。 */
    lastSaveResult() { return saveResult; },

    /* 判断这一章的测验要不要处理；要处理就返回 {found, questions} */
    async probe(ev) {
      if (cfg.mode <= 0) return null;
      let r;
      try { r = await ev(EXTRACT); } catch (e) { return null; }
      /* 【探到 0 道题时也要把结果带回去，不能 return null】
         以前这里写的是 `if (!r || !r.found) return null;`，
         于是驱动器那句「探针扫了 ? 个文档层」里的问号**永远**是问号 ——
         明明扫了 3 层却显示 ?，看日志的人分不清是"真没题"还是"探针压根没跑"。
         现在只判 r 本身；found=0 时照原样返回，调用方本来就是按 `found` 的真假走的，
         行为一模一样，只是日志里能看见扫描层数了。 */
      if (!r) return null;
      return r;
    },

    /* 真正处理一批题目，返回要打印的行 */
    async handle(chapter, r, log) {
      const lines = [];
      const stamp = new Date().toLocaleString('zh-CN');
      const obfN = r.obfCount || 0;
      const rm = cfg.readMode || 'auto';
      const haveTable = hasFontTable();
      /* 每一章都从"干净"的状态开始：上一章的用量/保存结论不该带过来。 */
      lastSave = null;
      saveResult = null;
      usage = QS.emptyUsage();
      bankHits = 0;            /* 题库命中数：只算"因此少问一次模型"的题 */
      bankSkipped = 0;
      let saveMsg = '';        /* 这一章最后一次保存的结论（结构化结果的 msg） */
      let filled = 0;          /* 这一章真填进页面的题数 */

      /* 关键一步：拿页面上的字体跟解码表里记的指纹对一下。
         对得上 → 表还有效；对不上 → 对方换过字体，表作废。

         ★ 但实测（2026-10-12）：平台是**每份卷子现生成一支替身字体**（码位随机、sha 每次都变、
           跟老表的码位交集 0 个）。所以"老表不匹配"不等于"这条路走不通" ——
           先按 sha 找"上次当场认出来的表"，没有就**当场认**（本地渲染 + 比对，不花 AI），
           认出来之后这一页就能按真字走（免费、而且本地题库也能命中）。 */
      /* 【每条命都从"干净"的状态开始】上一章认出来的字体表 / 拿不准的计数，都不该带过来 */
      setExtraTable(null);
      DECODE_UNCERTAIN = 0;

      /* 【课程名：用来"按课程分库"】驱动器那边只有课程编号，所以在这儿从页面上读一次。
         读不到就算了（那这一章照老规矩进主库）—— 绝不因为读不到课程名就不记题。 */
      let courseNow = '';
      try {
        const cn = await evFn(`(function () {
            var sels = ['.courseName', '#courseName', '.course_name', '.mCourseName', '.chapterTitle h1',
                        '.course-info .name', '.title .name', 'h1.course', '.navBarTitle', '.courseTitle'];
            for (var i = 0; i < sels.length; i++) {
              var el = null; try { el = document.querySelector(sels[i]); } catch (e) {}
              if (el) { var t = String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim(); if (t && t.length <= 40) return t; }
            }
            var ti = String(document.title || '').replace(/\\s+/g, ' ').trim();
            if (ti && ti.length <= 40 && ti.indexOf('学生学习') < 0 && ti.indexOf('学习通') !== 0) return ti.split(/[-|—–]/)[0].trim();
            return '';
          })()`);
        courseNow = String(cn || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 60);
        /* 【探不到就查映射表】实测（2026-10-12）：学习页的 DOM / iframe / 全局变量里**都没有课程名**，
           只有 stu_CourseId。所以用 `_课程名.json`（`node _实验\_取课程名映射.js` 生成）把 id 翻成名字。 */
        if (!courseNow) {
          const cid = await evFn(`(function(){
              try { if (window.stu_CourseId) return String(window.stu_CourseId); } catch (e) {}
              var m = String(location.href).match(/[?&]courseId=(\\d+)/i);
              return m ? m[1] : '';
            })()`);
          const id = String(cid || '').replace(/[^0-9]/g, '');
          if (id) {
            if (!courseMapTried) {
              courseMapTried = true;
              try {
                const f = path.join(__dirname, COURSE_MAP_FILE);
                courseMap = fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')) || {}) : {};
              } catch (e) { courseMap = {}; }
            }
            courseNow = String((courseMap && courseMap[id]) || '').trim().slice(0, 60);
          }
        }
      } catch (e) { courseNow = ''; }

      /* 【两条腿：题库 / AI】默认都开（= 先查库、库里没有再问 AI，跟以前一样）。
         mode 仍是总开关：mode<2 时这两条腿都不走。 */
      const useBank = (cfg.useBank !== false);
      const useAI = (cfg.useAI !== false);

      /* 【AI 模式关着的时候不要走截图路】截图那条路存在的唯一目的就是"给模型看图"，
         关了 AI 还去拍图，等于白拍 + 白等。 */
      if (!useAI && pipeline === 'shot') {
        pipeline = 'dom';      /* 退回按 DOM 文本读（能读就读、读不出就记下来，一律不问模型） */
        lines.push('');
        lines.push('  （AI 模式关着 → 不走截图路；能读到的题按题库答，读不到的留着不填）');
      }
      if (!useAI && cfg.mode >= 2) {
        lines.push('  （AI 模式关着：只按本地题库答，库里没有的题**留着不填**，一分钱不花）');
      }

      /* 【顺手攒图片指纹】题干里的插图/公式图 → 像素指纹的短 id。
         只攒不用（等指纹升 v3 时，带图的题才靠它进题库匹配）。
         整块包在 try/catch 里：算不出来**不影响**这一章的任何既有行为。 */
      const imgIds = new Map();          /* url → id */
      try {
        const urls = [];
        for (const q of (r.questions || [])) {
          for (const u of (q.imgs || [])) if (urls.indexOf(u) < 0) urls.push(u);
        }
        if (urls.length) {
          const tbl = IMGFP.loadTable(__dirname);
          let dirty = false;
          for (const u of urls) {
            if (tbl.urls[u]) { imgIds.set(u, tbl.urls[u]); continue; }
            const got = await IMGFP.idForUrl(u, { ev: evFn, table: tbl, dir: __dirname }).catch(() => null);
            if (got && got.ok) { imgIds.set(u, got.id); dirty = true; }
          }
          if (dirty) IMGFP.saveTable(tbl, __dirname);
        }
      } catch (e) { /* 攒不动就算了，绝不打断答题 */ }
      let tableOk = haveTable && fontTableMatches(r.fontB64);
      let fontNote = '';
      if (!tableOk && r.fontB64 && obfN > 0) {
        try {
          const sha = FI.shaOf(r.fontB64);
          const t = await FI.identifyFont({ b64: r.fontB64, sha: sha, ev: evFn });
          if (t.ok) {
            /* 【拿不准的字先别急着放弃：拿"以前记过的真字文本"整句对齐反推一把】
               记录/库里已经有上千道题的真字文本（AI 抄录 + DOM 解码来的）；
               同一道题的替身文本跟它逐字对齐，认不准的那几个位置就能**免费定下来**
               （判据：锚点够 + 同一个字两次独立对齐一致，见 字体识别.js 的 alignFill）。
               实测症状：45 个字里 3 个拿不准 → 整页被拒、退回截图；有两次**只因为 1 个字**。 */
            let alignNote = '';
            try {
              const unSet0 = Object.keys(t.table.map).filter((k) => t.table.conf && t.table.conf[k] === false);
              if (unSet0.length) {
                const norm = (s) => { try { return QB.aliasStem(String(s == null ? '' : s)); } catch (e) { return String(s || ''); } };
                const texts = [];
                for (const q of (r.questions || [])) {
                  texts.push(norm(q.stem));
                  for (const o of (q.options || [])) texts.push(norm(o.text));
                }
                const bForAlign = bankLoad();
                const knownTexts = bForAlign
                  ? Object.keys(bForAlign.entries).map((k) => norm(bForAlign.entries[k].stem)).filter(Boolean)
                  : [];
                if (knownTexts.length) {
                  const al = FI.alignFill({ table: t.table, texts: texts.filter(Boolean), known: knownTexts, norm: (s) => s });
                  const nFix = FI.applyAlign(t.table, al.added);
                  if (nFix) alignNote = '；整句对齐补了 ' + nFix + ' 个字（' + al.added.map((a) => a.sub + '→' + a.real).join('、') + '）';
                }
              }
            } catch (e) { alignNote = '；整句对齐没跑成（' + ((e && e.message) || e) + '）'; }

            /* 【补完再看：还有拿不准的字出现在页面文本里吗？】
               —— 只要真出现，整页就不用这张表（认错一个字就可能填错一道题，宁可走截图）。 */
            const un = new Set(Object.keys(t.table.map).filter((k) => t.table.conf && t.table.conf[k] === false));
            let hitUn = 0;
            if (un.size) {
              const scan = (s) => { for (const ch of String(s == null ? '' : s)) if (un.has(ch)) hitUn++; };
              for (const q of (r.questions || [])) {
                scan(q.stem);
                for (const o of (q.options || [])) scan(o.text);
              }
            }
            if (hitUn) {
              fontNote = t.source + '：' + t.note + alignNote +
                ' —— 但这一页的文本里出现了 ' + hitUn + ' 个"拿不准"的字，整页不用它（走截图）';
            } else {
              setExtraTable(t.table);
              tableOk = true;
              fontNote = t.source + '：' + t.note + alignNote;
            }
          } else {
            fontNote = '认不出来（' + t.why + '）';
          }
        } catch (e) {
          fontNote = '认字时出错：' + ((e && e.message) || e);
        }
      }

      /* 【"去题号"的那把键】同一个问题的题号在不同卷子里可能不一样（第 3 题 vs 第 7 题），
         而题号是页面文字的一部分。剥离规则与建库端是同一个函数（题库.js 的 aliasStem），
         两边必须一致，否则键对不上。算不出来就返回空串（那时候只按主键查）。 */
      const altKeyOf = (q) => {
        try {
          const dec = (q.obf && tableOk) ? decodeObf(q.stem).text : String(q.stem || '');
          const st = QB.aliasStem(dec);
          if (!st || st === dec) return '';
          return fp.fpOf({ type: q.type, stem: st, options: q.options });
        } catch (e) { return ''; }
      };

      /* 【"顺序无关"的那把键】题号 + 选项顺序/字母都可能跟库里不一样，
         这把键只认"题干（去题号）+ 选项正文**排序后**的集合"。
         算法与建库端同一个（题库.js 的 orderFreeFp + 同一个 normalizeForFp）。 */
      const orderKeyOf = (q) => {
        try {
          const dec = (o) => ((q.obf && tableOk) ? decodeObf(String(o == null ? '' : o)).text : String(o == null ? '' : o));
          const st = QB.aliasStem(dec(q.stem)) || dec(q.stem);
          const texts = (q.options || []).map((o) => QS.normalizeForFp(dec(o.text))).sort();
          return fp.fpOf({ type: q.type, stem: st, options: texts.map((t) => ({ letter: '', text: t })) });
        } catch (e) { return ''; }
      };

      /* 【走"顺序无关"那条路命中时，答案是**按字母记的**，而字母可能已经不对了】
         所以拿库里的选项正文，去**当前页面**的选项里找同文的那一个，用页面自己的字母来填。
         找不到 / 撞多个 / 页面上没有字母 → 一律不填（宁可漏，不填错）。
         判断题不受顺序影响（对/错 本身就是语义），原样返回。 */
      const remapAnswerByText = (hit, q) => {
        try {
          const ans = String(hit.answer || '');
          if (/^(对|错)$/.test(ans)) return { answer: ans, answerText: ans };
          const page = (q.options || []).map((o) => ({
            letter: String(o.letter || ''),
            t: QS.normalizeForFp((q.obf && tableOk) ? decodeObf(String(o.text == null ? '' : o.text)).text : String(o.text == null ? '' : o.text))
          }));
          const want = [];
          /* 【题库码那种"只有键 + 答案"的条目没有选项表】—— 那就直接用**答案正文**锚定。
             单选（答案就一个字母）才敢这么干；多选没有逐项正文 → 不填（宁可漏）。 */
          if (!(hit.entry.options || []).length) {
            if (ans.replace(/[^A-F]/g, '').length !== 1) return null;
            const t = QS.normalizeForFp(String(hit.answerText || ''));
            if (!t) return null;
            want.push(t);
          } else {
            for (const L of ans.replace(/[^A-F]/g, '').split('')) {
              const o = (hit.entry.options || []).filter((x) => String(x.letter || '').toUpperCase() === L)[0];
              const t = o ? QS.normalizeForFp(String(o.text == null ? '' : o.text)) : '';
              if (!t) return null;
              want.push(t);
            }
          }
          if (!want.length) return null;
          const picked = [];
          for (const t of want) {
            const m = page.filter((p) => p.t === t);
            if (m.length !== 1 || !m[0].letter) return null;
            picked.push(m[0].letter);
          }
          if (new Set(picked).size !== picked.length) return null;
          return { answer: picked.join(''), answerText: hit.answerText || '' };
        } catch (e) { return null; }
      };

      /* 一次把三把键都试完（主键 → 去题号 → 顺序无关），并把"顺序那条"的答案换算回页面字母。
         返回 { hit } / { miss: 原因 } / null（库里根本没有）。 */
      const bankHitOf = (q) => {
        if (!useBank) return null;              /* 题库模式关着 → 这道题就当库里没有 */
        const fpKey = fp.fpOf(q);
        /* 页面这道题的图片指纹（算不出来就是空 —— 那时候按老办法用 URL 比） */
        const pageIds = (q.imgs || []).map((u) => imgIds.get(u)).filter(Boolean);
        const bk = bankGet(fpKey, q.type, q.imgs, altKeyOf(q), orderKeyOf(q), pageIds);
        if (!bk || !bk.hit) return bk;
        if (!bk.hit.viaOrder) return bk;
        const rm = remapAnswerByText(bk.hit, q);
        if (!rm) return { miss: '选项顺序/字母对不上，按正文也没定位到（不填）' };
        return { hit: Object.assign({}, bk.hit, { answer: rm.answer, answerText: rm.answerText || bk.hit.answerText, byText: true }) };
      };

      /* 记账：这一章有哪些题最后没做成、为什么。
         必须定义在 handle 的最上面 —— 下面"截图路"和"DOM 路"都要用它，
         放中间会出现暂时性死区（先用的那条路直接 ReferenceError）。
         两个出口：
           a) cfg.onUnanswered —— 每漏一道就回调一次（驱动器拿去写界面）
           b) cfg.stats —— 累计数字，驱动器收尾时打总结 */
      const noteMiss = (q, whyMiss) => {
        try {
          if (cfg.stats) {
            cfg.stats.found = (cfg.stats.found || 0) + 1;
            cfg.stats.missed = (cfg.stats.missed || 0) + 1;
          }
          if (typeof cfg.onUnanswered === 'function') {
            cfg.onUnanswered({
              chapter: chapter || '',
              type: q ? q.type : '',
              stem: q ? String(q.stem || '').slice(0, 200) : '',
              options: q && q.options ? q.options.map((o) => (o.letter || '?') + '. ' + String(o.text || '').slice(0, 80)) : [],
              why: whyMiss || '未知',
            });
          }
        } catch (e) {}
      };

      /* 记一道"填进去了"。**只加 filled，不再靠 found-missed 反推** ——
         反推出来的数字会把"模型答了但没填上"和"填了但没保存"都算成填上了。 */
      const noteFilled = () => {
        filled++;
        try { if (cfg.stats) cfg.stats.filled = (cfg.stats.filled || 0) + 1; } catch (e) {}
      };

      /* 【保存结果的记账】
         旧统计字段（found/filled/missed）由 driver.js 用着，不能动它们的含义，
         但我们**另开**几个字段把"填"和"存"分开。
         【字段名是这三个，别再自创第四个 —— 这里踩过坑】
         handle 写的是 saveConfirmed/saveUnconfirmed，而 填作业.js 显示的是
         saved/savedUnconfirmed，两边对不上：确认成功也可能显示 0 次。
         现在**统一**成下面这组名字，全是"次数"不是"题数"：
           saveConfirmed  —— 保存被平台的成功提示**证实**了几次
           saveUnconfirmed—— 点下去了但没证据的次数（绝不能算成保存成功）
           saveFailed     —— 没保存的次数（没按钮 / 被闸门拒绝 / 页面抛错）
         读侧（填作业.js）另有一层显式映射，兜住老的 saved/savedUnconfirmed 写法。
         driver.js 暂时只读旧字段，所以下面还要靠日志把话说清楚：
         **日志里绝不能出现"已保存"这种没证据的词。** */
      const SAVE_TALLY_FIELD = {
        confirmed: 'saveConfirmed',
        unconfirmed: 'saveUnconfirmed',
        failed: 'saveFailed'
      };
      /* 读侧：先按统一名字读，读不到再退回老名字 —— 旧调用方（自己建的是
         saved / savedUnconfirmed）也能显示出真实**次数**，不会永远是 0。 */
      const saveTally = (kind) => {
        const s = cfg.stats || {};
        const f = SAVE_TALLY_FIELD[kind];
        if (Number.isFinite(Number(s[f]))) return Number(s[f]);
        const legacy = { confirmed: 'saved', unconfirmed: 'savedUnconfirmed', failed: 'saveFailed' }[kind];
        if (legacy && legacy !== f && Number.isFinite(Number(s[legacy]))) return Number(s[legacy]);
        return 0;
      };
      const noteSave = (res) => {
        if (!res) return;
        lastSave = res;
        saveResult = res;
        saveMsg = res.msg || '';
        try {
          const st = cfg.stats;
          if (st) {
            const bump = (k) => {
              const f = SAVE_TALLY_FIELD[k];
              st[f] = (Number(st[f]) || 0) + 1;
              /* 兼容别名：老写法 saved / savedUnconfirmed 跟着一起加，
                 这样任何还在读老名字的调用方看到的也是**次数**，不会因为
                 换了名字就永远读到 0。只在调用方确实建了这个字段时才补。 */
              if (k === 'confirmed' && st.saved !== undefined) st.saved = (Number(st.saved) || 0) + 1;
              if (k === 'unconfirmed' && st.savedUnconfirmed !== undefined) st.savedUnconfirmed = (Number(st.savedUnconfirmed) || 0) + 1;
            };
            if (res.status === QS.SAVE.SAVED) bump('confirmed');
            else if (QS.needsSaveConfirmation(res.status)) bump('unconfirmed');
            else bump('failed');
          }
        } catch (e) {}
      };

      /* 【填了 / 存了 必须分开说】
         handle 的调用方（driver.js 的 tallyChapter）暂时还在用 found-missed 那套旧口径，
         所以这里给一行明确的"账目口径"说明，让日志本身不会误导人。 */
      const accountLine = () => {
        let l = '  ── 本章账目：填进页面 ' + filled + ' 道';
        if (saveResult) {
          l += '；保存：' + (QS.SAVE_STATUS_NAME[saveResult.status] || saveResult.status);
          if (QS.needsSaveConfirmation(saveResult.status)) {
            l += ' ⚠（**没看到保存成功的证据**，草稿可能在也可能不在，' +
              '别在没核对的情况下继续下一章）';
          } else if (saveResult.status === QS.SAVE.REJECTED) {
            l += '（只找到提交类按钮，已拒绝，没点任何提交）';
          } else if (saveResult.status === QS.SAVE.FAILED) {
            l += '（待人工保存）';
          }
        } else if (cfg.autoFill) {
          l += '；这一章没有走到保存那一步';
        }
        const unconf = saveTally('unconfirmed');
        if (unconf) l += '；本次运行累计未确认保存 ' + unconf + ' 次';
        return l;
      };

      /* 定这一页走哪条路：
           dom  = 直接用网页里的文字（解码表有效时才敢）
           shot = 截图 + 看图模型（不依赖字体）
           none = 读不了，如实说清楚 */
      let pipeline = 'dom';
      let why = '';
      if (obfN > 0) {
        if (rm === 'shot') {
          pipeline = 'shot'; why = '设置里选了"只用截图读题"';
        } else if (rm === 'table') {
          if (tableOk) { pipeline = 'dom'; why = '解码表有效'; }
          else { pipeline = 'none'; why = haveTable ? '页面上的字体跟解码表对不上（对方换过字体）' : '本地没有解码表'; }
        } else {   /* auto */
          if (tableOk) { pipeline = 'dom'; why = '解码表有效'; }
          else { pipeline = 'shot'; why = haveTable ? '页面字体与解码表不符' : '本地没有解码表'; }
        }
      }

      /* 写记录文件。两条路都要写，所以提出来 */
      const save = () => {
        try {
          if (!fs.existsSync(OUT_FILE)) {
            fs.writeFileSync(OUT_FILE,
              '\uFEFF章节测验记录\n' +
              '驱动器遇到测验时自动记录。开了问 AI 的话，下面还会有答案和理由。\n' +
              '注意：这些答案没有经过任何验证，只是模型生成的 —— 用之前自己判断。\n' +
              '============================================================\r\n', 'utf8');
          }
          fs.appendFileSync(OUT_FILE, '\r\n[' + stamp + '] ' + (chapter || '') + '\r\n' +
          (courseNow ? ('课程：' + courseNow + '\r\n') : '') +
          lines.join('\r\n') + '\r\n', 'utf8');
        } catch (e) { /* 写不了就算了 */ }
      };

      lines.push('──────── 测验：' + (chapter || '') + '   共 ' + r.found + ' 题' +
                 (r.graded ? '（页面已在显示成绩，说明交过了）' : ''));
      if (obfN > 0) {
        lines.push('');
        lines.push('  ⚠ 字体反爬：' + obfN + '/' + r.found + ' 道题的正文用了 font-cxsecret 字体。');
        lines.push('     DOM 里存的是替身字（"从法律" 在 DOM 里存成 "庘庝律"），屏幕上看着对，读出来是乱码。');
        if (pipeline === 'dom') {
          lines.push('     已核对页面字体指纹，与解码表一致 → 用解码表换回真字（快、免费、零误差）。');
          if (fontNote) lines.push('     （这一页的表是' + fontNote + '）');
        } else if (pipeline === 'shot') {
          lines.push('     解码表这次用不上（' + why + '）→ 改用截图读题。');
          if (fontNote) lines.push('     字体识别的结果：' + fontNote);
          lines.push('     截图读题不看字体，对方怎么换都拦不住；代价是慢一点、要花 API 费用。');
        } else {
          lines.push('     这一页读不了题：' + why);
          lines.push('     想让它自动兜底，把"读题方式"改成 auto 或 shot（控制台 → 4 → 11）。');
        }
        lines.push('');
      }
      if (cfg.mode === 1) {
        lines.push('  （"记下题、不问 AI"模式：题目存进记录文件，不调用 API。要答案就改成"记下题 + 问 AI"）');
      }

      /* ---------------- 路 A：截图读题 ---------------- */
      if (pipeline === 'shot') {
        if (!cfg.apiKey) {
          lines.push('');
          lines.push('  → 截图读题要调用 API，但还没配 key（控制台 → 4 → 4 填一个）。');
          lines.push('');
          save();
          return lines;
        }
        const vm = cfg.visionModel || 'deepseek-flash';
        lines.push('');

        /* ------------------------------------------------------------------
         * 【截图之前，先拿**页面文本**查一遍库】
         *
         * 为什么必须放在这里：截图路以前完全不查库 —— 明明库里全有，它照样
         * 拍一整页、交给看图模型抄、再问一遍模型（白花钱 + 白等）。查库只需要
         * "页面上的文本 + 同一个指纹函数"，这两样在**拍照之前**就已经有了。
         *
         * 什么时候算不出指纹：题目带字体反爬、而本地解码表又对不上（那是替身字，
         * 运行时的指纹本该是解码后算的）。这种题一律排除，不硬凑。
         *
         * 本版只做**全命中**：一章的题库里全有 → 不截图、不抄录、不问模型，
         * 直接按库里的答案填。部分命中只报数、不改填空那条链
         * （那条链是"按题号顺序填"，掺进去容易错位 —— 留到下一步单独做）。
         * ------------------------------------------------------------------ */
        const bankable = (cfg.mode >= 2 && useBank) ? (() => {
          const b = bankLoad();
          if (!b || !Array.isArray(r.questions) || !r.questions.length) return null;
          const hits = [], miss = [];
          for (const q of r.questions) {
            if (q.obf && !tableOk) { miss.push({ q: q, why: '字体反爬、表对不上' }); continue; }
            const bk = bankHitOf(q);              /* 三把键都试（主键/去题号/顺序无关） */
            if (bk && bk.hit) hits.push({ q: q, hit: bk.hit }); else miss.push({ q: q, why: '库里没有' });
          }
          return { hits: hits, miss: miss, allHit: hits.length === r.questions.length && hits.length > 0 };
        })() : null;

        if (bankable && bankable.allHit) {
          lines.push('  → 这一章 ' + bankable.hits.length + ' 道题**库里全有** —— 不截图、不抄录、不问模型');
          lines.push('');
          let n = 0;
          for (const h of bankable.hits) {
            const q = h.q, hit = h.hit;
            bankHits++;
            n++;
            /* 文本照 DOM 路的规矩写：能解码就写解码后的真字（这样以后重建库还能算出同一个指纹） */
            let qq = q, obfNote = '';
            if (q.obf && tableOk) {
              const ds = decodeObf(q.stem);
              let oh = 0;
              const opts = q.options.map((o) => { const d = decodeObf(o.text); oh += d.hits; return { letter: o.letter, text: d.text }; });
              qq = { type: q.type, stem: ds.text, options: opts };
              obfNote = '   ⚠字体反爬，已解码（正文 ' + ds.hits + ' 处 / 选项 ' + oh + ' 处）';
            }
            lines.push('  [' + n + '] ' + q.type + obfNote);
            if (q.imgs && q.imgs.length) {
              lines.push('      → 图片 ' + q.imgs.length + ' 张：' + q.imgs.join(' | '));
              const ids = q.imgs.map((u) => imgIds.get(u)).filter(Boolean);
              if (ids.length) lines.push('      → 图片指纹：' + ids.join(' | '));
            }
            lines.push('      ' + String(qq.stem).replace(/\n/g, '\n      '));
            for (const o of qq.options) lines.push('        ' + (o.letter || '?') + '. ' + o.text);
            lines.push('      → 答案（题库' + (hit.lib ? '·' + hit.lib : '') + '·' + hit.trustLabel + '）：' + hit.answer +
              (hit.answerText ? '　【' + hit.answerText + '】' : '') +
              (hit.byText ? '（选项顺序/字母和库里不一样，已按**正文**重新对上）' : ''));
            if (hit.conflict) lines.push('        ⚠ ' + hit.conflictNote);
            if (cfg.autoFill && !r.graded) {
              const st = await tryFill(evFn, q.stem, hit.answer, q.type, clickAt);
              lines.push('      → ' + st);
              if (st.indexOf('没填上') >= 0 || st.indexOf('没填') >= 0) {
                noteMiss(q, '题库答案「' + hit.answer + '」填不进页面：' + st);
              } else {
                noteFilled();
              }
            } else if (r.graded) {
              lines.push('      → 这一页已经在显示答案了（说明交过了），不填');
              noteMiss(q, '页面已在显示答案（已交过），没填');
            }
            lines.push('');
          }
          if (cfg.autoFill && !r.graded) {
            let sr = null;
            try { sr = await saveDraftResult(evFn); }
            catch (e) {
              sr = QS.makeSaveResult(QS.SAVE.FAILED, '保存出错：' + ((e && e.message) ? e.message : e),
                { reason: 'save_threw', evidence: { kind: 'error', detail: (e && e.message) || String(e) } });
            }
            noteSave(sr);
            lines.push('  → ' + saveMsg);
          }
          lines.push('  本地题库命中 ' + bankHits + ' 题（整章没进截图、没问模型）');
          cacheStore();
          lines.push('');
          if (saveResult) lines.push(accountLine());
          lines.push('  ' + QS.formatUsage(usage));
          save();
          return lines;
        }
        /* 【部分命中：库里有的先填掉，只把"库里没有的"送进截图】
           填的是"页面上第几个题" —— tryFill 按题干定位（与 DOM 路同一个函数，不依赖序号）；
           截图只拍缺的那几道；回来填的时候由 fillFromText 的 indexMap
           把"第 k 条答案"换算成页面题号（否则模型说的"第 1 题"会被填到页面上第 1 题上，错位）。 */
        let shotOnly = null;
        if (bankable && bankable.hits.length) {
          const hitIdx = [];
          for (const h of bankable.hits) {
            const qi = r.questions.indexOf(h.q);
            const q = h.q, hit = h.hit;
            hitIdx.push(qi);
            bankHits++;
            let qq = q, obfNote = '';
            if (q.obf && tableOk) {
              const ds = decodeObf(q.stem);
              let oh = 0;
              const opts2 = q.options.map((o) => { const d = decodeObf(o.text); oh += d.hits; return { letter: o.letter, text: d.text }; });
              qq = { type: q.type, stem: ds.text, options: opts2 };
              obfNote = '   ⚠字体反爬，已解码（正文 ' + ds.hits + ' 处 / 选项 ' + oh + ' 处）';
            }
            lines.push('  [' + (qi + 1) + '] ' + q.type + '（题库，不问模型）' + obfNote);
            if (q.imgs && q.imgs.length) {
              lines.push('      → 图片 ' + q.imgs.length + ' 张：' + q.imgs.join(' | '));
              const ids = q.imgs.map((u) => imgIds.get(u)).filter(Boolean);
              if (ids.length) lines.push('      → 图片指纹：' + ids.join(' | '));
            }
            lines.push('      ' + String(qq.stem).replace(/\n/g, '\n      '));
            for (const o of qq.options) lines.push('        ' + (o.letter || '?') + '. ' + o.text);
            lines.push('      → 答案（题库' + (hit.lib ? '·' + hit.lib : '') + '·' + hit.trustLabel + '）：' + hit.answer +
              (hit.answerText ? '　【' + hit.answerText + '】' : '') +
              (hit.byText ? '（选项顺序/字母和库里不一样，已按**正文**重新对上）' : ''));
            if (hit.conflict) lines.push('        ⚠ ' + hit.conflictNote);
            if (cfg.autoFill && !r.graded) {
              const st = await tryFill(evFn, q.stem, hit.answer, q.type, clickAt);
              lines.push('      → ' + st);
              if (st.indexOf('没填上') >= 0 || st.indexOf('没填') >= 0) {
                noteMiss(q, '题库答案「' + hit.answer + '」填不进页面：' + st);
              } else {
                noteFilled();
              }
            } else if (r.graded) {
              lines.push('      → 这一页已经在显示答案了（说明交过了），不填');
            }
            lines.push('');
          }
          shotOnly = r.questions.map((q, i) => i).filter((i) => hitIdx.indexOf(i) < 0);
          lines.push('  → 这一章 ' + r.questions.length + ' 道题：库里已有 ' + bankable.hits.length +
            ' 道（已直接填，不问模型），剩 ' + shotOnly.length + ' 道进截图');
          lines.push('');
        }
        const shotN = shotOnly ? shotOnly.length : r.found;    /* 这次要拍几道题 */
        /* 【判定"这次抄录可不可信"要先定好】
           四条都要满足：
             ① 拍到了图；② 模型在这份抄录里认出了题；
             ③ 只读预检不是"题目在页面里但根本看不见"（那说明拍的是别的卡）；
             ④ 视口被压小时**确实撑回来了**（撑不回来，画面很可能是空白条/残缺条）。
           【④ 的措辞要准确】撑不回来是**识别与定位的可靠性风险**：
           拍到的题面可能被裁掉、糊掉，抄出来的题号/选项跟页面对不上号的风险变高。
           它**不等于**"一定填错"（也可能恰好拍全了、抄对了）—— 我们离线证不了是哪一种，
           所以按"不可信"保守处理；别在注释里把它说成必然出错。
           任一条不满足 → 后面**不问答案、不填、不保存**。
           原来这一整块预检被 `if (reopenQuiz)` 包着，于是"没有 reopenQuiz"的调用方
           （比如 填作业.js）连预检都不做 —— 等于默认"拍得到"，
           而它恰恰是最需要预检的那条路。 */
        let precheck = null;          /* null = 没做/没做成；{n,vis} = 真做过 */
        let shotDiag = { note: [], captureErrors: [] };
        const looksLikeQuestions = (s) => /【(单选|多选|判断)题】|\n\s*\d{1,2}\s*[.、)）]/.test(String(s || ''));
        const transcriptionTrust = (txt) => {
          if (!shots.length) return { ok: false, why: '一张都没截到' };
          if (!looksLikeQuestions(txt)) return { ok: false, why: '抄录里一道题都没有' };
          if (precheck && precheck.vis === 0) return { ok: false, why: '题目在页面里但没显示出来' };
          if (shotDiag.smallViewport && shotDiag.triedExpand && shotDiag.expanded === false) {
            /* 说清是"识别/定位可靠性"这一类的风险，不是断言题目被填错了 */
            return { ok: false, why: '视口被压小了又没能撑回来（' + (shotDiag.expandError || '未知原因') +
              '）—— 题面可能没拍全，抄录的识别/定位不可靠' };
          }
          return { ok: true, why: '' };
        };

        /* 【拍之前先确认题目真的画在屏幕上】
           实测（2026/9/26 16:44，军事理论 3.4 新中国国防建设成就【上】）：
           题目在 DOM 里（探针抠出 3 道），但切栏没真切过去/被切回来了，
           屏幕上显示的是视频卡 —— 整屏截图拍到的就是**视频播放页**，
           模型只能回一句"未提供任何题目或选项内容（截图仅为视频播放页）"，答案全空。
           截图这条路是"拍什么读什么"，所以拍之前必须确认拍的是题目页。 */
        try {
          const vis = await evFn(fillAct(0, { by: 'probe', v: [] }));
          if (vis && typeof vis.n === 'number') precheck = { n: vis.n, vis: (typeof vis.vis === 'number' ? vis.vis : null) };
        } catch (e) {
          precheck = null;
          lines.push('  （只读预检没做成：' + ((e && e.message) || e) + '）');
        }
        if (precheck && precheck.vis === 0) {
          lines.push('  → 题目在页面里但没显示出来（截图会拍到别的卡）。');
          if (reopenQuiz) {
            lines.push('     先重新打开测验栏…');
            const rr = await reopenQuiz();
            await new Promise((r2) => setTimeout(r2, 1500));
            let vis2 = null;
            try { vis2 = await evFn(fillAct(0, { by: 'probe', v: [] })); } catch (e) { vis2 = null; }
            if (vis2 && typeof vis2.n === 'number') precheck = { n: vis2.n, vis: (typeof vis2.vis === 'number' ? vis2.vis : null) };
            lines.push('     重新打开：' + rr + '　→　现在 DOM ' + ((vis2 && vis2.n) || 0) +
                       ' 道 / 可见 ' + ((vis2 && typeof vis2.vis === 'number') ? vis2.vis : '?') + ' 道');
            if (vis2 && vis2.vis === 0) {
              lines.push('     还是没显示出来 —— 这一章的结果不可信：不自动填，也不自动保存。');
            }
          } else {
            /* 【没有 reopenQuiz 时，"不可信"要能传到下面拦住自动填】
               审查里的原话：reopenQuiz 不可实现时，不可信抄录应阻止自动填并报告原因，
               不能用未验证的跳转去重开真实作业。所以这里**什么都不点**，
               只如实报告；抄录步骤结束时会按"不可信"处理，不填不保存。 */
            lines.push('     ⚠ 这个调用方没有提供「重新打开测验栏」，没法把它叫回来 ——');
            lines.push('       这一章按"不可信"处理：只抄录、**不自动填、不自动保存**。');
          }
        }
        lines.push('  → 正在截图…');
        let shots = [];
        try { shots = await grabShots(evFn, shot, cfg.maxShots || 3, shotDiag, shotOnly ? { only: shotOnly } : null); } catch (e) {
          shots = [];
          shotDiag.captureErrors.push('截图整体抛错：' + ((e && e.message) || e));
        }
        /* 截图期间视口撑不起来 / 还原不了，都要留在日志里 —— 否则拍出来是空白条，
           日志却一个字都不说，看起来跟成功一样。 */
        for (const nl of (shotDiag.note || [])) lines.push('     ' + nl);
        if (shotDiag.emptyShots && (shotDiag.captureErrors || []).length) {
          lines.push('     ⚠ 截图失败明细：' + shotDiag.captureErrors.slice(0, 3).join('；'));
        }
        if (!shots.length) {
          lines.push('  → 一张都没截到。通常是浏览器窗口被完全盖住或标签页在后台，');
          lines.push('     把浏览器点到最前面再试。');
        } else {
          lines.push('  → 截了 ' + shots.length + ' 张，交给 ' + vm + ' 抄录…');
          if (shotDiag.smallViewport && shotDiag.triedExpand && shotDiag.expanded === false) {
            lines.push('  ⚠ 视口被压小了又没能撑回来（' + (shotDiag.expandError || '未知原因') +
                       '）—— 这几张图可能不完整，抄出来的题也可能对不上，结果按"不可信"处理。');
          }
          /* 拍到的张数少于题目数 → 后面几道题压根没进画面，模型抄不到。
             【注意：这一条欠账不能现在就记，得等重拍也失败才算数】
             实测（2026/9/26 16:48，军事理论 3.8 军民融合）：第一拍只截到 1 张，
             这里先记了 2 道欠账；随后重拍救回来了、3 道全填上，
             可那 2 条欠账已经写进台账 —— 结果日志说"3 道全填上"、
             计数文件却写"3 道题 填上 1 欠 2"，两句话又打架。
             所以改成：先只提示，真正的记账推到下面"确认没补上"之后。 */
          const shotsShort = (typeof shotN === 'number' && shotN > shots.length);
          if (shotsShort) {
            lines.push('  ⚠ 这一页有 ' + r.found + ' 道题，但只截到 ' + shots.length + ' 张画面 —— ' +
                       '后面 ' + (r.found - shots.length) + ' 道题没进截图，模型抄不到，也就填不了。');
          }
          try {
            let t = await transcribeShots(cfg, shots);
            QS.addUsage(usage, t && t.usage);
            if (t && t.attempts > 1) lines.push('     （抄录这次重试过，共发 ' + t.attempts + ' 次请求）');
            lines.push('');
            lines.push('  ──── 模型抄录（原样，未经加工）────');
            for (const L of String(t.text).split(/\r?\n/)) lines.push('  ' + L);
            /* 【抄录里一道题都没有，就重开测验栏再拍一次】
               实测（2026/9/26 16:47，军事理论 3.7）：模型回的是
               "当前截图里没有题目或选项，只有课程章节页面信息，无法按规则抄录题目" ——
               **不是空字符串**，所以只判"空"会漏掉它（我第一版就漏了）。
               判定改成"抄录里有没有题号/题型标记"：一个都没有，就说明这一拍拍歪了。
               同一时刻只读探针实测页面本身是好的（countQuestions=3、可见 3 道），
               所以这是时序问题：切栏还没落定就拍了。重开一次、等一会儿、再拍。 */
            if (!looksLikeQuestions(t.text)) {
              if (reopenQuiz) {
                lines.push('  → 这次抄录里一道题都没有（很可能拍到别的页），重开测验栏再拍一次…');
                const rr = await reopenQuiz();
                await new Promise((r2) => setTimeout(r2, 2500));
                let shots2 = [];
                try { shots2 = await grabShots(evFn, shot, cfg.maxShots || 3, { note: [], captureErrors: [] }, shotOnly ? { only: shotOnly } : null); } catch (e) { shots2 = []; }
                if (shots2.length) {
                  t = await transcribeShots(cfg, shots2);
                  QS.addUsage(usage, t && t.usage);
                  lines.push('     重开：' + rr + '　重拍 ' + shots2.length + ' 张，第二次抄录：');
                  for (const L of String(t.text).split(/\r?\n/)) lines.push('  ' + L);
                  if (!looksLikeQuestions(t.text)) {
                    lines.push('     ⚠ 第二次抄录里还是没有题 —— 这一章这次做不了，会记进"没做的题"。');
                  }
                } else {
                  lines.push('     重开：' + rr + '　但一张都没重拍到。');
                }
              } else {
                /* 【不能重开时不能假装没事】
                   抄录里没有题 = 拿不到可信的题目顺序，按顺序填必然错位。
                   所以不重开（更不能用未验证的跳转去重开真实作业），只如实报告；
                   下面按"不可信"处理，不填不保存。 */
                lines.push('  → 这次抄录里一道题都没有，而这个调用方没法重开作业卡 ——');
                lines.push('     **不自动填、不自动保存**：按顺序填会把答案填到错位的题上。');
              }
            }
            lines.push('  ──────────────────────────────────');
            /* 【重拍也没补上，才把"截图没拍到"这笔账记下】
               放在这里是因为要等重拍的结果：第一拍少截几张时先记账，
               重拍成功后就变成"欠 2 道"的假账（实测 3.8 军民融合就是这个）。
               判据：现在手里这份抄录里到底认出了几道题。 */
            if (shotsShort) {
              const shotCount = (String(t.text || '').match(/【(单选|多选|判断)题】/g) || []).length;
              if (shotCount >= shotN) {
                lines.push('  ↳ 重拍之后抄到了 ' + shotCount + ' 道题，前面"没进画面"的问题补上了，不计欠账。');
              } else {
                noteMiss({ type: '(截图没拍到)', stem: '这一章共 ' + shotN + ' 道题，只抄到 ' + shotCount + ' 道', options: [] },
                         '截图只拍到 ' + shots.length + ' 张、重拍后仍只抄到 ' + shotCount + ' 道题');
              }
            }
            if (cfg.mode >= 2 && useAI) {
              /* 【抄录不可信时，后面整块"问答案 → 填 → 保存"统统不做】
                 理由是**可靠性**：题面抄错/抄缺的时候，模型给的答案跟页面上那道题
                 对不上号的风险很高 —— 也可能恰好对上，但离线分不出是哪一种，
                 而这种错在日志里**看不出来**，所以按不可信保守处理，不填不保存。
                 （审查里的原话：reopenQuiz 不可实现时，不可信抄录应阻止自动填并报告原因。） */
              const trust = transcriptionTrust(t.text);
              if (!trust.ok) {
                lines.push('  ⚠ 这次抄录不可信（' + trust.why + '）——');
                lines.push('     不再问模型、也不填、不保存（没有可靠题面作依据时，宁可不填）。');
                noteMiss({ type: '(截图读题·不可信)', stem: '这一章共 ' + shotN + ' 道题：抄录不可信（' + trust.why + '）', options: [] },
                         '抄录不可信（' + trust.why + '），整章没做（没有可靠题面作依据）');
              } else {
              try {
                /* 【空正文要自动降级重试 —— 否则整章白丢】
                   实测（2026/9/26 23:15，军事理论 3.5 新中国国防建设成就【中】）：
                   题抄得好好的（3 道全对），但答案那段是空的：
                     {"prompt_tokens":354,"completion_tokens":8000}
                   8000 个输出 token 全被思考模式烧在思维链上，正文一个字没剩。
                   请求是成功的（HTTP 200），所以不会抛错 —— 一路静默，最后报"没能认出第几题选什么"，
                   这一章的题就白丢了。
                   光提示用户"调小每章题数"不够 —— 这里自己救一次：
                   先原样重问一遍（思考链偶尔会短），还空就把题目砍一半再问一次。
                   砍半是有依据的：题越少，思维链越短，正文越可能留下来。 */
                let a = await askRaw(ANSWER_FROM_TEXT + '\n\n' + t.text, cfg);
                QS.addUsage(usage, a && a.usage);
                if (a && a.empty) {
                  lines.push('  → 第一次问没拿到正文（思考把额度吃光了），原样重问一次…');
                  await new Promise((r2) => setTimeout(r2, 1200));
                  a = await askRaw(ANSWER_FROM_TEXT + '\n\n' + t.text, cfg);
                  QS.addUsage(usage, a && a.usage);
                }
                if (a && a.empty) {
                  /* 砍一半：只把前一半题目发过去 —— 宁可按顺序答对前几道，也别整章空手 */
                  const src = String(t.text || '');
                  const qMarks = [...src.matchAll(/【(单选|多选|判断)题】/g)].map((m) => m.index);
                  if (qMarks.length > 1) {
                    const keep = Math.max(1, Math.floor(qMarks.length / 2));
                    const cutAt = qMarks[keep] != null ? qMarks[keep] : src.length;
                    lines.push('  → 还是空的，改成只问前 ' + keep + ' 道（题少→思考短→正文才留得下）…');
                    await new Promise((r2) => setTimeout(r2, 1200));
                    a = await askRaw(ANSWER_FROM_TEXT + '\n\n' + src.slice(0, cutAt), cfg);
                    QS.addUsage(usage, a && a.usage);
                    if (a && !a.empty) lines.push('     这一次拿到正文了（只覆盖前 ' + keep + ' 道题）。');
                  }
                }
                lines.push('');
                lines.push('  ──── 答案（模型生成，没有验证过）────');
                for (const L of String(a.text).split(/\r?\n/)) lines.push('  ' + L);
                if (a.empty && a.note) for (const L of String(a.note).split('\n')) lines.push('  ' + L);
                lines.push('  ────────────────────────────────────');
                /* 截图这条路以前只出答案不填 —— 这就是"设置了填充却没填"的原因。
                   现在按题号顺序填（抄录的是真字，页面存的是替身字，题干对不上，只能按顺序）。 */
                if (cfg.autoFill) {
                  if (r.graded) {
                    lines.push('  → 这一页已经在显示答案了（交过了），不填');
                  } else {
                    /* 【保存那一步单独记账、单独兜错】
                       原来"填 + 保存"挤在一个 try 里：保存一抛错，
                       连"填了几道"都记不上账（审查里点的就是这条）。
                       现在：填 → 先记填的账 → 再单独保存 → 保存的账单独记。
                       调用签名（evFn, text, r.found, deps）一个字都没改。 */
                    let fillMsg = '';
                    let fillErr = '';
                    let fillReport = null;
                    try {
                      fillMsg = await fillFromText(evFn, a.text, shotN, {
                        /* 【部分命中：把"第 k 条答案"换算成页面题号】不传（全拍）时行为不变 */
                        indexMap: shotOnly || undefined,
                        reopenQuiz, clickAt,
                        /* 结构化结果直接给数字，省得再从字符串里正则数 */
                        onResult: (rep) => { fillReport = rep; }
                      });
                    } catch (e) {
                      fillErr = (e && e.message) ? e.message : String(e);
                      fillMsg = '填充出错：' + fillErr;
                    }
                    lines.push('  → ' + fillMsg);
                    /* 一道都没认出：按"整章欠账"记，别让账目变成空白。
                       （这是上面那句"一道都没填"的另一半修复：以前这条消息
                        既不匹配"没填上"，也没人记欠账，于是计数文件谎报"全填上了"。） */
                    if (fillErr) {
                      noteMiss({ type: '(截图读题)', stem: '(整章填充出错)', options: [] }, '填充出错：' + fillErr);
                    } else if (/一道都没填/.test(String(fillMsg))) {
                      noteMiss({ type: '(截图读题·整章)', stem: '这一章共 ' + shotN + ' 道题：模型给的答案没能对上题号', options: [] },
                               '模型答案没认出题号，整章没填：' + String(fillMsg).slice(0, 100));
                    } else {
                      /* 有没填上的题，逐条记账（fillFromText 的结论形如"没填上：第2题=…"） */
                      const mm = String(fillMsg).match(/没填上：([\s\S]*)$/);
                      if (mm) {
                        for (const piece of mm[1].split('），').join('）|').split('|')) {
                          const s = piece.trim().replace(/）$/, '）');
                          if (!s) continue;
                          noteMiss({ type: '(截图读题)', stem: s.slice(0, 160), options: [] }, '截图读题后没填上：' + s.slice(0, 120));
                        }
                      }
                      /* 真填进去几道：优先用 fillFromText 直接报回来的数字；
                         拿不到再退回从"已按顺序填进页面：…"里数条数。
                         不再让上层用 found-missed 反推 —— 那个数字把"没填上"和
                         "填了但没保存"都算成了填上了。 */
                      if (fillReport && typeof fillReport.filled === 'number') {
                        for (let i = 0; i < fillReport.filled; i++) noteFilled();
                      } else {
                        const dm = String(fillMsg).match(/已按顺序填进页面：([\s\S]*)$/);
                        if (dm) {
                          const cnt = dm[1].split('，').map((x) => x.trim()).filter(Boolean).length;
                          for (let i = 0; i < cnt; i++) noteFilled();
                        }
                      }
                    }
                    /* ---- 保存（单独一步，抛错也进账） ---- */
                    try {
                      noteSave(await saveDraftResult(evFn));
                    } catch (e) {
                      noteSave(QS.makeSaveResult(QS.SAVE.FAILED,
                        '保存出错：' + ((e && e.message) ? e.message : e),
                        { reason: 'save_threw', evidence: { kind: 'error', detail: (e && e.message) || String(e) } }));
                    }
                    lines.push('  → ' + saveMsg);
                  }
                }
              } catch (e) {
                lines.push('  → 问 AI 失败：' + e.message);
              }
              }
            }
          } catch (e) {
            /* 抄录那一步抛错：已经记过的 usage 照样留在账上 */
            lines.push('  → 看图失败：' + e.message);
            lines.push('     （401 = key 不对；400/404 = 模型名不对，检查"看图模型"这项）');
          }
        }
        lines.push('');
        if (saveResult) lines.push(accountLine());
        lines.push('  ' + QS.formatUsage(usage));
        save();
        return lines;
      }

      /* ---------------- 路 B：直接读网页里的文字 ---------------- */
      let n = 0;
      for (const q of r.questions) {
        if (n >= cfg.maxPerChapter) {
          lines.push('  （超过每章上限 ' + cfg.maxPerChapter + ' 题，剩下的跳过了）');
          noteMiss(q, '超过每章上限 ' + cfg.maxPerChapter + ' 题，被跳过');
          break;
        }
        /* 【指纹：解码后的**完整题干** + **全部选项正文** + 题型】
           原来这里是 `(q.stem||'').slice(0,80) + '|' + q.options.length` ——
           三个毛病：① 只取前 80 字，同一页"下列说法正确的是…"这种开头高度模板化的题，
           两道很容易前 80 字一样、选项数也一样，第二道就被**静默**丢掉；
           ② 用的是解码前的替身字，字体一换同一道题的指纹就变了，去重形同虚设；
           ③ 选项内容完全没进指纹。
           现在用短哈希，而且**被跳过时必须在日志里说明原因和题号**（下面那条 noteMiss）。 */
        const fpKey = fp.fpOf(q);
        if (done.has(fpKey)) {
          const why = doneWhy.get(fpKey) || '与前面某道题指纹相同';
          lines.push('  [跳过] ' + fp.digestOf(q) + ' —— ' + why + '（指纹 ' + fpKey.slice(0, 8) + '）');
          noteMiss(q, '与前面那道题指纹相同（' + why + '，指纹 ' + fpKey.slice(0, 8) + '），已跳过');
          continue;
        }
        done.add(fpKey);
        doneWhy.set(fpKey, '同一章里已经处理过这道题');
        n++;
        if (cfg.stats) cfg.stats.found = (cfg.stats.found || 0) + 1;

        /* 字体反爬：先换回真字，再拿去显示和问 AI */
        let qq = q;
        let obfNote = '';
        if (q.obf && pipeline === 'dom') {
          const ds = decodeObf(q.stem);
          let oh = 0;
          const opts = q.options.map((o) => {
            const d = decodeObf(o.text);
            oh += d.hits;
            return { letter: o.letter, text: d.text };
          });
          qq = { type: q.type, stem: ds.text, options: opts };
          obfNote = '   ⚠字体反爬，已解码（正文 ' + ds.hits + ' 处 / 选项 ' + oh + ' 处）';
        } else if (q.obf) {
          obfNote = '   ⚠正文字体被混淆，这一页没能读出来';
        }

        lines.push('');
        lines.push('  [' + n + '] ' + q.type + obfNote);
        /* 【图片只记 URL，不记内容】题干里常常缺了一块（公式是一张图），
           把图片身份写下来，题库给答案前要核对两边是否一致。
           这一行用 → 开头，跟其它 → 行一样**不进指纹**（建库那边按前缀跳过）。 */
        if (q.imgs && q.imgs.length) {
          lines.push('      → 图片 ' + q.imgs.length + ' 张：' + q.imgs.join(' | '));
          const ids2 = q.imgs.map((u) => imgIds.get(u)).filter(Boolean);
          if (ids2.length) lines.push('      → 图片指纹：' + ids2.join(' | '));
        }
        lines.push('      ' + String(qq.stem).replace(/\n/g, '\n      '));
        for (const o of qq.options) lines.push('        ' + (o.letter || '?') + '. ' + o.text);

        if (cfg.mode >= 2) {
          if (q.obf && pipeline !== 'dom') {
            lines.push('      → 正文没读出来，跳过问 AI');
            noteMiss(q, '字体反爬、正文没读出来（截图那条路也没抄到）');
            continue;
          }
          if (!useAI) {
            /* AI 关着：不走缓存/模型，只查库；库里没有就留着不填（下面 p 为 null 时统一处理） */
          } else if (!cfg.apiKey) {
            lines.push('      → 没有配置 API key，跳过（双击 控制台.cmd → 4 → 4 填）');
            noteMiss(q, '没有配置 API key');
            continue;
          }
          /* 【先查模型答案缓存】
             命中条件（题面指纹一致 + 题型一致 + 模型配置一致 + 缓存结构版本一致）
             四条全中才算命中，缺一条就老老实实重新问。
             **缓存里只有答案**：不假装页面已填写，也不假装平台那边完成了。
             cfg.useAnswerCache === false 时整条缓存都不碰（想每次都问新的就关掉它）。 */
          let p = null;
          /* 缓存也是"模型给的答案"，AI 关着就不该拿它糊上（要重新答一遍的语义） */
          const cached = (cfg.useAnswerCache === false || !useAI) ? null : cacheGet(fpKey, q.type);
          if (cached) {
            p = { answer: cached.answer, reason: (cached.reason || '') + '（来自答案缓存，没重新问模型）' };
            lines.push('      → 答案（缓存）：' + p.answer);
            if (cached.reason) lines.push('        理由：' + cached.reason);
          }
          /* 【本地题库】缓存没命中才查库。命中就把可信度一并打出来
             （aria 确认过 / 多来源一致 / 单来源未确认），冲突的还要多提示一句 ——
             库里可能有别人记录来的答案，用不用得由看得见的人决定，但**不能瞒着**。 */
          if (!p) {
            const bk = bankHitOf(q);               /* 三把键都试（主键/去题号/顺序无关） */
            if (bk && bk.hit) {
              const hit = bk.hit;
              bankHits++;
              p = {
                answer: hit.answer,
                reason: (hit.why || '') + '（来自本地题库：' + hit.trustLabel + '，没问模型）'
              };
              lines.push('      → 答案（题库' + (hit.lib ? '·' + hit.lib : '') + '·' + hit.trustLabel + '）：' + p.answer +
                (hit.answerText ? '　【' + hit.answerText + '】' : '') +
                (hit.byText ? '（选项顺序/字母和库里不一样，已按**正文**重新对上）' : ''));
              if (hit.why) lines.push('        理由：' + hit.why);
              if (hit.conflict) lines.push('        ⚠ ' + hit.conflictNote);
            } else if (bk && bk.miss) {
              /* 库里有这道题，但图片对不上 —— 如实说，别让人以为"库里没有" */
              bankSkipped++;
              lines.push('      → 库里有这道题，但' + bk.miss + ' → 不用（怕填错题），走原路');
            }
          }
          try {
            if (!p && !useAI) {
              /* 【AI 模式关着】库里没有 → **留着不填**（一分钱不花），并且如实记账。
                 题库模式的价值就在这里：有就答、没有就停手，绝不偷偷去问模型。 */
              lines.push('      → 库里没有这道题，AI 模式关着 → 留着不填');
              noteMiss(q, 'AI 模式关着，题库里也没有');
              continue;
            }
            if (!p) {
              const a = await askOne(qq, cfg);
              QS.addUsage(usage, a && a.usage);
              p = parseAnswer(a.text, q.type);
              lines.push('      → 答案：' + (p.answer === null ? '（模型无法确定）' : p.answer));
              if (p.reason) lines.push('        理由：' + p.reason);
              /* 空正文要说清是"模型没返回"而不是"模型不确定" —— 两者处理方式不同：
                 前者调小每章题数/换模型就行，后者是题目本身没法判。 */
              if (a.empty && a.note) {
                lines.push('      → ⚠ 模型返回的是空正文（不是"答不上来"）');
                for (const L of String(a.note).split('\n')) lines.push('        ' + L);
              }
              if (p.answer !== null) cachePut(fpKey, q.type, p.answer, p.reason);
            }

            /* 填进页面（只填，不交）。用 q.stem（页面上的原文）去定位，
               不能用 qq.stem（那是解码后的，页面上不存在）。 */
            if (cfg.autoFill && p.answer !== null) {
              if (r.graded) {
                lines.push('      → 这一页已经在显示答案了（说明交过了），不填');
                noteMiss(q, '页面已在显示答案（已交过），没填');
              } else {
                const st = await tryFill(evFn, q.stem, p.answer, q.type, clickAt);
                lines.push('      → ' + st);
                if (st.indexOf('没填上') >= 0 || st.indexOf('没填') >= 0) {
                  noteMiss(q, '答案「' + p.answer + '」填不进页面：' + st);
                } else {
                  noteFilled();      /* 只有"真填上了"才走到这里 */
                }
              }
            } else if (cfg.autoFill === false) {
              noteMiss(q, '没开自动填（autoFill=false）');
            } else {
              /* p.answer === null：模型答不出来 */
              noteMiss(q, '模型无法确定答案');
            }
          } catch (e) {
            lines.push('      → 问 AI 失败：' + e.message);
            noteMiss(q, '问 AI 失败：' + e.message);
          }
        } else {
          noteMiss(q, '答题助手模式是「' + (cfg.mode === 0 ? '不做题' : '记下题·不问AI') + '」，没答题');
        }
      }
      if (cfg.autoFill && !r.graded && obfN > 0) {
        /* 【保存这一步单独兜错】原来这里是 `catch (e) {}` ——
           "保存失败"和"保存成功"在日志里长得一模一样。现在如实记进保存账目。 */
        let sr = null;
        try {
          sr = await saveDraftResult(evFn);
        } catch (e) {
          sr = QS.makeSaveResult(QS.SAVE.FAILED, '保存出错：' + ((e && e.message) ? e.message : e),
            { reason: 'save_threw', evidence: { kind: 'error', detail: (e && e.message) || String(e) } });
        }
        noteSave(sr);
        lines.push('  → ' + saveMsg);
      }
      if (bankHits) lines.push('  本地题库命中 ' + bankHits + ' 题（这些题没问模型）');
      if (bankLastNote) { lines.push('  ' + bankLastNote); bankLastNote = ''; }
      if (bankSkipped) lines.push('  ⚠ 另有 ' + bankSkipped + ' 题库里有、但图片对不上没敢用的（怕填错题）');
      cacheStore();       /* 把这一章问到的新答案落盘，重跑时能省 API 调用 */
      lines.push('');
      if (saveResult) lines.push(accountLine());
      lines.push('  ' + QS.formatUsage(usage));
      save();
      return lines;
    }
  };
}

module.exports = {
  apiUrlOf, maskApiUrl, API_URL,
  loadConfig, saveConfig, makeHelper, parseAnswer,
  decodeObf, hasFontTable, loadFontTable, fontTableMatches,
  /* 下面几个是为了能单独测"截图读题"和"填进页面"这两条路而导出的 */
  grabShots, transcribeShots, scrollToQuestion, countQuestions, askRaw,
  fillAct, tryFill, fillFromText, JUDGE_SYN, saveDraft, saveProbe, questionShotPlan,
  modelMigrationNote, DEAD_MODELS,
  DEFAULT_CFG, FONT_TABLE,
  /* ---- 2026-10 新增（都是加法，老的导出一个没动）----
     saveDraftResult —— 结构化的保存结果（状态/证据/待确认标记），给记账用；
     saveDraft 保持原样返回字符串，driver.js 与控制台不受影响。
     lastConfigError —— 配置读坏时的原因（原来被静默吞掉）。 */
  saveDraftResult, lastConfigError, configBackupInfo,
  SAVE_STATE, describeSaveProgress,
  /* 用量与限额常量，方便离线测试与自检 */
  API_TIMEOUT_MS, API_TIMEOUT_MS_LONG, API_RETRIES_CONN, API_RETRIES_TIMEOUT,
  VISION_TIMEOUT_MS, classifyApiFailure, fetchWithTimeout,
  /* 答案缓存的位置与读写（测试可以把它指到临时目录） */
  get ANSWER_CACHE_FILE() { return ANSWER_CACHE_FILE; },
  set ANSWER_CACHE_FILE(p) { ANSWER_CACHE_FILE = p; },
  /* 本地题库的位置（测试指到临时目录；生产就是工程根那份 题库.json） */
  get BANK_FILE() { return BANK_FILE; },
  set BANK_FILE(p) { BANK_FILE = p; },
  /* 配置文件位置：测试指到临时目录用（**绝不要指向真文件**） */
  get CFG_FILE() { return CFG_FILE; },
  set CFG_FILE(p) { CFG_FILE = p; },
  get CFG_BAK_FILE() { return cfgBakFile(); },
  /* 记录文件位置：测试指到临时目录用（**绝不往真记录里写测试内容**） */
  get OUT_FILE() { return OUT_FILE; },
  set OUT_FILE(p) { OUT_FILE = p; }
};
