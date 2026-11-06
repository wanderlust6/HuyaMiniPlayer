// ==UserScript==
// @name         Huya Mini Player
// @namespace    https://www.huya.com/
// @version      0.3.0
// @description  虎牙直播 Canvas 小窗与弹幕叠加，支持设置和视频源恢复
// @match        https://www.huya.com/*
// @match        https://*.huya.com/*
// @run-at       document-idle
// @grant        none
// @inject-into  page
// ==/UserScript==
(() => {
'use strict';
const existingRoots = [...document.querySelectorAll('#hmp-root')];
if (window.__HUYA_MINI_PLAYER__) {
  if (existingRoots.length > 1) {
    const rank = el => {
      const label = el.querySelector('#hmp-canvas-pip')?.textContent || '';
      return label.includes('小窗播放') || label.includes('关闭小窗') ? 2 : label.includes('重试准备') ? 1 : 0;
    };
    const keep = existingRoots.reduce((best, el) => !best || rank(el) > rank(best) ? el : best, null);
    existingRoots.forEach(el => { if (el !== keep) el.remove(); });
  }
  return;
}
existingRoots.forEach(el => el.remove());
window.__HUYA_MINI_PLAYER__ = true;

const state = {
  chat: null, chatObserver: null, pageObserver: null,
  chatMutationCount: 0, chatRebindCount: 0, lastChatMutations: [], danmuSampleTimer: 0,
  chatNodeText: new WeakMap(), pendingChatNodes: new Set(), chatFlushTimer: 0,
  danmuQueue: [], danmuReceivedCount: 0, danmuDroppedCount: 0, danmuActiveCount: 0,
  canvas: null, canvasVideo: null, canvasStream: null, raf: 0,
  sourceVideo: null, videoFrameCallbackId: 0, pipFrameCallbackId: 0,
  prepareAttempt: 0
};

// HMP_PREP_DIAGNOSTICS：只记录初始化过程，不改变播放/捕获行为。
function logPrepare(attempt, startedAt, trigger, stage, detail = {}) {
  const elapsedMs = Math.round(performance.now() - startedAt);
  console.info('[HuyaMiniPlayer][prepare #' + attempt + ']', {
    trigger, stage, elapsedMs, wallTime: new Date().toISOString(), ...detail
  });
}

document.querySelectorAll('#hmp-style').forEach(el => el.remove());
const style = document.createElement('style');
style.id = 'hmp-style';
style.textContent = '#hmp-root{position:fixed;right:18px;bottom:90px;z-index:2147483647;display:flex;gap:8px;align-items:center;font:14px system-ui;color:white}' +
  '#hmp-canvas-pip,#hmp-settings-toggle{background:rgba(23,25,29,.94);color:#fff;border:1px solid rgba(255,255,255,.55);border-radius:22px;padding:10px 17px;cursor:pointer;font:600 14px system-ui;box-shadow:0 2px 12px rgba(0,0,0,.35);transition:background .15s,border-color .15s}' +
  '#hmp-canvas-pip:hover:not(:disabled),#hmp-settings-toggle:hover{background:#30343b;border-color:#fff}' +
  '#hmp-canvas-pip:disabled{opacity:.72;cursor:wait}' +
  '#hmp-settings-panel{position:absolute;right:0;bottom:52px;width:290px;box-sizing:border-box;padding:14px;background:rgba(23,25,29,.97);border:1px solid rgba(255,255,255,.24);border-radius:12px;box-shadow:0 4px 22px rgba(0,0,0,.42);color:#fff;display:none;gap:12px;flex-direction:column}' +
  '#hmp-settings-panel.open{display:flex}' +
  '.hmp-setting-row{display:flex;flex-direction:column;gap:5px;font-size:12px}' +
  '.hmp-setting-head{display:flex;justify-content:space-between;align-items:center;color:#eee}' +
  '#hmp-settings-panel input[type=range]{width:100%;accent-color:#58a6ff}' +
  '#hmp-block-words{width:100%;height:76px;box-sizing:border-box;resize:vertical;border:1px solid #555;border-radius:7px;background:#17191d;color:#fff;padding:7px;font:12px system-ui}' +
  '.hmp-setting-actions{display:flex;justify-content:space-between;align-items:center;gap:8px}' +
  '.hmp-setting-actions button{border:1px solid #666;border-radius:7px;background:#30343b;color:#fff;padding:6px 10px;cursor:pointer}' +
  '#hmp-settings-hint{font-size:11px;color:#aaa}' +
  '#hmp-canvas-video{position:fixed;left:0;top:0;width:2px;height:2px;opacity:.01;pointer-events:none}';
document.documentElement.appendChild(style);
const root = document.createElement('div');
root.id = 'hmp-root';
root.innerHTML = '<button class="hmp-btn" id="hmp-canvas-pip" disabled>正在准备小窗…</button>' +
  '<button id="hmp-settings-toggle" type="button" title="弹幕设置">设置</button>' +
  '<section id="hmp-settings-panel" aria-label="弹幕设置">' +
    '<div class="hmp-setting-row"><div class="hmp-setting-head"><span>弹幕透明度</span><span id="hmp-opacity-value">85%</span></div><input id="hmp-opacity" type="range" min="0" max="100" step="1" value="85"></div>' +
    '<div class="hmp-setting-row"><div class="hmp-setting-head"><span>字体大小</span><span id="hmp-font-value">36 px</span></div><input id="hmp-font-size" type="range" min="24" max="56" step="1" value="36"></div>' +
    '<div class="hmp-setting-row"><div class="hmp-setting-head"><span>滚动速度</span><span id="hmp-speed-value">120 px/s</span></div><input id="hmp-speed" type="range" min="40" max="240" step="5" value="120"></div>' +
    '<div class="hmp-setting-row"><div class="hmp-setting-head"><span>弹幕屏蔽词</span><span>每行一个</span></div><textarea id="hmp-block-words" placeholder="输入屏蔽词，每行一个；也可用逗号分隔"></textarea></div>' +
    '<div class="hmp-setting-actions"><span id="hmp-settings-hint">设置自动保存</span><button id="hmp-save-words" type="button">保存屏蔽词</button></div>' +
  '</section>';
document.documentElement.appendChild(root);
root.style.display = 'none';

const $ = q => root.querySelector(q);
function status(t) {
  const button = $('#hmp-canvas-pip');
  if (button) button.title = String(t).replace(/\n/g, ' ');
}

function videoInfo(v, i) {
  const r = v.getBoundingClientRect();
  let src = v.currentSrc || v.src || '(无 src)';
  if (src.length > 90) src = src.slice(0, 87) + '...';
  return '#' + i + ' ready=' + v.readyState + ' paused=' + v.paused +
    ' size=' + v.videoWidth + 'x' + v.videoHeight +
    ' rect=' + Math.round(r.width) + 'x' + Math.round(r.height) +
    ' pip=' + (v.disablePictureInPicture ? 'disabled' : 'allowed') +
    '\nsrc=' + src;
}
function scan() {
  const videos = [...document.querySelectorAll('video')].filter(v => v.isConnected);
  return { videos, report: [
    '当前页面：' + location.href,
    '顶层 video 数量：' + videos.length,
    ...videos.map(videoInfo)
  ].join('\n') };
}

// 小窗宿主 video（#hmp-canvas-video）播放的是本脚本自己绘制的 Canvas 捕获流。
// 它同样是一个 playing、有 videoWidth 的 <video>，如果被选为输入源就会形成自我捕获的
// 反馈回路：每帧都把上一帧的合成画面（已经带有弹幕文字）重新画回 Canvas，
// 表现为小窗视频像停在一帧、弹幕文字拖影/重影/条纹残影，且刷新页面后才恢复。
function isOwnCanvasVideo(v) {
  return !!v && (v === state.canvasVideo || v.id === 'hmp-canvas-video');
}

function chooseSource() {
  const { videos, report } = scan();
  const candidates = videos.filter(v =>
    !isOwnCanvasVideo(v) &&
    v.videoWidth > 0 && v.videoHeight > 0 &&
    !v.disablePictureInPicture &&
    typeof v.requestPictureInPicture === 'function'
  );
  candidates.sort((a, b) => {
    const score = v => (v.paused ? 0 : 100000000) +
      v.videoWidth * v.videoHeight +
      Math.max(0, v.getBoundingClientRect().width * v.getBoundingClientRect().height);
    return score(b) - score(a);
  });
  return { video: candidates[0], videos, report };
}

// 原生 PiP 路径保持独立，不依赖 Canvas。
// 原生 PiP 入口已收敛到 Canvas 小窗按钮，不再单独显示。

function stopCanvas() {
  // 注意：这里不能隐藏 #hmp-root。stopCanvas 会在准备开始、绘制异常和 pagehide 时被调用，
  // 一旦隐藏，失败/重试路径就没有任何可点击的入口，按钮看起来像“脚本没反应”。
  if (state.raf) cancelAnimationFrame(state.raf);
  state.raf = 0;
  if (state.sourceVideo && state.videoFrameCallbackId &&
      typeof state.sourceVideo.cancelVideoFrameCallback === 'function') {
    state.sourceVideo.cancelVideoFrameCallback(state.videoFrameCallbackId);
  }
  state.videoFrameCallbackId = 0;
  if (state.canvasVideo && state.pipFrameCallbackId &&
      typeof state.canvasVideo.cancelVideoFrameCallback === 'function') {
    state.canvasVideo.cancelVideoFrameCallback(state.pipFrameCallbackId);
  }
  state.pipFrameCallbackId = 0;
  state.sourceVideo = null;
  if (state.canvasStream) state.canvasStream.getTracks().forEach(t => t.stop());
  state.canvasStream = null;
  if (state.canvasVideo) {
    state.canvasVideo.pause();
    state.canvasVideo.srcObject = null;
    state.canvasVideo.remove();
  }
  state.canvasVideo = null;
  state.canvas = null;
  state.danmuQueue.length = 0;
  activeDanmu = [];
  danmuTrackNextAt = [];
  danmuLastFrameAt = 0;
  $('#hmp-canvas-pip').disabled = true;
  $('#hmp-canvas-pip').textContent = '正在准备小窗…';
}

// 独立弹幕引擎：消息来自右侧聊天列表 .msg-normal，不依赖网页视频弹幕动画。
const DANMU_CONFIG = {
  fontSizeAt720: 36,
  speedAt1280: 120,
  opacity: 0.85,
  blockedWords: [],
  trackHeightAt720: 64,
  displayHeightRatio: 0.50,
  gapAt1280: 100,
  strokeAt720: 2,
  maxQueue: 20,
  maxActive: 5,
  maxMessageAgeMs: 4000,
  maxTextLength: 60
};
let activeDanmu = [];
let danmuTrackNextAt = [];
let danmuLastFrameAt = 0;

const DANMU_SETTINGS_KEY = 'huyaMiniPlayer.danmuSettings.v1';
function loadDanmuSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(DANMU_SETTINGS_KEY) || '{}');
    if (Number.isFinite(saved.opacity)) DANMU_CONFIG.opacity = Math.min(1, Math.max(0, saved.opacity));
    if (Number.isFinite(saved.fontSizeAt720)) DANMU_CONFIG.fontSizeAt720 = Math.min(56, Math.max(24, saved.fontSizeAt720 === 30 ? 36 : saved.fontSizeAt720));
    if (Number.isFinite(saved.speedAt1280)) DANMU_CONFIG.speedAt1280 = Math.min(240, Math.max(40, saved.speedAt1280));
    if (Array.isArray(saved.blockedWords)) DANMU_CONFIG.blockedWords = saved.blockedWords.filter(x => typeof x === 'string' && x.trim()).slice(0, 100);
  } catch (error) { console.warn('[HuyaMiniPlayer] Failed to load danmu settings:', error); }
}
function saveDanmuSettings() {
  try {
    localStorage.setItem(DANMU_SETTINGS_KEY, JSON.stringify({ opacity:DANMU_CONFIG.opacity, fontSizeAt720:DANMU_CONFIG.fontSizeAt720, speedAt1280:DANMU_CONFIG.speedAt1280, blockedWords:DANMU_CONFIG.blockedWords }));
    const hint = $('#hmp-settings-hint'); if (hint) hint.textContent = '已自动保存';
  } catch (error) { const hint = $('#hmp-settings-hint'); if (hint) hint.textContent = '保存失败：浏览器存储不可用'; }
}
function syncDanmuSettingsUI() {
  $('#hmp-opacity').value = String(Math.round(DANMU_CONFIG.opacity*100)); $('#hmp-opacity-value').textContent = Math.round(DANMU_CONFIG.opacity*100)+'%';
  $('#hmp-font-size').value = String(DANMU_CONFIG.fontSizeAt720); $('#hmp-font-value').textContent = DANMU_CONFIG.fontSizeAt720+' px';
  $('#hmp-speed').value = String(DANMU_CONFIG.speedAt1280); $('#hmp-speed-value').textContent = DANMU_CONFIG.speedAt1280+' px/s';
  $('#hmp-block-words').value = DANMU_CONFIG.blockedWords.join('\n');
}
loadDanmuSettings(); syncDanmuSettingsUI();
$('#hmp-settings-toggle').addEventListener('click',()=>$('#hmp-settings-panel').classList.toggle('open'));
$('#hmp-opacity').addEventListener('input',e=>{DANMU_CONFIG.opacity=Number(e.target.value)/100;$('#hmp-opacity-value').textContent=e.target.value+'%';saveDanmuSettings();});
$('#hmp-font-size').addEventListener('input',e=>{DANMU_CONFIG.fontSizeAt720=Number(e.target.value);$('#hmp-font-value').textContent=e.target.value+' px';saveDanmuSettings();});
$('#hmp-speed').addEventListener('input',e=>{DANMU_CONFIG.speedAt1280=Number(e.target.value);$('#hmp-speed-value').textContent=e.target.value+' px/s';saveDanmuSettings();});
$('#hmp-save-words').addEventListener('click',()=>{
  const words=$('#hmp-block-words').value.split(/[\n,，;；]+/).map(x=>x.trim()).filter(Boolean);
  DANMU_CONFIG.blockedWords=[...new Set(words)].slice(0,100); $('#hmp-block-words').value=DANMU_CONFIG.blockedWords.join('\n');
  saveDanmuSettings(); $('#hmp-settings-hint').textContent='已保存 '+DANMU_CONFIG.blockedWords.length+' 个屏蔽词';
});

function configureDanmuScheduler(canvas) {
  activeDanmu = [];
  const trackHeight = DANMU_CONFIG.trackHeightAt720 * canvas.height / 720;
  const trackCount = Math.max(1, Math.floor(canvas.height * DANMU_CONFIG.displayHeightRatio / trackHeight));
  danmuTrackNextAt = Array(trackCount).fill(0);
  danmuLastFrameAt = 0;
}

function enqueueChatDanmu(rawText) {
  if (!state.canvas) return;
  const text = String(rawText || '').replace(/\s+/g, ' ').trim().slice(0, DANMU_CONFIG.maxTextLength);
  if (!text) return;
  const normalizedText = text.toLocaleLowerCase();
  if (DANMU_CONFIG.blockedWords.some(word => normalizedText.includes(word.toLocaleLowerCase()))) return;
  if (state.danmuQueue.length >= DANMU_CONFIG.maxQueue) {
    state.danmuQueue.shift();
    state.danmuDroppedCount++;
  }
  state.danmuQueue.push({ text, queuedAt: performance.now() });
  state.danmuReceivedCount++;
}

function extractDanmuContent(messageEl) {
  // 复制消息节点后移除昵称、头像、等级、徽章和时间等装饰节点，只保留消息正文。
  const clone = messageEl.cloneNode(true);
  const removePattern = /(nick|nickname|username|user-name|msg-name|msg-user|sender|avatar|badge|medal|level|timestamp|msg-time|icon)/i;
  for (const node of [...clone.querySelectorAll('*')]) {
    const classes = typeof node.className === 'string'
      ? node.className
      : (node.getAttribute('class') || '');
    const id = node.id || '';
    if (removePattern.test(classes + ' ' + id)) node.remove();
  }
  let text = (clone.textContent || '').replace(/\s+/g, ' ').trim();
  // 兼容部分把“昵称：正文”直接写入文本节点的结构。
  text = text.replace(/^[^:：]{1,24}[:：]\s*/, '').trim();
  return text.slice(0, DANMU_CONFIG.maxTextLength);
}

function flushPendingChatMessages() {
  state.chatFlushTimer = 0;
  for (const el of state.pendingChatNodes) {
    if (!el.isConnected) continue;
    const text = extractDanmuContent(el);
    if (!text) continue;
    const previous = state.chatNodeText.get(el);
    if (previous === text) continue;
    state.chatNodeText.set(el, text);
    enqueueChatDanmu(text);
  }
  state.pendingChatNodes.clear();
}

function collectChatMessageNodes(records) {
  const found = new Set();
  const addCandidate = (node, includeDescendants = false) => {
    if (!node) return;
    const el = node.nodeType === 1 ? node : node.parentElement;
    if (!el) return;
    if (el.matches?.('.msg-normal')) found.add(el);
    const parentMessage = el.closest?.('.msg-normal');
    if (parentMessage) found.add(parentMessage);
    if (includeDescendants && el.querySelectorAll) {
      for (const child of el.querySelectorAll('.msg-normal')) found.add(child);
    }
  };

  for (const record of records) {
    // target 只用于识别其所属消息；仅扫描新增节点的后代，避免每次都重扫整份聊天记录。
    addCandidate(record.target, false);
    for (const node of record.addedNodes || []) addCandidate(node, true);
  }
  for (const el of found) state.pendingChatNodes.add(el);
  if (state.pendingChatNodes.size && !state.chatFlushTimer) {
    // 合并同一条消息的连续 DOM 更新，避免把尚未填充完成的文本拆成多条弹幕。
    state.chatFlushTimer = window.setTimeout(flushPendingChatMessages, 60);
  }
}

function drawDanmuOverlay(ctx, canvas, now) {
  const scale = canvas.height / 720;
  const fontSize = Math.max(12, DANMU_CONFIG.fontSizeAt720 * scale);
  const speed = DANMU_CONFIG.speedAt1280 * canvas.width / 1280;
  const gap = DANMU_CONFIG.gapAt1280 * canvas.width / 1280;
  const trackHeight = DANMU_CONFIG.trackHeightAt720 * scale;
  const strokeWidth = Math.max(1.5, DANMU_CONFIG.strokeAt720 * scale);

  // 使用绝对时间计算位置，避免逐帧累积误差造成横向微抖。
  danmuLastFrameAt = now;
  for (const item of activeDanmu) {
    item.x = canvas.width + 2 - speed * ((now - item.startedAt) / 1000);
  }
  ctx.save();
  ctx.font = '600 ' + fontSize + 'px "Microsoft YaHei", "PingFang SC", sans-serif';
  for (const item of activeDanmu) item.width = Math.ceil(ctx.measureText(item.text).width);
  activeDanmu = activeDanmu.filter(item => item.x + item.width > 0);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  // 限制屏幕同时显示的弹幕数量；队列只短暂缓冲，避免消息堆积。
  let spawned = 0;
  while (state.danmuQueue.length && spawned < 1 && activeDanmu.length < DANMU_CONFIG.maxActive) {
    const queued = state.danmuQueue[0];
    if (now - queued.queuedAt > DANMU_CONFIG.maxMessageAgeMs) {
      state.danmuQueue.shift();
      state.danmuDroppedCount++;
      continue;
    }

    let track = -1;
    let earliest = Infinity;
    for (let i = 0; i < danmuTrackNextAt.length; i++) {
      if (danmuTrackNextAt[i] <= now && danmuTrackNextAt[i] < earliest) {
        earliest = danmuTrackNextAt[i];
        track = i;
      }
    }
    if (track < 0) break;

    const width = Math.ceil(ctx.measureText(queued.text).width);
    state.danmuQueue.shift();
    activeDanmu.push({ text: queued.text, x: canvas.width + 2, startedAt: now, width, track });
    danmuTrackNextAt[track] = now + ((width + gap) / speed) * 1000;
    spawned++;
  }

  ctx.beginPath();
  ctx.rect(0, 0, canvas.width, canvas.height * DANMU_CONFIG.displayHeightRatio);
  ctx.clip();
  ctx.lineJoin = 'round';
  ctx.lineWidth = strokeWidth;
  ctx.strokeStyle = 'rgba(0,0,0,0.82)';
  ctx.fillStyle = '#ffffff';
  ctx.globalAlpha = DANMU_CONFIG.opacity;

  for (const item of activeDanmu) {
    const y = (item.track + 0.5) * trackHeight;
    ctx.strokeText(item.text, item.x, y);
    ctx.fillText(item.text, item.x, y);
  }
  ctx.restore();
  state.danmuActiveCount = activeDanmu.length;
  return activeDanmu.length;
}

async function waitForCapturedFrames(video, requiredFrames = 2, timeoutMs = 5000) {
  // 等待 Canvas 捕获视频真正呈现帧，而不只检查元数据。
  if (typeof video.requestVideoFrameCallback === 'function') {
    return new Promise((resolve, reject) => {
      let received = 0, callbackId = 0;
      const timer = window.setTimeout(() => {
        if (callbackId && typeof video.cancelVideoFrameCallback === 'function') video.cancelVideoFrameCallback(callbackId);
        reject(new Error('Canvas 捕获流在限定时间内未能连续输出视频帧'));
      }, timeoutMs);
      const onFrame = (now, metadata) => {
        received++;
        if (received >= requiredFrames) { clearTimeout(timer); resolve({ received, mediaTime: metadata.mediaTime }); return; }
        callbackId = video.requestVideoFrameCallback(onFrame);
      };
      callbackId = video.requestVideoFrameCallback(onFrame);
    });
  }
  return new Promise((resolve, reject) => {
    const start = performance.now(); let lastTime = video.currentTime, advances = 0;
    const check = () => {
      if (video.currentTime > lastTime + 0.005) { advances++; lastTime = video.currentTime; }
      if (advances >= requiredFrames) resolve({ received: advances, mediaTime: video.currentTime });
      else if (performance.now() - start >= timeoutMs) reject(new Error('Canvas 捕获流 currentTime 未能持续推进'));
      else window.setTimeout(check, 100);
    };
    window.setTimeout(check, 100);
  });
}

async function waitForStableCapturedFrames(video, requiredFrames = 10, timeoutMs = 7000) {
  // 仅用于自动 PiP 实验：要求捕获视频连续输出不同的媒体帧，并覆盖足够的媒体时间。
  if (typeof video.requestVideoFrameCallback === 'function') {
    return new Promise((resolve, reject) => {
      let received = 0;
      let firstMediaTime = null;
      let lastMediaTime = -Infinity;
      let callbackId = 0;
      const timer = window.setTimeout(() => {
        if (callbackId && typeof video.cancelVideoFrameCallback === 'function') {
          video.cancelVideoFrameCallback(callbackId);
        }
        reject(new Error('Canvas 捕获流未能通过稳定帧检查（' + received + '/' + requiredFrames + ' 帧）'));
      }, timeoutMs);
      const onFrame = (now, metadata) => {
        const mediaTime = Number(metadata?.mediaTime);
        if (Number.isFinite(mediaTime) && mediaTime > lastMediaTime + 0.0001) {
          if (firstMediaTime === null) firstMediaTime = mediaTime;
          lastMediaTime = mediaTime;
          received++;
        }
        if (received >= requiredFrames && firstMediaTime !== null &&
            lastMediaTime - firstMediaTime >= 0.20) {
          clearTimeout(timer);
          resolve({
            received, firstMediaTime, lastMediaTime,
            mediaTimeSpan: lastMediaTime - firstMediaTime
          });
          return;
        }
        callbackId = video.requestVideoFrameCallback(onFrame);
      };
      callbackId = video.requestVideoFrameCallback(onFrame);
    });
  }

  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    let lastTime = video.currentTime;
    const firstTime = lastTime;
    let advances = 0;
    const check = () => {
      const currentTime = video.currentTime;
      if (currentTime > lastTime + 0.005) {
        advances++;
        lastTime = currentTime;
      }
      if (advances >= requiredFrames && currentTime - firstTime >= 0.20) {
        resolve({ received: advances, firstMediaTime: firstTime, lastMediaTime: currentTime,
          mediaTimeSpan: currentTime - firstTime });
      } else if (performance.now() - startedAt >= timeoutMs) {
        reject(new Error('Canvas 捕获流未能通过稳定帧检查（' + advances + '/' + requiredFrames + ' 次推进）'));
      } else {
        window.setTimeout(check, 100);
      }
    };
    window.setTimeout(check, 100);
  });
}

async function prepareCanvas(trigger = 'manual', autoOpenPiP = false) {
  const attempt = ++state.prepareAttempt;
  const startedAt = performance.now();
  logPrepare(attempt, startedAt, trigger, 'start', {
    pageReadyState: document.readyState,
    existingCanvas: !!state.canvas,
    existingCanvasVideo: !!state.canvasVideo,
    existingStreamTracks: state.canvasStream ? state.canvasStream.getTracks().map(t => ({ kind: t.kind, readyState: t.readyState })) : []
  });
  stopCanvas();
  logPrepare(attempt, startedAt, trigger, 'after-stopCanvas');
  const { video, videos, report } = chooseSource();
  const sourceSnapshot = video ? {
    readyState: video.readyState, paused: video.paused, ended: video.ended,
    currentTime: video.currentTime, videoWidth: video.videoWidth, videoHeight: video.videoHeight,
    isConnected: video.isConnected, hasRVFC: typeof video.requestVideoFrameCallback === 'function'
  } : null;
  logPrepare(attempt, startedAt, trigger, 'source-selected', { videoCount: videos.length, selectedSource: sourceSnapshot });
  if (!video) {
    const button = $('#hmp-canvas-pip');
    button.disabled = false;
    button.textContent = '重试准备';
    // 页面上确实存在视频（只是尚未就绪）时才显示重试入口；完全没有视频的页面保持隐藏。
    if (videos.length > 0) root.style.display = 'flex';
    logPrepare(attempt, startedAt, trigger, 'failed-no-source', { videoCount: videos.length, report });
    status('暂未找到已加载的视频。请确认直播已开始，然后点击重试。\n' + report);
    return;
  }
  try {
    const canvas = document.createElement('canvas');
    // 最高 1280x720：降低每帧像素处理量，仍保持 16:9 和清晰的小窗画面。
    const downScale = Math.min(1, 1280 / video.videoWidth, 720 / video.videoHeight);
    canvas.width = Math.max(1, Math.round(video.videoWidth * downScale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * downScale));
    const ctx = canvas.getContext('2d', { alpha: false });
    const baseCanvas = document.createElement('canvas');
    baseCanvas.width = canvas.width;
    baseCanvas.height = canvas.height;
    const baseCtx = baseCanvas.getContext('2d', { alpha: false });
    if (!baseCtx) throw new Error('Unable to create background cache context');
    if (!ctx) throw new Error('无法创建 Canvas 2D context');

    // 先实际绘制并读取像素，尽早发现跨域污染或空帧。
    baseCtx.drawImage(video, 0, 0, canvas.width, canvas.height);
    ctx.drawImage(baseCanvas, 0, 0, canvas.width, canvas.height);
    ctx.getImageData(0, 0, 1, 1);
    logPrepare(attempt, startedAt, trigger, 'canvas-first-draw-ok', {
      canvasWidth: canvas.width, canvasHeight: canvas.height,
      sourceCurrentTime: video.currentTime, sourceReadyState: video.readyState
    });

    const stream = canvas.captureStream();
    logPrepare(attempt, startedAt, trigger, 'captureStream-created', {
      tracks: stream.getTracks().map(t => ({ kind: t.kind, readyState: t.readyState, settings: t.getSettings?.() || {} }))
    });
    const pipVideo = document.createElement('video');
    pipVideo.id = 'hmp-canvas-video';
    pipVideo.muted = true;
    pipVideo.playsInline = true;
    pipVideo.autoplay = true;
    pipVideo.srcObject = stream;
    document.documentElement.appendChild(pipVideo);

    state.canvas = canvas;
    state.sourceVideo = video;
    configureDanmuScheduler(canvas);
    state.canvasStream = stream;
    state.canvasVideo = pipVideo;

    const metadataReady = new Promise((resolve, reject) => {
      if (pipVideo.readyState >= 1 && pipVideo.videoWidth > 0) return resolve();
      const timer = setTimeout(() => reject(new Error('等待 Canvas 视频元数据超时（8 秒）')), 8000);
      pipVideo.addEventListener('loadedmetadata', () => { clearTimeout(timer); resolve(); }, { once: true });
      pipVideo.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Canvas 临时视频加载失败')); }, { once: true });
    });

    await pipVideo.play();
    await metadataReady;
    logPrepare(attempt, startedAt, trigger, 'pip-video-playing-metadata-ready', {
      pipReadyState: pipVideo.readyState, pipPaused: pipVideo.paused,
      pipWidth: pipVideo.videoWidth, pipHeight: pipVideo.videoHeight,
      pipCurrentTime: pipVideo.currentTime,
      sourceCurrentTime: video.currentTime, sourcePaused: video.paused
    });

    // 视频帧与弹幕动画分开调度：
    // 视频只在源视频产生新帧时更新；弹幕则跟随显示器 requestAnimationFrame 连续移动。
    // 运行期间允许虎牙替换原始 video；Canvas 捕获流和 PiP video 保持不变，只重新绑定输入源。
    let activeVideo = video;
    let supportsVideoFrameCallback = typeof activeVideo.requestVideoFrameCallback === 'function';
    let videoFrameDirty = true;
    let lastVideoFrameAt = performance.now();
    let lastMediaProgressAt = performance.now();
    let lastObservedMediaTime = activeVideo.currentTime;
    let lastPipFrameAt = performance.now();
    let lastMonitorLogAt = 0;
    let lastDrawnMediaTime = activeVideo.currentTime;
    let sourceFrameCallbacks = 0;
    let lastSourceScanAt = 0;
    let sourceRebindCount = 0;
    const cancelSourceFrameCallback = () => {
      if (activeVideo && state.videoFrameCallbackId &&
          typeof activeVideo.cancelVideoFrameCallback === 'function') {
        activeVideo.cancelVideoFrameCallback(state.videoFrameCallbackId);
      }
      state.videoFrameCallbackId = 0;
    };

    const onVideoFrame = () => {
      if (!state.canvas || !activeVideo || !activeVideo.isConnected) return;
      sourceFrameCallbacks++;
      lastVideoFrameAt = performance.now();
     videoFrameDirty = true;
      if (typeof activeVideo.requestVideoFrameCallback === 'function') {
        state.videoFrameCallbackId = activeVideo.requestVideoFrameCallback(onVideoFrame);
      }
    };

    const scheduleSourceFrameCallback = () => {
      if (!state.canvas || !activeVideo || !activeVideo.isConnected ||
          typeof activeVideo.requestVideoFrameCallback !== 'function') return;
      state.videoFrameCallbackId = activeVideo.requestVideoFrameCallback(onVideoFrame);
    };

    const rebindSourceVideo = (nextVideo, reason) => {
      if (!nextVideo || nextVideo === activeVideo || isOwnCanvasVideo(nextVideo) ||
          !nextVideo.isConnected ||
          nextVideo.videoWidth <= 0 || nextVideo.videoHeight <= 0) return false;
      cancelSourceFrameCallback();
      const previous = activeVideo;
      activeVideo = nextVideo;
      state.sourceVideo = nextVideo;
      supportsVideoFrameCallback = typeof activeVideo.requestVideoFrameCallback === 'function';
      videoFrameDirty = true;
      lastVideoFrameAt = performance.now();
      lastMediaProgressAt = lastVideoFrameAt;
      lastDrawnMediaTime = activeVideo.currentTime;
      sourceRebindCount++;
      try {
        if (activeVideo.readyState >= 2) {
          baseCtx.drawImage(activeVideo, 0, 0, canvas.width, canvas.height);
          videoFrameDirty = false;
        }
      } catch (_) {}
      scheduleSourceFrameCallback();
      console.info('[HuyaMiniPlayer][source-recovery]', {
        reason, sourceRebindCount,
        previousConnected: !!previous?.isConnected,
        nextReadyState: activeVideo.readyState,
        nextPaused: activeVideo.paused,
        nextCurrentTime: activeVideo.currentTime,
        nextSize: activeVideo.videoWidth + 'x' + activeVideo.videoHeight
      });
      return true;
    };

    const recoverSourceIfNeeded = now => {
      if (now - lastSourceScanAt < 500) return;
      lastSourceScanAt = now;
      const disconnected = !activeVideo || !activeVideo.isConnected;
      const currentTime = activeVideo && Number.isFinite(activeVideo.currentTime) ? activeVideo.currentTime : lastObservedMediaTime;
      if (activeVideo && Math.abs(currentTime - lastObservedMediaTime) > 0.0005) {
        lastObservedMediaTime = currentTime;
        lastMediaProgressAt = now;
      }
      const mediaStalled = activeVideo && !activeVideo.paused && now - lastMediaProgressAt > 2500;
      if (!disconnected && !mediaStalled) return;
      const candidate = chooseSource().video;
      if (candidate && candidate !== activeVideo && !candidate.paused) {
        rebindSourceVideo(candidate, disconnected ? 'source-disconnected' : 'playing-source-media-time-stalled');
      } else if (mediaStalled && now - lastMonitorLogAt > 5000) {
        lastMonitorLogAt = now;
        console.warn('[HuyaMiniPlayer][source-stalled-no-alternate]', {
          paused: activeVideo.paused, currentTime: activeVideo.currentTime,
          readyState: activeVideo.readyState, lastFrameAgeMs: Math.round(now - lastVideoFrameAt)
        });
      }
    };
    scheduleSourceFrameCallback();
    const schedulePipFrameCallback = () => {
      if (!state.canvas || !pipVideo.isConnected || typeof pipVideo.requestVideoFrameCallback !== 'function') return;
      state.pipFrameCallbackId = pipVideo.requestVideoFrameCallback(() => {
        lastPipFrameAt = performance.now();
        schedulePipFrameCallback();
      });
    };
    schedulePipFrameCallback();


    const draw = now => {
      if (!state.canvas) return;
      try {
        recoverSourceIfNeeded(now);
        if (now - lastMonitorLogAt > 5000 && now - lastPipFrameAt > 2500 &&
            activeVideo && !activeVideo.paused && now - lastMediaProgressAt < 1000) {
          lastMonitorLogAt = now;
          console.warn('[HuyaMiniPlayer][pip-output-stalled]', {
            sourceCurrentTime: activeVideo.currentTime, pipCurrentTime: pipVideo.currentTime,
            pipReadyState: pipVideo.readyState, pipFrameAgeMs: Math.round(now - lastPipFrameAt),
            streamTrackState: state.canvasStream?.getVideoTracks()[0]?.readyState
          });
          // 浏览器偶尔会暂停这个几乎不可见的宿主 video；检测到暂停时主动恢复播放。
          if (pipVideo.paused) pipVideo.play().catch(() => {});
        }
        if (activeVideo && activeVideo.isConnected &&
            activeVideo.readyState >= 2 && activeVideo.videoWidth > 0) {
          // 源视频帧回调正常时按回调刷新；回调中断但媒体时间推进时启用兜底绘制。
          const callbackStalled = supportsVideoFrameCallback && (now - lastVideoFrameAt > 750);
          const mediaTimeAdvanced = Math.abs(activeVideo.currentTime - lastDrawnMediaTime) > 0.0005;
          if (!supportsVideoFrameCallback || videoFrameDirty || (callbackStalled && mediaTimeAdvanced)) {
            baseCtx.drawImage(activeVideo, 0, 0, canvas.width, canvas.height);
            videoFrameDirty = false;
            lastDrawnMediaTime = activeVideo.currentTime;
            if (mediaTimeAdvanced) lastVideoFrameAt = now;
          }
        }
        ctx.drawImage(baseCanvas, 0, 0, canvas.width, canvas.height);
        drawDanmuOverlay(ctx, canvas, now);
        // 即使旧 video 被移除，也继续运行监测；新 video 出现后可重新绑定。
        state.raf = requestAnimationFrame(draw);
      } catch (e) {
        status('Canvas 持续绘制失败：' + e.name + ' / ' + e.message);
        stopCanvas();
        const button = $('#hmp-canvas-pip');
        if (button) {
          button.disabled = false;
          button.textContent = '重试准备';
        }
        root.style.display = 'flex';
      }
    };
    state.raf = requestAnimationFrame(draw);

    // 等待捕获视频真正呈现至少两帧后，再允许用户打开 PiP。
    logPrepare(attempt, startedAt, trigger, 'before-captured-frame-check', {
      sourceCurrentTime: video.currentTime, sourcePaused: video.paused,
      sourceFrameCallbacks, pipReadyState: pipVideo.readyState,
      pipCurrentTime: pipVideo.currentTime, pipPaused: pipVideo.paused
    });
    const frameCheck = await waitForCapturedFrames(pipVideo, 2, 5000);
    const stabilityCheck = autoOpenPiP
      ? await waitForStableCapturedFrames(pipVideo, 10, 7000)
      : null;
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack || videoTrack.readyState !== 'live') throw new Error('Canvas 视频轨道未进入 live 状态');
    logPrepare(attempt, startedAt, trigger, 'success', {
      frameCheck, stabilityCheck, sourceFrameCallbacks,
      source: { currentTime: video.currentTime, paused: video.paused, readyState: video.readyState },
      pip: { currentTime: pipVideo.currentTime, paused: pipVideo.paused, readyState: pipVideo.readyState },
      track: { readyState: videoTrack.readyState, settings: videoTrack.getSettings?.() || {} }
    });
    root.style.display = 'flex';
    $('#hmp-canvas-pip').disabled = false;
    $('#hmp-canvas-pip').textContent = '小窗播放';
    if (autoOpenPiP) {
      logPrepare(attempt, startedAt, trigger, 'stable-frames-confirmed', { stabilityCheck });
      try {
        await pipVideo.requestPictureInPicture();
        $('#hmp-canvas-pip').textContent = '关闭小窗';
        status('稳定帧检查通过，小窗已自动启动。声音仍由虎牙网页播放。');
        logPrepare(attempt, startedAt, trigger, 'auto-pip-opened', {
          pipCurrentTime: pipVideo.currentTime,
          pipReadyState: pipVideo.readyState,
          stabilityCheck
        });
      } catch (pipError) {
        // PiP 被浏览器拒绝时保留已预热的流，用户仍可再次手动点击。
        $('#hmp-canvas-pip').disabled = false;
        $('#hmp-canvas-pip').textContent = '小窗播放';
        status('稳定帧检查通过，但自动启动 PiP 被浏览器拒绝：' +
          pipError.name + ' / ' + pipError.message + '。请点击“小窗播放”手动启动。');
        logPrepare(attempt, startedAt, trigger, 'auto-pip-rejected', {
          errorName: pipError.name, errorMessage: pipError.message,
          pipCurrentTime: pipVideo.currentTime, stabilityCheck
        });
        return;
      }
    }
    status(
      (autoOpenPiP && document.pictureInPictureElement
        ? 'Canvas 预热成功，小窗已启动。\\n'
        : 'Canvas 预热成功，尚未启动小窗。\\n') +
      '源视频：' + videoInfo(video, videos.indexOf(video)) + '\n' +
      'Canvas：' + canvas.width + 'x' + canvas.height + '\n' +
      '弹幕区域：上方 50%；轨道：' + danmuTrackNextAt.length + ' 条\n' +
      '弹幕字号：' + Math.round(DANMU_CONFIG.fontSizeAt720 * canvas.height / 720) + ' px\n' +
      '捕获帧率：跟随源视频帧回调，不额外限帧\n' +
      '临时视频元数据：readyState=' + pipVideo.readyState +
      '，尺寸=' + pipVideo.videoWidth + 'x' + pipVideo.videoHeight + '\n' +
      '像素读取：成功（未检测到 Canvas 跨域污染）\n' +
      ''
    );
  } catch (e) {
    logPrepare(attempt, startedAt, trigger, 'failed-exception', {
      errorName: e.name, errorMessage: e.message,
      source: video ? { currentTime: video.currentTime, paused: video.paused, readyState: video.readyState, videoWidth: video.videoWidth, videoHeight: video.videoHeight, isConnected: video.isConnected } : null,
      pip: state.canvasVideo ? { currentTime: state.canvasVideo.currentTime, paused: state.canvasVideo.paused, readyState: state.canvasVideo.readyState, videoWidth: state.canvasVideo.videoWidth, videoHeight: state.canvasVideo.videoHeight } : null,
      tracks: state.canvasStream ? state.canvasStream.getTracks().map(t => ({ kind: t.kind, readyState: t.readyState })) : []
    });
    stopCanvas();
    const button = $('#hmp-canvas-pip');
    button.disabled = false;
    button.textContent = '重试准备';
    root.style.display = 'flex';
    status('小窗准备失败：' + e.name + ' / ' + e.message);
    console.error('[HuyaMiniPlayer] Canvas preparation failed:', e);
  }
}

// 虎牙播放器晚于脚本注入创建 video，只在固定时间点准备一次会在页面稍慢时直接失败，
// 而失败后按钮又被隐藏，用户看到的就是“脚本没反应”。改为等可用视频出现后再预热。
const AUTO_START_DELAY_MS = 1200;
const AUTO_START_POLL_MS = 500;
const AUTO_START_MAX_WAIT_MS = 20000;

function startAutomaticPrepare() {
  const startedAt = performance.now();
  const tick = () => {
    if (state.canvas || state.canvasVideo) return;
    const elapsed = performance.now() - startedAt;
    const { video, videos } = chooseSource();
    if (video || (videos.length > 0 && elapsed >= AUTO_START_MAX_WAIT_MS)) {
      prepareCanvas('automatic-startup');
      return;
    }
    if (elapsed >= AUTO_START_MAX_WAIT_MS) return;
    window.setTimeout(tick, AUTO_START_POLL_MS);
  };
  window.setTimeout(tick, AUTO_START_DELAY_MS);
}
startAutomaticPrepare();

// PiP 请求必须直接发生在用户点击回调中，不能放到异步预热之后。
$('#hmp-canvas-pip').addEventListener('click', () => {
  const v = state.canvasVideo;
  if (document.pictureInPictureElement) {
    document.exitPictureInPicture().catch(e => status('关闭小窗失败：' + e.name + ' / ' + e.message));
    return;
  }
  if (!v || v.readyState < 2 || !v.videoWidth || !state.canvasStream || state.canvasStream.getVideoTracks()[0]?.readyState !== 'live') {
    const button = $('#hmp-canvas-pip');
    const trigger = button.textContent === '重试准备' ? 'retry-button' : 'click-recovery';
    button.disabled = true;
    button.textContent = '正在准备小窗…';
    prepareCanvas(trigger, true);
    return;
  }
  try {
    v.requestPictureInPicture()
      .then(() => {
        $('#hmp-canvas-pip').textContent = '关闭小窗';
        status('小窗已启动。声音仍由虎牙网页播放。');
      })
      .catch(e => status('小窗启动失败：' + e.name + ' / ' + e.message));
  } catch (e) {
    status('小窗启动失败：' + e.name + ' / ' + e.message);
  }
});
document.addEventListener('leavepictureinpicture', () => {
  $('#hmp-canvas-pip').textContent = '小窗播放';
});


function describeElement(el, depth = 0, maxDepth = 3) {
  if (!el || el.nodeType !== 1) return '';
  const indent = '  '.repeat(depth);
  const tag = el.tagName.toLowerCase();
  const idText = el.id ? '#' + el.id : '';
  const classes = typeof el.className === 'string'
    ? '.' + el.className.trim().split(/\s+/).filter(Boolean).slice(0, 5).join('.')
    : '';
  const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 110);
  const line = indent + tag + idText + classes +
    ' [children=' + el.children.length + ', text="' + text + '"]';
  if (depth >= maxDepth || !el.children.length) return line;
  const children = [...el.children].slice(0, 4);
  return [line, ...children.map(child => describeElement(child, depth + 1, maxDepth))].join('\n');
}

function runChatDiagnostics() {
  const target = document.querySelector('#chat-room__list');
  const selectors = [
    '#chat-room__list',
    '[id*="chat-room"]',
    '[class*="chat-room__list"]',
    '[class*="chat-list"]',
    '[class*="chatroom"]',
    '[class*="danmu"]',
    '[class*="message-list"]'
  ];
  const candidateMap = new Map();
  for (const selector of selectors) {
    try {
      for (const el of document.querySelectorAll(selector)) {
        if (!candidateMap.has(el)) candidateMap.set(el, []);
        candidateMap.get(el).push(selector);
      }
    } catch (_) {}
  }

  const lines = [
    '弹幕 DOM 诊断',
    '页面：' + location.href,
    '精确选择器 #chat-room__list：' + (target ? '找到' : '未找到'),
    '容器重绑定次数：' + state.chatRebindCount,
    '观察到的 DOM 变更次数：' + state.chatMutationCount,
    '弹幕消息接收数：' + state.danmuReceivedCount,
    '当前排队：' + state.danmuQueue.length + '；当前屏幕：' + state.danmuActiveCount,
    '因拥挤或过期丢弃：' + state.danmuDroppedCount,
    '候选容器数量：' + candidateMap.size
  ];

  if (target) {
    lines.push(
      '',
      '【#chat-room__list 容器】',
      describeElement(target, 0, 3),
      'scrollHeight=' + target.scrollHeight +
        ' clientHeight=' + target.clientHeight +
        ' childElementCount=' + target.childElementCount,
      '',
      '【直接子节点样本（最多 6 个）】'
    );
    [...target.children].slice(0, 6).forEach((el, i) => {
      lines.push('样本 ' + (i + 1) + ':', describeElement(el, 0, 3));
    });
  } else {
    lines.push('', '未找到预期容器。候选节点如下：');
  }

  lines.push('', '【其他候选容器】');
  let index = 0;
  for (const [el, matched] of candidateMap) {
    if (el === target) continue;
    if (index++ >= 12) break;
    lines.push(
      matched.join(', ') + ' => ' +
      el.tagName.toLowerCase() +
      (el.id ? '#' + el.id : '') +
      (typeof el.className === 'string' && el.className.trim()
        ? '.' + el.className.trim().split(/\s+/).slice(0, 4).join('.')
        : '') +
      ' children=' + el.childElementCount +
      ' text="' + (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 100) + '"'
    );
  }

  if (state.lastChatMutations.length) {
    lines.push('', '【最近 DOM 变更摘要】', ...state.lastChatMutations.slice(-8));
  }
  lines.push('', '请复制这份诊断结果发回；暂时不需要截图。');
  status(lines.join('\n'));
}




function sampleVideoDanmu() {
  if (state.danmuSampleTimer) {
    status('正在采样视频弹幕，请等待采样结束。');
    return;
  }
  const { video } = chooseSource();
  if (!video) {
    status('采样失败：没有找到已加载的视频。');
    return;
  }
  const videoRect = video.getBoundingClientRect();
  const duration = 8000;
  const interval = 200;
  const samples = new Map();
  const startedAt = performance.now();
  $('#hmp-danmu-sample').disabled = true;
  status('正在采集 .danmu-item，持续 8 秒。请保持直播播放，不要切换页面。');

  const timer = window.setInterval(() => {
    const now = performance.now();
    const nodes = document.querySelectorAll('.danmu-item');
    for (const el of nodes) {
      if (!el.isConnected) continue;
      const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      let item = samples.get(el);
      if (!item) {
        item = {
          text: text.slice(0, 70),
          first: { x: r.x, y: r.y, w: r.width, h: r.height, t: now - startedAt },
          last: null,
          count: 0,
          color: cs.color,
          opacity: cs.opacity,
          fontSize: cs.fontSize,
          transform: cs.transform,
          position: cs.position
        };
        samples.set(el, item);
      }
      item.last = { x: r.x, y: r.y, w: r.width, h: r.height, t: now - startedAt };
      item.count++;
      if (samples.size >= 80) break;
    }
    if (now - startedAt >= duration) {
      clearInterval(timer);
      state.danmuSampleTimer = 0;
      $('#hmp-danmu-sample').disabled = false;
      const lines = [
        '视频弹幕采样结果',
        '选择器：.danmu-item',
        '采样时长：8 秒；采样间隔：200 ms',
        '源视频尺寸：' + video.videoWidth + 'x' + video.videoHeight,
        '视频屏幕坐标：x=' + Math.round(videoRect.x) + ', y=' + Math.round(videoRect.y) +
          ', w=' + Math.round(videoRect.width) + ', h=' + Math.round(videoRect.height),
        '采集到的不同 DOM 节点：' + samples.size,
        '',
        '【节点样本】'
      ];
      let i = 0;
      for (const item of samples.values()) {
        if (i++ >= 16) break;
        const a = item.first;
        const b = item.last || a;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const relX = ((a.x - videoRect.x) / Math.max(1, videoRect.width) * 100).toFixed(1);
        const relY = ((a.y - videoRect.y) / Math.max(1, videoRect.height) * 100).toFixed(1);
        lines.push(
          (i) + '. "' + item.text + '"',
          '  first=(' + a.x.toFixed(1) + ',' + a.y.toFixed(1) + ')' +
            ' last=(' + b.x.toFixed(1) + ',' + b.y.toFixed(1) + ')' +
            ' delta=(' + dx.toFixed(1) + ',' + dy.toFixed(1) + ')' +
            ' samples=' + item.count,
          '  video-relative start=(' + relX + '%, ' + relY + '%)' +
            ' size=' + a.w.toFixed(1) + 'x' + a.h.toFixed(1),
          '  style color=' + item.color + ' opacity=' + item.opacity +
            ' fontSize=' + item.fontSize + ' position=' + item.position +
            ' transform=' + item.transform
        );
      }
      lines.push('', '请复制采样结果发回。');
      status(lines.join('\n'));
    }
  }, interval);
  state.danmuSampleTimer = timer;
}



function bindChat() {
  const found = document.querySelector('#chat-room__list');
  if (found === state.chat) return;
  state.chatObserver?.disconnect();
  state.chat = found;
  state.chatRebindCount++;
  if (found) {
    state.chatObserver = new MutationObserver(records => {
      state.chatMutationCount += records.length;
      collectChatMessageNodes(records);
      const summaries = records.slice(-5).map(record => {
        const added = [...record.addedNodes].filter(n => n.nodeType === 1).slice(0, 3)
          .map(n => n.tagName.toLowerCase() +
            (n.id ? '#' + n.id : '') +
            (typeof n.className === 'string' && n.className.trim()
              ? '.' + n.className.trim().split(/\s+/).slice(0, 3).join('.')
              : ''));
        return new Date().toLocaleTimeString() +
          ' type=' + record.type +
          ' added=' + record.addedNodes.length +
          ' removed=' + record.removedNodes.length +
          (added.length ? ' [' + added.join(', ') + ']' : '');
      });
      state.lastChatMutations.push(...summaries);
      state.lastChatMutations = state.lastChatMutations.slice(-20);
    });
    state.chatObserver.observe(found, {
      childList: true, subtree: true, characterData: true
    });
    // 找到聊天容器后立即停止全页面观察，避免对直播页面的高频 DOM 更新反复查询。
    state.pageObserver?.disconnect();
    state.pageObserver = null;
  }
}
bindChat();
if (!state.chat) {
  state.pageObserver = new MutationObserver(() => {
    if (!state.chat) bindChat();
  });
  state.pageObserver.observe(document.documentElement, { childList: true, subtree: true });
}

window.addEventListener('pagehide', () => {
  state.chatObserver?.disconnect();
  state.pageObserver?.disconnect();
  if (state.danmuSampleTimer) clearInterval(state.danmuSampleTimer);
  if (state.chatFlushTimer) clearTimeout(state.chatFlushTimer);
  state.danmuSampleTimer = 0;
  state.chatFlushTimer = 0;
  stopCanvas();
});
})();