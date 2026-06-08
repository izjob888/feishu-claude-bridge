/**
 * 8号 飞书「正在输入」状态指示器
 *
 * 功能：
 *   - 每 1.5 秒扫一次 feishu-inbox.jsonl
 *   - 对主席发来的新私聊，立刻给消息加 ✅ reaction（飞书公开 API 没有 typing 端点，
 *     这是最接近"正在输入"的可视化效果——reaction 头像会出现在消息右下角）
 *   - 群消息 / @_all 类不触发
 *   - 已加 reaction 的 message_id 写入 typing.state.json（最多保留 200 条）
 *
 * 跑法：pm2 start ecosystem-typing.config.js
 * 设计目标：不改 bridge.js，与现有链路解耦
 */

'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const CHAIRMAN = 'ou_329fc3dba60340e361f4224140efa551';
const APP_ID = process.env.FEISHU_APP_ID_8HAO;
const APP_SECRET = process.env.FEISHU_APP_SECRET_8HAO;
const INBOX = path.join(__dirname, 'feishu-inbox.jsonl');
const STATE = path.join(__dirname, 'typing.state.json');
const POLL_MS = 1500;
const EMOJI = 'DONE'; // ✅ - 飞书支持的反应 emoji

// 进程内 inflight 锁：避免多次轮询给同一消息重复加 reaction
const inflight = new Set();

if (!APP_ID || !APP_SECRET) {
  console.error('[FATAL] 缺凭证 FEISHU_APP_ID_8HAO / FEISHU_APP_SECRET_8HAO');
  process.exit(1);
}

function log(level, msg) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
  process.stdout.write(line);
  try { fs.appendFileSync(path.join(__dirname, 'typing-bot.log'), line, 'utf8'); } catch {}
}

function getToken() {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET });
    const req = https.request({
      hostname: 'open.feishu.cn', port: 443, method: 'POST',
      path: '/open-apis/auth/v3/tenant_access_token/internal',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

function addReaction(messageId, emojiType, token) {
  return new Promise((resolve) => {
    const data = JSON.stringify({ reaction_type: { emoji_type: emojiType } });
    const req = https.request({
      hostname: 'open.feishu.cn', port: 443, method: 'POST',
      path: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve({ code: -1, msg: e.message }); } });
    });
    req.on('error', (e) => resolve({ code: -1, msg: e.message }));
    req.write(data); req.end();
  });
}

function loadState() {
  if (fs.existsSync(STATE)) {
    try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch {}
  }
  return { reactedIds: [] };
}

function saveState(state) {
  try { fs.writeFileSync(STATE, JSON.stringify(state, null, 2), 'utf8'); } catch {}
}

async function processInbox() {
  if (!fs.existsSync(INBOX)) return;
  const state = loadState();
  const lines = fs.readFileSync(INBOX, 'utf8').split('\n').filter(Boolean);

  // 只看最近的 50 条，避免无谓扫描
  const recent = lines.slice(-50);

  for (const line of recent) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const msgId = e.message?.message_id;
    if (!msgId) continue;
    if (state.reactedIds.includes(msgId)) continue;
    if (inflight.has(msgId)) continue;
    if (e.sender?.sender_id?.open_id !== CHAIRMAN) continue;

    // 只处理私聊
    const isGroup = e.message?.chat_type === 'group';
    if (isGroup) {
      state.reactedIds.push(msgId);
      if (state.reactedIds.length > 200) state.reactedIds = state.reactedIds.slice(-200);
      saveState(state);
      continue;
    }

    // 加 inflight 锁 + 立刻写 state（避免下一轮重复加）
    inflight.add(msgId);
    state.reactedIds.push(msgId);
    if (state.reactedIds.length > 200) state.reactedIds = state.reactedIds.slice(-200);
    saveState(state);

    // 加 reaction 表示"正在输入"
    try {
      const tok = await getToken();
      const r = await addReaction(msgId, EMOJI, tok.tenant_access_token);
      if (r.code === 0) {
        log('TYPING', `${msgId} +${EMOJI} reaction`);
      } else if (r.code === 231002 || r.code === 231015) {
        // 重复 reaction / 并发请求，忽略
        log('DUP', `${msgId} code=${r.code}`);
      } else {
        log('FAIL', `${msgId} code=${r.code} ${r.msg}`);
      }
    } catch (err) {
      log('ERR', `${msgId} ${err.message}`);
    } finally {
      inflight.delete(msgId);
    }
  }
}

log('START', `typing-bot 启动 POLL=${POLL_MS}ms emoji=${EMOJI}`);
processInbox();
const timer = setInterval(processInbox, POLL_MS);

process.on('SIGINT', () => { log('STOP', 'SIGINT'); clearInterval(timer); process.exit(0); });
process.on('SIGTERM', () => { log('STOP', 'SIGTERM'); clearInterval(timer); process.exit(0); });
