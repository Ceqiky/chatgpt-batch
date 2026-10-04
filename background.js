const CHAT_URLS = ['https://chatgpt.com/*', 'https://chat.openai.com/*'];
const isChatUrl = (url) => /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(url || '');

// Показать/скрыть панель во вкладке. Если скрипта там нет (вкладка открыта до
// установки/обновления расширения) — внедряем его и пробуем снова.
async function togglePanel(tabId, forceOpen = false) {
  const msg = { type: forceOpen ? 'open' : 'toggle' };
  try {
    await chrome.tabs.sendMessage(tabId, msg);
    return;
  } catch { /* скрипта нет — внедрим */ }
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  // после внедрения панель и так откроется, но на всякий случай
  try { await chrome.tabs.sendMessage(tabId, { type: 'open' }); } catch { /* ignore */ }
}

chrome.action.onClicked.addListener(async (tab) => {
  // 1) Активная вкладка — ChatGPT: работаем в ней
  if (isChatUrl(tab.url)) {
    await togglePanel(tab.id);
    return;
  }
  // 2) Есть уже открытая вкладка ChatGPT — переключаемся на неё
  const [existing] = await chrome.tabs.query({ url: CHAT_URLS, currentWindow: true });
  const target = existing || (await chrome.tabs.query({ url: CHAT_URLS }))[0];
  if (target) {
    await chrome.tabs.update(target.id, { active: true });
    await chrome.windows.update(target.windowId, { focused: true });
    await togglePanel(target.id, true);
    return;
  }
  // 3) ChatGPT нигде не открыт — открываем новую вкладку
  chrome.tabs.create({ url: 'https://chatgpt.com/' });
});

// После установки/обновления расширения — сразу подключаемся к уже открытым вкладкам ChatGPT
chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: CHAT_URLS });
  for (const t of tabs) {
    try { await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content.js'] }); } catch { /* ignore */ }
  }
});

// «Тики» для работы в фоновой вкладке: пока идёт очередь, content.js держит
// соединение, а мы шлём сообщение каждые 0,5 с. Таймеры фоновой части расширения
// не тормозятся так, как таймеры скрытых вкладок, а входящие сообщения
// «будят» страницу. Ответные «pong» держат фоновую часть активной.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ticker') return;
  const timer = setInterval(() => {
    try { port.postMessage('tick'); } catch { clearInterval(timer); }
  }, 500);
  port.onMessage.addListener(() => { /* pong — продлевает жизнь service worker */ });
  port.onDisconnect.addListener(() => clearInterval(timer));
});

// Уведомления Chrome (очередь закончилась / встала / ждёт лимит). Клик — вернуться на вкладку ChatGPT.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'notify') return;
  const id = `batch-${Date.now()}`;
  chrome.notifications.create(id, {
    type: 'basic', iconUrl: 'icon.png',
    title: String(msg.title || 'Batch Prompter').slice(0, 80),
    message: String(msg.message || '').slice(0, 200) || ' ',
  });
  if (sender.tab) notifTabs.set(id, { tabId: sender.tab.id, windowId: sender.tab.windowId });
});
const notifTabs = new Map();
chrome.notifications.onClicked.addListener(async (id) => {
  const t = notifTabs.get(id);
  chrome.notifications.clear(id);
  notifTabs.delete(id);
  if (!t) return;
  try {
    await chrome.tabs.update(t.tabId, { active: true });
    await chrome.windows.update(t.windowId, { focused: true });
  } catch { /* вкладку могли закрыть */ }
});

// Скачивание по запросу из content.js. Ответ приходит, только когда файл РЕАЛЬНО сохранён
// (или загрузка оборвалась) — раньше «ок» отправлялось на старте, и сбои терялись.
// conflictAction: 'overwrite' — повторная загрузка с тем же именем заменяет файл, а не плодит «имя (1).png».
const dlWaiters = new Map(); // id → функция, которой сообщаем итог
chrome.downloads.onChanged.addListener((d) => {
  const cur = d.state && d.state.current;
  if (cur !== 'complete' && cur !== 'interrupted') return;
  const w = dlWaiters.get(d.id);
  if (!w) return;
  dlWaiters.delete(d.id);
  w(cur === 'complete' ? { ok: true } : { ok: false, error: (d.error && d.error.current) || 'загрузка прервана' });
});

function downloadAndWait(url, filename) {
  return new Promise((resolve) => {
    chrome.downloads.download({ url, filename, conflictAction: 'overwrite', saveAs: false }, (id) => {
      if (chrome.runtime.lastError || id === undefined) {
        resolve({ ok: false, error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'не удалось начать загрузку' });
        return;
      }
      const finish = (res) => {
        clearTimeout(timer);
        chrome.downloads.search({ id }, (items) => resolve({ ...res, id, filename: items && items[0] && items[0].filename }));
      };
      const timer = setTimeout(() => { dlWaiters.delete(id); finish({ ok: false, error: 'таймаут загрузки (90 с)' }); }, 90000);
      dlWaiters.set(id, finish);
      // Загрузка могла завершиться раньше, чем мы подписались
      chrome.downloads.search({ id }, (items) => {
        const st = items && items[0] && items[0].state;
        if (st === 'complete' && dlWaiters.has(id)) { dlWaiters.delete(id); finish({ ok: true }); }
        else if (st === 'interrupted' && dlWaiters.has(id)) { dlWaiters.delete(id); finish({ ok: false, error: items[0].error || 'загрузка прервана' }); }
      });
    });
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'download') {
    downloadAndWait(msg.url, msg.filename).then(sendResponse);
    return true; // ответ асинхронный
  }
});
