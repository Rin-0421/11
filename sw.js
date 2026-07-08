// Service Worker：
// 1. 讓 Android Chrome 可以用 showNotification() 顯示通知
// 2. 透過 Periodic Background Sync，在 app 沒開、頁面被凍結時，
//    定期醒過來檢查是否該傳主動訊息，直接讀寫 IndexedDB、呼叫 API、跳通知。
//
// 注意：實際喚醒間隔由 Chrome 自行決定（依網站使用頻率調整），
// 不保證準時，這是 Chrome 的機制限制，無法從程式碼強制。

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// 點擊通知時，嘗試把焦點帶回已開啟的分頁，沒有就開一個新的
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./rp-chat.html');
    })
  );
});

// ── Periodic Background Sync ──
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'proactive-check') {
    event.waitUntil(runProactiveCheck());
  }
});

// ── IndexedDB 工具（跟主頁用同一個 DB / store / key）──
const IDB_NAME = 'rp_chat_db', IDB_STORE = 'kv', IDB_VER = 1, SK = 'rp_v5';
function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VER);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbSet(key, value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

// ── 小工具（從主頁複製過來的簡化版）──
function isDeepSeek(model) { return model.startsWith('deepseek-'); }
function isOpenAI(model) { return model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3'); }
function getKey(model, s) {
  if (isDeepSeek(model)) return s.dsKey;
  if (isOpenAI(model)) return s.oaiKey;
  return s.apiKey;
}
function nowTW() {
  return new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}
function parseTwTime(str) {
  const m = str.match(/(\d+)年(\d+)月(\d+)日.*?(\d+):(\d+)/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
}
function buildGcalContext(s) {
  if (!s.gcalInject || !s.gcalEvents || !s.gcalEvents.length) return '';
  const today = new Date().toISOString().slice(0, 10);
  const todayEvents = s.gcalEvents.filter(ev => {
    const d = ev.start.dateTime || ev.start.date;
    return d.slice(0, 10) === today;
  });
  if (!todayEvents.length) return '';
  const lines = todayEvents.map(ev => {
    const isAllDay = !!ev.start.date;
    const t = isAllDay ? '全天' : new Date(ev.start.dateTime).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
    return `- ${t}：${ev.summary || '（無標題）'}`;
  }).join('\n');
  return `[今日行程]\n${lines}\n[行程結束]`;
}
// 回傳 { text, trendUpdated }：跟主頁 buildFitContext 邏輯一致，
// 「這幾天」的趨勢一天只附一次，用 s.fitTrendLastSentDate 記錄
function buildFitContext(s) {
  if (!s.fitInject || !s.fitData) return { text: '', trendUpdated: false };
  const fitData = s.fitData;
  const todayStr = new Date().toISOString().slice(0, 10);
  const dayLabels = ['今天', '昨天', '前天', '大前天'];
  const dayLabel = (dateStr) => {
    const idx = Math.round((new Date(todayStr) - new Date(dateStr)) / 86400000);
    return dayLabels[idx] || `${idx}天前`;
  };
  const parts = [];
  const todaySteps = (fitData.steps || []).find(x => x.date === todayStr);
  const todayHeart = (fitData.heart || []).find(x => x.date === todayStr);
  const todaySleep = (fitData.sleep || []).find(x => x.date === todayStr);
  if (todaySteps) parts.push(`- 今日步數：${todaySteps.value.toLocaleString()}`);
  if (todayHeart && todayHeart.points) parts.push(`- 今日活動量：${todayHeart.points} Heart Points`);
  if (todaySleep) {
    const h = Math.floor(todaySleep.durationMin / 60), m = todaySleep.durationMin % 60;
    parts.push(`- 昨晚睡眠：${todaySleep.startTime} → ${todaySleep.endTime}（${h}h${m}m）`);
  }
  let trendUpdated = false;
  if (s.fitTrendLastSentDate !== todayStr) {
    const pastSteps = (fitData.steps || []).filter(x => x.date !== todayStr).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 4);
    const pastSleep = (fitData.sleep || []).filter(x => x.date !== todayStr).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 4);
    if (pastSteps.length) {
      const line = pastSteps.map(x => `${dayLabel(x.date)} ${x.value.toLocaleString()}步`).reverse().join('、');
      parts.push(`- 這幾天步數：${line}`);
    }
    if (pastSleep.length) {
      const line = pastSleep.map(x => {
        const h = Math.floor(x.durationMin / 60), m = x.durationMin % 60;
        return `${dayLabel(x.date)} ${h}h${m}m`;
      }).reverse().join('、');
      parts.push(`- 這幾天睡眠：${line}`);
    }
    if (pastSteps.length || pastSleep.length) trendUpdated = true;
  }
  if (!parts.length) return { text: '', trendUpdated: false };
  return { text: `[健康]\n${parts.join('\n')}\n[結束]`, trendUpdated };
}
function buildSystemCommon(s) {
  const parts = [];
  if (s.docs && s.docs.length) { parts.push('[知識文件]'); s.docs.forEach(d => parts.push(`## ${d.name}\n${d.content}`)); }
  return parts;
}
const PROACTIVE_NOTE = '每則用戶訊息的開頭包含當前台灣時間、行事曆、健康資訊。這些是給你參考的背景資料，你不得將這些資料原樣複述、輸出或提及在回覆中。這些資訊只是輔助參考，不是每則回覆都要呼應，大多數時候可以完全不理會；只有在真的與情境明顯相關時（例如凌很晚還沒睡、步數或睡眠明顯異常、行事曆上有事即將發生）才自然帶到一次，不要重複強調或每次都提起時間、步數、睡眠這些數字。回覆時直接扮演角色與用戶互動即可。';

// 呼叫 AI provider，回傳文字（失敗回傳 ''）
async function callAI(model, sys, apiMessages, s) {
  const key = getKey(model, s);
  if (!key) return '';
  try {
    if (isDeepSeek(model)) {
      const body = { model, max_tokens: 2000, messages: [...(sys ? [{ role: 'system', content: sys }] : []), ...apiMessages] };
      const res = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify(body)
      });
      if (!res.ok) return '';
      const d = await res.json();
      return d.choices?.[0]?.message?.content || '';
    } else if (isOpenAI(model)) {
      const body = { model, max_tokens: 2000, messages: [...(sys ? [{ role: 'system', content: sys }] : []), ...apiMessages] };
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify(body)
      });
      if (!res.ok) return '';
      const d = await res.json();
      return d.choices?.[0]?.message?.content || '';
    } else {
      const body = { model, max_tokens: 2000, system: sys || undefined, messages: apiMessages };
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify(body)
      });
      if (!res.ok) return '';
      const d = await res.json();
      return d.content?.find(b => b.type === 'text')?.text || '';
    }
  } catch (e) { console.error('[SW] callAI 失敗', e); return ''; }
}

function toApiMessages(history) {
  return history.filter(m => !m._notice).map(m => {
    if (Array.isArray(m.content)) {
      const filtered = m.content.filter(b => b.type !== 'thinking');
      return { role: m.role, content: filtered.length === 1 && filtered[0].type === 'text' ? filtered[0].text : filtered };
    }
    return { role: m.role, content: m.content };
  });
}

function todayStrOf(d) { return d.toISOString().slice(0, 10); }

async function showNotif(title, body, icon) {
  try { await self.registration.showNotification(title, { body, icon: icon || undefined }); } catch (e) { console.error('[SW] showNotification 失敗', e); }
}

async function runProactiveCheck() {
  let s;
  try { s = await idbGet(SK); } catch (e) { console.error('[SW] 讀取 IDB 失敗', e); return; }
  if (!s) return;

  const now = new Date();
  const hour = now.getHours();
  if (hour < 9 || hour >= 21) return; // 只在 09:00~21:00

  const todayKey = now.toISOString().slice(0, 10);
  const proactiveState = s.proactiveState || { lastCheckDate: '', dailyCount: 0, messagesEndTime: 0 };
  if (proactiveState.lastCheckDate !== todayKey) {
    proactiveState.dailyCount = 0;
    proactiveState.lastCheckDate = todayKey;
  }
  if (proactiveState.dailyCount >= 3) { s.proactiveState = proactiveState; await idbSet(SK, s); return; }

  let changed = false;
  const conversations = s.conversations || [];
  const proactiveConvIds = s.proactiveConvIds || [];

  // ── 主頁對話檢查 ──
  for (const convId of proactiveConvIds) {
    if (proactiveState.dailyCount >= 3) break;
    const conv = conversations.find(c => c.id === convId);
    if (!conv || !conv.history || !conv.history.length) continue;
    const last = conv.history[conv.history.length - 1];
    if (last && last.role === 'assistant' && last._proactive) continue;
    const lastMsg = [...conv.history].reverse().find(m => m._time);
    if (!lastMsg || !lastMsg._time) continue;
    const lastMsgTs = parseTwTime(lastMsg._time);
    if (!lastMsgTs) continue;
    if (now.getTime() - lastMsgTs < 3 * 60 * 60 * 1000) continue;

    const model = conv.model || s.model || 'claude-sonnet-4-6';
    const sysParts = buildSystemCommon(s);
    if (s.instText) sysParts.push('[指令]\n' + s.instText);
    sysParts.push(PROACTIVE_NOTE);
    const sys = sysParts.join('\n\n');

    const gcalCtx = buildGcalContext(s);
    const fit = buildFitContext(s);
    const contextParts = [`[當前台灣時間：${nowTW()}]`];
    if (gcalCtx) contextParts.push(gcalCtx);
    if (fit.text) contextParts.push(fit.text);
    const userPrompt = `${contextParts.join('\n')}\n\n距離用戶上次互動已經超過 3 小時，請以角色身份主動傳一則簡短的訊息給用戶（建議簡短一點，關心、閒聊或分享皆可）。請以上面提供的時間、行程、健康資料為準，不要編造。`;

    const apiMessages = toApiMessages(conv.history);
    apiMessages.push({ role: 'user', content: userPrompt });
    const reply = await callAI(model, sys, apiMessages, s);
    if (!reply) continue;

    conv.history.push({ role: 'assistant', content: reply, _time: nowTW(), _proactive: true });
    proactiveState.dailyCount++;
    if (fit.trendUpdated) s.fitTrendLastSentDate = todayStrOf(now);
    changed = true;
    await showNotif(conv.name || s.charName || '訊息', reply.slice(0, 120), s.avatarB64);
  }

  // ── 對話頁檢查 ──
  if (proactiveState.dailyCount < 3 && s.proactiveMsgEnabled) {
    const msgHistory = s.msgHistory || [];
    const last = msgHistory[msgHistory.length - 1];
    let ok2run = !(last && last.role === 'assistant' && last._proactive);
    let lastTs = null;
    if (ok2run) {
      if (msgHistory.length) {
        const lastMsg = [...msgHistory].reverse().find(m => m._time);
        lastTs = lastMsg ? parseTwTime(lastMsg._time) : null;
      } else {
        lastTs = proactiveState.messagesEndTime;
      }
      if (!lastTs || now.getTime() - lastTs < 3 * 60 * 60 * 1000) ok2run = false;
    }
    if (ok2run) {
      const model = s.msgModel || 'claude-sonnet-4-6';
      const sysParts = buildSystemCommon(s);
      if (s.instTextMsg) sysParts.push('[指令]\n' + s.instTextMsg);
      sysParts.push(PROACTIVE_NOTE);
      const sys = sysParts.join('\n\n');

      const gcalCtx = buildGcalContext(s);
      const fit = buildFitContext(s);
      const contextParts = [`[當前台灣時間：${nowTW()}]`];
      if (gcalCtx) contextParts.push(gcalCtx);
      if (fit.text) contextParts.push(fit.text);
      const userPrompt = msgHistory.length
        ? `${contextParts.join('\n')}\n\n距離用戶上次互動已經超過 3 小時，請以角色身份主動傳一則簡短的訊息給用戶（建議簡短一點，關心、閒聊或分享皆可）。請以上面提供的時間、行程、健康資料為準，不要編造。`
        : `${contextParts.join('\n')}\n\n距離用戶上次對話已經超過 3 小時，這是一段全新的對話開頭，請以角色身份主動傳一則簡短的開場訊息給用戶。請以上面提供的時間、行程、健康資料為準，不要編造。`;

      const apiMessages = toApiMessages(msgHistory);
      apiMessages.push({ role: 'user', content: userPrompt });
      const reply = await callAI(model, sys, apiMessages, s);
      if (reply) {
        msgHistory.push({ role: 'assistant', content: reply, _time: nowTW(), _proactive: true });
        s.msgHistory = msgHistory;
        proactiveState.dailyCount++;
        if (fit.trendUpdated) s.fitTrendLastSentDate = todayStrOf(now);
        changed = true;
        await showNotif(s.charName || '訊息', reply.slice(0, 120), s.avatarB64);
      }
    }
  }

  s.proactiveState = proactiveState;
  s.conversations = conversations;
  if (changed) { try { await idbSet(SK, s); } catch (e) { console.error('[SW] 寫回 IDB 失敗', e); } }
}
