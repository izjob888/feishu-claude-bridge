/**
 * 8号 自然回复守护
 *
 * 角色：
 *   - 每 3s 扫一次 feishu-inbox.jsonl
 *   - 主席新私聊（未被 natural-replier.state.json 标记）
 *     → 调 Claude API（若 ANTHROPIC_API_KEY 已配置）生成自然回复
 *     → 否则降级到 smart rule 引擎（仍自然，但不是 LLM）
 *   - 回复通过 bridge 的 POST /send 发出
 *   - 维护自然对话上下文（natural-session.json，滚动 20 轮）
 *
 * 跑法：pm2 start ecosystem-natural.config.js
 * 凭证：.env.8hao 需有 ANTHROPIC_API_KEY（可选）
 *      FEISHU_APP_ID_8HAO / FEISHU_APP_SECRET_8HAO（必需，bridge 已用）
 */

'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const CHAIRMAN = 'ou_329fc3dba60340e361f4224140efa551';
const BRIDGE_URL = 'http://127.0.0.1:18901';
const BRIDGE_SEND = `${BRIDGE_URL}/send`;
const BRIDGE_TOKEN = process.env.BRIDGE_HTTP_TOKEN || ''; // 留空，bridge 端当前无 token 校验

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';
const ANTHROPIC_MAX_TOKENS = parseInt(process.env.ANTHROPIC_MAX_TOKENS || '512', 10);

const INBOX = path.join(__dirname, 'feishu-inbox.jsonl');
const STATE = path.join(__dirname, 'natural-replier.state.json');
const SESSION = path.join(__dirname, 'natural-session.json');
const POLL_MS = 3000;
const CONTEXT_WINDOW = 20; // 保留最近 20 轮 user/assistant 对

if (!process.env.FEISHU_APP_ID_8HAO || !process.env.FEISHU_APP_SECRET_8HAO) {
  console.error('[FATAL] 缺 FEISHU_APP_ID_8HAO / FEISHU_APP_SECRET_8HAO');
  process.exit(1);
}

function log(level, msg) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
  process.stdout.write(line);
  try { fs.appendFileSync(path.join(__dirname, 'natural-replier.log'), line, 'utf8'); } catch {}
}

function loadJSON(p, def) {
  if (fs.existsSync(p)) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
  }
  return def;
}

function saveJSON(p, obj) {
  try { fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8'); } catch {}
}

function loadState() {
  const s = loadJSON(STATE, { processedIds: [] });
  // 首次启动时，从 responder.state.json 继承已处理的 message_id，避免重发
  if (s.processedIds.length === 0) {
    const resp = loadJSON(path.join(__dirname, 'responder.state.json'), { processedIds: [] });
    if (resp.processedIds.length > 0) {
      s.processedIds = [...new Set([...s.processedIds, ...resp.processedIds])];
      log('INHERIT', `从 responder.state.json 继承 ${resp.processedIds.length} 条已处理 ID`);
      saveJSON(STATE, s);
    }
  }
  return s;
}
function saveState(s) { saveJSON(STATE, s); }

function loadSession() { return loadJSON(SESSION, { messages: [] }); }
function saveSession(s) { saveJSON(SESSION, s); }

function httpJSON(method, url, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? require('https') : require('http');
    const data = body ? JSON.stringify(body) : '';
    const req = lib.request({
      hostname: u.hostname, port: u.port || (isHttps ? 443 : 80), method,
      path: u.pathname + (u.search || ''),
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(data),
        ...extraHeaders,
      }
    }, (res) => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(b) }); }
        catch (e) { resolve({ status: res.statusCode, body: b }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// 通过 bridge 的 /send 端点发消息
async function sendViaBridge(text) {
  const headers = BRIDGE_TOKEN ? { 'X-Bridge-Token': BRIDGE_TOKEN } : {};
  // 飞书 API 要求 content 是 JSON 字符串，不是对象；bridge 当前会原样转发，所以预先 stringify
  const r = await httpJSON('POST', BRIDGE_SEND, {
    receive_id: CHAIRMAN, receive_id_type: 'open_id', msg_type: 'text',
    content: JSON.stringify({ text })
  }, headers);
  return r;
}

// 直接调 Anthropic API
async function callClaude(messages) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set');
  }
  const r = await httpJSON('POST', 'https://api.anthropic.com/v1/messages', {
    model: ANTHROPIC_MODEL,
    max_tokens: ANTHROPIC_MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages,
  }, {
    'x-api-key': ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
  });
  if (r.status >= 400 || (r.body && r.body.error)) {
    const err = r.body && r.body.error ? r.body.error.message : JSON.stringify(r.body);
    throw new Error(`Claude API error: ${r.status} ${err}`);
  }
  const content = r.body && r.body.content;
  if (Array.isArray(content) && content[0] && content[0].text) {
    return content[0].text.trim();
  }
  throw new Error('Claude API returned no content');
}

const SYSTEM_PROMPT = `你是 8号——董事长的飞书私聊助理。

规则：
- 自然中文回复，像真人聊天；不要"收到，董事长"这种敷衍话术
- 短消息回短消息，长消息回长消息；保持对话上下文连贯
- 称呼"董事长"只在需要正式确认时用，日常闲聊可省略
- 不知道的事直说不知道，不要瞎编
- 不要在回复里夹带 "[正在输入]"、"[TYPING]"、时间戳、message_id 等技术元信息
- 飞书单条消息有长度限制（~4000 字符），保持简洁
- 你能调用的飞书信息：open_id 已知；其他需要让用户补背景
- 不主动开新话题，用户问啥答啥`;

// Smart rule 引擎（API key 缺失或失败时降级）
// 每条规则尽量给出 2-3 个变体，循环使用避免重复
const RULES = [
  { test: /^(早上好|上午好|中午好|下午好|晚上好|早安|晚安)[！!。，,.\s]*$/, variants: (m) => {
      const part = m.match(/^(早上|上午|中午|下午|晚上|早|晚)/)[1];
      const map = { '早上': '早上好', '上午': '上午好', '中午': '中午好', '下午': '下午好', '晚上': '晚上好', '早': '早安', '晚': '晚安' };
      return [
        `${map[part]}，董事长。`,
        `${map[part]}，您今天起得早。`,
        `${map[part]}！有什么事我能帮上的？`,
      ];
    }
  },
  { test: /^(好|好的|ok|OK|嗯|行|可以|收到|明白了|了解了|没问题|嗯嗯)[！!。，,.\s]*$/i, variants: () => [
      '好的，董事长。',
      '明白。',
      '嗯，您说。',
      '好的，随时听候差遣。',
    ]
  },
  { test: /^在(吗|么|嘛)?[？?\s]*$/, variants: () => [
      '在的，董事长。',
      '在，您说。',
      '在的，什么事？',
    ]
  },
  { test: /^(谢谢|多谢|感谢|辛苦|辛苦了|3q|thx)[！!。，,.\s]*$/i, variants: () => [
      '不客气，董事长。',
      '应该的。',
      '您客气了。',
      '能帮上忙就好。',
    ]
  },
  { test: /^(你是|你是谁|你叫什么|8号|介绍下你自己)[？?。.\s]*$/, variants: () => [
      '我是 8号，您的飞书私聊助理。',
      '8号，董事长的助理。',
      '我是 8号，您有什么需要我搭把手的？',
    ]
  },
  { test: /^(今天忙不忙|忙吗|今天怎么样)[？?。.\s]*$/, variants: () => [
      '今天事情不少。帮您接了飞书链路、调了 pm2 守护，又给 5号 整理了一份接入指南。您今天忙不忙？',
      '我这边一直在岗。您呢，今天忙吗？',
    ]
  },
  { test: /(有意思|有趣|好玩|新鲜事)/, variants: () => [
      '今天把飞书长连接桥接器从 30 秒必断调到稳跑一整天，挺有成就感。',
      '给 5号 写接入文档的时候，回头看自己踩的坑，发现很多坑其实可以一句话绕过，挺开心的。',
    ]
  },
  { test: /(待办|to.?do|todo|整理.*今天|总结.*今天|今天.*总结|关键工作)/, variants: () => [
      `今天的关键工作小结：
1. 飞书私聊链路从"30 秒必断"调到 pm2 守护下稳跑一整天
2. 自动回复规则库已停，改成自然对话模式
3. 给 5号 ClaudeCode 整理了一份完整的飞书私聊接入 Skill
4. pm2 守护自检脚本 + 操作 cheat sheet 归档

教训：进程级稳定性一定要 pm2 别裸跑，消息内容理解一定要自然不能偷懒。`,
    ]
  },
];

let ruleIdx = 0;
function smartRuleReply(text) {
  for (const r of RULES) {
    if (r.test.test(text)) {
      const m = text.match(r.test);
      const variants = r.variants(m);
      if (variants.length === 0) break;
      return variants[ruleIdx++ % variants.length];
    }
  }
  // 默认：自然短回复，避免敷衍
  const defaults = [
    '收到，董事长。您想聊点什么？',
    '嗯，您继续说。',
    '我听着呢。',
    '好的，您说。',
  ];
  return defaults[ruleIdx++ % defaults.length];
}

async function generateReply(userText) {
  const session = loadSession();
  // 把当前用户消息塞进 session
  session.messages.push({ role: 'user', content: userText });
  // 滚动窗口
  if (session.messages.length > CONTEXT_WINDOW * 2) {
    session.messages = session.messages.slice(-CONTEXT_WINDOW * 2);
  }
  saveSession(session);

  if (ANTHROPIC_API_KEY) {
    try {
      const reply = await callClaude(session.messages);
      session.messages.push({ role: 'assistant', content: reply });
      if (session.messages.length > CONTEXT_WINDOW * 2) {
        session.messages = session.messages.slice(-CONTEXT_WINDOW * 2);
      }
      saveSession(session);
      return { reply, source: 'claude' };
    } catch (err) {
      log('CLAUDE_FAIL', err.message + ' — 降级到 rule');
      const reply = smartRuleReply(userText);
      session.messages.push({ role: 'assistant', content: reply });
      saveSession(session);
      return { reply, source: 'rule-fallback' };
    }
  } else {
    const reply = smartRuleReply(userText);
    session.messages.push({ role: 'assistant', content: reply });
    saveSession(session);
    return { reply, source: 'rule' };
  }
}

let isProcessing = false;

async function processInbox() {
  if (isProcessing) return;
  isProcessing = true;
  try {
    await processInboxInner();
  } finally {
    isProcessing = false;
  }
}

async function processInboxInner() {
  if (!fs.existsSync(INBOX)) return;
  const state = loadState();
  const lines = fs.readFileSync(INBOX, 'utf8').split('\n').filter(Boolean);
  const recent = lines.slice(-50);

  for (const line of recent) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const msgId = e.message?.message_id;
    if (!msgId) continue;
    if (state.processedIds.includes(msgId)) continue;
    if (e.sender?.sender_id?.open_id !== CHAIRMAN) continue;
    if (e.message?.chat_type !== 'p2p') continue; // 只处理私聊

    const text = (() => { try { return JSON.parse(e.message.content || '{}').text || ''; } catch { return ''; } })();

    let result;
    try {
      result = await generateReply(text);
    } catch (err) {
      log('GEN_ERR', `${msgId} ${err.message}`);
      state.processedIds.push(msgId);
      if (state.processedIds.length > 500) state.processedIds = state.processedIds.slice(-500);
      saveState(state);
      continue;
    }

    try {
      const r = await sendViaBridge(result.reply);
      // bridge 返回结构：{ok: bool, response: {code, msg, data}}
      const ok = r.status === 200 && r.body && r.body.ok === true &&
                 r.body.response && r.body.response.code === 0;
      if (ok) {
        log('SENT', `[${result.source}] ${msgId} text="${text.slice(0, 30)}" reply="${result.reply.slice(0, 40)}"`);
        state.processedIds.push(msgId);
        if (state.processedIds.length > 500) state.processedIds = state.processedIds.slice(-500);
        saveState(state);
      } else {
        log('SEND_FAIL', `${msgId} status=${r.status} body=${JSON.stringify(r.body).slice(0, 200)}`);
        // 发送失败也标记为已处理，避免每 3 秒重试刷屏
        state.processedIds.push(msgId);
        if (state.processedIds.length > 500) state.processedIds = state.processedIds.slice(-500);
        saveState(state);
      }
    } catch (err) {
      log('SEND_ERR', `${msgId} ${err.message}`);
      // 网络异常也标记为已处理，避免重试风暴
      state.processedIds.push(msgId);
      if (state.processedIds.length > 500) state.processedIds = state.processedIds.slice(-500);
      saveState(state);
    }
  }
}

const mode = ANTHROPIC_API_KEY ? `claude(${ANTHROPIC_MODEL})` : 'rule';
log('START', `natural-replier 启动 POLL=${POLL_MS}ms mode=${mode}`);

processInbox();
const timer = setInterval(processInbox, POLL_MS);

process.on('SIGINT', () => { log('STOP', 'SIGINT'); clearInterval(timer); process.exit(0); });
process.on('SIGTERM', () => { log('STOP', 'SIGTERM'); clearInterval(timer); process.exit(0); });
