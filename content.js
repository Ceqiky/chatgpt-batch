(() => {
  // Живая копия уже работает на странице — второй раз не запускаемся
  if (typeof window.__cgptBatchAlive === 'function' && window.__cgptBatchAlive()) return;
  window.__cgptBatchAlive = () => { try { return !!chrome.runtime.id; } catch { return false; } };
  // Старая копия после обновления расширения («осиротевшая») — убираем её панель
  document.dispatchEvent(new CustomEvent('cgpt-batch-kill'));
  document.querySelectorAll('#cgpt-batch-host').forEach((el) => el.remove());

  // Версия из manifest.json — видна в шапке панели и в отчёте: сразу ясно, какой код сейчас работает
  const VERSION = (() => { try { return chrome.runtime.getManifest().version; } catch { return '?'; } })();

  // ─── Селекторы ChatGPT. Если OpenAI поменяет вёрстку — править здесь. ───
  const SEL = {
    // Порядок важен: сначала contenteditable-редактор, textarea — только запасной вариант
    inputList: [
      'div#prompt-textarea[contenteditable="true"]',
      'div.ProseMirror[contenteditable="true"]',
      'form [contenteditable="true"][role="textbox"]',
      'form [contenteditable="true"]',
      'textarea#prompt-textarea',
      'textarea[name="prompt-textarea"]',
      'form textarea',
    ],
    sendList: [
      'button[data-testid="send-button"]',
      'button#composer-submit-button',
      'button[aria-label*="Send prompt" i]',
      'button[aria-label*="Отправить" i]',
      'button[aria-label*="Send" i]',
      'form button[type="submit"]',
    ],
    stop: 'button[data-testid="stop-button"], button[aria-label*="Stop stream"], button[aria-label*="Остановить"]',
    turn: 'article[data-testid^="conversation-turn"]',
    msg: '[data-message-author-role]',
  };
  // Текст, по которому видно, что картинка ещё рисуется
  const IMAGE_PENDING_RE = /(creating image|generating image|создание изображения|создаю изображение|генерирую изображение)/i;
  const MIN_IMG_SIZE = 200; // меньше — это иконки/аватарки

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  // ─── Работа в фоновой вкладке ───
  // Chrome тормозит таймеры скрытых вкладок (до 1 раза в минуту). Поэтому во время
  // работы фоновая часть расширения шлёт «тики» каждые 0,5 с — сообщения не тормозятся,
  // и по ним мы досрочно «будим» все ожидающие sleep().
  const sleepers = new Set();
  const wakeSleepers = () => {
    const now = Date.now();
    for (const s of sleepers) if (now >= s.end) { sleepers.delete(s); clearTimeout(s.t); s.res(); }
  };
  const sleep = (ms) => new Promise((res) => {
    const s = { end: Date.now() + ms, res };
    s.t = setTimeout(() => { sleepers.delete(s); res(); }, ms);
    sleepers.add(s);
  });

  let tickPort = null, tickWanted = false, lastTick = 0;
  function startTicker() {
    tickWanted = true;
    if (tickPort) return;
    try {
      tickPort = chrome.runtime.connect({ name: 'ticker' });
      tickPort.onMessage.addListener(() => {
        lastTick = Date.now();
        wakeSleepers();
        try { tickPort && tickPort.postMessage('pong'); } catch { /* ignore */ }
      });
      tickPort.onDisconnect.addListener(() => {
        tickPort = null;
        // фоновая часть могла уснуть — переподключаемся, пока идёт очередь
        if (tickWanted) setTimeout(startTicker, 200);
      });
    } catch { tickPort = null; }
  }
  function stopTicker() {
    tickWanted = false;
    if (tickPort) { try { tickPort.disconnect(); } catch { /* ignore */ } tickPort = null; }
  }
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const srcOf = (img) => img.currentSrc || img.src || '';

  // ─── Состояние ───
  const DEFAULTS = {
    text: '', sep: 'line', prefix: '',
    delayMin: 5, delayMax: 10,
    waitImage: true, download: true, folder: 'ChatGPT_Images',
    retries: 1, timeoutMin: 10, startFrom: 1, names: [], refs: [], wordRows: [], commonMode: 'first', debug: false,
    editPrompt: `Edit this image using targeted inpainting — do NOT re-render or redraw the scene. Treat the image as a fixed plate: only the regions listed under REMOVE may change; every other pixel must stay as close to the original as possible.

REMOVE completely (fill every freed area with the plain black background — never with new objects or texture):
1. All text of any kind and in any language: titles, subtitles, headlines, labels, captions, numbers, units, formulas, single letters and symbols next to arrows or objects (e.g. "v", "v₁", "9 м/с"), legends, watermarks and logos (including the "Beyim" logo).
2. Every UI / infographic layer that carries text: callout boxes, label chips, rounded-rectangle panels, side cards, info bars, badges, frames, and any mini-diagrams or icons inside them — together with the short ticks or leader lines that attach them to the scene.
3. Flat background decoration: overlay grids, dot patterns, technical or polar grids, gradients, vignettes, noise and texture.
4. Decorative out-of-focus shapes: bokeh circles, blurred planets or spheres, lens flares and light leaks near the edges and corners of the frame.

BACKGROUND: pure solid black #000000 (RGB 0,0,0) from edge to edge — no colour tint anywhere (no blue, teal, violet or grey haze) and no gradient. A soft glow is allowed only as light naturally emitted by the kept objects, tight around them and fading to pure black.

KEEP exactly as it is — same position, size, shape, colour, lighting, perspective and camera angle:
- every main object and character with all its details, materials and shading;
- every arrow, vector, trajectory, arc, dashed or guide line and arrowhead — only their text labels are removed;
- lines that belong to the scene itself (grid lines drawn on objects, floor / road / track / water perspective lines) and the shadows or reflections the objects cast;
- the overall composition, framing, aspect ratio and resolution.

DO NOT: add any new element, text or decoration; move, resize, restyle, recolour or blur any kept element; crop or zoom; leave empty frames, outlines, smudges or ghost remnants where removed items used to be.

RESULT: the same scene, isolated on a clean pure black background — only the objects, their lines and arrows, shadows and native glow — ready for compositing with the Screen blend mode. Clean edges, no dark halo or grey fringe around objects.`,
    editSuffix: '_black', followUp: false, editOpen: false,
    libName: '', notify: true, skipFailed: true, perRunFolder: true, onlyFinal: true,
    runFolder: '', csvName: '', failed: [], resultsMap: {}, savedKeys: [],
    open: true, settingsOpen: false, logOpen: true, pos: null,
  };
  let S = { ...DEFAULTS };
  const run = { active: false, paused: false, stop: false };
  const STORE_KEY = 'cgptBatch';

  // После обновления/перезагрузки расширения старая копия скрипта теряет доступ к chrome.*.
  // В этом случае она тихо выключается (новая копия уже подключена к вкладке).
  const extAlive = () => { try { return !!(chrome.runtime && chrome.runtime.id && chrome.storage); } catch { return false; } };
  let retired = false;
  function retire() {
    if (retired) return;
    retired = true;
    run.stop = true;
    tickWanted = false;
    const h = document.getElementById('cgpt-batch-host');
    if (h && h.shadowRoot === shadowRef) h.remove();
  }
  let shadowRef = null;

  // Настройки общие для всех вкладок, а промпты и прогресс очереди — свои у каждой вкладки,
  // чтобы в разных чатах можно было вести отдельные очереди одновременно.
  const TAB_FIELDS = ['text', 'sep', 'prefix', 'names', 'refs', 'wordRows', 'startFrom', 'csvName', 'runFolder', 'failed', 'resultsMap', 'savedKeys'];
  const TAB_TTL = 14 * 24 * 3600 * 1000;
  const tabId = (() => {
    try {
      let id = sessionStorage.getItem('cgptBatchTab');
      if (!id) { id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36); sessionStorage.setItem('cgptBatchTab', id); }
      return id;
    } catch { return Math.random().toString(36).slice(2, 10); }
  })();
  const TAB_KEY = `${STORE_KEY}:tab:${tabId}`;

  const save = () => {
    if (!extAlive()) { retire(); return; }
    const shared = {}, tab = { _ts: Date.now() };
    for (const k of Object.keys(S)) (TAB_FIELDS.includes(k) ? tab : shared)[k] = S[k];
    try { chrome.storage.local.set({ [STORE_KEY]: shared, [TAB_KEY]: tab }).catch(() => {}); } catch { retire(); }
  };
  const load = async () => {
    try {
      const data = await chrome.storage.local.get([STORE_KEY, TAB_KEY]);
      const shared = { ...(data[STORE_KEY] || {}) };
      const tab = data[TAB_KEY];
      // Первый запуск после обновления: промпты и прогресс лежали в общих настройках — берём их этой вкладке
      // (при следующем сохранении они из общих уходят, так что достанутся только одной вкладке)
      const seed = {};
      if (!tab) for (const k of TAB_FIELDS) if (k in shared) seed[k] = shared[k];
      for (const k of TAB_FIELDS) delete shared[k];
      S = { ...DEFAULTS, ...shared, ...seed, ...(tab || {}) };
      delete S._ts;
      // Старый короткий шаблон доработки (если пользователь его не менял) → новый
      if ((S.editPrompt || '').startsWith('Edit this image. Remove ALL text: headlines')) S.editPrompt = DEFAULTS.editPrompt;
      pruneTabs();
    } catch { S = { ...DEFAULTS }; }
  };
  // Записи закрытых вкладок не копим
  async function pruneTabs() {
    try {
      const all = await chrome.storage.local.get(null);
      const old = Object.keys(all).filter((k) => k.startsWith(`${STORE_KEY}:tab:`) && k !== TAB_KEY && !((all[k] && all[k]._ts) > Date.now() - TAB_TTL));
      if (old.length) await chrome.storage.local.remove(old);
    } catch { /* не критично */ }
  }

  // Время последнего изменения страницы — чтобы понять, что ответ «успокоился»
  let lastMut = Date.now();
  new MutationObserver(() => { lastMut = Date.now(); }).observe(document.documentElement, {
    subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ['src', 'data-testid', 'aria-label'],
  });

  // ─── Разбор промптов ───
  // Результат кешируется: панель спрашивает список промптов на каждое нажатие клавиши
  let promptsCache = { text: null, sep: null, out: [] };
  function parsePrompts(text, sep) {
    if (text === promptsCache.text && sep === promptsCache.sep) return promptsCache.out;
    let parts;
    if (sep === 'blank') parts = text.split(/\r?\n\s*\r?\n/);
    else if (sep === 'dash') parts = text.split(/^\s*-{3,}\s*$/m);
    else parts = text.split(/\r?\n/);
    const out = parts.map((s) => s.trim()).filter(Boolean);
    promptsCache = { text, sep, out };
    return out;
  }

  // «@IMG_4811 @logo /paparazzi» → файлы из библиотеки ChatGPT + текст промпта.
  // Берутся только «@имя» в самом начале, чтобы не цеплять «@» внутри текста.
  function splitLibRefs(text) {
    const m = text.match(/^\s*((?:@[^\s@]+(?:\s+|$))+)/);
    if (!m) return { refs: [], text: text.trim() };
    return { refs: m[1].trim().split(/\s+/).map((s) => s.slice(1)), text: text.slice(m[0].length).trim() };
  }

  function parseCSV(text) {
    const firstLine = text.split(/\r?\n/)[0] || '';
    const delim = firstLine.includes(';') && !firstLine.includes(',') ? ';' : (firstLine.includes('\t') ? '\t' : ',');
    const rows = []; let row = [], cur = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === delim) { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else if (c !== '\r') cur += c;
    }
    row.push(cur); rows.push(row);
    const data = rows.filter((r) => r.some((c) => c.trim()));
    if (!data.length) return { prompts: [], names: [], refs: [], rows: [] };

    // Заголовок: ищем колонку с промптом и (необязательно) с именем файла
    const head = data[0].map((c) => c.trim().toLowerCase());
    let pCol = head.findIndex((h) => /^(prompt|prompts|промпт|промпты|запрос)$/.test(h));
    const nCol = head.findIndex((h) => /^(имя_результата|имя_файла|filename|file_name|name|имя)$/.test(h));
    const rCol = head.findIndex((h) => /^(реф_файл|реф|референс|ref|reference|ref_file|image|картинка)$/.test(h));
    const wCol = head.findIndex((h) => /^(строка_в_word|строка_word|строка|word_row|row)$/.test(h));
    const hasHeader = pCol >= 0 || nCol >= 0 || rCol >= 0 || wCol >= 0;
    const body = hasHeader ? data.slice(1) : data;
    if (pCol < 0) {
      // Нет заголовка «prompt» — берём колонку с самым длинным текстом
      const width = Math.max(...body.map((r) => r.length));
      let best = 0, bestLen = -1;
      for (let c = 0; c < width; c++) {
        const len = body.reduce((s, r) => s + (r[c] || '').length, 0);
        if (len > bestLen) { bestLen = len; best = c; }
      }
      pCol = best;
    }
    const prompts = [], names = [], refs = [], wrows = [];
    for (const r of body) {
      const p = (r[pCol] || '').trim();
      if (!p) continue;
      prompts.push(p);
      names.push(nCol >= 0 ? (r[nCol] || '').trim() : '');
      refs.push(rCol >= 0 ? (r[rCol] || '').trim() : '');
      wrows.push(wCol >= 0 ? (r[wCol] || '').trim() : '');
    }
    return { prompts, names, refs, rows: wrows };
  }

  // ─── Работа со страницей ChatGPT ───
  const isGenerating = () => !!$(SEL.stop);
  const countTurns = () => Math.max($$(SEL.turn).length, $$(SEL.msg).length);

  function allImgs() {
    const root = $('main') || document.body;
    const composer = composerRoot();
    return $$('img', root).filter((i) => {
      const s = srcOf(i);
      if (!s || s.startsWith('data:image/svg')) return false;
      // не считаем картинки из поля ввода (превью вложений) и из сообщений пользователя (референсы)
      if (composer && composer.contains(i)) return false;
      if (i.closest('[data-message-author-role="user"], [data-turn="user"]')) return false;
      const turn = i.closest(SEL.turn);
      if (turn && turn.querySelector('[data-message-author-role="user"]') && !turn.querySelector('[data-message-author-role="assistant"]')) return false;
      return true;
    });
  }

  // Новые картинки (которых не было до отправки), без дублей по src
  function newImages(before) {
    const seen = new Set();
    return allImgs().filter((i) => {
      const s = srcOf(i);
      if (before.has(s) || seen.has(s)) return false;
      if (i.complete && i.naturalWidth && i.naturalWidth < MIN_IMG_SIZE) return false;
      // В фоновой вкладке «ленивые» картинки могут не грузиться — заставляем
      if (i.loading === 'lazy') i.loading = 'eager';
      seen.add(s);
      return true;
    });
  }
  const imgReady = (i) => i.complete && i.naturalWidth >= MIN_IMG_SIZE;
  const hasRealSrc = (i) => /^(https?:|blob:|data:image\/(?!svg))/.test(srcOf(i));
  const isBlurred = (i) => /blur\(/.test(getComputedStyle(i).filter);
  // Картинку можно скачивать: она загрузилась, либо вкладка скрыта и у картинки
  // уже есть настоящая ссылка (скачивание идёт по ссылке, отрисовка не нужна)
  const imgUsable = (i) => imgReady(i) || (document.hidden && hasRealSrc(i) && !isBlurred(i));

  function lastTurnText() {
    const turns = $$(SEL.turn);
    const el = turns[turns.length - 1] || $$(SEL.msg).pop();
    return el ? el.textContent || '' : ''; // textContent не заставляет браузер пересчитывать вёрстку
  }

  function imagePending(before) {
    if (IMAGE_PENDING_RE.test(lastTurnText())) return true;
    // размытая заготовка / ещё грузящаяся картинка
    return newImages(before).some((i) => !imgUsable(i) || isBlurred(i));
  }

  // Очередь привязана к чату, в котором её запустили: перешли в другой — останавливаемся,
  // а не начинаем слать промпты туда. Пустой чат (/) после первой отправки становится /c/<id> — это тот же чат.
  const chatPath = () => location.pathname.replace(/\/+$/, '') || '/';
  function checkChat() {
    if (!run.chatPath) return;
    const cur = chatPath();
    if (cur === run.chatPath) return;
    if (!run.chatPath.startsWith('/c/') && cur.startsWith('/c/')) { run.chatPath = cur; return; }
    run.stop = true; run.paused = false;
    log('Вы перешли в другой чат — очередь остановлена. Вернитесь в нужный чат и нажмите «Продолжить»', 'warn');
  }
  function checkStop() { checkChat(); if (run.stop) throw new Error('STOP'); }
  async function waitPause() { while (run.paused) { checkStop(); await sleep(300); } }
  async function sleepChecked(ms, onTick) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      checkStop();
      onTick && onTick(Math.ceil((end - Date.now()) / 1000));
      await sleep(Math.min(250, end - Date.now()));
    }
  }

  // ─── Поиск элементов: только ВИДИМЫЕ (в ChatGPT есть скрытый запасной textarea) ───
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity !== 0;
  }
  function inputCandidates() {
    const seen = new Set();
    return SEL.inputList.flatMap((s) => $$(s)).filter((el) => !seen.has(el) && seen.add(el));
  }
  // Поле ввода запоминаем: искать его заново (7 селекторов + стили) нужно, только если ChatGPT его перерисовал
  let inputCache = null;
  const findInput = () => {
    if (inputCache && inputCache.isConnected && isVisible(inputCache)) return inputCache;
    inputCache = inputCandidates().find(isVisible) || null;
    return inputCache;
  };
  const inputText = (el) => (el ? (el.tagName === 'TEXTAREA' ? el.value : el.innerText) : '');

  function sendCandidates() {
    const seen = new Set();
    return SEL.sendList.flatMap((s) => $$(s))
      .filter((b) => !seen.has(b) && seen.add(b))
      .filter((b) => b.getAttribute('data-testid') !== 'stop-button');
  }
  const findSend = () => sendCandidates().find((b) => isVisible(b) && !b.disabled && b.getAttribute('aria-disabled') !== 'true') || null;

  // Текст в поле совпадает с промптом (с допуском на пробелы/переносы)
  function textMatches(el, text) {
    const a = norm(inputText(el)), b = norm(text);
    if (!a) return false;
    return a === b || (a.length >= b.length * 0.95 && a.includes(b.slice(0, 60)) && a.includes(b.slice(-40)));
  }

  // ChatGPT может перерисовать поле ввода (после отправки, при смене чата) — тогда прежняя
  // ссылка на него «отвалилась» от страницы. Берём актуальное поле.
  const liveInput = (el) => (el && el.isConnected && isVisible(el) ? el : findInput());

  function clearInput(el) {
    el = liveInput(el);
    if (!el) return;
    el.focus();
    if (el.tagName === 'TEXTAREA') { setTextareaValue(el, ''); return; }
    // Chrome не выделяет диапазон вне основного документа (отвалившийся элемент, shadow DOM) и
    // пишет в консоль предупреждение «addRange(): range isn't in document» — поэтому проверяем заранее
    if (inMainDocument(el)) {
      try {
        const sel = getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges(); sel.addRange(range);
      } catch {
        document.execCommand('selectAll', false);
      }
    } else {
      document.execCommand('selectAll', false); // запасной способ выделить всё в сфокусированном поле
    }
    document.execCommand('delete', false);
  }
  const inMainDocument = (el) => !!el && el.isConnected && el.getRootNode() === document;
  function setTextareaValue(el, v) {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Способы вставки — пробуем по очереди, после каждого проверяем результат
  const INSERT_METHODS = [
    ['paste', async (el, text) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }],
    ['insertText', async (el, text) => {
      if (el.tagName === 'TEXTAREA') { setTextareaValue(el, text); return; }
      document.execCommand('insertText', false, text);
    }],
    ['beforeinput', async (el, text) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertFromPaste', dataTransfer: dt, bubbles: true, cancelable: true }));
    }],
    ['dom', async (el, text) => {
      if (el.tagName === 'TEXTAREA') { setTextareaValue(el, text); return; }
      el.innerHTML = text.split(/\r?\n/).map((l) => `<p>${l ? escapeHtml(l) : '<br>'}</p>`).join('');
      el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: text, bubbles: true }));
    }],
  ];

  function placeCaretEnd(el) {
    el = liveInput(el);
    if (!el) return;
    el.focus();
    if (el.tagName === 'TEXTAREA') { el.selectionStart = el.selectionEnd = el.value.length; return; }
    if (!inMainDocument(el)) return; // каретка встанет сама при фокусе
    try {
      const sel = getSelection(), range = document.createRange();
      range.selectNodeContents(el); range.collapse(false);
      sel.removeAllRanges(); sel.addRange(range);
    } catch { /* поле перерисовали */ }
  }
  // keep=true — дописать текст в конец, не стирая то, что уже есть в поле (ссылку @файл)
  function keepMatches(el, text) {
    const a = norm(inputText(el)), b = norm(text);
    return !!a && a.includes(b.slice(0, 60)) && a.includes(b.slice(-40));
  }

  async function typePrompt(text, keep = false) {
    let el = findInput();
    if (!el) {
      dbg('Поле ввода не найдено', diag());
      throw new Error('Не найдено видимое поле ввода ChatGPT');
    }
    for (const [name, fn] of INSERT_METHODS) {
      if (keep && name === 'dom') continue; // этот способ перезаписывает всё поле и сотрёт ссылку
      el = liveInput(el) || el; // поле могли перерисовать — берём актуальное
      if (keep) placeCaretEnd(el); else clearInput(el);
      await sleep(60);
      el = liveInput(el) || el;
      el.focus();
      try { await fn(el, keep ? ' ' + text : text); } catch (e) { dbg(`Вставка «${name}» упала: ${e.message}`); }
      // Не ждём вслепую 0,5 с: проверяем результат каждые 80 мс, до 1,5 с
      const tIns = Date.now();
      let inserted = false;
      while (Date.now() - tIns < 1500) {
        if (keep ? keepMatches(el, text) : textMatches(el, text)) { inserted = true; break; }
        await sleep(80);
      }
      if (inserted) {
        dbg(`Текст вставлен способом «${name}» (${inputText(el).length} симв.) в ${desc(el)}`);
        return el;
      }
      dbg(`Способ «${name}» не сработал: в поле ${norm(inputText(el)).length} симв. из ${norm(text).length}`);
    }
    dbg('Ни один способ вставки не сработал', diag());
    throw new Error('Не удалось вставить текст в поле ввода');
  }

  // ─── Референс из библиотеки ChatGPT: «@имя» + выбор в подсказке ───
  // Файл уже лежит в библиотеке ChatGPT, поэтому заново грузить его не нужно.
  const fireClick = (el) => ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']
    .forEach((t) => el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })));
  function pressKey(el, key, code, keyCode) {
    el.focus();
    const o = { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', o));
    el.dispatchEvent(new KeyboardEvent('keyup', o));
  }
  // Ссылка действительно превратилась во вложение/«чип», а не осталась буквальным текстом «@имя»
  function libAttached(before, el, name) {
    const n = labelKey(name), now = composerSnapshot();
    if (now.imgs > before.imgs) return true;
    if (el.querySelector('[contenteditable="false"], [data-mention], [data-type="mention"], [class*="mention" i]')) return true;
    // «@имя» осталось в поле буквальным текстом — значит, файл не выбран
    if (labelKey(inputText(el)).includes('@' + n)) return false;
    // «@имя» из поля исчезло. Если в поле уже была картинка (ChatGPT не плодит дубли) — счётчик
    // не вырастет, но вложение на месте: считаем, что файл выбран.
    if (now.imgs >= 1 && now.imgs >= before.imgs) return true;
    return now.text.includes(n);
  }

  // Кнопки «удалить» у превью вложений в поле ввода. У ChatGPT они часто видны только при
  // наведении (прозрачные), поэтому видимость не проверяем — только что кнопка рядом с картинкой.
  function attachmentRemoveButtons() {
    const root = composerRoot();
    if (!root) return [];
    const ed = findInput();
    return $$('button', root).filter((b) => {
      if (!b.isConnected || host.contains(b) || (ed && ed.contains(b))) return false;
      if (!/(remove|delete|удал|убрать|закрыт|close)/i.test(`${b.getAttribute('aria-label') || ''} ${b.title || ''}`)) return false;
      let p = b.parentElement;
      for (let i = 0; i < 4 && p && p !== root; i++, p = p.parentElement) if (p.querySelector('img')) return true;
      return false;
    });
  }
  // Убрать все вложения из поля ввода: остатки прошлой попытки мешают выбору файла через «@»
  async function clearAttachments() {
    let n = 0;
    for (let k = 0; k < 8; k++) {
      const b = attachmentRemoveButtons()[0];
      if (!b) break;
      b.click(); n++;
      await sleep(200);
    }
    if (n) dbg(`Убрал старых вложений из поля: ${n}`);
    return n;
  }
  // Файл из библиотеки для всех промптов. Пустое поле — не используется (переключателя нет:
  // одно состояние вместо двух, их нельзя рассинхронизировать). «@» в начале убирается.
  const libNameClean = () => (S.libName || '').trim().replace(/^@+/, '').trim();

  // Меню «@» ищем только среди того, что ПОЯВИЛОСЬ на странице после ввода, — а не обходим
  // весь чат каждые 0,1 с (на длинном чате это ~36 тыс. узлов и заметно тормозило страницу).
  function watchAdded() {
    const roots = new Set();
    const mo = new MutationObserver((list) => {
      for (const m of list) {
        if (m.type === 'characterData') { if (m.target.parentElement) roots.add(m.target.parentElement); continue; }
        for (const n of m.addedNodes) {
          const e = n.nodeType === 1 ? n : n.parentElement;
          if (e) roots.add(e);
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    return { roots, stop: () => mo.disconnect() };
  }
  // Пункты с именем файла внутри появившихся элементов (не в поле ввода, не в чате, не в панели)
  function entriesIn(roots, name) {
    const n = labelKey(name), ed = findInput(), out = [];
    for (const r of roots) {
      if (!r.isConnected || host.contains(r) || (ed && (ed.contains(r) || r.contains(ed)))) continue;
      if (r.closest(`${SEL.turn}, [data-message-author-role]`)) continue;
      if (!labelKey(r.textContent || '').includes(n)) continue; // быстрый отсев без обхода
      const w = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
      for (let t; (t = w.nextNode());) {
        const p = t.parentElement;
        if (p && labelKey(t.nodeValue).includes(n) && !(ed && ed.contains(p)) && isVisible(p)) out.push(p);
      }
    }
    return out;
  }
  const clickTarget = (el) => el.closest('[role="option"], [role="menuitem"], [cmdk-item], button, a, li, [tabindex], [class*="cursor-pointer"]') || el;

  // Какой способ ввода «@» у тебя работает — запоминаем, чтобы в следующий раз не пробовать лишнее
  let libStrategy = 'chunk';

  // fresh=true — поле очищается перед вводом; false — «@имя» дописывается (второй файл и т.д.)
  async function insertLibraryRef(name, fresh = true) {
    let el = findInput();
    if (!el) throw new Error('Не найдено видимое поле ввода ChatGPT');
    if (fresh) { clearInput(el); await sleep(60); el = liveInput(el) || el; }
    const before = composerSnapshot();
    const typed = () => labelKey(inputText(el)).includes('@' + labelKey(name));
    // Убрать недописанное «@имя», не трогая то, что было в поле до него
    const eraseTyped = () => {
      if (!typed()) return;
      if (fresh) { clearInput(el); return; }
      placeCaretEnd(el);
      for (let k = 0; k <= name.length; k++) document.execCommand('delete', false);
    };

    const waitFor = async (fn, ms) => {
      const t = Date.now();
      while (Date.now() - t < ms) { checkStop(); const v = fn(); if (v) return v; await sleep(100); }
      return fn();
    };
    const waitAttached = (ms) => waitFor(() => libAttached(before, el, name), ms);

    // Способы набрать «@имя» (все — как ввод с клавиатуры, вставкой меню не открывается)
    const typers = {
      chunk: async () => { // «@» отдельно, затем имя одним куском — быстро
        el.focus(); placeCaretEnd(el);
        document.execCommand('insertText', false, '@'); await sleep(250);
        document.execCommand('insertText', false, name);
      },
      slow: async () => { // «@», затем имя по символам — медленно, но как руками
        el.focus(); placeCaretEnd(el);
        document.execCommand('insertText', false, '@'); await sleep(350);
        for (const ch of name) { document.execCommand('insertText', false, ch); await sleep(45); }
      },
    };
    const order = libStrategy === 'slow' ? ['slow'] : ['chunk', 'slow'];
    const seenTexts = new Set();

    for (const strategy of order) {
      eraseTyped(); await sleep(100);
      el = liveInput(el) || el;
      const watch = watchAdded();
      try {
        await typers[strategy]();
        // Enter НЕ нажимаем, пока в меню не появился пункт с именем файла:
        // без открытого меню Enter отправил бы в чат сообщение «@имя».
        const entry = await waitFor(() => entriesIn(watch.roots, name)[0], strategy === 'slow' ? 9000 : 4000);
        for (const r of watch.roots) if (r.isConnected && !host.contains(r)) seenTexts.add(norm(r.textContent).slice(0, 60));
        if (!entry) { dbg(`Способ «${strategy}»: пункт меню с именем «${name}» не появился`); continue; }
        dbg(`Способ «${strategy}»: пункт меню найден «${norm(entry.textContent).slice(0, 60)}»`);
        await sleep(150); // дать меню дорисоваться
        fireClick(clickTarget(entry));
        let attached = await waitAttached(6000);
        if (!attached && entriesIn(watch.roots, name).length) { // меню всё ещё открыто — Enter безопасен
          dbg('Клик не подтвердился, меню открыто — жму Enter');
          pressKey(el, 'Enter', 'Enter', 13);
          attached = await waitAttached(4000);
        }
        if (attached) {
          libStrategy = strategy;
          dbg(`Файл «${name}» выбран из библиотеки (способ «${strategy}»)`);
          return el;
        }
        dbg(`Способ «${strategy}»: пункт найден, но файл не прикрепился`);
      } finally {
        watch.stop();
      }
    }

    // Не вышло: убираем недописанный «@имя», чтобы он случайно не ушёл в чат
    eraseTyped();
    dbg('Ссылка из библиотеки не сработала', { appearedOnPage: [...seenTexts].filter(Boolean).slice(0, 30), ...diag() });
    throw new Error(`не удалось выбрать «${name}» из библиотеки (@)`);
  }

  // Отправка уже произошла? (поле очистилось / пошла генерация / появилось новое сообщение)
  const sentOk = (el, turnsBefore) => isGenerating() || countTurns() > turnsBefore || !norm(inputText(el));

  async function clickSend(el, turnsBefore, waitMs = 10000) {
    // 1) ждём активную кнопку «Отправить» (с файлами — дольше: пока идёт загрузка, она неактивна)
    const t0 = Date.now();
    let btn = null;
    while (Date.now() - t0 < waitMs) {
      checkStop();
      btn = findSend();
      if (btn) break;
      if (waitMs > 10000) setStatus('gen', `Загрузка файлов… ${Math.round((Date.now() - t0) / 1000)} с`);
      await sleep(300);
    }
    const tries = [];
    if (btn) tries.push(['кнопка', () => btn.click()]);
    else dbg(`Кнопка «Отправить» не найдена за ${Math.round(waitMs / 1000)} с`, diag());
    tries.push(['Enter', () => {
      el.focus();
      const o = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent('keydown', o));
      el.dispatchEvent(new KeyboardEvent('keypress', o));
      el.dispatchEvent(new KeyboardEvent('keyup', o));
    }]);
    tries.push(['form.submit', () => {
      const form = el.closest('form');
      if (form && form.requestSubmit) form.requestSubmit(); else throw new Error('нет формы');
    }]);

    // 2) пробуем способы, пока отправка не подтвердится
    for (const [name, fn] of tries) {
      try { fn(); } catch (e) { dbg(`Отправка «${name}» упала: ${e.message}`); continue; }
      const t1 = Date.now();
      while (Date.now() - t1 < 4000) {
        if (sentOk(el, turnsBefore)) { dbg(`Отправлено способом «${name}»`); return true; }
        await sleep(200);
      }
      dbg(`Отправка «${name}» не подтвердилась`);
    }
    dbg('Не удалось отправить', diag());
    return false;
  }

  // ─── Прикрепление файлов ───
  // Файлы живут только в памяти вкладки: после перезагрузки страницы их нужно выбрать заново.
  // refSource: 'folder' — референсы из папки, 'word' — картинки из таблицы Word-ТЗ
  const files = { common: [], refs: new Map(), edit: [], word: [], wordName: '', refSource: '' };
  const baseName = (n) => (n || '').split(/[\\/]/).pop().toLowerCase();
  const stripExt = (n) => n.replace(/\.[a-z0-9]{2,5}$/i, '');
  const isImageFile = (f) => /^image\//.test(f.type) || /\.(png|jpe?g|webp|gif)$/i.test(f.name);

  // ─── Word-ТЗ (.docx): достаём картинки из строк таблицы ───
  // .docx — это zip. Распаковываем встроенным DecompressionStream, без библиотек.
  async function unzip(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    const dv = new DataView(buf.buffer);
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('файл не похож на .docx');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const entries = {};
    const dec = new TextDecoder();
    for (let k = 0; k < count && dv.getUint32(p, true) === 0x02014b50; k++) {
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const off = dv.getUint32(p + 42, true);
      entries[dec.decode(buf.subarray(p + 46, p + 46 + nlen))] = { method, csize, off };
      p += 46 + nlen + elen + clen;
    }
    const read = async (name) => {
      const e = entries[name];
      if (!e) return null;
      const start = e.off + 30 + dv.getUint16(e.off + 26, true) + dv.getUint16(e.off + 28, true);
      const data = buf.subarray(start, start + e.csize);
      if (e.method === 0) return data;
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    };
    return { read };
  }

  const xmlUnescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const cellText = (xml) => xml.split(/<\/w:p>/).map((p) =>
    xmlUnescape([...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(''))).filter((t) => t.trim()).join('\n');
  const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

  // Строки таблиц, в которых есть картинка → [{ label, title, desc, file }]
  async function parseWordTZ(docx) {
    const z = await unzip(docx);
    const dec = new TextDecoder();
    const docXml = await z.read('word/document.xml');
    if (!docXml) throw new Error('в файле нет word/document.xml');
    const xml = dec.decode(docXml);
    const relsRaw = await z.read('word/_rels/document.xml.rels');
    const rels = {};
    for (const m of dec.decode(relsRaw || new Uint8Array()).matchAll(/<Relationship\b[^>]*>/g)) {
      const id = (m[0].match(/\bId="([^"]+)"/) || [])[1];
      const target = (m[0].match(/\bTarget="([^"]+)"/) || [])[1];
      if (id && target) rels[id] = target.startsWith('/') ? target.slice(1) : 'word/' + target;
    }
    const out = [];
    let section = '';
    for (const row of xml.matchAll(/<w:tr[\s>][\s\S]*?<\/w:tr>/g)) {
      const cells = [...row[0].matchAll(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g)].map((c) => c[1]);
      const ids = [...row[0].matchAll(/r:(?:embed|id)="(rId\d+)"/g)].map((m) => m[1]).filter((id) => /\.(png|jpe?g|gif|webp)$/i.test(rels[id] || ''));
      if (!ids.length) {
        // Строка из одной ячейки («Сценарий к слайдам», «Сценарий к подробнее») — заголовок раздела
        const t = cells.length === 1 ? cellText(cells[0]).replace(/\s+/g, ' ').trim() : '';
        if (t) section = t;
        continue;
      }
      const texts = cells.map(cellText);
      const imgCell = cells.findIndex((c) => /r:(?:embed|id)="rId\d+"/.test(c));
      const path = rels[ids[0]];
      const bytes = await z.read(path);
      if (!bytes) continue;
      const ext = path.split('.').pop().toLowerCase();
      const label = (texts[0] || '').trim() || `Строка ${out.length + 1}`;
      const file = new File([bytes], `${String(out.length + 1).padStart(2, '0')}_${slug(label)}.${ext}`, { type: MIME[ext] || 'image/png' });
      out.push({ label, section, title: (texts[1] || '').trim(), desc: (texts[imgCell] || texts[texts.length - 1] || '').trim(), file });
    }
    // Названия «1», «2», «1», «2» (по разделам) нельзя искать в тексте промпта: цифра есть в любом тексте.
    // Такие строки подбираем по порядку.
    const cnt = {};
    out.forEach((r) => { cnt[labelKey(r.label)] = (cnt[labelKey(r.label)] || 0) + 1; });
    out.forEach((r) => { r.vague = /^\d+$/.test(r.label.trim()) || cnt[labelKey(r.label)] > 1; });
    return out;
  }

  // Какая строка Word нужна промпту №i:
  // 1) колонка «строка_в_Word» из CSV → 2) «Слайд 1» / «Рисунок 2» в тексте промпта → 3) по порядку
  const labelKey = (s) => norm(s).toLowerCase().replace(/ё/g, 'е');
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function wordRowFor(i) {
    const rows = files.word;
    if (!rows.length) return null;
    const prompts = parsePrompts(S.text, S.sep);
    const col = S.wordRows && S.wordRows.length === prompts.length ? S.wordRows[i] : '';
    if (col) {
      const r = rows.find((x) => labelKey(x.label) === labelKey(col) && !x.vague)
        || rows.find((x) => labelKey(`${x.section} ${x.label}`) === labelKey(col));
      if (r) return { row: r, how: 'колонка «строка_в_Word»' };
    }
    const t = labelKey(prompts[i] || '');
    let loose = null;
    for (const r of rows) {
      const L = labelKey(r.label);
      if (!L || r.vague) continue;
      if (t.includes(`«${L}»`) || t.includes(`"${L}"`)) return { row: r, how: 'упоминание в промпте' };
      if (!loose && new RegExp(`(^|[^\\p{L}\\p{N}])${escRe(L)}(?!\\p{N})`, 'u').test(t)) loose = r;
    }
    if (loose) return { row: loose, how: 'упоминание в промпте' };
    return rows[i] ? { row: rows[i], how: 'по порядку' } : null;
  }

  // Референс для промпта №i: по колонке «реф_файл», иначе по номеру в начале имени (01_…, 1_…)
  function refFor(i) {
    if (files.refSource === 'word') { const w = wordRowFor(i); return w ? w.row.file : null; }
    // Колонка из CSV действует, только пока список промптов тот же, что был загружен
    const refsValid = S.refs && S.refs.length && S.refs.length === parsePrompts(S.text, S.sep).length;
    const want = refsValid && S.refs[i];
    if (want) {
      const b = baseName(want);
      const hit = files.refs.get(b) || files.refs.get(stripExt(b));
      if (hit) return hit;
      // Имя расходится только знаками/регистром/расширением (che-sld1.jpg ↔ che_sld1.png)
      const flat = (n) => stripExt(n).replace(/[^\p{L}\p{N}]+/gu, '');
      for (const [name, f] of files.refs) if (flat(name) === flat(b)) return f;
      return null;
    }
    const num = i + 1;
    for (const [name, f] of files.refs) {
      const m = name.match(/^0*(\d+)[\s._-]/);
      if (m && +m[1] === num) return f;
    }
    return null;
  }
  function attachmentsFor(i, isFirstOfRun) {
    const list = [];
    if (files.common.length && (S.commonMode === 'each' || isFirstOfRun)) list.push(...files.common);
    const r = refFor(i);
    if (r) list.push(r);
    else if (files.refSource === 'folder' && S.refs && S.refs[i] && files.refs.size) log(`#${i + 1}: референс «${S.refs[i]}» не найден в выбранной папке`, 'warn');
    else if (files.refSource === 'word') log(`#${i + 1}: подходящей строки в Word не нашлось — без референса`, 'warn');
    return list;
  }

  // Область с полем ввода и превью вложений
  function composerRoot() {
    const el = findInput();
    if (!el) return null;
    return el.closest('form') || el.closest('[class*="composer"]') || el.parentElement?.parentElement?.parentElement || null;
  }
  function composerSnapshot() {
    const root = composerRoot();
    if (!root) return { imgs: 0, text: '' };
    const ed = findInput();
    const imgs = $$('img', root).filter((i) => !ed || !ed.contains(i)).length;
    return { imgs, text: (root.textContent || '').toLowerCase() };
  }
  // Файл появился среди вложений? Картинка — новое превью, документ — его имя в поле
  function fileAppeared(file, before) {
    const now = composerSnapshot();
    if (isImageFile(file)) return now.imgs > before.imgs;
    const stem = stripExt(file.name.toLowerCase()).slice(0, 18);
    return now.text.includes(stem) && !before.text.includes(stem);
  }

  function fileInputsFor(file) {
    const all = $$('input[type="file"]');
    const score = (inp) => {
      const acc = (inp.getAttribute('accept') || '').toLowerCase();
      if (!acc) return 2;
      const ext = '.' + file.name.split('.').pop().toLowerCase();
      if (acc.includes(ext) || (file.type && acc.includes(file.type))) return 3;
      if (isImageFile(file) && acc.includes('image')) return 3;
      if (!isImageFile(file) && /^image\/?\*?(,\s*image\/[^,]+)*$/.test(acc)) return -1; // только картинки
      return 1;
    };
    return all.map((inp) => [inp, score(inp)]).filter(([, s]) => s >= 0).sort((a, b) => b[1] - a[1]).map(([inp]) => inp);
  }

  const ATTACH_METHODS = [
    ['input', async (file) => {
      const inputs = fileInputsFor(file);
      if (!inputs.length) throw new Error('нет input[type=file]');
      const dt = new DataTransfer(); dt.items.add(file);
      inputs[0].files = dt.files;
      inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      inputs[0].dispatchEvent(new Event('change', { bubbles: true }));
    }],
    ['paste', async (file) => {
      const el = findInput(); el.focus();
      const dt = new DataTransfer(); dt.items.add(file);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }],
    ['drop', async (file) => {
      const target = composerRoot() || findInput();
      const dt = new DataTransfer(); dt.items.add(file);
      for (const type of ['dragenter', 'dragover', 'drop']) {
        target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
        await sleep(80);
      }
    }],
  ];

  async function attachFiles(list) {
    for (const file of list) {
      // При повторе документ уже может висеть в поле — второй раз не прикрепляем
      if (!isImageFile(file) && composerSnapshot().text.includes(stripExt(file.name.toLowerCase()).slice(0, 18))) {
        dbg(`Файл «${file.name}» уже прикреплён — пропускаю`);
        continue;
      }
      let ok = false;
      for (const [name, fn] of ATTACH_METHODS) {
        checkStop();
        const before = composerSnapshot();
        try { await fn(file); } catch (e) { dbg(`Прикрепление «${file.name}» способом «${name}» упало: ${e.message}`); continue; }
        const t0 = Date.now();
        while (Date.now() - t0 < 6000) {
          if (fileAppeared(file, before)) { ok = true; break; }
          await sleep(250);
        }
        if (ok) { dbg(`Файл «${file.name}» прикреплён способом «${name}»`); break; }
        dbg(`Способ «${name}» для «${file.name}» не подтвердился`);
      }
      if (!ok) {
        dbg(`Не удалось прикрепить «${file.name}»`, diag());
        throw new Error(`не удалось прикрепить файл «${file.name}»`);
      }
      await sleep(400);
    }
  }

  // ─── Диагностика ───
  function desc(el) {
    if (!el) return '—';
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const tid = el.getAttribute('data-testid'); if (tid) s += `[testid=${tid}]`;
    const al = el.getAttribute('aria-label'); if (al) s += `[aria=${al}]`;
    if (el.getAttribute('contenteditable')) s += `[ce=${el.getAttribute('contenteditable')}]`;
    s += isVisible(el) ? ' видим' : ' СКРЫТ';
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') s += ' disabled';
    return s;
  }
  function diag() {
    const inp = findInput();
    return {
      url: location.href,
      visibility: document.visibilityState,
      focus: document.hasFocus(),
      input: desc(inp),
      inputTextLen: norm(inputText(inp)).length,
      fileInputs: $$('input[type="file"]').map((f) => f.getAttribute('accept') || '*'),
      attachments: { common: files.common.map((f) => f.name), refs: new Set(files.refs.values()).size },
      composer: composerSnapshot().imgs + ' img',
      inputCandidates: inputCandidates().map(desc),
      send: desc(findSend()),
      sendCandidates: sendCandidates().map(desc),
      composerButtons: (() => {
        const form = inp && (inp.closest('form') || inp.closest('[class*="composer"]'));
        return form ? $$('button', form).filter(isVisible).map(desc).slice(0, 12) : [];
      })(),
      stop: desc($(SEL.stop)),
      generating: isGenerating(),
      turns: countTurns(),
      imgs: allImgs().length,
      ua: navigator.userAgent.replace(/^.*(Chrome\/[\d.]+).*$/, '$1'),
    };
  }

  // Проверка без отправки: вставить тестовый текст и стереть
  async function testInput() {
    log('Проверка поля ввода…', 'info');
    const d = diag();
    dbg('Состояние страницы', d);
    const el = findInput();
    if (!el) { log('✗ Видимое поле ввода не найдено', 'err'); return; }
    const sample = 'Тест Batch Prompter\nвторая строка';
    let ok = false;
    try { await typePrompt(sample); ok = true; } catch (e) { log(`✗ ${e.message}`, 'err'); }
    if (ok) {
      await sleep(300);
      const btn = findSend();
      log(btn ? `✓ Текст вставляется, кнопка «Отправить» найдена: ${desc(btn)}` : '⚠ Текст вставился, но кнопка «Отправить» не найдена (сработает Enter)', btn ? 'ok' : 'warn');
      await sleep(800);
      clearInput(el);
    }
    log('Нажмите «Копировать отчёт» и пришлите его, если что-то не так', 'info');
  }

  async function waitIdle() {
    const t0 = Date.now();
    while (isGenerating() && Date.now() - t0 < S.timeoutMin * 60000) { checkStop(); await sleep(400); }
  }

  // ─── Лимиты ChatGPT и уведомления ───
  const LIMIT_RE = /(too many (requests|images)|rate limit|reached (the |your )?(current )?(usage |daily |hourly )?(cap|limit)|usage cap|image generation limit|слишком много запросов|достигли (текущего )?лимита|достигнут лимит|лимит[^.]{0,40}(исчерпан|достигнут)|повторите попытку|попробуйте (снова|позже|ещё раз|еще раз) через|try again (later|in))/i;
  function limitText(assistBefore = 0) {
    const parts = assistCount() > assistBefore ? [lastTurnText()] : [];
    for (const e of $$('[role="alert"], [role="dialog"], [role="status"], [data-testid*="toast" i], [class*="toast" i]')) {
      if (isVisible(e) && !host.contains(e)) parts.push(e.innerText || '');
    }
    return parts.join('\n');
  }
  // Сколько ждать: «через 3 минуты», «in 2 hours»; если не указано — 15 минут
  function parseWaitMs(t) {
    const m = t.match(/(\d+(?:[.,]\d+)?)\s*(секунд\w*|сек\b|seconds?|secs?|минут\w*|мин\b|minutes?|mins?|час\w*|hours?|hrs?)/i);
    if (!m) return 15 * 60000;
    const n = parseFloat(m[1].replace(',', '.')), u = m[2].toLowerCase();
    const mult = /^(сек|sec)/.test(u) ? 1000 : /^(мин|min)/.test(u) ? 60000 : 3600000;
    return Math.round(n * mult) + 5000;
  }
  function detectLimit(assistBefore = 0) {
    const t = limitText(assistBefore), m = t.match(LIMIT_RE);
    if (!m) return null;
    return { text: norm(t.slice(Math.max(0, m.index - 30), m.index + 150)), waitMs: parseWaitMs(t.slice(m.index)) };
  }
  // Отказ по правилам контента: «Нам очень жаль, но ваш запрос может нарушать наши правила…»
  const REFUSAL_RE = /(нарушать наши правила|правила использования контента|нарушает правила|may violate (our )?(content )?polic|violat\w* (our )?(content )?polic|content polic|can[’']?t (help|assist|create|generate)[^.]{0,50}(that|this|request|image)|не могу (создать|сгенерировать|помочь|выполнить))/i;
  const assistCount = () => $$('[data-message-author-role="assistant"]').length;
  // assistBefore — сколько ответов было до отправки: без этого можно принять за новый отказ ответ на ПРОШЛЫЙ промпт
  function detectRefusal(assistBefore = 0) {
    // Только ответ ассистента: в сообщении пользователя (наш промпт) такие слова ничего не значат
    const answers = $$('[data-message-author-role="assistant"]');
    if (answers.length <= assistBefore) return null;
    const t = answers[answers.length - 1].textContent || '';
    const m = t.match(REFUSAL_RE);
    return m ? norm(t.slice(Math.max(0, m.index - 20), m.index + 140)) : null;
  }
  async function waitLimit(lim, label) {
    const ms = Math.min(Math.max(lim.waitMs, 10000), 3 * 3600000);
    log(`${label}: лимит ChatGPT — жду ${fmtTime(Math.round(ms / 1000))} и продолжу сам`, 'warn');
    dbg('Текст про лимит', { text: lim.text });
    notify('Лимит ChatGPT', `Очередь ждёт ${fmtTime(Math.round(ms / 1000))} и продолжит сама`);
    await sleepChecked(ms, (s) => setStatus('wait', `Лимит ChatGPT — осталось ${fmtTime(s)}`));
  }
  // Уведомление Chrome (показывает фоновая часть расширения)
  function notify(title, message) {
    if (!S.notify || !extAlive()) return;
    try { chrome.runtime.sendMessage({ type: 'notify', title, message }).catch(() => {}); } catch { /* контекст недействителен */ }
  }

  async function waitDone(before, turnsBefore, assistBefore = 0) {
    const t0 = Date.now();
    const timeout = Math.max(1, +S.timeoutMin) * 60000;

    // 1) Дождаться начала генерации
    let started = false;
    while (Date.now() - t0 < 30000) {
      checkStop();
      if (isGenerating() || countTurns() > turnsBefore) { started = true; break; }
      await sleep(500);
    }
    if (!started) {
      const lim = detectLimit(assistBefore);
      if (lim) return { ok: false, limit: lim, reason: 'лимит ChatGPT' };
      const ref = detectRefusal(assistBefore);
      if (ref) return { ok: false, refused: ref, reason: 'отказ ChatGPT (правила контента)' };
      dbg('Генерация не началась за 30 с', diag());
      return { ok: false, reason: 'генерация не началась' };
    }
    dbg(`Генерация началась (stop-кнопка: ${isGenerating() ? 'есть' : 'нет'}, сообщений ${countTurns()})`);

    // 2) Дождаться окончания
    let idleSince = 0, lastReport = 0;
    while (true) {
      checkStop();
      const elapsed = Math.round((Date.now() - t0) / 1000);
      setStatus('gen', `Генерация… ${fmtTime(elapsed)}`);
      if (Date.now() - lastReport > 30000) {
        lastReport = Date.now();
        const imgs = newImages(before);
        dbg(`…${fmtTime(elapsed)}: stop=${isGenerating()}, новых картинок ${imgs.length} (готовых ${imgs.filter(imgReady).length}), тишина ${Math.round((Date.now() - lastMut) / 1000)} с, вкладка ${document.visibilityState}, тик ${lastTick ? Math.round((Date.now() - lastTick) / 1000) + ' с назад' : 'нет'}`);
      }
      if (Date.now() - t0 > timeout) { dbg('Таймаут', diag()); return { ok: false, reason: 'таймаут' }; }
      if (isGenerating()) { idleSince = 0; await sleep(500); continue; }
      if (!idleSince) idleSince = Date.now();
      const quietMs = Date.now() - lastMut;
      // Генерация закончилась, а картинки нет — возможно, ChatGPT ответил, что исчерпан лимит
      if (S.waitImage && quietMs > 800 && !newImages(before).length) {
        const lim = detectLimit(assistBefore);
        if (lim) return { ok: false, limit: lim, reason: 'лимит ChatGPT' };
        const ref = detectRefusal(assistBefore);
        if (ref) return { ok: false, refused: ref, reason: 'отказ ChatGPT (правила контента)' };
      }

      if (!S.waitImage) {
        if (quietMs > 2500) break;
      } else {
        const imgs = newImages(before);
        const pending = imagePending(before);
        if (imgs.some(imgUsable) && !pending && quietMs > 2000) break;
        // Картинки нет и ничего не происходит 30 с — скорее всего, её и не будет
        if (!imgs.length && !pending && Date.now() - idleSince > 30000 && quietMs > 10000) break;
      }
      await sleep(400);
    }
    return { ok: true };
  }

  // ─── Скачивание ───
  const slug = (s) => norm(s).replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 50) || 'image';
  const safeFolder = (s) => (s || '').replace(/[<>:"|?*\x00-\x1f]/g, '').replace(/\\/g, '/')
    .split('/').map((p) => p.trim().replace(/^\.+|\.+$/g, '')).filter(Boolean).join('/');
  const safeName = (s) => (s || '').replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[<>:"\/\\|?*\x00-\x1f]/g, '_').trim();
  const pad2 = (n) => String(n).padStart(2, '0');
  const stamp = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`; };

  // Состояние текущего запуска: папка, что уже сохранено, что не удалось, итоги по промптам
  const runCtx = { folder: '', savedKeys: new Set(), pending: [], results: [], mode: 'prompts' };
  // Результат промпта: в таблицу попадает последний по номеру (повтор заменяет прошлую неудачу)
  function recordResult(rec) {
    runCtx.results.push(rec);
    if (runCtx.mode !== 'edit') { S.resultsMap = S.resultsMap || {}; S.resultsMap[rec.num] = rec; }
  }

  // Папка: «Загрузки» / базовая / запуск / подпапка (например, edited)
  const downloadDir = (sub) => [safeFolder(S.folder), S.perRunFolder ? runCtx.folder : '', safeFolder(sub)].filter(Boolean).join('/');

  async function blobToDataURL(url) {
    const blob = await (await fetch(url)).blob();
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob);
    });
  }

  // Одна и та же картинка встречается в странице несколько раз (миниатюра, полный размер, размытая
  // заготовка) — раньше из-за этого файл качался дважды. Узнаём картинку по идентификатору в адресе.
  function imageKey(src) {
    const m = src.match(/file[-_][A-Za-z0-9]+/);
    if (m) return m[0];
    try { const u = new URL(src, location.href); return u.origin + u.pathname + (u.searchParams.get('id') || ''); } catch { return src.slice(0, 200); }
  }
  function uniqueImgs(imgs) {
    const best = new Map();
    for (const i of imgs) {
      const k = imageKey(srcOf(i)), cur = best.get(k);
      if (!cur || (i.naturalWidth || 0) > (cur.naturalWidth || 0)) best.set(k, i); // оставляем самую крупную
    }
    return [...best.entries()].map(([key, img]) => ({ key, img }));
  }

  // Сохранить один файл: до 3 попыток, каждую подтверждает фоновая часть (файл реально на диске)
  async function saveFile(src, filename) {
    let url = src;
    try { if (url.startsWith('blob:')) url = await blobToDataURL(url); } catch (e) { return { ok: false, error: `не прочитать картинку: ${e.message}` }; }
    let err = '';
    for (let a = 1; a <= 3; a++) {
      try {
        const res = await chrome.runtime.sendMessage({ type: 'download', url, filename });
        if (res && res.ok) return { ok: true, path: res.filename || filename };
        err = (res && res.error) || 'нет ответа';
      } catch (e) { err = e.message; }
      await sleep(1500 * a);
    }
    return { ok: false, error: err };
  }

  // Скачать картинки одного промпта. Возвращает итог для журнала и для таблицы результатов.
  // Из найденных картинок оставляем итог генерации: без размытых заготовок и уменьшенных черновиков.
  // Если ChatGPT показал несколько вариантов одинакового размера — берём последний.
  function finalImages(imgs) {
    const list = uniqueImgs(imgs);
    dbg('Картинки ответа', list.map(({ key, img }) => `${key.slice(0, 18)} ${img.naturalWidth}×${img.naturalHeight}${isBlurred(img) ? ' blur' : ''}`));
    if (!S.onlyFinal || list.length < 2) return list;
    let ok = list.filter(({ img }) => !isBlurred(img));
    if (!ok.length) ok = list;
    const maxW = Math.max(...ok.map(({ img }) => img.naturalWidth || 0));
    ok = ok.filter(({ img }) => (img.naturalWidth || 0) >= maxW * 0.8);
    return [ok[ok.length - 1]];
  }
  async function downloadImgs(imgs, job) {
    const uniq = S.onlyFinal ? finalImages(imgs) : uniqueImgs(imgs);
    const fresh = uniq.filter((u) => !runCtx.savedKeys.has(u.key));
    const skipped = uniq.length - fresh.length;
    const base = safeName(job.name) || `${pad3(job.num)}_${slug(job.text)}`;
    const dir = downloadDir(job.sub);
    const names = [], failed = [];
    let k = 0;
    for (const { key, img } of fresh) {
      k++;
      const file = `${base}${fresh.length > 1 ? '_' + k : ''}.png`;
      const res = await saveFile(srcOf(img), dir ? `${dir}/${file}` : file);
      if (res.ok) {
        runCtx.savedKeys.add(key); names.push(file);
        if (runCtx.mode !== 'edit') S.savedKeys = [...runCtx.savedKeys].slice(-1000);
      }
      else {
        failed.push(file);
        runCtx.pending.push({ src: srcOf(img), filename: dir ? `${dir}/${file}` : file, label: job.label, key });
        log(`${job.label}: не скачалось «${file}» — ${res.error}`, 'err');
      }
    }
    return { total: uniq.length, saved: names.length, skipped, failed: failed.length, names, dir };
  }

  // В конце запуска ещё раз пробуем то, что не скачалось
  async function retryPending() {
    if (!runCtx.pending.length) return 0;
    log(`Повторяю скачивание: ${runCtx.pending.length} файл(ов)`, 'warn');
    const left = [];
    for (const p of runCtx.pending) {
      const res = await saveFile(p.src, p.filename);
      if (res.ok) { runCtx.savedKeys.add(p.key); log(`${p.label}: «${p.filename.split('/').pop()}» скачан со второго раза`, 'ok'); }
      else left.push(p);
    }
    runCtx.pending = left;
    return left.length;
  }

  const fmtTime = (sec) => (sec >= 60 ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` : `${sec} с`);

  // ─── Основной цикл ───
  const pad3 = (n) => String(n).padStart(3, '0');
  const stemOf = (name) => (name || '').replace(/\.[a-z0-9]{2,5}$/i, '');

  // После остановки / ошибки / конца: убрать из поля ввода всё, что осталось от нас —
  // недописанный промпт, «@файл» и превью вложений (иначе их легко отправить случайно)
  async function cleanupComposer() {
    try {
      const el = findInput();
      if (!el) return;
      if (norm(inputText(el))) clearInput(el);
      await clearAttachments();
    } catch { /* страница могла измениться — не критично */ }
  }

  // Одна отправка с повторами. Каждая попытка начинается с чистого поля, поэтому никакое
  // промежуточное состояние (пауза, стоп, ошибка) не переносится на следующую попытку.
  // job: { num, label, text, attach: () => File[], name, useLib }
  async function runJob(job) {
    let limitWaits = 0, refusedText = '', lastReason = '';
    // Файлы из библиотеки: «@имя» в начале промпта, а если их нет — общий из поля «Файл из библиотеки»
    const split = job.useLib ? splitLibRefs(job.text) : { refs: [], text: job.text };
    const libRefs = !job.useLib ? [] : split.refs.length ? [...new Set(split.refs)] : [libNameClean()].filter(Boolean);
    const text = split.text;

    for (let attempt = 0; attempt <= S.retries; attempt++) {
      if (attempt > 0) {
        log(`${job.label}: повтор ${attempt} из ${S.retries}`, 'warn');
        await sleepChecked(5000, (s) => setStatus('wait', `Повтор через ${s} с`));
      }
      setStatus('gen', 'Ждём, пока ChatGPT освободится');
      await waitIdle();
      const before = new Set(allImgs().map(srcOf));
      const turns = countTurns();
      const assist = assistCount();

      // 1) Чистое поле: убираем текст и вложения, оставшиеся от прошлой попытки
      const inp = findInput();
      if (inp) { clearInput(inp); await clearAttachments(); }

      // 2) Вложения с компьютера (Word, референсы)
      const att = job.attach ? job.attach() : [];
      if (att.length) {
        setStatus('gen', `Прикрепляю файлы (${att.length})`);
        try { await attachFiles(att); } catch (e) {
          if (e.message === 'STOP') throw e;
          log(`${job.label}: ${e.message}`, 'err'); continue;
        }
        log(`${job.label}: прикреплено — ${att.map((f) => f.name).join(', ')}`, 'info');
      }

      // 3) Файлы из библиотеки ChatGPT через «@»
      let libOk = true;
      for (let k = 0; k < libRefs.length; k++) {
        setStatus('gen', `Файл из библиотеки: @${libRefs[k]}`);
        try { await insertLibraryRef(libRefs[k], k === 0); } catch (e) {
          if (e.message === 'STOP') throw e;
          log(`${job.label}: ${e.message}`, 'err'); libOk = false; break;
        }
      }
      if (!libOk) continue;
      if (libRefs.length) log(`${job.label}: из библиотеки — ${libRefs.map((n) => '@' + n).join(', ')}`, 'info');

      // 4) Текст промпта (после «@файлов» — дописываем, не стирая их)
      let el = findInput();
      if (text) {
        setStatus('gen', 'Вставка промпта');
        try { el = await typePrompt(text, libRefs.length > 0); } catch (e) {
          if (e.message === 'STOP') throw e;
          log(`${job.label}: ${e.message}`, 'err'); continue;
        }
      }

      // 5) Отправка и ожидание
      setStatus('gen', 'Отправка');
      const sendWait = att.length ? 180000 : libRefs.length ? 60000 : 10000;
      if (!(await clickSend(el, turns, sendWait))) { log(`${job.label}: не удалось нажать «Отправить»`, 'err'); continue; }
      log(`${job.label} отправлен`, 'info');

      const r = await waitDone(before, turns, assist);
      if (!r.ok && r.limit && limitWaits < 12) {
        // Лимит — не ошибка промпта: ждём и повторяем, попытка не тратится
        limitWaits++;
        await waitLimit(r.limit, job.label);
        attempt--;
        continue;
      }
      if (!r.ok && r.refused) {
        // Отказ по правилам контента. ChatGPT сам советует «попробуйте ещё раз» — ложные срабатывания бывают
        refusedText = r.refused; lastReason = 'отказ ChatGPT (правила контента)';
        log(`${job.label}: ChatGPT отказал — «${r.refused.slice(0, 90)}»`, 'warn');
        continue;
      }
      if (!r.ok) { lastReason = r.reason; log(`${job.label}: ${r.reason}`, 'err'); continue; }
      refusedText = '';

      // 6) Результат
      if (!S.waitImage) { log(`${job.label} готово`, 'ok'); return { ok: true, imgs: 0, names: [] }; }
      const imgs = newImages(before).filter(imgUsable);
      if (!imgs.length) {
        // Что ChatGPT ответил вместо картинки: без этого причину сбоя не видно
        const answers = $$('[data-message-author-role="assistant"]');
        const said = answers.length > assist ? norm(answers[answers.length - 1].textContent || '').slice(0, 300) : '';
        lastReason = 'картинка не появилась';
        log(`${job.label}: картинка не появилась${said ? ` — ChatGPT ответил: «${said}»` : ' — ответа ChatGPT в чате нет'}`, 'err');
        continue;
      }
      if (S.download) {
        setStatus('gen', 'Скачивание');
        const d = await downloadImgs(imgs, job);
        const note = [d.skipped ? `дубль пропущен: ${d.skipped}` : '', d.failed ? `НЕ СКАЧАНО: ${d.failed}` : ''].filter(Boolean).join(' · ');
        log(`${job.label} готово · скачано ${d.saved} из ${d.total}${d.names.length ? ' → ' + d.names.join(', ') : ''}${note ? ' · ' + note : ''}`, d.failed ? 'warn' : 'ok');
        return { ok: true, imgs: d.saved, names: d.names, dlFailed: d.failed };
      }
      log(`${job.label} готово · картинок: ${uniqueImgs(imgs).length}`, 'ok');
      return { ok: true, imgs: uniqueImgs(imgs).length, names: [] };
    }
    return { ok: false, imgs: 0, refused: refusedText, reason: lastReason };
  }

  // mode: 'prompts' — очередь промптов; 'edit' — доработка готовых картинок из папки;
  //       'retry' — только те промпты, что не вышли в прошлый раз (отказы, ошибки)
  async function start(mode = 'prompts') {
    readForm();
    const isEdit = mode === 'edit', isRetry = mode === 'retry';
    const editText = (S.editPrompt || '').trim();
    let jobs = [];

    if (isEdit) {
      if (!editText) { flash('Заполните универсальный промпт доработки'); return; }
      if (!files.edit.length) { flash('Сначала выберите папку с картинками'); return; }
      jobs = files.edit.map((f, i) => ({
        num: i + 1, label: `✎${i + 1}`, text: editText, display: f.name,
        attach: () => [f], name: stemOf(f.name) + (S.editSuffix || ''), sub: '',
      }));
    } else {
      const prompts = parsePrompts(S.text, S.sep);
      if (!prompts.length) { flash('Добавьте хотя бы один промпт'); return; }
      const named = S.names.length === prompts.length;
      jobs = prompts.map((p, i) => ({
        num: i + 1, label: `#${i + 1}`, display: p,
        text: (S.prefix.trim() ? S.prefix.trim() + ' ' : '') + p,
        useLib: true, sub: '',
        attach: null, // задаётся ниже — зависит от того, первый ли это промпт запуска
        name: (named && S.names[i]) ? stemOf(S.names[i]) : `${pad3(i + 1)}_${slug(p)}`,
      }));
    }
    if (isRetry) {
      const want = new Set(S.failed || []);
      jobs = jobs.filter((j) => want.has(j.num));
      if (!jobs.length) { S.failed = []; save(); updateButtons(); flash('Пропущенных промптов нет'); return; }
    }
    if (!findInput()) { flash('Поле ввода ChatGPT не найдено — нажмите «Проверить поле»'); dbg('Старт: поле не найдено', diag()); return; }
    dbg('Старт', diag());

    run.active = true; run.paused = false; run.stop = false; run.chatPath = chatPath();
    startTicker();
    updateButtons();

    // С какого места идём
    let i = (isEdit || isRetry) ? 0 : Math.min(Math.max(0, (parseInt(S.startFrom, 10) || 1) - 1), jobs.length - 1);
    const startIdx = i;
    const freshStart = !isEdit && !isRetry && (parseInt(S.startFrom, 10) || 1) <= 1;
    if (!isEdit) jobs.forEach((j, k) => { j.attach = () => attachmentsFor(j.num - 1, k === startIdx); });
    const followUp = !isEdit && !isRetry && S.followUp && editText;

    // Папка запуска: «продолжить» кладёт файлы в ту же папку, новый запуск с №1 — в новую
    runCtx.savedKeys = new Set(); runCtx.pending = []; runCtx.results = []; runCtx.mode = mode;
    if (isEdit) runCtx.folder = `edit_${stamp()}`;
    else {
      if (freshStart || !S.runFolder) S.runFolder = `${stamp()}${S.csvName ? '_' + slug(S.csvName) : ''}`;
      runCtx.folder = S.runFolder;
    }
    if (freshStart) { S.resultsMap = {}; S.savedKeys = []; }
    // Пауза/стоп/«Продолжить» в той же папке: что уже скачано, второй раз не качаем
    if (!isEdit && !freshStart) runCtx.savedKeys = new Set(S.savedKeys || []);
    const failedSet = new Set(freshStart ? [] : (S.failed || []));
    if (!isEdit) { S.failed = [...failedSet]; save(); }

    let okCount = 0, imgCount = 0, refusedCount = 0, errCount = 0, streak = 0;
    const t0 = Date.now();
    if (isEdit) {
      log(`Доработка: ${jobs.length} картинок, суффикс «${S.editSuffix || ''}»`, 'info');
    } else {
      if (S.refs && S.refs.length === jobs.length && S.refs.some(Boolean) && !files.refs.size) log('В CSV есть колонка референсов, но папка с ними не выбрана — промпты пойдут без референсов', 'warn');
      if (files.common.length) log(`Общие файлы: ${files.common.map((f) => f.name).join(', ')} — ${S.commonMode === 'each' ? 'к каждому промпту' : 'к первому промпту'}`, 'info');
      // Сразу видно, какие промпты получат файл из библиотеки
      const own = jobs.filter((j) => splitLibRefs(j.text).refs.length).length;
      if (libNameClean()) log(`Файл из библиотеки: @${libNameClean()} — к ${own ? 'остальным' : 'каждому'} промпт${own ? 'ам' : 'у'}`, 'info');
      if (own) log(`Свои файлы «@имя» указаны в ${own} ${plural(own, 'промпте', 'промптах', 'промптах')} — для них общий файл не добавляется`, 'info');
      if (!libNameClean() && !own) log('Файлы из библиотеки не используются', 'info');
      if (followUp) log('После каждой картинки будет отправляться доработка', 'info');
      log(isRetry ? `Повторяю пропущенные: ${jobs.map((j) => j.label).join(', ')}` : `Старт: ${jobs.length} промптов, начиная с №${i + 1}`, 'info');
    }
    if (S.download) log(`Папка: Загрузки/${downloadDir('') || '(корень)'}`, 'info');

    try {
      for (; i < jobs.length; i++) {
        if (run.paused) { setStatus('paused', 'Пауза'); await waitPause(); }
        checkStop();
        const job = jobs[i];
        setProgress(i, jobs.length);
        setCurrent(i + 1, job.display);

        const jt0 = Date.now();
        const res = await runJob(job);
        const sec = Math.round((Date.now() - jt0) / 1000);

        if (!res.ok) {
          streak++;
          // Одна неудача (отказ, сбой) не должна останавливать очередь на 50 промптов:
          // откладываем и идём дальше. Три подряд — похоже на системную проблему, тогда пауза.
          if (S.skipFailed && streak < 3) {
            if (res.refused) refusedCount++; else errCount++;
            recordResult({ num: job.num, status: res.refused ? 'отказ' : 'ошибка', prompt: job.display, sec, reason: res.refused || res.reason || '' });
            failedSet.add(job.num);
            log(`${job.label}: ${res.refused ? 'отказ ChatGPT' : 'не получился'} — пропускаю, вернусь к нему кнопкой «Повторить пропущенные»`, 'warn');
          } else {
            log(`${job.label} не получился${streak >= 3 ? ' (третий подряд)' : ''}. «Продолжить» повторит его`, 'warn');
            notify('Очередь на паузе', `${job.label} не получился — нужна проверка`);
            run.paused = true; updateButtons();
            setStatus('error', 'Ошибка — очередь на паузе');
            await waitPause();
            streak = 0;
            i--; // повторить тот же
            continue;
          }
        } else {
          streak = 0;
          imgCount += res.imgs;
          failedSet.delete(job.num);
          let status = res.dlFailed ? 'не скачано' : 'ок';
          okCount++;

          // Доработка только что созданной картинки в том же чате — в подпапку edited
          if (followUp) {
            await sleepChecked(800, (s) => setStatus('wait', `Доработка через ${s} с`));
            setCurrent(i + 1, `доработка: ${job.display}`);
            const fx = await runJob({
              num: job.num, label: `${job.label} ✎`, text: editText, attach: null,
              name: job.name + (S.editSuffix || ''), sub: 'edited',
            });
            if (fx.ok) { imgCount += fx.imgs; if (fx.dlFailed) status = 'не скачано'; }
            else { log(`${job.label}: доработка не получилась — идём дальше`, 'warn'); status += ', доработка не вышла'; }
            if (fx.ok && fx.names.length) res.names = res.names.concat(fx.names.map((n) => `edited/${n}`));
          }
          recordResult({ num: job.num, status, files: (res.names || []).join(', '), prompt: job.display, sec });
        }

        S.failed = [...failedSet];
        if (!isEdit && !isRetry) S.startFrom = i + 2;
        save(); syncStartField();
        setProgress(i + 1, jobs.length);

        if (i < jobs.length - 1) {
          const lo = Math.max(0, +S.delayMin), hi = Math.max(lo, +S.delayMax);
          const d = Math.round(lo + Math.random() * (hi - lo));
          if (d > 0) await sleepChecked(d * 1000, (s) => setStatus('wait', `Следующий через ${s} с`));
        }
      }

      // Конец очереди: добираем то, что не скачалось, и подводим итог
      setStatus('gen', 'Проверяю скачивание');
      const dlLeft = await retryPending();
      const took = fmtTime(Math.round((Date.now() - t0) / 1000));
      const parts = [`✓ ${okCount}`];
      if (refusedCount) parts.push(`отказов ${refusedCount}`);
      if (errCount) parts.push(`ошибок ${errCount}`);
      if (dlLeft) parts.push(`НЕ СКАЧАНО ${dlLeft}`);
      log(`Готово за ${took}: ${parts.join(' · ')}${S.waitImage ? ` · картинок ${imgCount}` : ''}`, dlLeft || refusedCount || errCount ? 'warn' : 'ok');
      if (failedSet.size) log(`Пропущено: ${[...failedSet].sort((a, b) => a - b).map((n) => '#' + n).join(', ')} — нажмите «Повторить пропущенные»`, 'warn');
      if (dlLeft) log('Картинки, которые не скачались, остались в чате ChatGPT — скачайте их вручную', 'warn');
      setStatus('done', failedSet.size ? `Готово, пропущено: ${failedSet.size}` : isEdit ? 'Доработка завершена' : 'Все промпты выполнены');
      notify(failedSet.size ? 'Готово, есть пропущенные' : 'Готово', `${parts.join(' · ')} за ${took}`);
      setCurrent(null);
      if (!isEdit && !isRetry) S.startFrom = 1;
    } catch (e) {
      if (e.message === 'STOP') {
        log(isEdit || isRetry ? 'Остановлено' : `Остановлено. Продолжить можно с №${S.startFrom}`, 'warn');
        setStatus('idle', 'Остановлено');
      } else {
        log(`Ошибка: ${e.message}`, 'err'); setStatus('error', 'Ошибка');
        notify('Очередь остановлена', e.message);
      }
    }
    S.failed = [...failedSet];
    save(); syncStartField();
    // Убираем за собой: недописанный промпт, «@файл» и превью вложений в поле ввода
    await cleanupComposer();
    run.active = false; run.paused = false;
    stopTicker();
    updateButtons();
  }

  // ─── Иконки ───
  const I = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    at: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/></svg>',
    wand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m4 20 11-11M14 4l1 2 2 1-2 1-1 2-1-2-2-1 2-1zM19 11l.7 1.3L21 13l-1.3.7L19 15l-.7-1.3L17 13l1.3-.7z"/></svg>',
    doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>',
    img: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/></svg>',
    upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V4M7 9l5-5 5 5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
    min: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 12h12"/></svg>',
    chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
    bolt: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12L13 2z"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  };

  // ─── Панель ───
  const ui = {};
  const host = document.createElement('div');
  host.id = 'cgpt-batch-host';
  const shadow = host.attachShadow({ mode: 'open' });
  shadowRef = shadow;
  // Периодически проверяем, что расширение не перезагрузили под нами
  const aliveTimer = setInterval(() => { if (!extAlive()) { clearInterval(aliveTimer); retire(); } }, 3000);

  shadow.innerHTML = `
  <style>
    :host { all: initial; }
    .root {
      --bg: #ffffff; --bg2: #f7f7f8; --bg3: #efeff1; --fg: #0d0d0d; --muted: #6e6e80; --border: #e3e3e8;
      --accent: #10a37f; --accent-h: #0d8f6f; --accent-soft: rgba(16,163,127,.12);
      --warn: #d97706; --warn-soft: rgba(217,119,6,.12); --danger: #e5484d; --danger-soft: rgba(229,72,77,.12);
      --shadow: 0 12px 40px rgba(0,0,0,.14), 0 2px 8px rgba(0,0,0,.06);
      font: 13px/1.4 ui-sans-serif, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      color: var(--fg); -webkit-font-smoothing: antialiased;
    }
    .root.dark {
      --bg: #212121; --bg2: #2a2a2a; --bg3: #333; --fg: #ececec; --muted: #9b9ba5; --border: #3a3a3d;
      --accent-soft: rgba(16,163,127,.18); --shadow: 0 16px 48px rgba(0,0,0,.5), 0 2px 8px rgba(0,0,0,.3);
    }
    * { box-sizing: border-box; }
    svg { width: 16px; height: 16px; flex: none; display: block; }
    button { font: inherit; color: inherit; cursor: pointer; border: 0; background: none; }
    button:disabled { opacity: .45; cursor: default; }
    input, textarea { font: inherit; color: var(--fg); }

    .panel { position: fixed; right: 20px; bottom: 20px; width: 384px; max-height: calc(100vh - 40px);
      display: flex; flex-direction: column; background: var(--bg); border: 1px solid var(--border);
      border-radius: 18px; box-shadow: var(--shadow); z-index: 2147483647; overflow: hidden; }

    .hdr { display: flex; align-items: center; gap: 10px; padding: 12px 12px 12px 14px; cursor: grab; user-select: none; }
    .hdr:active { cursor: grabbing; }
    .logo { width: 28px; height: 28px; border-radius: 9px; background: var(--accent); color: #fff; display: grid; place-items: center; }
    .title { font-weight: 650; font-size: 14px; flex: 1; letter-spacing: -.01em; }
    .ver { font-weight: 400; font-size: 11px; color: var(--muted); margin-left: 4px; }
    .pill { display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px; border-radius: 99px;
      font-size: 11.5px; font-weight: 600; background: var(--bg3); color: var(--muted); white-space: nowrap; }
    .pill i { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
    .pill.gen, .pill.wait { background: var(--accent-soft); color: var(--accent); }
    .pill.gen i { animation: pulse 1.2s infinite; }
    .pill.paused { background: var(--warn-soft); color: var(--warn); }
    .pill.error { background: var(--danger-soft); color: var(--danger); }
    .pill.done { background: var(--accent-soft); color: var(--accent); }
    @keyframes pulse { 50% { opacity: .3; } }
    .icon-btn { width: 30px; height: 30px; border-radius: 8px; display: grid; place-items: center; color: var(--muted); }
    .icon-btn:hover { background: var(--bg3); color: var(--fg); }

    .body { overflow: auto; padding: 0 14px 14px; display: flex; flex-direction: column; gap: 12px; }

    .card { background: var(--bg2); border: 1px solid var(--border); border-radius: 14px; }
    .sec-title { font-size: 11.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }

    /* Промпты */
    .prompts { padding: 10px; display: flex; flex-direction: column; gap: 8px; }
    .prompts-top { display: flex; align-items: center; justify-content: space-between; }
    .count { font-size: 12px; color: var(--muted); }
    .count b { color: var(--fg); }
    textarea { width: 100%; height: 132px; resize: vertical; min-height: 80px; padding: 10px 11px;
      background: var(--bg); border: 1px solid var(--border); border-radius: 10px; outline: none;
      font-size: 13px; line-height: 1.5; transition: border-color .15s, box-shadow .15s; }
    textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
    textarea.drag { border-color: var(--accent); border-style: dashed; background: var(--accent-soft); }
    .tools { display: flex; align-items: center; gap: 6px; }
    .seg { display: inline-flex; background: var(--bg3); border-radius: 8px; padding: 2px; flex: 1; }
    .seg button { flex: 1; padding: 5px 6px; border-radius: 6px; font-size: 12px; color: var(--muted); white-space: nowrap; }
    .seg button.on { background: var(--bg); color: var(--fg); font-weight: 600; box-shadow: 0 1px 2px rgba(0,0,0,.12); }
    .ghost { display: inline-flex; align-items: center; gap: 5px; padding: 6px 9px; border-radius: 8px;
      font-size: 12px; font-weight: 550; color: var(--fg); border: 1px solid var(--border); background: var(--bg); }
    .ghost:hover:not(:disabled) { background: var(--bg3); }
    .ghost svg { width: 14px; height: 14px; }
    .ghost.sq { padding: 6px; }

    /* Настройки */
    details { border-radius: 14px; }
    summary { list-style: none; display: flex; align-items: center; gap: 8px; padding: 10px 12px; cursor: pointer;
      font-weight: 600; user-select: none; }
    summary::-webkit-details-marker { display: none; }
    summary .chev { margin-left: auto; color: var(--muted); transition: transform .2s; }
    details[open] summary .chev { transform: rotate(90deg); }
    summary .hint { font-weight: 400; color: var(--muted); font-size: 12px; }
    .settings { padding: 2px 12px 12px; display: flex; flex-direction: column; gap: 12px; }
    .field label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 5px; }
    .inp { width: 100%; padding: 7px 10px; background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
      outline: none; font-size: 13px; }
    .inp:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .range { display: flex; align-items: center; gap: 6px; }
    .range .inp { text-align: center; }
    .range span { color: var(--muted); }
    .grid3 { display: grid; grid-template-columns: 1.6fr 1fr 1fr; gap: 10px; }
    .num { -moz-appearance: textfield; text-align: center; }
    .num::-webkit-inner-spin-button, .num::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
    .sw-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; cursor: pointer; }
    .sw-row .t { font-size: 13px; }
    .sw-row .d { font-size: 11.5px; color: var(--muted); }
    .sw { position: relative; width: 36px; height: 20px; flex: none; }
    .sw input { opacity: 0; width: 0; height: 0; position: absolute; }
    .sw span { position: absolute; inset: 0; background: var(--border); border-radius: 99px; transition: .2s; }
    .sw span::after { content: ""; position: absolute; left: 2px; top: 2px; width: 16px; height: 16px; border-radius: 50%;
      background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.25); transition: .2s; }
    .sw input:checked + span { background: var(--accent); }
    .sw input:checked + span::after { transform: translateX(16px); }
    .sw input:disabled + span { opacity: .5; }
    .divider { height: 1px; background: var(--border); }

    /* Запуск */
    .runbox { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
    .prog-top { display: flex; align-items: baseline; justify-content: space-between; }
    .prog-num { font-size: 22px; font-weight: 700; letter-spacing: -.02em; }
    .prog-num small { font-size: 13px; color: var(--muted); font-weight: 500; }
    .status { font-size: 12px; color: var(--muted); text-align: right; }
    .bar { height: 6px; background: var(--bg3); border-radius: 99px; overflow: hidden; }
    .bar i { display: block; height: 100%; width: 0; background: var(--accent); border-radius: 99px; transition: width .4s ease; }
    .current { font-size: 12.5px; color: var(--fg); background: var(--bg); border: 1px solid var(--border);
      border-radius: 9px; padding: 7px 9px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .current b { color: var(--accent); }
    .start-from { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); }
    .start-from .inp { width: 64px; padding: 5px 8px; text-align: center; }
    .actions { display: flex; gap: 8px; }
    .btn { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 7px; height: 40px;
      border-radius: 11px; font-weight: 600; font-size: 13.5px; transition: background .15s, transform .05s; }
    .btn:active:not(:disabled) { transform: scale(.98); }
    .btn.primary { background: var(--accent); color: #fff; }
    .btn.primary:hover:not(:disabled) { background: var(--accent-h); }
    .btn.secondary { background: var(--bg3); color: var(--fg); }
    .btn.secondary:hover:not(:disabled) { background: var(--border); }
    .btn.danger { background: var(--danger-soft); color: var(--danger); flex: 0 0 auto; padding: 0 14px; }
    .flash { font-size: 12px; color: var(--danger); min-height: 0; }

    /* Журнал */
    .log { max-height: 150px; overflow: auto; padding: 0 12px 10px; display: flex; flex-direction: column; gap: 3px;
      font-size: 12px; }
    .log .e { display: flex; gap: 8px; line-height: 1.45; }
    .log .tm { color: var(--muted); font-variant-numeric: tabular-nums; flex: none; }
    .log .ok .tx { color: var(--accent); }
    .log .err .tx { color: var(--danger); }
    .log .warn .tx { color: var(--warn); }
    .log .empty { color: var(--muted); }
    .log .dbg .tx { color: var(--muted); font-size: 11.5px; }
    .files { padding: 10px; display: flex; flex-direction: column; gap: 9px; }
    .frow { display: flex; align-items: center; gap: 10px; }
    .fic { width: 30px; height: 30px; border-radius: 8px; background: var(--bg3); color: var(--muted); display: grid; place-items: center; flex: none; }
    .fic.on { background: var(--accent-soft); color: var(--accent); }
    .ftxt { flex: 1; min-width: 0; }
    .ftxt .t { font-size: 13px; font-weight: 550; }
    .ftxt .d { font-size: 11.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ftxt .d.ok { color: var(--accent); }
    .ftxt .d.warn { color: var(--warn); }
    .seg.small button { font-size: 11.5px; padding: 4px 6px; }
    .seg.dim { opacity: .45; pointer-events: none; }
    textarea.small-ta { height: 92px; min-height: 60px; font-size: 12px; line-height: 1.45; padding: 8px 10px; }
    .logtools { display: flex; align-items: center; gap: 6px; padding: 0 12px 8px; }
    .logtools .ghost { white-space: nowrap; padding: 6px 8px; }
    .mini-sw { margin-left: auto; display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--muted); cursor: pointer; }
    .mini-sw input { accent-color: var(--accent); margin: 0; }
    .clear-log { margin-left: auto; font-size: 11.5px; color: var(--muted); padding: 2px 6px; border-radius: 6px; font-weight: 500; }
    .clear-log:hover { background: var(--bg3); color: var(--fg); }

    .fab { position: fixed; right: 20px; bottom: 96px; width: 46px; height: 46px; border-radius: 14px;
      background: var(--accent); color: #fff; display: grid; place-items: center; z-index: 2147483647;
      box-shadow: 0 6px 20px rgba(16,163,127,.4); transition: transform .15s; }
    .fab:hover { transform: translateY(-2px); }
    .fab svg { width: 20px; height: 20px; }
    .fab .badge { position: absolute; top: -5px; right: -5px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 99px;
      background: var(--fg); color: var(--bg); font-size: 10.5px; font-weight: 700; display: none; place-items: center; }
    .fab.running .badge { display: grid; }
    .hidden { display: none !important; }
  </style>

  <div class="root">
    <button class="fab hidden" title="Batch Prompter">${I.bolt}<span class="badge"></span></button>

    <div class="panel">
      <div class="hdr">
        <div class="logo">${I.bolt}</div>
        <div class="title">Batch Prompter <span class="ver">v${VERSION}</span></div>
        <span class="pill" data-pill><i></i><span>Готов</span></span>
        <button class="icon-btn" data-min title="Свернуть">${I.min}</button>
      </div>

      <div class="body">
        <!-- 1. Промпты -->
        <div class="card prompts">
          <div class="prompts-top">
            <span class="sec-title">Промпты</span>
            <span class="count" data-count></span>
          </div>
          <textarea data-k="text" spellcheck="false"
            placeholder="Вставьте промпты — по одному на строку&#10;или перетащите сюда файл .txt / .csv"></textarea>
          <div class="tools">
            <div class="seg" data-seg title="Как разделены промпты">
              <button data-v="line">По строкам</button>
              <button data-v="blank">Пустая строка</button>
              <button data-v="dash">---</button>
            </div>
            <button class="ghost" data-upload title="Загрузить .txt или .csv">${I.upload}Файл</button>
            <button class="ghost sq" data-clear title="Очистить">${I.trash}</button>
            <input type="file" accept=".txt,.csv,.tsv,text/plain,text/csv" data-file hidden>
          </div>
        </div>

        <!-- 1б. Файлы -->
        <div class="card files">
          <div class="prompts-top">
            <span class="sec-title">Прикреплять файлы <span style="text-transform:none;font-weight:400;letter-spacing:0">· необязательно</span></span>
            <button class="clear-log" data-clearfiles>Сбросить</button>
          </div>
          <div class="frow">
            <div class="fic">${I.doc}</div>
            <div class="ftxt">
              <div class="t">Общие файлы</div>
              <div class="d" data-commoninfo>Файл, на который ссылаются промпты</div>
            </div>
            <button class="ghost" data-pickcommon>Выбрать</button>
          </div>
          <div class="seg small" data-cmode title="К какому промпту прикреплять общие файлы">
            <button data-v="first">к первому промпту</button>
            <button data-v="each">к каждому</button>
          </div>
          <div class="divider"></div>
          <div class="frow">
            <div class="fic">${I.img}</div>
            <div class="ftxt">
              <div class="t">Референсы к промптам</div>
              <div class="d" data-refinfo>По колонке «реф_файл» из CSV или по номеру в имени</div>
            </div>
            <button class="ghost" data-pickword title="Достать картинки из таблицы Word-ТЗ">Word</button>
            <button class="ghost" data-pickrefs title="Папка с картинками-референсами">Папка</button>
          </div>
          <div class="divider"></div>
          <div class="frow">
            <div class="fic">${I.at}</div>
            <div class="ftxt">
              <div class="t">Файл из библиотеки ChatGPT</div>
              <div class="d" title="Свой файл для отдельного промпта: начните промпт с @имя, например «@IMG_4811 /wideshot». Он заменяет общий файл">Ко всем промптам, без загрузки. Пусто — не нужен</div>
            </div>
          </div>
          <div class="frow">
            <input class="inp" data-k="libName" placeholder="имя файла, например IMG_4811" spellcheck="false">
            <button class="ghost" data-testlib title="Вставить @имя в поле ChatGPT без отправки">Проверить</button>
          </div>
          <input type="file" multiple hidden data-commonfile>
          <input type="file" multiple webkitdirectory hidden data-refdir>
          <input type="file" accept=".docx" hidden data-worddoc>
        </div>

        <!-- 1в. Доработка -->
        <details class="card" data-editbox>
          <summary>${I.wand}Доработка <span class="hint" data-edithint></span><span class="chev">${I.chev}</span></summary>
          <div class="settings">
            <div class="field">
              <label>Универсальный промпт доработки</label>
              <textarea class="inp small-ta" data-k="editPrompt" spellcheck="false"></textarea>
            </div>
            <div class="field">
              <label>Суффикс к имени файла</label>
              <input class="inp" data-k="editSuffix" placeholder="_black">
            </div>
            <label class="sw-row">
              <div><div class="t">После каждой генерации</div><div class="d">Сразу отправлять доработку в тот же чат и скачать обе версии</div></div>
              <span class="sw"><input type="checkbox" data-k="followUp"><span></span></span>
            </label>
            <div class="divider"></div>
            <div class="frow">
              <div class="fic">${I.img}</div>
              <div class="ftxt">
                <div class="t">Готовые картинки</div>
                <div class="d" data-editinfo>Выберите папку — каждая картинка уйдёт с этим промптом</div>
              </div>
              <button class="ghost" data-pickedit>Папка</button>
            </div>
            <button class="btn secondary" data-runedit disabled>${I.wand}<span>Доработать картинки</span></button>
            <input type="file" multiple webkitdirectory hidden data-editdir>
          </div>
        </details>

        <!-- 2. Настройки -->
        <details class="card" data-settings>
          <summary>${I.gear}Настройки <span class="hint" data-summary></span><span class="chev">${I.chev}</span></summary>
          <div class="settings">
            <div class="field">
              <label>Префикс перед каждым промптом</label>
              <input class="inp" data-k="prefix" placeholder="например: Сгенерируй изображение:">
            </div>
            <div class="grid3">
              <div class="field">
                <label>Пауза, сек</label>
                <div class="range">
                  <input class="inp num" type="number" min="0" data-k="delayMin"><span>–</span>
                  <input class="inp num" type="number" min="0" data-k="delayMax">
                </div>
              </div>
              <div class="field"><label>Повторы</label><input class="inp num" type="number" min="0" max="5" data-k="retries" title="Сколько раз повторить промпт, если картинка не получилась"></div>
              <div class="field"><label>Таймаут, мин</label><input class="inp num" type="number" min="1" data-k="timeoutMin" title="Максимальное время ожидания одного ответа"></div>
            </div>
            <div class="divider"></div>
            <label class="sw-row">
              <div><div class="t">Ждать картинку</div><div class="d">Считать ответ готовым, только когда картинка догрузилась</div></div>
              <span class="sw"><input type="checkbox" data-k="waitImage"><span></span></span>
            </label>
            <label class="sw-row">
              <div><div class="t">Уведомления</div><div class="d">Сообщать, когда очередь закончилась, встала на паузу или ждёт лимит</div></div>
              <span class="sw"><input type="checkbox" data-k="notify"><span></span></span>
            </label>
            <label class="sw-row">
              <div><div class="t">Пропускать неудачные</div><div class="d">Отказ ChatGPT или сбой не останавливает очередь: промпт откладывается, потом его можно повторить кнопкой</div></div>
              <span class="sw"><input type="checkbox" data-k="skipFailed"><span></span></span>
            </label>
            <label class="sw-row">
              <div><div class="t">Скачивать картинки</div><div class="d">В «Загрузки» → папка ниже</div></div>
              <span class="sw"><input type="checkbox" data-k="download"><span></span></span>
            </label>
            <div class="field" data-folder-field>
              <input class="inp" data-k="folder" placeholder="ChatGPT_Images">
            </div>
            <label class="sw-row" data-folder-field>
              <div><div class="t">Отдельная папка на запуск</div><div class="d">Папка с датой и именем CSV; доработанные — в подпапке edited</div></div>
              <span class="sw"><input type="checkbox" data-k="perRunFolder"><span></span></span>
            </label>
            <label class="sw-row" data-folder-field>
              <div><div class="t">Только итог генерации</div><div class="d">Не скачивать черновики и размытые заготовки — одна итоговая картинка на промпт</div></div>
              <span class="sw"><input type="checkbox" data-k="onlyFinal"><span></span></span>
            </label>
          </div>
        </details>

        <!-- 3. Запуск -->
        <div class="card runbox">
          <div class="prog-top">
            <div class="prog-num" data-prognum>0 <small>/ 0</small></div>
            <div class="status" data-status>Готов к запуску</div>
          </div>
          <div class="bar"><i></i></div>
          <div class="current hidden" data-current></div>
          <div class="start-from">Начать с №<input class="inp num" type="number" min="1" data-k="startFrom"></div>
          <div class="actions">
            <button class="btn primary" data-start>${I.play}<span>Запустить</span></button>
            <button class="btn secondary hidden" data-pause>${I.pause}<span>Пауза</span></button>
            <button class="btn danger hidden" data-stop title="Остановить">${I.stop}</button>
            <button class="btn secondary hidden" data-retry title="Запустить заново только те промпты, что не вышли">${I.play}<span>Повторить пропущенные</span></button>
          </div>
          <div class="flash" data-flash></div>
        </div>

        <!-- 4. Журнал -->
        <details class="card" data-logbox>
          <summary>Журнал <button class="clear-log" data-clearlog>Очистить</button><span class="chev" style="margin-left:0">${I.chev}</span></summary>
          <div class="logtools">
            <button class="ghost" data-test title="Вставить тестовый текст в поле ChatGPT без отправки">Проверить поле</button>
            <button class="ghost" data-copy title="Скопировать подробный отчёт для отладки">Копировать отчёт</button>
            <label class="mini-sw" title="Показывать технические подробности в журнале"><input type="checkbox" data-k="debug">подробно</label>
          </div>
          <div class="log" data-log><div class="empty">Здесь появится ход работы</div></div>
        </details>
      </div>
    </div>
  </div>`;

  const q = (s) => shadow.querySelector(s);
  Object.assign(ui, {
    root: q('.root'), panel: q('.panel'), hdr: q('.hdr'), fab: q('.fab'), badge: q('.fab .badge'),
    pill: q('[data-pill]'), status: q('[data-status]'), prognum: q('[data-prognum]'), bar: q('.bar i'),
    current: q('[data-current]'), start: q('[data-start]'), pause: q('[data-pause]'), stop: q('[data-stop]'), retry: q('[data-retry]'),
    flash: q('[data-flash]'), log: q('[data-log]'), count: q('[data-count]'), seg: q('[data-seg]'),
    file: q('[data-file]'), upload: q('[data-upload]'), clear: q('[data-clear]'), textarea: q('textarea'),
    settings: q('[data-settings]'), summary: q('[data-summary]'), logbox: q('[data-logbox]'),
    folderFields: [...shadow.querySelectorAll('[data-folder-field]')],
    fields: [...shadow.querySelectorAll('[data-k]')],
    commonInfo: q('[data-commoninfo]'), refInfo: q('[data-refinfo]'), cmode: q('[data-cmode]'),
    pickCommon: q('[data-pickcommon]'), pickRefs: q('[data-pickrefs]'), clearFiles: q('[data-clearfiles]'),
    commonFile: q('[data-commonfile]'), refDir: q('[data-refdir]'),
    pickWord: q('[data-pickword]'), wordDoc: q('[data-worddoc]'), testLib: q('[data-testlib]'),
    editBox: q('[data-editbox]'), editHint: q('[data-edithint]'), editInfo: q('[data-editinfo]'),
    pickEdit: q('[data-pickedit]'), runEdit: q('[data-runedit]'), editDir: q('[data-editdir]'),
  });

  function refreshEdit() {
    const n = files.edit.length;
    ui.editInfo.textContent = n ? `Выбрано ${n} ${plural(n, 'картинка', 'картинки', 'картинок')}` : 'Выберите папку — каждая картинка уйдёт с этим промптом';
    ui.editInfo.className = n ? 'd ok' : 'd';
    shadow.querySelectorAll('[data-editbox] .fic')[0].classList.toggle('on', n > 0);
    ui.runEdit.disabled = run.active || !n;
    ui.runEdit.querySelector('span').textContent = n ? `Доработать ${n} ${plural(n, 'картинку', 'картинки', 'картинок')}` : 'Доработать картинки';
    const bits = [];
    if (S.followUp) bits.push('после каждой');
    if (n) bits.push(`${n} в очереди`);
    ui.editHint.textContent = bits.length ? '· ' + bits.join(' · ') : '';
  }

  function refreshFiles() {
    const [cIc, rIc, lIc] = shadow.querySelectorAll('.files .fic');
    lIc.classList.toggle('on', !!libNameClean());
    // общие
    if (files.common.length) {
      ui.commonInfo.textContent = files.common.map((f) => f.name).join(', ');
      ui.commonInfo.className = 'd ok'; cIc.classList.add('on');
    } else {
      ui.commonInfo.textContent = 'Файл, на который ссылаются промпты';
      ui.commonInfo.className = 'd'; cIc.classList.remove('on');
    }
    [...ui.cmode.children].forEach((b) => b.classList.toggle('on', b.dataset.v === S.commonMode));
    ui.cmode.classList.toggle('dim', !files.common.length);
    // референсы
    const n = parsePrompts(S.text, S.sep).length;
    const wanted = (S.refs && S.refs.length === n) ? S.refs.filter(Boolean).length : 0;
    if (files.refSource === 'word') {
      const byHow = {};
      let found = 0;
      for (let i = 0; i < n; i++) { const w = wordRowFor(i); if (w) { found++; byHow[w.how] = (byHow[w.how] || 0) + 1; } }
      const orderOnly = byHow['по порядку'] === found && found > 0;
      ui.refInfo.textContent = `Word: ${files.word.length} картинок · для ${found} из ${n} промптов` + (orderOnly ? ' (по порядку)' : '');
      ui.refInfo.className = found < n || orderOnly ? 'd warn' : 'd ok'; rIc.classList.add('on');
      ui.refInfo.title = `${files.wordName}\n` + Object.entries(byHow).map(([h, c]) => `${h}: ${c}`).join('\n');
    } else if (!files.refs.size) {
      ui.refInfo.textContent = wanted ? `В CSV указано ${wanted} — выберите папку с ними` : 'По колонке «реф_файл» из CSV или по номеру в имени';
      ui.refInfo.className = wanted ? 'd warn' : 'd'; rIc.classList.remove('on');
      ui.refInfo.title = '';
    } else {
      const found = [], missing = [];
      for (let i = 0; i < n; i++) {
        if (refFor(i)) found.push(i + 1);
        else if (wanted && S.refs[i]) missing.push(S.refs[i]);
      }
      ui.refInfo.textContent = `Найдено для ${found.length} из ${n} промптов` + (missing.length ? ` · нет: ${missing.length}` : '');
      ui.refInfo.className = missing.length ? 'd warn' : 'd ok'; rIc.classList.add('on');
      ui.refInfo.title = missing.length ? 'Не найдены: ' + missing.join(', ') : `Файлов в папке: ${files.refs.size}`;
    }
  }

  // Не даём ChatGPT перехватывать клавиши и вставку внутри панели
  ['keydown', 'keyup', 'keypress', 'paste', 'copy', 'cut'].forEach((ev) =>
    host.addEventListener(ev, (e) => e.stopPropagation()));

  // Тема — как у ChatGPT
  const syncTheme = () => {
    const html = document.documentElement;
    const dark = html.classList.contains('dark') ||
      (!html.classList.contains('light') && matchMedia('(prefers-color-scheme: dark)').matches);
    ui.root.classList.toggle('dark', dark);
  };
  new MutationObserver(syncTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncTheme);

  // Сохранение с задержкой: при наборе текста не пишем в хранилище на каждую клавишу
  let saveTimer = 0;
  const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(save, 400); };

  function readForm() {
    for (const f of ui.fields) {
      const k = f.dataset.k;
      if (f.type === 'checkbox') S[k] = f.checked;
      else if (f.type === 'number') S[k] = f.value === '' ? DEFAULTS[k] : Number(f.value);
      else S[k] = f.value;
    }
    saveSoon();
    refreshInfo();
  }
  function fillForm() {
    for (const f of ui.fields) {
      const k = f.dataset.k;
      if (f.type === 'checkbox') f.checked = !!S[k]; else f.value = S[k];
    }
    ui.settings.open = !!S.settingsOpen;
    ui.logbox.open = !!S.logOpen;
    ui.editBox.open = !!S.editOpen;
    refreshInfo();
    setOpen(S.open);
  }
  function refreshInfo() {
    refreshFiles();
    refreshEdit();
    const n = parsePrompts(S.text, S.sep).length;
    ui.count.innerHTML = n ? `<b>${n}</b> ${plural(n, 'промпт', 'промпта', 'промптов')}` : 'пусто';
    [...ui.seg.children].forEach((b) => b.classList.toggle('on', b.dataset.v === S.sep));
    ui.folderFields.forEach((f) => f.classList.toggle('hidden', !S.download));
    const bits = [`${S.delayMin}–${S.delayMax} с`];
    if (S.download) bits.push('скачивание');
    if (S.prefix.trim()) bits.push('префикс');
    ui.summary.textContent = '· ' + bits.join(' · ');
    if (!run.active) setProgress(Math.max(0, Math.min(n, (S.startFrom || 1) - 1)), n);
  }
  const plural = (n, a, b, c) => {
    const m10 = n % 10, m100 = n % 100;
    return m10 === 1 && m100 !== 11 ? a : (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? b : c);
  };
  function syncStartField() {
    const f = ui.fields.find((x) => x.dataset.k === 'startFrom');
    if (f) f.value = S.startFrom;
  }
  function setProgress(done, total) {
    ui.bar.style.width = `${total ? (done / total) * 100 : 0}%`;
    ui.prognum.innerHTML = `${done} <small>/ ${total}</small>`;
    ui.badge.textContent = `${done}/${total}`;
  }
  function setCurrent(num, text) {
    if (!num) { ui.current.classList.add('hidden'); return; }
    ui.current.classList.remove('hidden');
    ui.current.innerHTML = '';
    const b = document.createElement('b'); b.textContent = `#${num} `;
    ui.current.append(b, document.createTextNode(text));
  }
  const PILL = { idle: 'Готов', gen: 'Работает', wait: 'Работает', paused: 'Пауза', error: 'Ошибка', done: 'Готово' };
  function setStatus(kind, text) {
    ui.pill.className = `pill ${kind}`;
    ui.pill.querySelector('span').textContent = PILL[kind] || '';
    ui.status.textContent = text;
  }
  function flash(msg) {
    ui.flash.textContent = msg;
    clearTimeout(flash.t);
    flash.t = setTimeout(() => { ui.flash.textContent = ''; }, 4000);
  }
  function updateButtons() {
    ui.start.classList.toggle('hidden', run.active);
    ui.pause.classList.toggle('hidden', !run.active);
    ui.stop.classList.toggle('hidden', !run.active);
    const nFailed = (S.failed || []).length;
    ui.retry.classList.toggle('hidden', run.active || !nFailed);
    ui.retry.querySelector('span').textContent = `Повторить пропущенные (${nFailed})`;
    ui.pause.innerHTML = run.paused ? `${I.play}<span>Продолжить</span>` : `${I.pause}<span>Пауза</span>`;
    ui.fields.forEach((f) => { f.disabled = run.active; });
    [...ui.seg.children, ui.upload, ui.clear, ui.pickCommon, ui.pickRefs, ui.pickWord, ui.clearFiles, ...ui.cmode.children, ui.pickEdit, ui.testLib]
      .forEach((b) => { b.disabled = run.active; });
    refreshEdit();
    ui.fab.classList.toggle('running', run.active);
    if (!run.active && !['done', 'error'].includes(ui.pill.classList[1])) setStatus('idle', 'Готов к запуску');
  }
  // Полный отчёт (включая технические детали) — для «Копировать отчёт»
  const report = [];
  const now = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  function pushReport(line) {
    report.push(line);
    if (report.length > 1500) report.splice(0, report.length - 1500);
  }
  function log(msg, type = 'info') {
    pushReport(`[${now()}] ${type.toUpperCase()} ${msg}`);
    addLogLine(msg, type);
  }
  // Технические подробности: всегда в отчёт, в журнал — если включён «Подробный журнал»
  function dbg(msg, data) {
    pushReport(`[${now()}] DBG ${msg}${data ? '\n' + JSON.stringify(data, null, 2) : ''}`);
    if (S.debug) addLogLine(msg + (data ? ` · поле: ${data.input}; отправить: ${data.send}` : ''), 'dbg');
  }
  function addLogLine(msg, type) {
    const empty = ui.log.querySelector('.empty');
    if (empty) empty.remove();
    const e = document.createElement('div');
    e.className = `e ${type}`;
    const tm = document.createElement('span'); tm.className = 'tm';
    tm.textContent = now();
    const tx = document.createElement('span'); tx.className = 'tx'; tx.textContent = msg;
    e.append(tm, tx);
    ui.log.append(e);
    while (ui.log.children.length > 300) ui.log.firstChild.remove();
    ui.log.scrollTop = ui.log.scrollHeight;
  }
  async function copyReport() {
    const head = [
      `Batch Prompter v${VERSION} — отчёт`,
      `Время: ${new Date().toLocaleString()}`,
      `Настройки: ${JSON.stringify({ sep: S.sep, prefix: S.prefix, delay: [S.delayMin, S.delayMax], waitImage: S.waitImage, download: S.download, retries: S.retries, timeoutMin: S.timeoutMin, startFrom: S.startFrom, prompts: parsePrompts(S.text, S.sep).length })}`,
      'Состояние сейчас:',
      JSON.stringify(diag(), null, 2),
      '─── Журнал ───',
    ];
    const text = head.concat(report).join('\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text; shadow.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    flash('Отчёт скопирован — вставьте его в чат (Ctrl+V)');
    ui.flash.style.color = 'var(--accent)';
    setTimeout(() => { ui.flash.style.color = ''; }, 4000);
  }
  function setOpen(open) {
    S.open = open;
    ui.panel.classList.toggle('hidden', !open);
    ui.fab.classList.toggle('hidden', open);
    save();
  }

  // Перетаскивание панели за шапку
  function applyPos() {
    if (!S.pos) return;
    const r = ui.panel.getBoundingClientRect();
    const x = Math.min(Math.max(8, S.pos.x), innerWidth - r.width - 8);
    const y = Math.min(Math.max(8, S.pos.y), innerHeight - 60);
    Object.assign(ui.panel.style, { left: `${x}px`, top: `${y}px`, right: 'auto', bottom: 'auto', maxHeight: `calc(100vh - ${y + 8}px)` });
  }
  ui.hdr.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    const r = ui.panel.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    const move = (ev) => { S.pos = { x: ev.clientX - dx, y: ev.clientY - dy }; applyPos(); };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); save(); };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  });
  ui.hdr.addEventListener('dblclick', () => {
    S.pos = null; save();
    Object.assign(ui.panel.style, { left: '', top: '', right: '', bottom: '', maxHeight: '' });
  });
  addEventListener('resize', applyPos);

  // Загрузка файла
  async function loadFile(file) {
    const text = await file.text();
    let prompts, names = [], refs = [], rows = [];
    if (/\.(csv|tsv)$/i.test(file.name)) ({ prompts, names, refs, rows } = parseCSV(text));
    else prompts = parsePrompts(text, S.sep);
    // Если в промптах есть переносы строк — разделяем через ---
    const multi = prompts.some((p) => p.includes('\n'));
    S.sep = multi ? 'dash' : 'line';
    S.text = prompts.join(multi ? '\n---\n' : '\n');
    S.names = names.some(Boolean) ? names : [];
    S.refs = refs.some(Boolean) ? refs : [];
    S.wordRows = rows.some(Boolean) ? rows : [];
    S.startFrom = 1;
    // Новый файл — новый набор: имя для папки запуска, прошлые пропущенные больше не актуальны
    S.csvName = file.name.replace(/\.[a-z0-9]{2,5}$/i, '');
    S.runFolder = ''; S.failed = []; S.resultsMap = {};
    fillForm(); save();
    log(`Загружен ${file.name}: ${prompts.length} ${plural(prompts.length, 'промпт', 'промпта', 'промптов')}` +
      (S.names.length ? ', имена файлов из CSV' : ''), 'info');
  }

  // События
  ui.fields.forEach((f) => f.addEventListener(f.type === 'checkbox' ? 'change' : 'input', readForm));
  // Файлы для прикрепления
  ui.pickCommon.addEventListener('click', () => ui.commonFile.click());
  ui.commonFile.addEventListener('change', () => {
    files.common = [...ui.commonFile.files];
    ui.commonFile.value = '';
    if (files.common.length) log(`Общие файлы: ${files.common.map((f) => f.name).join(', ')}`, 'info');
    refreshFiles();
  });
  // Проверка «@имя» без отправки
  ui.testLib.addEventListener('click', async () => {
    if (run.active) { flash('Сначала остановите очередь'); return; }
    const name = libNameClean();
    if (!name) { flash('Впишите имя файла из библиотеки'); return; }
    const btn = ui.testLib;
    btn.disabled = true;
    startTicker(); // в скрытой вкладке таймеры иначе замедляются до раза в секунду
    try {
      log(`Проверка @${name}…`, 'info');
      const t0 = Date.now();
      await clearAttachments(); // старое превью от прошлой проверки мешает выбору файла
      await insertLibraryRef(name);
      log(`✓ «${name}» выбран из библиотеки за ${((Date.now() - t0) / 1000).toFixed(1)} с`, 'ok');
      log('Тест ничего не отправлял. Уберите превью в поле ввода крестиком, если оно появилось', 'info');
    } catch (e) {
      log(`✗ ${e.message}. Нажмите «Копировать отчёт» и пришлите его`, 'err');
    } finally { btn.disabled = false; if (!run.active) stopTicker(); }
  });

  // Референсы из Word-ТЗ: картинки из строк таблицы
  ui.pickWord.addEventListener('click', () => ui.wordDoc.click());
  ui.wordDoc.addEventListener('change', async () => {
    const f = ui.wordDoc.files[0];
    ui.wordDoc.value = '';
    if (!f) return;
    try {
      const rows = await parseWordTZ(f);
      if (!rows.length) { log(`В «${f.name}» не нашлось таблицы с картинками`, 'err'); return; }
      files.word = rows; files.wordName = f.name; files.refSource = 'word';
      log(`Word «${f.name}»: ${rows.length} картинок — ${rows.map((r) => r.label).join(', ')}`, 'info');
      // Показываем, какой промпт получит какую картинку
      const n = parsePrompts(S.text, S.sep).length;
      for (let i = 0; i < n; i++) {
        const w = wordRowFor(i);
        log(`  #${i + 1} ← ${w ? `${w.row.label}${w.row.title ? ' · ' + w.row.title.slice(0, 40) : ''} (${w.how})` : 'нет'}`, w ? (w.how === 'по порядку' ? 'warn' : 'info') : 'warn');
      }
    } catch (e) {
      log(`Не удалось прочитать Word: ${e.message}`, 'err');
    }
    refreshFiles();
  });
  ui.pickRefs.addEventListener('click', () => ui.refDir.click());
  ui.refDir.addEventListener('change', () => {
    files.refs = new Map();
    for (const f of ui.refDir.files) {
      if (!isImageFile(f) && !/\.(pdf|docx?|txt)$/i.test(f.name)) continue;
      const b = baseName(f.name);
      files.refs.set(b, f);
      if (!files.refs.has(stripExt(b))) files.refs.set(stripExt(b), f);
    }
    ui.refDir.value = '';
    const uniq = new Set(files.refs.values()).size;
    files.refSource = 'folder';
    log(`Папка с референсами: ${uniq} файлов`, 'info');
    refreshFiles();
    // Какие имена из CSV не нашлись в папке — сразу видно, а не посреди запуска
    const n = parsePrompts(S.text, S.sep).length;
    if (S.refs && S.refs.length === n) {
      const miss = [];
      for (let i = 0; i < n; i++) if (S.refs[i] && !refFor(i)) miss.push(`#${i + 1} «${S.refs[i]}»`);
      if (miss.length) log(`В папке нет референсов: ${miss.join(', ')}. В папке есть: ${[...new Set(files.refs.values())].map((f) => f.name).join(', ')}`, 'warn');
    }
  });
  // Доработка готовых картинок
  ui.pickEdit.addEventListener('click', () => ui.editDir.click());
  ui.editDir.addEventListener('change', () => {
    files.edit = [...ui.editDir.files].filter(isImageFile)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    ui.editDir.value = '';
    log(`Для доработки: ${files.edit.length} картинок`, 'info');
    refreshEdit();
  });
  ui.runEdit.addEventListener('click', () => { if (!run.active) start('edit'); });
  ui.editBox.addEventListener('toggle', () => { S.editOpen = ui.editBox.open; save(); });

  ui.cmode.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b || run.active) return;
    S.commonMode = b.dataset.v; save(); refreshFiles();
  });
  ui.clearFiles.addEventListener('click', () => {
    if (run.active) return;
    files.common = []; files.refs = new Map(); files.word = []; files.wordName = ''; files.refSource = ''; refreshFiles();
  });

  ui.seg.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b || run.active) return;
    S.sep = b.dataset.v; save(); refreshInfo();
  });
  ui.upload.addEventListener('click', () => ui.file.click());
  ui.file.addEventListener('change', async () => {
    if (ui.file.files[0]) await loadFile(ui.file.files[0]);
    ui.file.value = '';
  });
  ui.clear.addEventListener('click', () => {
    if (!S.text.trim() || confirm('Очистить список промптов?')) {
      S.text = ''; S.names = []; S.refs = []; S.startFrom = 1; S.csvName = ''; S.runFolder = ''; S.failed = []; S.resultsMap = {}; fillForm(); save();
    }
  });
  ui.textarea.addEventListener('dragover', (e) => {
    if (run.active || !e.dataTransfer.types.includes('Files')) return;
    e.preventDefault(); ui.textarea.classList.add('drag');
  });
  ui.textarea.addEventListener('dragleave', () => ui.textarea.classList.remove('drag'));
  ui.textarea.addEventListener('drop', async (e) => {
    ui.textarea.classList.remove('drag');
    const f = e.dataTransfer.files[0];
    if (!f || run.active) return;
    e.preventDefault();
    await loadFile(f);
  });
  ui.settings.addEventListener('toggle', () => { S.settingsOpen = ui.settings.open; save(); });
  ui.logbox.addEventListener('toggle', () => { S.logOpen = ui.logbox.open; save(); });
  q('[data-clearlog]').addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    ui.log.innerHTML = '<div class="empty">Здесь появится ход работы</div>';
  });
  q('[data-test]').addEventListener('click', async (e) => {
    if (run.active) { flash('Сначала остановите очередь'); return; }
    const btn = e.currentTarget;
    btn.disabled = true;
    try { await testInput(); } finally { btn.disabled = false; }
  });
  q('[data-copy]').addEventListener('click', copyReport);
  q('[data-min]').addEventListener('click', () => setOpen(false));
  ui.fab.addEventListener('click', () => setOpen(true));
  ui.start.addEventListener('click', () => { if (!run.active) start(); });
  ui.retry.addEventListener('click', () => { if (!run.active) start('retry'); });
  ui.pause.addEventListener('click', () => {
    run.paused = !run.paused;
    if (run.paused) { log('Пауза после текущего промпта', 'warn'); setStatus('paused', 'Пауза после текущего промпта'); }
    else log('Продолжаем', 'info');
    updateButtons();
  });
  ui.stop.addEventListener('click', () => { run.stop = true; run.paused = false; setStatus('paused', 'Останавливаем…'); });

  let ready = false, openRequested = false;
  const onMsg = (msg) => {
    if (!msg) return;
    if (msg.type === 'toggle') { if (ready) setOpen(!S.open); else openRequested = true; }
    if (msg.type === 'open') { if (ready) setOpen(true); else openRequested = true; }
  };
  chrome.runtime.onMessage.addListener(onMsg);

  // Нас заменяет новая версия расширения — останавливаемся и убираем панель
  document.addEventListener('cgpt-batch-kill', () => {
    run.stop = true;
    host.remove();
    try { chrome.runtime.onMessage.removeListener(onMsg); } catch { /* контекст уже недействителен */ }
  }, { once: true });

  (async () => {
    await load();
    document.documentElement.appendChild(host);
    syncTheme();
    fillForm();
    updateButtons();
    ready = true;
    if (openRequested) setOpen(true);
    applyPos();
    setStatus('idle', 'Готов к запуску');
    if (S.startFrom > 1 && parsePrompts(S.text, S.sep).length) {
      ui.status.textContent = `Можно продолжить с №${S.startFrom}`;
    }
  })();
})();
