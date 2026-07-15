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
// 回傳 { text, trendUpdated }：跟主檔 buildFitContext 邏輯一致 ——
// 每個「窗口」（conv）當天第一次送出主動訊息才附帶一次「今天」的步數/睡眠，
// conv 為 null 代表「聊天」單頁模式，用 s.fitTrendLastSentDate 記錄。
// 過去趨勢／體重改成讓模型自己呼叫工具查，這裡不再直接塞文字。
function buildFitContext(s, conv) {
  if (!s.fitInject || !s.fitData) return { text: '', trendUpdated: false };
  const fitData = s.fitData;
  const todayStr = new Date().toISOString().slice(0, 10);
  const lastSentDate = conv ? (conv.fitTrendDate || '') : (s.fitTrendLastSentDate || '');
  if (lastSentDate === todayStr) return { text: '', trendUpdated: false };

  const todaySteps = (fitData.steps || []).find(x => x.date === todayStr);
  const todaySleep = (fitData.sleep || []).find(x => x.date === todayStr);
  const parts = [];
  if (todaySteps) parts.push(`- 今日步數：${todaySteps.value.toLocaleString()}`);
  if (todaySleep) {
    const h = Math.floor(todaySleep.durationMin / 60), m = todaySleep.durationMin % 60;
    parts.push(`- 昨晚睡眠：${todaySleep.startTime} → ${todaySleep.endTime}（${h}h${m}m）`);
  }
  if (!parts.length) return { text: '', trendUpdated: false };
  return { text: `[健康]\n${parts.join('\n')}\n（如需更完整的健康資訊，可以呼叫 get_today_health、get_recent_health、get_latest_weight 或 get_weight_history 工具查詢，不需要主動提起也可以）\n[結束]`, trendUpdated: true };
}

// ── 健康資料工具（步數/睡眠/體重，心跳指數已移除）──
function getHealthTools(s) {
  if (!s.fitInject) return [];
  return [
    { name: 'get_today_health', description: '查詢使用者「今天」的步數與睡眠資料。', input_schema: { type: 'object', properties: {} } },
    { name: 'get_recent_health', description: '查詢使用者「最近 5 天（含今天）」的步數與睡眠趨勢，可用來判斷最近作息、活動量的變化。', input_schema: { type: 'object', properties: {} } },
    { name: 'get_latest_weight', description: '查詢使用者「最新一筆」體重紀錄（使用者手動輸入的資料）。', input_schema: { type: 'object', properties: {} } },
    { name: 'get_weight_history', description: '查詢使用者「全部體重紀錄」（最多 5 筆，使用者手動輸入的資料），可用來判斷體重變化趨勢。', input_schema: { type: 'object', properties: {} } }
  ];
}
function getHealthToolsOpenAI(s) {
  return getHealthTools(s).map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
}
function executeHealthTool(s, name) {
  const fitData = s.fitData || {};
  const todayStr = new Date().toISOString().slice(0, 10);
  if (name === 'get_today_health') {
    const todaySteps = (fitData.steps || []).find(x => x.date === todayStr);
    const todaySleep = (fitData.sleep || []).find(x => x.date === todayStr);
    const parts = [];
    if (todaySteps) parts.push(`今日步數：${todaySteps.value.toLocaleString()}`);
    if (todaySleep) {
      const h = Math.floor(todaySleep.durationMin / 60), m = todaySleep.durationMin % 60;
      parts.push(`昨晚睡眠：${todaySleep.startTime} → ${todaySleep.endTime}（${h}h${m}m）`);
    }
    return parts.length ? parts.join('\n') : '目前沒有今天的步數/睡眠資料。';
  }
  if (name === 'get_recent_health') {
    const dayLabels = ['今天', '昨天', '前天', '大前天'];
    const dayLabel = (dateStr) => {
      const idx = Math.round((new Date(todayStr) - new Date(dateStr)) / 86400000);
      return dayLabels[idx] || `${idx}天前`;
    };
    const recentSteps = (fitData.steps || []).filter(x => x.date <= todayStr).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
    const recentSleep = (fitData.sleep || []).filter(x => x.date <= todayStr).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
    const parts = [];
    if (recentSteps.length) parts.push('這幾天步數：' + recentSteps.map(x => `${dayLabel(x.date)} ${x.value.toLocaleString()}步`).reverse().join('、'));
    if (recentSleep.length) parts.push('這幾天睡眠：' + recentSleep.map(x => {
      const h = Math.floor(x.durationMin / 60), m = x.durationMin % 60;
      return `${dayLabel(x.date)} ${h}h${m}m`;
    }).reverse().join('、'));
    return parts.length ? parts.join('\n') : '目前沒有最近幾天的步數/睡眠資料。';
  }
  if (name === 'get_latest_weight') {
    const weight = fitData.weight || [];
    if (!weight.length) return '使用者目前沒有輸入過體重紀錄。';
    const latest = weight[weight.length - 1];
    return `最新體重紀錄（${latest.date}）：${latest.value} kg`;
  }
  if (name === 'get_weight_history') {
    const weight = fitData.weight || [];
    if (!weight.length) return '使用者目前沒有輸入過體重紀錄。';
    return '體重紀錄（由舊到新）：' + weight.map(w => `${w.date} ${w.value}kg`).join('、');
  }
  return '（未知的健康工具）';
}
function buildSystemCommon(s) {
  const parts = [];
  if (s.docs && s.docs.length) { parts.push('[知識文件]'); s.docs.forEach(d => parts.push(`## ${d.name}\n${d.content}`)); }
  return parts;
}
const PROACTIVE_NOTE = '每則用戶訊息的開頭包含當前台灣時間、行事曆、健康資訊。這些是給你參考的背景資料，你不得將這些資料原樣複述、輸出或提及在回覆中。這些資訊只是輔助參考，不是每則回覆都要呼應，大多數時候可以完全不理會；只有在真的與情境明顯相關時（例如凌很晚還沒睡、步數或睡眠明顯異常、行事曆上有事即將發生）才自然帶到一次，不要重複強調或每次都提起時間、步數、睡眠這些數字。回覆時直接扮演角色與用戶互動即可。';

// 在 Claude 的 messages 陣列最後一則訊息加上 cache_control 斷點，讓「這則之前的所有歷史」被快取
function addHistoryCacheBreakpoint(messages) {
  if (!messages.length) return messages;
  const lastIdx = messages.length - 1;
  return messages.map((m, i) => {
    if (i !== lastIdx) return m;
    const content = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content.map(b => ({ ...b }));
    for (let j = content.length - 1; j >= 0; j--) {
      if (content[j].type === 'text') { content[j] = { ...content[j], cache_control: { type: 'ephemeral' } }; return { ...m, content }; }
    }
    return m;
  });
}

// 呼叫 AI provider，回傳文字（失敗回傳 ''）。三家都支援健康工具的來回呼叫（模型呼叫 → 我們執行 → 把結果丟回去 → 拿最終回覆）
async function callAI(model, sys, apiMessages, s) {
  const key = getKey(model, s);
  if (!key) return '';
  try {
    if (isDeepSeek(model) || isOpenAI(model)) {
      let messages = [...(sys ? [{ role: 'system', content: sys }] : []), ...apiMessages];
      const body = { model, max_tokens: 2000 };
      const tools = getHealthToolsOpenAI(s);
      if (tools.length) body.tools = tools;
      const url = isDeepSeek(model) ? 'https://api.deepseek.com/chat/completions' : 'https://api.openai.com/v1/chat/completions';
      const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` };
      let accumulatedReply = '';
      for (let round = 0; round < 4; round++) {
        const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...body, messages }) });
        if (!res.ok) return accumulatedReply;
        const d = await res.json();
        const msg = d.choices?.[0]?.message;
        const text = msg?.content || '';
        const toolCalls = msg?.tool_calls || [];
        if (text) accumulatedReply += text;
        if (toolCalls.length) {
          messages = [...messages, { role: 'assistant', content: text || null, tool_calls: toolCalls }];
          toolCalls.forEach(tc => messages.push({ role: 'tool', tool_call_id: tc.id, content: executeHealthTool(s, tc.function?.name) }));
          continue;
        }
        break;
      }
      return accumulatedReply;
    } else {
      let messages = addHistoryCacheBreakpoint(apiMessages);
      const body = { model, max_tokens: 2000 };
      if (sys) body.system = [{ type: 'text', text: sys, cache_control: { type: 'ephemeral' } }];
      if (model === 'claude-sonnet-5') body.thinking = { type: 'disabled' }; // s5 預設思考全開，背景主動訊息明確關閉省錢
      const tools = getHealthTools(s);
      if (tools.length) body.tools = tools;
      const headers = { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' };
      const url = 'https://api.anthropic.com/v1/messages';
      let accumulatedReply = '';
      for (let round = 0; round < 4; round++) {
        const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...body, messages }) });
        if (!res.ok) return accumulatedReply;
        const d = await res.json();
        const textBlock = d.content?.find(b => b.type === 'text');
        const toolBlocks = (d.content || []).filter(b => b.type === 'tool_use');
        if (textBlock?.text) accumulatedReply += textBlock.text;
        if (d.stop_reason === 'tool_use' && toolBlocks.length) {
          const assistantContent = [];
          if (textBlock?.text) assistantContent.push({ type: 'text', text: textBlock.text });
          toolBlocks.forEach(tb => assistantContent.push({ type: 'tool_use', id: tb.id, name: tb.name, input: tb.input }));
          messages = [...messages, { role: 'assistant', content: assistantContent }];
          const toolResults = toolBlocks.map(tb => ({ type: 'tool_result', tool_use_id: tb.id, content: executeHealthTool(s, tb.name) }));
          messages = [...messages, { role: 'user', content: toolResults }];
          continue;
        }
        break;
      }
      return accumulatedReply;
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
  const startHour = (typeof s.proactiveStartHour === 'number') ? s.proactiveStartHour : 9;
  const endHour = (typeof s.proactiveEndHour === 'number') ? s.proactiveEndHour : 21;
  if (hour < startHour || hour >= endHour) return; // 只在設定的時間範圍內

  const todayKey = now.toISOString().slice(0, 10);
  const proactiveState = s.proactiveState || { lastCheckDate: '', dailyCount: 0, messagesEndTime: 0 };
  if (proactiveState.lastCheckDate !== todayKey) {
    proactiveState.dailyCount = 0;
    proactiveState.lastCheckDate = todayKey;
  }
  const proactiveHours = (typeof s.proactiveHours === 'number' && s.proactiveHours > 0) ? s.proactiveHours : 3;
  const proactiveMaxDaily = (typeof s.proactiveMaxDaily === 'number' && s.proactiveMaxDaily > 0) ? s.proactiveMaxDaily : 3;
  if (proactiveState.dailyCount >= proactiveMaxDaily) { s.proactiveState = proactiveState; await idbSet(SK, s); return; }

  let changed = false;
  const conversations = s.conversations || [];
  const proactiveConvIds = s.proactiveConvIds || [];
  // 收集這次背景檢查實際產生的新內容，最後統一 merge 到「寫回當下」最新的資料上，
  // 而不是直接改這份可能已經過期的 s 快照。
  const convAppends = []; // { convId, msg, fitTrendDate }

  // ── 主頁對話檢查 ──
  for (const convId of proactiveConvIds) {
    if (proactiveState.dailyCount >= proactiveMaxDaily) break;
    const conv = conversations.find(c => c.id === convId);
    if (!conv || !conv.history || !conv.history.length) continue;
    const last = conv.history[conv.history.length - 1];
    if (last && last.role === 'assistant' && last._proactive) continue;
    const lastMsg = [...conv.history].reverse().find(m => m._time);
    if (!lastMsg || !lastMsg._time) continue;
    const lastMsgTs = parseTwTime(lastMsg._time);
    if (!lastMsgTs) continue;
    if (now.getTime() - lastMsgTs < proactiveHours * 60 * 60 * 1000) continue;

    const model = conv.model || 'claude-sonnet-4-6';
    const sysParts = buildSystemCommon(s);
    if (s.instText) sysParts.push('[指令]\n' + s.instText);
    sysParts.push(PROACTIVE_NOTE);
    const sys = sysParts.join('\n\n');

    const gcalCtx = buildGcalContext(s);
    const fit = buildFitContext(s, conv);
    const contextParts = [`[當前台灣時間：${nowTW()}]`];
    if (gcalCtx) contextParts.push(gcalCtx);
    if (fit.text) contextParts.push(fit.text);
    const userPrompt = `${contextParts.join('\n')}\n\n距離用戶上次互動已經超過設定的時間，請以角色身份主動傳一則簡短的訊息給用戶（建議簡短一點，關心、閒聊或分享皆可）。請以上面提供的時間、行程、健康資料為準，不要編造。`;

    const apiMessages = toApiMessages(conv.history);
    apiMessages.push({ role: 'user', content: userPrompt });
    const reply = await callAI(model, sys, apiMessages, s);
    if (!reply) continue;

    const msg = { role: 'assistant', content: reply, _time: nowTW(), _proactive: true };
    convAppends.push({ convId, msg, fitTrendDate: fit.trendUpdated ? todayStrOf(now) : null });
    proactiveState.dailyCount++;
    changed = true;
    await showNotif(conv.name || s.charName || '訊息', reply.slice(0, 120), s.avatarB64);
  }

  // ── 對話頁檢查 ──
  let msgAppend = null, msgFitTrendDate = null;
  if (proactiveState.dailyCount < proactiveMaxDaily && s.proactiveMsgEnabled) {
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
      if (!lastTs || now.getTime() - lastTs < proactiveHours * 60 * 60 * 1000) ok2run = false;
    }
    if (ok2run) {
      // 通知／主動訊息一律固定用 DeepSeek V4 Pro，不使用 s.msgModel
      // （msgModel 是前景聊天頁「手動傳訊息」用的模型選擇，背景通知不應該受它影響或被它的舊快照值干擾）
      const model = 'deepseek-v4-pro';
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
        msgAppend = { role: 'assistant', content: reply, _time: nowTW(), _proactive: true };
        msgFitTrendDate = fit.trendUpdated ? todayStrOf(now) : null;
        proactiveState.dailyCount++;
        changed = true;
        await showNotif(s.charName || '訊息', reply.slice(0, 120), s.avatarB64);
      }
    }
  }

  if (!changed) return;

  // 寫回前重新讀一次最新狀態：runProactiveCheck 一開始讀到的 s 只是個舊快照，
  // 中間呼叫 AI 可能要好幾秒，這段期間如果前景頁面剛好也 save() 了新設定
  // （例如切換模型、傳了新訊息），絕對不能直接把整包舊 s 寫回去蓋掉它——
  // 只把這次 SW 自己新產生的訊息，接到「寫回當下」最新資料的陣列後面，
  // 其他欄位（模型設定等）一律以最新的為準，完全不動。
  try {
    const fresh = (await idbGet(SK)) || s;
    fresh.proactiveState = proactiveState;

    const freshConvs = fresh.conversations || [];
    convAppends.forEach(({ convId, msg, fitTrendDate }) => {
      const c = freshConvs.find(c => c.id === convId);
      if (!c) return;
      c.history = c.history || [];
      c.history.push(msg);
      if (fitTrendDate) c.fitTrendDate = fitTrendDate;
    });
    fresh.conversations = freshConvs;

    if (msgAppend) {
      fresh.msgHistory = [...(fresh.msgHistory || []), msgAppend];
      if (msgFitTrendDate) fresh.fitTrendLastSentDate = msgFitTrendDate;
    }

    await idbSet(SK, fresh);
  } catch (e) { console.error('[SW] 寫回 IDB 失敗', e); }
}
