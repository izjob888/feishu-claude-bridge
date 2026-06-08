/**
 * 8号 飞书长连接桥接器
 *
 * 功能：
 *   1. WebSocket 长连接（飞书主动推送事件）— 事件订阅
 *   2. 收到的消息追加写入 feishu-inbox.jsonl
 *   3. HTTP 服务（端口 18901）：
 *        POST /send      → 转发到飞书 REST API 发消息
 *        GET  /health    → 健康检查（WS 状态、inbox 行数、uptime）
 *        GET  /inbox?n=N → 读取最近 N 条 inbox
 *   4. 收到的消息也写 outbox.jsonl 作为审计
 *   5. 可选 Encrypt Key 解密（暂未实现，需要时再加）
 *
 * 触发：start-bridge.ps1 一键启动
 * 停止：stop-bridge.ps1（杀 18901 监听进程）
 *
 * 凭据来源：环境变量 FEISHU_APP_ID_8HAO / FEISHU_APP_SECRET_8HAO
 *   （由 start-bridge.ps1 从 .env.8hao 读入）
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const lark = require('@larksuiteoapi/node-sdk');

// ==================== 配置 ====================
const APP_ID = process.env.FEISHU_APP_ID_8HAO;
const APP_SECRET = process.env.FEISHU_APP_SECRET_8HAO;
const ENCRYPT_KEY = process.env.FEISHU_ENCRYPT_KEY || null;
const HTTP_PORT = parseInt(process.env.BRIDGE_HTTP_PORT || '18901', 10);
const HTTP_HOST = '127.0.0.1';
const INBOX_PATH = path.join(__dirname, 'feishu-inbox.jsonl');
const OUTBOX_PATH = path.join(__dirname, 'feishu-outbox.jsonl');
const LOG_PATH = path.join(__dirname, 'bridge.log');

// ==================== 健全性 ====================
if (!APP_ID || !APP_SECRET) {
  console.error('[FATAL] FEISHU_APP_ID_8HAO / FEISHU_APP_SECRET_8HAO 未设置');
  process.exit(1);
}

if (ENCRYPT_KEY) {
  console.log('[INIT] Encrypt Key 已设置（解密逻辑待补，目前按不加密处理）');
}

// ==================== 工具 ====================
function log(level, msg) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
  try { fs.appendFileSync(LOG_PATH, line, 'utf8'); } catch {}
  process.stdout.write(line);
}

function appendJsonl(filePath, obj) {
  try {
    fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf8');
  } catch (e) {
    log('ERR', `写文件失败 ${filePath}: ${e.message}`);
  }
}

function readInbox(n = 20) {
  if (!fs.existsSync(INBOX_PATH)) return [];
  const lines = fs.readFileSync(INBOX_PATH, 'utf8').split('\n').filter(Boolean);
  return lines.slice(-n).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function inboxSize() {
  if (!fs.existsSync(INBOX_PATH)) return 0;
  return fs.readFileSync(INBOX_PATH, 'utf8').split('\n').filter(Boolean).length;
}

// ==================== 事件处理 ====================
async function handleMessageReceive(data) {
  const ts = new Date().toISOString();
  let textPreview = '(non-text)';
  try {
    const c = JSON.parse(data.message.content);
    if (c.text) textPreview = c.text.slice(0, 80);
  } catch {}
  const entry = {
    received_at: ts,
    event: 'im.message.receive_v1',
    sender: data.sender,
    message: data.message,
  };
  appendJsonl(INBOX_PATH, entry);
  log('INBOX', `chat=${data.message.chat_id} type=${data.message.chat_type} from=${data.sender.sender_id.open_id} text="${textPreview}"`);
  return { code: 0 };
}

async function handleBotAdded(data) {
  const entry = {
    received_at: new Date().toISOString(),
    event: 'im.chat.member.bot.added_v1',
    data,
  };
  appendJsonl(INBOX_PATH, entry);
  log('EVENT', `bot 加入 chat=${data.chat_id || '(unknown)'}`);
  return { code: 0 };
}

async function handleBotDeleted(data) {
  const entry = {
    received_at: new Date().toISOString(),
    event: 'im.chat.member.bot.deleted_v1',
    data,
  };
  appendJsonl(INBOX_PATH, entry);
  log('EVENT', `bot 离开 chat=${data.chat_id || '(unknown)'}`);
  return { code: 0 };
}

// SDK 不同版本对事件回调的入参结构不一样：有的传 {sender, message}，有的传 {event: {sender, message}}
// 加一个 wrapper 兼容两种
function wrapHandler(handlerName, fn) {
  return async (raw) => {
    try {
      log('EVENT_RAW', `${handlerName} keys=${Object.keys(raw || {}).join(',')} sample=${JSON.stringify(raw).slice(0,300)}`);
      // 兼容: {sender, message}  或  {event: {sender, message}}
      const data = raw.event ? raw.event : raw;
      await fn(data);
    } catch (e) {
      log('ERR', `${handlerName} 处理失败: ${e.message}`);
      return { code: -1, msg: e.message };
    }
  };
}

// ==================== WS 客户端 ====================
const eventDispatcher = new lark.EventDispatcher({});
eventDispatcher.register({
  'im.message.receive_v1': wrapHandler('im.message.receive_v1', handleMessageReceive),
  'im.chat.member.bot.added_v1': wrapHandler('im.chat.member.bot.added_v1', handleBotAdded),
  'im.chat.member.bot.deleted_v1': wrapHandler('im.chat.member.bot.deleted_v1', handleBotDeleted),
});

const wsClient = new lark.WSClient({
  appId: APP_ID,
  appSecret: APP_SECRET,
  loggerLevel: lark.LoggerLevel.info,
});

// WS 状态探针
setInterval(() => {
  if (wsClient.getConnectionStatus) {
    try {
      const s = wsClient.getConnectionStatus();
      if (typeof s === 'object') {
        log('WS_STATE', `state=${JSON.stringify(s)}`);
      } else {
        log('WS_STATE', `state=${s}`);
      }
    } catch (e) {
      log('WS_STATE_ERR', e.message);
    }
  }
}, 30000);
log('WS_STATE', 'before-start');

// ==================== HTTP 服务 ====================
const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf--8');
  res.setHeader('Access-Control-Allow-Origin', '127.0.0.1');

  // GET /health
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/health/')) {
    let wsStatus = 'unknown';
    try { wsStatus = wsClient.getConnectionStatus ? wsClient.getConnectionStatus() : 'no-method'; } catch (e) { wsStatus = 'err:' + e.message; }
    res.end(JSON.stringify({
      ok: true,
      app_id: APP_ID,
      bridge_pid: process.pid,
      inbox_path: INBOX_PATH,
      inbox_size: inboxSize(),
      ws_started: wsStarted,
      ws_status: wsStatus,
      uptime_sec: Math.round(process.uptime()),
      ts: new Date().toISOString(),
    }, null, 2));
    return;
  }

  // GET /inbox?n=20
  if (req.method === 'GET' && req.url.startsWith('/inbox')) {
    const url = new URL(req.url, `http://${HTTP_HOST}:${HTTP_PORT}`);
    const n = parseInt(url.searchParams.get('n') || '20', 10);
    res.end(JSON.stringify({ ok: true, count: Math.min(n, inboxSize()), messages: readInbox(n) }, null, 2));
    return;
  }

  // POST /send
  if (req.method === 'POST' && req.url === '/send') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { receive_id, receive_id_type = 'open_id', msg_type = 'text', content } = JSON.parse(body);
        if (!receive_id || !content) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: 'missing receive_id or content' }));
          return;
        }
        log('SEND', `→ ${receive_id_type}=${receive_id} type=${msg_type} content=${JSON.stringify(content).slice(0, 200)}`);

        // 拿 tenant_access_token
        const tokenResp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
        });
        const tokenData = await tokenResp.json();
        if (tokenData.code !== 0) {
          res.statusCode = 502;
          res.end(JSON.stringify({ ok: false, error: 'token 获取失败', detail: tokenData }));
          return;
        }
        const token = tokenData.tenant_access_token;

        // 发消息
        const sendResp = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receive_id_type}`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ receive_id, msg_type, content }),
        });
        const sendData = await sendResp.json();

        // 写 outbox 审计
        appendJsonl(OUTBOX_PATH, {
          sent_at: new Date().toISOString(),
          receive_id, receive_id_type, msg_type, content,
          response: sendData,
        });

        res.end(JSON.stringify({ ok: sendData.code === 0, response: sendData }, null, 2));
      } catch (e) {
        log('ERR', `/send 失败: ${e.message}`);
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ ok: false, error: 'not found', hint: 'GET /health | GET /inbox?n=20 | POST /send' }));
});

server.listen(HTTP_PORT, HTTP_HOST, () => {
  log('HTTP', `8号 桥接器 HTTP 端点已起 http://${HTTP_HOST}:${HTTP_PORT}`);
});

// ==================== 启动 WS ====================
let wsStarted = false;
// SDK 1.66.1: start({eventDispatcher}) 是关键！不传就静默 return
wsClient.start({
  eventDispatcher: eventDispatcher,
}).then(() => {
  wsStarted = true;
  log('WS', `8号 飞书长连接已启动 app_id=${APP_ID}`);
}).catch(e => {
  log('ERR', `WS 启动失败: ${e.message}`);
  process.exit(1);
});

// ==================== 优雅退出 ====================
function shutdown(sig) {
  log('SHUTDOWN', `收到 ${sig}，退出中...`);
  server.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
