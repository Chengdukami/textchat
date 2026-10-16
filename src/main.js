const { app, BrowserWindow, globalShortcut, desktopCapturer, screen, ipcMain, Tray, Menu, nativeImage, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

let settingsWindow = null;
let answerWindow = null;
let debugWindow = null;
let tray = null;
let screenshots = [];
let answerVisible = true;
let currentAnswer = '';
let captureInProgress = false;
const debugLines = [];

const settingsPath = path.join(app.getPath('userData'), 'settings.json');
const defaultSettings = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  apiKey: ''
};

function loadSettings() {
  try {
    const value = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (value.apiKeyEncrypted && safeStorage.isEncryptionAvailable()) {
      value.apiKey = safeStorage.decryptString(Buffer.from(value.apiKeyEncrypted, 'base64'));
    }
    return { ...defaultSettings, ...value };
  } catch {
    return { ...defaultSettings };
  }
}

function saveSettings(value) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const record = { ...defaultSettings, ...value };
  if (safeStorage.isEncryptionAvailable() && record.apiKey) {
    record.apiKeyEncrypted = safeStorage.encryptString(record.apiKey).toString('base64');
    delete record.apiKey;
  }
  fs.writeFileSync(settingsPath, JSON.stringify(record, null, 2), 'utf8');
}

function appendDebug(title, value) {
  const stamp = new Date().toLocaleString();
  let detail = value;
  if (typeof value !== 'string') {
    try { detail = JSON.stringify(value, null, 2); } catch { detail = String(value); }
  }
  debugLines.push(`[${stamp}] ${title}\n${detail}`);
  if (debugLines.length > 100) debugLines.shift();
  if (debugWindow && !debugWindow.isDestroyed() && !debugWindow.webContents.isLoading()) {
    debugWindow.webContents.send('debug:update', debugLines.join('\n\n'));
  }
}

function createDebugWindow() {
  if (debugWindow && !debugWindow.isDestroyed()) {
    debugWindow.show();
    debugWindow.focus();
    debugWindow.webContents.send('debug:update', debugLines.join('\n\n'));
    return;
  }

  debugWindow = new BrowserWindow({
    width: 900,
    height: 650,
    title: '调试信息',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  debugWindow.loadFile(path.join(__dirname, 'debug.html'));
  debugWindow.webContents.once('did-finish-load', () => {
    debugWindow.webContents.send('debug:update', debugLines.join('\n\n'));
  });
  debugWindow.on('closed', () => { debugWindow = null; });
}

function createAnswerWindow() {
  answerWindow = new BrowserWindow({
    width: 300,
    height: 210,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  answerWindow.setAlwaysOnTop(true, 'floating');
  answerWindow.setIgnoreMouseEvents(true);
  answerWindow.loadFile(path.join(__dirname, 'answer.html'));
  answerWindow.once('ready-to-show', () => {
    positionAnswerWindow();
    updateAnswerWindow();
  });
}

function positionAnswerWindow() {
  if (!answerWindow || answerWindow.isDestroyed()) return;
  const workArea = screen.getPrimaryDisplay().workArea;
  const [width, height] = answerWindow.getSize();
  answerWindow.setPosition(workArea.x + 18, workArea.y + workArea.height - height - 18, false);
}

function updateAnswerWindow() {
  if (!answerWindow || answerWindow.isDestroyed()) return;
  answerWindow.webContents.send('answer:update', { text: currentAnswer || '等待截图…' });
  if (answerVisible) answerWindow.showInactive();
  else answerWindow.hide();
}

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 470,
    height: 430,
    title: '设置',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

async function captureScreen() {
  if (captureInProgress) return;
  captureInProgress = true;
  try {
    // 答案窗口属于本程序自己的屏幕内容。截图前先隐藏，避免上一轮答案被识别成新题目。
    if (answerWindow && !answerWindow.isDestroyed()) answerWindow.hide();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const display = screen.getPrimaryDisplay();
    const scale = display.scaleFactor || 1;
    const size = display.size;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(size.width * scale), height: Math.round(size.height * scale) },
      fetchWindowIcons: false
    });
    const source = sources.find((item) => item.display_id === String(display.id)) || sources[0];
    if (!source || source.thumbnail.isEmpty()) {
      throw new Error('没有拿到屏幕截图，请检查屏幕录制权限。');
    }
    screenshots.push(source.thumbnail.toPNG());
    appendDebug('截图已暂存', { count: screenshots.length, bytes: screenshots[screenshots.length - 1].length });
    currentAnswer = `已保存 ${screenshots.length} 张截图\n按 ↑ 提交，按 ↓ 显示/隐藏`;
  } finally {
    captureInProgress = false;
    updateAnswerWindow();
  }
}

function extractText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return String(content || '').trim();
  return content.map((item) => item?.text || '').join('').trim();
}

async function askAI() {
  if (screenshots.length === 0) {
    appendDebug('提交失败', '当前没有暂存截图');
    currentAnswer = '还没有截图';
    updateAnswerWindow();
    return;
  }

  const settings = loadSettings();
  if (!settings.apiKey || !settings.model) {
    appendDebug('提交失败', 'API Key 或模型名称为空');
    currentAnswer = '请先打开设置填写 API Key 和模型';
    answerVisible = true;
    updateAnswerWindow();
    createSettingsWindow();
    return;
  }

  currentAnswer = '正在识别…';
  answerVisible = true;
  updateAnswerWindow();

  const imageParts = screenshots.map((buffer) => ({
    type: 'image_url',
    image_url: { url: `data:image/png;base64,${buffer.toString('base64')}` }
  }));
  const body = {
    model: settings.model,
    thinking: { type: 'disabled' },
    temperature: 0,
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '请只回答当前截图里的题目，不要引用截图之外的信息，也不要引用之前轮次的答案。按题目从上到下、从左到右的顺序回答：选择题返回选项字母，填空题返回应填的单词或短语，排序题返回正确的完整顺序，匹配题按对应关系回答。不要强制所有答案都编号；排序题可以使用“排序：A > C > B”这样的格式。只输出答案，不要解释。' },
        ...imageParts
      ]
    }]
  };

  try {
    const baseUrl = settings.baseUrl.replace(/\/$/, '');
    appendDebug('请求开始', {
      url: `${baseUrl}/chat/completions`,
      model: settings.model,
      screenshotCount: screenshots.length,
      screenshotBytes: screenshots.reduce((sum, item) => sum + item.length, 0)
    });
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify(body)
    });
    const rawResponse = await response.text();
    appendDebug(`AI 原始响应（HTTP ${response.status}）`, rawResponse);
    let data;
    try {
      data = JSON.parse(rawResponse);
    } catch {
      throw new Error('AI 返回的内容不是有效 JSON');
    }
    if (!response.ok) throw new Error(data?.error?.message || `请求失败（${response.status}）`);
    appendDebug('解析后的字段', {
      finishReason: data?.choices?.[0]?.finish_reason,
      content: data?.choices?.[0]?.message?.content ?? '',
      reasoningLength: data?.choices?.[0]?.message?.reasoning_content?.length || 0
    });
    currentAnswer = extractText(data?.choices?.[0]?.message?.content) || 'AI 没有返回答案';
    screenshots = [];
    updateAnswerWindow();
  } catch (error) {
    appendDebug('请求异常', error.stack || error.message || String(error));
    currentAnswer = `请求失败：${error.message}`;
    updateAnswerWindow();
  }
}

function registerShortcuts() {
  const shortcuts = [
    ['Left', captureScreen],
    ['Up', askAI],
    ['Down', () => { answerVisible = !answerVisible; updateAnswerWindow(); }]
  ];
  for (const [accelerator, handler] of shortcuts) {
    const registered = globalShortcut.register(accelerator, () => {
      Promise.resolve(handler()).catch((error) => {
        currentAnswer = `操作失败：${error.message}`;
        answerVisible = true;
        updateAnswerWindow();
      });
    });
    if (!registered) console.warn(`无法注册全局快捷键 ${accelerator}`);
  }
}

function createTray() {
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip('截图答题助手');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '设置', click: createSettingsWindow },
    { label: '打开调试窗口', click: createDebugWindow },
    { label: '清空截图', click: () => { screenshots = []; currentAnswer = ''; updateAnswerWindow(); } },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]));
  tray.on('click', createSettingsWindow);
}

ipcMain.handle('settings:load', () => loadSettings());
ipcMain.handle('settings:save', (_event, value) => { saveSettings(value); return { ok: true }; });
ipcMain.handle('debug:open', () => { createDebugWindow(); return { ok: true }; });
ipcMain.on('debug:clear', () => {
  debugLines.length = 0;
  if (debugWindow && !debugWindow.isDestroyed()) debugWindow.webContents.send('debug:update', '');
});

app.whenReady().then(() => {
  createAnswerWindow();
  createTray();
  registerShortcuts();
  createSettingsWindow();
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', (event) => event.preventDefault());
