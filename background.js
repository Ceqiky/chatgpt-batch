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

// Скачивание картинок по запросу из content.js
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'download') {
    chrome.downloads.download(
      { url: msg.url, filename: msg.filename, conflictAction: 'uniquify', saveAs: false },
      (id) => {
        if (chrome.runtime.lastError) sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        else sendResponse({ ok: true, id });
      }
    );
    return true; // ответ асинхронный
  }
});
