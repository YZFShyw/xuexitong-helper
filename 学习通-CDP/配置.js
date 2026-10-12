/* 配置 —— 答题助手的命令行开关
 *
 * 用法：
 *   node 配置.js                  看当前配置（key 打码）
 *   node 配置.js --json           输出完整 JSON（key 也打码，要明文请自己开文件）
 *   node 配置.js --set mode=2     改配置（会先备份上一份，再原子写入）
 *   node 配置.js --set key=sk-xx  设 API key
 *   node 配置.js --set apiUrl=https://your-gateway.example/v1/chat/completions
 *                                 换 API 网关（默认 DeepSeek 官方；填 default 或留空 = 恢复默认）
 *   node 配置.js --clear-key      清掉 key
 *   node 配置.js --test           拿当前 key 真的发一次请求，看能不能用
 *   node 配置.js --table          看字体反爬对照表的状态
 *
 * 【写配置的两条硬规矩】
 *   1. 原文件读不出来（JSON 坏了 / 是空的）就**拒绝写**，并把原因打出来 ——
 *      loadConfig 在坏文件上会静默返回默认值，直接保存等于把里面的 API key 抹掉。
 *   2. 写完会留一份 .bak（上一份），并且是"临时文件 + rename"的原子写 ——
 *      中途断电也不会留下半截 JSON。
 *   另外：这个命令行**从不输出 key 明文**（连 --json 也是打码）。
 *
 * ------------------------------------------------------------------
 * 为什么要单独做这个命令行，而不是让控制台直接改 JSON：
 *
 *   答题设置.json 的读写规则集中在 答题助手.js 里
 *   （包括"PowerShell 写的 UTF-8 带 BOM，JSON.parse 之前要先剥掉"这条）。
 *   如果控制台自己再去读写这个文件，就等于有两个人管同一份配置，
 *   迟早出现"界面显示 mode 1、驱动器读到 mode 0"这种鬼事。
 *   所以：写配置只走这一个入口，而这个入口复用 答题助手.js 的读写法。
 *
 * 另一个原因是防止 key 被命令行解析搞坏：
 *   PowerShell 调 node 时参数是按数组传的，不经过 cmd 拆词，
 *   所以 sk-xxx 里就算有特殊字符也不会被吃掉。
 *   如果改成拼接一整个命令行字符串，就会有这个风险。
 * ------------------------------------------------------------------ */

'use strict';

const fs = require('fs');
const path = require('path');
const q = require('./答题助手.js');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : null;
};

function mask(k) {
  if (!k) return '(没配)';
  if (k.length <= 12) return k.slice(0, 3) + '…(' + k.length + ' 位)';
  return k.slice(0, 5) + '…' + k.slice(-4) + '  (' + k.length + ' 位)';
}

/* 有效 key：配置文件优先，其次环境变量 DEEPSEEK_API_KEY */
function effectiveKey(cfg) {
  if (cfg.apiKey) return { key: cfg.apiKey, from: '配置文件' };
  if (process.env.DEEPSEEK_API_KEY) return { key: process.env.DEEPSEEK_API_KEY, from: '环境变量 DEEPSEEK_API_KEY' };
  return { key: '', from: '没有' };
}

const MODE_NAME = ['不做题（只放视频翻节，测验一概不碰）', '记下题，不问 AI', '记下题 + 问 AI'];

const READ_MODE_NAME = {
  table: '只用解码表（快、免费；对方换字体就失效）',
  shot: '只用截图 + 看图模型（慢、要钱；不依赖字体）',
  auto: '自动（解码表有效就用表，失效就改用截图）'
};

/* ---------------- --table ---------------- */
if (has('--table')) {
  const tf = q.FONT_TABLE;
  console.log('字体反爬对照表');
  console.log('  位置: ' + tf);
  if (!fs.existsSync(tf)) {
    console.log('  状态: 缺失 —— 遇到混淆文本只能跳过');
    console.log('  生成: 见 _字体\\对照表说明.txt');
    process.exit(1);
  }
  const t = JSON.parse(fs.readFileSync(tf, 'utf8').replace(/^\uFEFF/, ''));
  const n = Object.keys(t.map || {}).length;
  console.log('  状态: 已装，' + n + ' 个替身字');
  console.log('  生成: ' + t.generated + '   方法: ' + t.method);

  /* 校验：对照表记录的字体指纹，跟磁盘上那份字体对不对得上。
     对不上说明字体被换过，这张表就不能信了。 */
  const fp = path.join(path.dirname(tf), 'font-01-font-cxsecret.ttf');
  if (fs.existsSync(fp)) {
    const sha = require('crypto').createHash('sha256').update(fs.readFileSync(fp)).digest('hex');
    if (sha === t.sha256) {
      console.log('  校验: 通过（字体指纹一致）');
    } else {
      console.log('  校验: 不通过！磁盘字体 ' + sha.slice(0, 16) + '… 与表里记录的 ' + t.sha256.slice(0, 16) + '… 不同');
      console.log('        这说明字体被换过，请按说明重新生成对照表。');
    }
  }
  process.exit(0);
}

/* ---------------- --test ---------------- */
if (has('--test')) {
  const cfg = q.loadConfig();
  const cfgErrT = q.lastConfigError ? q.lastConfigError() : '';
  if (cfgErrT) {
    console.log('⚠ ' + cfgErrT);
    console.log('  这一趟测的是**默认值**里的模型，不一定是配置文件里那个。');
    console.log('');
  }
  const e = effectiveKey(cfg);
  if (!e.key) {
    console.log('没有 key，没法测。先设一个：node 配置.js --set key=sk-xxx');
    process.exit(1);
  }
  console.log('用 ' + e.from + ' 里的 key（' + mask(e.key) + '）向 ' + cfg.model + ' 发一次最小请求…');
  console.log('  网关：' + q.maskApiUrl(q.apiUrlOf(cfg)) + (q.apiUrlOf(cfg) === q.API_URL ? '（默认 DeepSeek）' : '（自定义）'));
  const t0 = Date.now();
  fetch(q.apiUrlOf(cfg), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + e.key },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 16,
      messages: [{ role: 'user', content: '回答两个字：可以' }]
    })
  }).then(async (r) => {
    const txt = await r.text();
    const ms = Date.now() - t0;
    if (r.ok) {
      let reply = '';
      try { reply = JSON.parse(txt)?.choices?.[0]?.message?.content || ''; } catch { }
      console.log('');
      console.log('  可用！HTTP ' + r.status + '   ' + ms + 'ms');
      console.log('  模型回话: ' + JSON.stringify(reply.slice(0, 60)));
      console.log('  余额信息: ' + (r.headers.get('x-ratelimit-remaining') || '（接口没给）'));
      process.exit(0);
    }
    console.log('');
    console.log('  用不了。HTTP ' + r.status + '   ' + ms + 'ms');
    const why = {
      400: '请求格式有问题',
      401: 'key 不对（或者被停用了）',
      402: '账户余额不足，需要充值',
      422: '参数不合法',
      429: '请求太频繁，或者额度用尽了',
      500: '对方服务器出错了',
      503: '对方服务暂时不可用'
    }[r.status] || '未知错误';
    console.log('  原因: ' + why);
    console.log('  原文: ' + txt.slice(0, 200));
    process.exit(1);
  }).catch((err) => {
    console.log('');
    console.log('  连不上: ' + (err && err.message));
    console.log('  原因链: ' + ((err && err.cause && err.cause.message) || '（没有更多信息）'));
    console.log('  这台机器上 Node 是能连 ' + (() => { try { return new URL(q.apiUrlOf(cfg)).host; } catch (e) { return '接口地址'; } })() + ' 的，');
    console.log('  连不上通常是代理、防火墙或者断网。');
    process.exit(1);
  });
} else {

  /* ---------------- 写配置之前：先确认原文件是好的 ----------------
   * 【为什么要有这一道】
   *   loadConfig() 在 JSON 坏掉时会**静默返回默认配置**（driver.js 依赖这条，
   *   不能改成抛异常）。但命令行拿到那份"默认值"再 saveConfig，
   *   就等于把用户原文件里的 API key 一起抹掉 —— 而且用户看到的只是
   *   "配置怎么变回默认值了"，完全不知道真正发生的是"文件坏了"。
   *   所以：写之前先严格读一次；读不出来就拒绝写，并把原因打出来。
   *   网页控制台里本来就有同样一道闸门（saveConfigPatch），
   *   这里补上之后，两个写入口就都挡得住。
   * ------------------------------------------------------------------ */
  function guardBeforeWrite() {
    let raw = null, exists = false;
    try {
      exists = fs.existsSync(q.CFG_FILE);
      if (exists) raw = fs.readFileSync(q.CFG_FILE, 'utf8');
    } catch (e) {
      console.log('读不了 ' + q.CFG_FILE + '：' + (e && e.message ? e.message : e));
      console.log('这次一个字节都没写。');
      process.exit(1);
    }
    if (!exists) return;                       /* 文件不在：正常创建 */
    const t = String(raw).replace(/^\uFEFF/, '').trim();
    if (!t) {
      console.log('⚠ ' + q.CFG_FILE + ' 是空的 —— 不敢在上面写东西。');
      console.log('  里面可能本来有 API key。请先手工看一眼那个文件。这次一个字节都没写。');
      process.exit(1);
    }
    let bad = '';
    try {
      const j = JSON.parse(t);
      if (!j || typeof j !== 'object' || Array.isArray(j)) bad = '内容不是 JSON 对象';
    } catch (e) {
      bad = '不是合法 JSON：' + ((e && e.message) || e);
    }
    if (bad) {
      console.log('⚠ ' + q.CFG_FILE + ' 现在读不出来（' + bad + '）。');
      console.log('  为了不把里面的 API key 一起写没，这次**什么也没改**。');
      console.log('  请先手工修好那个文件（或者先把它改名备份），再来设置。');
      process.exit(1);
    }
  }

  /* 每次写完都说一句写没写成、备份在哪。绝不回显 key。 */
  function writeCfg(c) {
    try {
      const r = q.saveConfig(c);
      if (r && r.backup) console.log('（上一份已备份到 ' + path.basename(r.backup) + '）');
      return true;
    } catch (e) {
      console.log('写配置失败：' + ((e && e.message) ? e.message : e));
      process.exit(1);
    }
  }

  /* ---------------- --set / --clear-key ---------------- */
  if (has('--clear-key')) {
    guardBeforeWrite();
    const c = q.loadConfig();
    c.apiKey = '';
    writeCfg(c);
    console.log('已清除 API key。');
  }

  const setArg = val('--set');
  if (setArg && setArg.includes('=')) {
    /* 【先挡坏文件，再改】顺序不能反 —— 反过来就是"先读了默认值、再把默认值写回去" */
    guardBeforeWrite();
    const i = setArg.indexOf('=');
    const k = setArg.slice(0, i).trim();
    const v = setArg.slice(i + 1);
    const c = q.loadConfig();
    const cfgErr = q.lastConfigError ? q.lastConfigError() : '';
    if (cfgErr) {
      /* 走到这里说明文件刚才是好的、刚刚读坏了 —— 同样拒绝写。 */
      console.log('⚠ 配置读出来的不是原文件的内容：' + cfgErr);
      console.log('  这次什么也没改。');
      process.exit(1);
    }
    switch (k) {
      case 'mode': {
        const n = Number(v);
        if (![0, 1, 2].includes(n)) { console.log('mode 只能是 0 / 1 / 2'); process.exit(1); }
        c.mode = n;
        console.log('模式已设为 ' + n + ' —— ' + MODE_NAME[n]);
        break;
      }
      case 'key':
      case 'apiKey': {
        const t = String(v).trim();
        if (!t) { console.log('key 是空的，没改。要清掉请用 --clear-key'); process.exit(1); }
        c.apiKey = t;
        console.log('API key 已保存（' + mask(t) + '）');
        break;
      }
      case 'model': {
        if (!String(v).trim()) { console.log('模型名不能为空'); process.exit(1); }
        c.model = String(v).trim();
        console.log('模型已设为 ' + c.model);
        break;
      }
      /* 【网关地址】默认 DeepSeek；换中转就填整条 URL（很多网关是 /v1/chat/completions）。
         传 default 或空 = 恢复默认。校验 http(s)：写错就当场拒绝，不让 key 被发到奇怪的地方。 */
      case 'apiUrl': {
        const t = String(v).trim();
        if (!t || t.toLowerCase() === 'default') {
          c.apiUrl = q.API_URL;
          console.log('网关地址=默认（' + q.maskApiUrl(q.API_URL) + '）');
          break;
        }
        if (!/^https?:\/\//i.test(t)) {
          console.log('网关地址必须以 http:// 或 https:// 开头（你填的是：' + t.slice(0, 80) + '）');
          process.exit(1);
        }
        c.apiUrl = t;
        console.log('网关地址已设为 ' + q.maskApiUrl(t));
        break;
      }
      case 'readMode': {
        const t = String(v).trim();
        if (!['table', 'shot', 'auto'].includes(t)) {
          console.log('readMode 只能是 table / shot / auto');
          process.exit(1);
        }
        c.readMode = t;
        console.log('读题方式已设为 ' + t + ' —— ' + READ_MODE_NAME[t]);
        break;
      }
      case 'visionModel': {
        if (!String(v).trim()) { console.log('模型名不能为空'); process.exit(1); }
        c.visionModel = String(v).trim();
        console.log('看图模型已设为 ' + c.visionModel);
        break;
      }
      case 'autoFill': {
        if (!['0', '1', 'true', 'false', 'on', 'off', '开', '关', '是', '否'].includes(v)) {
          console.log('autoFill 只能是 1 / 0');
          process.exit(1);
        }
        c.autoFill = ['1', 'true', 'on', '开', '是'].includes(v);
        console.log('AI 答案自动填进页面：' + (c.autoFill ? '开（只填选择/判断题，不提交）' : '关'));
        break;
      }
      case 'useAI': {
        if (!['0', '1', 'true', 'false', 'on', 'off', '开', '关', '是', '否'].includes(v)) {
          console.log('useAI 只能是 1 / 0');
          process.exit(1);
        }
        c.useAI = ['1', 'true', 'on', '开', '是'].includes(v);
        console.log('AI 模式（问模型答题）：' + (c.useAI ? '开' : '关（一分钱不花）'));
        break;
      }
      case 'useBank': {
        if (!['0', '1', 'true', 'false', 'on', 'off', '开', '关', '是', '否'].includes(v)) {
          console.log('useBank 只能是 1 / 0');
          process.exit(1);
        }
        c.useBank = ['1', 'true', 'on', '开', '是'].includes(v);
        console.log('题库模式（先用本地题库答）：' + (c.useBank ? '开' : '关（一律重新问模型）'));
        break;
      }
      case 'maxPerChapter': {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 1) { console.log('每章上限要是正整数'); process.exit(1); }
        c.maxPerChapter = Math.floor(n);
        console.log('每章上限已设为 ' + c.maxPerChapter);
        break;
      }
      case 'stopAtQuiz': {
        if (!['0', '1', 'true', 'false', 'on', 'off', '是', '否'].includes(v)) {
          console.log('stopAtQuiz 只能是 1/0'); process.exit(1);
        }
        c.stopAtQuiz = ['1', 'true', 'on', '是'].includes(v);
        console.log('遇到测验停下：' + (c.stopAtQuiz ? '开' : '关'));
        break;
      }
      case 'useAnswerCache': {
        if (!['0', '1', 'true', 'false', 'on', 'off', '开', '关', '是', '否'].includes(v)) {
          console.log('useAnswerCache 只能是 1 / 0'); process.exit(1);
        }
        c.useAnswerCache = ['1', 'true', 'on', '开', '是'].includes(v);
        console.log('模型答案缓存：' + (c.useAnswerCache
          ? '开（题面指纹 + 题型 + 模型都一致才复用，只存答案、不存凭据）'
          : '关（每次都重新问模型）'));
        break;
      }
      default:
        console.log('不认识的配置项: ' + k);
        console.log('可用: mode / key / model / readMode / visionModel / autoFill / maxPerChapter / stopAtQuiz / useAnswerCache / useAI / useBank');
        process.exit(1);
    }
    writeCfg(c);
  } else if (has('--set')) {
    console.log('--set 的写法是 --set 项目=值，比如 --set mode=2');
    process.exit(1);
  } else if (has('--json')) {
    /* 【--json 也不回显 key】
       原来这里是 `JSON.stringify(q.loadConfig(), null, 2)` ——
       整份配置连同 API key 明文打到终端（还会留在终端回滚缓冲、
       被复制粘贴到聊天里）。要看 key 请自己开 答题设置.json，
       命令行只给打码形式。
       --json 的用途是"看清楚每一项现在是什么"，打码不影响这个用途。 */
    const j = q.loadConfig();
    const red = Object.assign({}, j);
    if (red.apiKey) red.apiKey = '<已配置 ' + String(red.apiKey).length + ' 位，这里不回显>';
    const cfgErrJson = q.lastConfigError ? q.lastConfigError() : '';
    if (cfgErrJson) red.__读取提示 = cfgErrJson;
    console.log(JSON.stringify(red, null, 2));
    process.exit(0);
  }

  /* ---------------- 默认：人看的配置 ---------------- */
  const cfg = q.loadConfig();
  const e = effectiveKey(cfg);
  const cfgErr = q.lastConfigError ? q.lastConfigError() : '';
  const bak = q.configBackupInfo ? q.configBackupInfo() : null;
  /* 【配置坏了要说出来】
     以前这里什么都不说，用户看到的就是"配置全变默认值了"，
     而真相是"文件读不出来"。这句话就是为这个场景加的。 */
  if (cfgErr) {
    console.log('⚠ ' + cfgErr);
    if (bak) console.log('  （上一份备份还在：' + path.basename(bak.file) + '，' + bak.at + '，' + bak.size + ' 字节）');
    console.log('  在修好之前，任何 --set / --clear-key 都会被拒绝，不会覆盖原文件。');
    console.log('');
  }
  const mig = q.modelMigrationNote ? q.modelMigrationNote() : '';
  console.log('答题助手配置     ' + q.CFG_FILE);
  console.log('  模式           ' + cfg.mode + ' —— ' + MODE_NAME[cfg.mode]);
  console.log('  模型           ' + cfg.model + (mig ? ('   ⚠ ' + mig) : ''));
  console.log('  网关地址       ' + q.maskApiUrl(q.apiUrlOf(cfg)) +
    (q.apiUrlOf(cfg) === q.API_URL ? '   （默认 DeepSeek）' : '   （自定义）'));
  if (mig) {
    console.log('                 官方现在只有两个模型名：');
    console.log('                   deepseek-flash    V4.1-Flash，1M 上下文，支持看图，便宜');
    console.log('                   deepseek-v4-pro   V4-Pro，更强更贵，不支持看图');
    console.log('                 存一下：node 配置.js --set model=deepseek-flash');
  }
  console.log('  API key        ' + mask(e.key) + (e.key ? '   来源: ' + e.from : ''));
  console.log('  每章上限       ' + cfg.maxPerChapter + ' 题');
  console.log('  遇到测验停下   ' + (cfg.stopAtQuiz ? '开（测验停）' : '关（测验不停）'));
  console.log('  读题方式       ' + (READ_MODE_NAME[cfg.readMode] || cfg.readMode));
  console.log('  看图模型       ' + cfg.visionModel);
  console.log('  自动填答案     ' + (cfg.autoFill ? '开（只填选择/判断题，不提交）' : '关'));
  console.log('  AI 模式        ' + (cfg.useAI !== false ? '开（不命中题库就问模型）' : '关（只按题库答，一分钱不花）'));
  console.log('  题库模式       ' + (cfg.useBank !== false ? '开（先查本地题库）' : '关（一律重新问模型）'));
  console.log('  记录文件       ' + q.OUT_FILE);
  process.exit(0);
}
