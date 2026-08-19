/* ============================================================
   音韵学学习工具 — 应用逻辑 (v2.1)
   修复：allChars 正确填充为字头，表格显示汉字列表
   ============================================================ */

// ============ 全局状态 ============
const App = {
  data: null,
  charMap: {},             // char -> { char, fanqie, shengmu, yunbu, deng, hu, shengdiao, ipa, she, loaded, detailLoaded, ... }
  charReadings: {},        // char -> [同字的多份读音/解释]
  fanqieMap: {},
  ipaMap: {},
  allChars: [],
  filterIndex: { sheng: [], yun: [], deng: [], hu: [], diao: [], yunshe: [] },
  filterData: { sheng: {}, yun: {}, deng: {}, hu: {}, diao: {}, yunshe: {} },
  currentView: 'detail',
  bookmarks: [],
  activeAudio: null,
  batchTimer: null,
  batchIndex: 0,
  filters: { sheng: [], yun: [], deng: [], hu: [], diao: [], yunshe: [] },
  currentChar: null,
  blindMode: false,
  cacheEnabled: true,
  lastUpdate: '',
  detailPrefixCache: {},
  reconCache: {},
  filterResults: [],
  filterPage: 0,
  filterPageSize: 15,
  filterRendered: 0,
  filterBusy: false,
  filterJobId: 0,
  filterObserver: null,
  filterScrollHandler: null,
  filterParamsApplied: false,
  allMode: false,
  rawResults: [],
  rawIndex: 0,
  allQueue: [],
  allPrefixIndex: 0,
  fanqieQueue: [],
  fanqieResults: [],
  fanqieRendered: 0,
  fanqiePage: 0,
  fanqieBusy: false,
  fanqieJobId: 0,
  fanqieObserver: null,
  fanqieScrollHandler: null,
};

const DETAIL_PREFIXES = [
  'e39', 'e3a', 'e3b',
  'e48', 'e49', 'e4a', 'e4b',
  'e58', 'e59', 'e5a', 'e5b',
  'e68', 'e69', 'e6a', 'e6b',
  'e78', 'e79', 'e7a', 'e7b',
  'e88', 'e89', 'e8a', 'e8b',
  'e98', 'e99', 'e9a', 'e9b',
  'f0a'
];
const FILTER_BATCH_CANDIDATES = 60;
const DATA_CACHE_ENABLED_KEY = 'phonology_cache_enabled_v1';
const DATA_CACHE_DATE_KEY = 'phonology_data_cache_date_v1';
const DATA_CACHE_VALIDATED_KEY = 'phonology_data_cache_validated_v1';
const DATA_CACHE_SEEN_KEY = 'phonology_cache_seen_v1';
const CACHE_VALIDATE_INTERVAL_MS = 5 * 60 * 1000;

const FILTER_FIELD_MAP = {
  sheng: 'shengmu',
  yun: 'yunbu',
  deng: 'deng',
  hu: 'hu',
  diao: 'shengdiao',
  yunshe: 'she'
};

// ============ DOM 引用 ============
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ============ 工具 ============
function getHexFromChar(char) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(char);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
function getFolderAndFile(hex) {
  return { folder: hex.slice(0, 4), file: hex };
}
function getDetailPrefix(hex) {
  return hex.slice(0, 3);
}
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function buildDetailFromLine(char, dataLine) {
  return {
    char,
    xiesheng: dataLine[0],
    xingxu: dataLine[1],
    fanqie: dataLine[2],
    upper: dataLine[3],
    lower: dataLine[4],
    guangyun_head: dataLine[5],
    definition: dataLine[6],
    ipa: dataLine[7],
    shengmu: dataLine[8],
    hu: dataLine[9],
    deng: dataLine[10],
    yunbu: dataLine[11],
    shengdiao: dataLine[12],
    zu: dataLine[13],
    she: dataLine[14],
    zgy: [],
    sgy: [],
    loaded: true,
    detailLoaded: true
  };
}
function readingKey(detail) {
  return [
    detail.fanqie, detail.upper, detail.lower, detail.definition, detail.ipa,
    detail.shengmu, detail.hu, detail.deng, detail.yunbu, detail.shengdiao,
    detail.zu, detail.she, detail.guangyun_head
  ].join('\u0001');
}
function parseDetailText(text) {
  const map = new Map();
  const seen = new Set();
  text.split('\n').forEach(line => {
    const dataLine = line.split(',').map(s => s.trim());
    if (dataLine.length < 15) return;
    const char = dataLine[5];
    if (!char) return;
    const detail = buildDetailFromLine(char, dataLine);
    const key = readingKey(detail);
    if (seen.has(key)) return;
    seen.add(key);
    if (!map.has(char)) map.set(char, []);
    map.get(char).push(detail);
  });
  return map;
}
const dataTextCache = new Map();
const DATA_CACHE_PREFIX = 'phonology_data_v1_';
async function fetchText(url) {
  if (App.cacheEnabled && dataTextCache.has(url)) return dataTextCache.get(url);
  const cacheKey = DATA_CACHE_PREFIX + encodeURIComponent(url);
  if (App.cacheEnabled && typeof localStorage !== 'undefined') {
    try {
      const stored = localStorage.getItem(cacheKey);
      if (stored !== null) {
        dataTextCache.set(url, stored);
        return stored;
      }
    } catch (e) { /* 缓存不可用时直接请求 */ }
  }
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`加载失败: ${url}`);
  const text = await resp.text();
  if (App.cacheEnabled) dataTextCache.set(url, text);
  if (App.cacheEnabled && typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(cacheKey, text);
    } catch (e) { /* 超出存储上限时忽略 */ }
  }
  return text;
}
function clearPersistentDataCache() {
  if (typeof localStorage === 'undefined') return;
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(DATA_CACHE_PREFIX)) keys.push(key);
  }
  keys.forEach(key => localStorage.removeItem(key));
}
function clearDataCaches() {
  dataTextCache.clear();
  App.detailPrefixCache = {};
  App.reconCache = {};
  clearPersistentDataCache();
}
async function syncCacheDate() {
  let cachedDate = '';
  let cachedValidated = 0;
  if (typeof localStorage !== 'undefined') {
    try {
      cachedDate = localStorage.getItem(DATA_CACHE_DATE_KEY) || '';
      const rawValidated = localStorage.getItem(DATA_CACHE_VALIDATED_KEY) || '';
      cachedValidated = rawValidated ? Date.parse(rawValidated) || 0 : 0;
    } catch (e) { /* 忽略 */ }
  }
  const now = Date.now();
  if (cachedDate && cachedValidated && now - cachedValidated <= CACHE_VALIDATE_INTERVAL_MS) return;

  let lastUpdate = '';
  try {
    const resp = await fetch('data/lastupdate.txt', { cache: 'no-store' });
    if (resp.ok) lastUpdate = (await resp.text()).trim();
  } catch (e) {
    return;
  }
  if (!/^\d{12}$/.test(lastUpdate)) return;
  const validatedAt = Date.now();
  App.lastUpdate = lastUpdate;
  if (typeof localStorage !== 'undefined') {
    try { localStorage.setItem(DATA_CACHE_VALIDATED_KEY, new Date(validatedAt).toISOString()); } catch (e) { /* 忽略 */ }
  }
  if (cachedDate !== lastUpdate) {
    clearPersistentDataCache();
    if (typeof localStorage !== 'undefined') {
      try { localStorage.setItem(DATA_CACHE_DATE_KEY, lastUpdate); } catch (e) { /* 忽略 */ }
    }
    showToast(`数据缓存日期已更新为 ${lastUpdate}`);
  }
}
function initCacheControl() {
  const toggle = $('#cache-toggle');
  if (!toggle) return;
  const promptEl = $('#cache-prompt');
  let storedEnabled = null;
  if (typeof localStorage !== 'undefined') {
    try { storedEnabled = localStorage.getItem(DATA_CACHE_ENABLED_KEY); } catch (e) { /* 忽略 */ }
  }
  App.cacheEnabled = storedEnabled === null ? false : storedEnabled === '1';
  toggle.checked = App.cacheEnabled;

  let seen = false;
  if (typeof localStorage !== 'undefined') {
    try { seen = localStorage.getItem(DATA_CACHE_SEEN_KEY) === '1'; } catch (e) { /* 忽略 */ }
  }
  if (!seen && promptEl) {
    const accept = $('#btn-cache-accept');
    const decline = $('#btn-cache-decline');
    promptEl.style.display = 'flex';
    const finish = (enabled) => {
      App.cacheEnabled = enabled;
      toggle.checked = enabled;
      if (typeof localStorage !== 'undefined') {
        try { localStorage.setItem(DATA_CACHE_ENABLED_KEY, enabled ? '1' : '0'); } catch (e) { /* 忽略 */ }
      }
      promptEl.style.display = 'none';
      showToast(enabled ? '已开启本地数据缓存' : '暂不开启本地数据缓存');
    };
    if (accept) accept.addEventListener('click', () => finish(true));
    if (decline) decline.addEventListener('click', () => finish(false));
  } else if (!seen) {
    showToast('未启用本地数据缓存，可在右上角设置中开启', 5000);
  }
  if (!seen && typeof localStorage !== 'undefined') {
    try { localStorage.setItem(DATA_CACHE_SEEN_KEY, '1'); } catch (e) { /* 忽略 */ }
  }

  toggle.addEventListener('change', () => {
    App.cacheEnabled = toggle.checked;
    if (typeof localStorage !== 'undefined') {
      try { localStorage.setItem(DATA_CACHE_ENABLED_KEY, App.cacheEnabled ? '1' : '0'); } catch (e) { /* 忽略 */ }
    }
    if (!App.cacheEnabled) clearDataCaches();
    showToast(App.cacheEnabled ? '已开启数据缓存' : '已关闭数据缓存，本次不再复用缓存');
  });
}

function initSettings() {
  const openBtn = $('#btn-open-settings');
  const panel = $('#settings-panel');
  if (!openBtn || !panel) return;
  openBtn.addEventListener('click', () => {
    const bookmarkPanel = $('#bookmark-panel');
    if (bookmarkPanel) bookmarkPanel.classList.remove('open');
    panel.classList.toggle('open');
    const toggle = $('#cache-toggle');
    if (toggle) toggle.checked = App.cacheEnabled;
  });
  const closeBtn = $('#btn-close-settings');
  if (closeBtn) closeBtn.addEventListener('click', () => panel.classList.remove('open'));
}
async function loadDetailPrefix(prefix) {
  if (App.cacheEnabled && App.detailPrefixCache[prefix] !== undefined) return App.detailPrefixCache[prefix];
  if (!DETAIL_PREFIXES.includes(prefix)) {
    if (App.cacheEnabled) App.detailPrefixCache[prefix] = new Map();
    return new Map();
  }
  let map = new Map();
  try {
    const text = await fetchText(`data/details/${prefix}.txt`);
    map = parseDetailText(text);
  } catch (e) {
    console.warn(`读取详情文件失败: data/details/${prefix}.txt`, e);
  }
  if (App.cacheEnabled) App.detailPrefixCache[prefix] = map;
  return map;
}
function showToast(msg, duration = 2500) {
  const existing = $('.toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
}
function showLoading(visible) {
  const el = $('#loading-overlay');
  if (visible) el.classList.add('visible');
  else el.classList.remove('visible');
}

// ============ 数据加载 ============
function parseIndexLine(line) {
  return line.trim().match(/[\u3400-\u9fff][A-Za-z]?/g) || [];
}

async function loadData() {
  showLoading(true);
  try {
    await syncCacheDate();
    // 筛选页才加载 filterindex；搜索页不加载筛选资源
    if ($('#chips-initial')) {
      const idxText = await fetchText('data/filterindex.txt');
      const lines = idxText.split('\n').filter(line => line.trim() !== '');
      if (lines.length < 6) throw new Error('filterindex 格式错误，需6行');
      const categories = ['sheng', 'yun', 'deng', 'hu', 'diao', 'yunshe'];
      categories.forEach((cat, i) => {
        App.filterIndex[cat] = parseIndexLine(lines[i]);
      });
    }
    if ($('#chips-shangqie')) {
      await ensureFanqieIndex();
    }

    // 2. 加载生字本
    loadBookmarks();

  } catch (err) {
    console.error('数据加载失败:', err);
    showToast('数据加载失败: ' + err.message);
  } finally {
    showLoading(false);
  }
}

function normalizeFilterValue(cat, raw) {
  if (!raw) return '';
  const options = App.filterIndex[cat] || [];
  if (options.includes(raw)) return raw;
  for (const option of options) {
    if (raw.startsWith(option) || option.startsWith(raw)) return option;
  }
  const clean = raw.replace(/[\uFFFD].*$/, '').trim();
  return clean;
}

async function loadFilterValue(cat, value) {
  if (App.filterData[cat][value] !== undefined) return App.filterData[cat][value];
  if (!(App.filterIndex[cat] || []).includes(value)) {
    App.filterData[cat][value] = [];
    return [];
  }
  const path = `data/filter/${cat}/${getHexFromChar(value)}.txt`;
  try {
    const text = await fetchText(path);
    const chars = parseCharListText(text);
    App.filterData[cat][value] = chars;
    return chars;
  } catch (e) {
    console.warn(`读取筛选文件失败: ${path}`, e);
    App.filterData[cat][value] = [];
    return [];
  }
}

function parseCharListText(text) {
  const chars = [];
  const seen = new Set();
  text.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    const entries = tokens.length > 1 ? tokens : Array.from(tokens[0]);
    entries.forEach(ch => {
      if (!ch || seen.has(ch)) return;
      seen.add(ch);
      chars.push(ch);
    });
  });
  return chars;
}

function detailMatchesFilters(detail) {
  for (const [cat, field] of Object.entries(FILTER_FIELD_MAP)) {
    const selected = App.filters[cat] || [];
    if (selected.length === 0) continue;
    const value = normalizeFilterValue(cat, detail[field]);
    if (!selected.includes(value)) return false;
  }
  return true;
}

function hasMoreRawResults() {
  if (App.allMode) {
    return App.allPrefixIndex < DETAIL_PREFIXES.length || App.allQueue.length > 0;
  }
  return App.rawIndex < App.rawResults.length;
}

async function buildRawResults() {
  const groups = Object.keys(FILTER_FIELD_MAP);
  App.allMode = !groups.some(g => (App.filters[g] || []).length > 0);
  if (App.allMode) {
    App.rawResults = [];
    App.rawIndex = 0;
    App.allQueue = [];
    App.allPrefixIndex = 0;
    return;
  }

  let resultSet = null;
  for (const g of groups) {
    const selected = App.filters[g] || [];
    if (selected.length === 0) continue;
    const unionSet = new Set();
    for (const val of selected) {
      const chars = await loadFilterValue(g, val);
      chars.forEach(c => unionSet.add(c));
    }
    if (resultSet === null) {
      resultSet = unionSet;
    } else {
      const nextSet = new Set();
      for (const c of resultSet) {
        if (unionSet.has(c)) nextSet.add(c);
      }
      resultSet = nextSet;
    }
    if (resultSet.size === 0) break;
  }

  App.rawResults = Array.from(resultSet || []);
  App.rawIndex = 0;
}

async function takeNextRawChar() {
  if (!App.allMode) {
    if (App.rawIndex >= App.rawResults.length) return null;
    return App.rawResults[App.rawIndex++];
  }

  while (App.allQueue.length === 0 && App.allPrefixIndex < DETAIL_PREFIXES.length) {
    const prefix = DETAIL_PREFIXES[App.allPrefixIndex++];
    const map = await loadDetailPrefix(prefix);
    for (const [char, readings] of map.entries()) {
      registerCharReadings(char, readings);
      App.allQueue.push(char);
    }
  }
  return App.allQueue.shift() || null;
}

async function fillFilterRows() {
  const smallBatch = !App.allMode && App.rawResults.length > 0 && App.rawResults.length <= FILTER_BATCH_CANDIDATES;
  const target = smallBatch ? App.rawResults.length : App.filterPage + App.filterPageSize;
  let processed = 0;
  while (App.filterResults.length < target && processed < FILTER_BATCH_CANDIDATES) {
    const char = await takeNextRawChar();
    if (!char) break;
    processed++;
    let readings = App.charReadings[char] && App.charReadings[char].length
      ? App.charReadings[char]
      : await getCharReadings(char);
    if (!readings || readings.length === 0) continue;
    if (!App.allMode && !detailMatchesFilters(readings[0])) continue;
    App.filterResults.push(char);
  }
  App.filterPage = App.filterResults.length;
  renderNewFilterRows();
}

function renderNewFilterRows() {
  const tbody = $('#table-body');
  if (!tbody) return;
  let html = '';
  for (let i = App.filterRendered; i < App.filterResults.length; i++) {
    html += buildFilterRowHtml(App.filterResults[i]);
  }
  if (html) {
    const loadingRow = tbody.querySelector('#filter-loading-row');
    if (loadingRow) loadingRow.remove();
    const sentinel = $('#filter-sentinel');
    if (sentinel) sentinel.insertAdjacentHTML('beforebegin', html);
    else tbody.insertAdjacentHTML('beforeend', html);
    bindFilterRowEvents(tbody, App.filterRendered, App.filterResults.length);
    App.filterRendered = App.filterResults.length;
  }
  const countEl = $('#result-count');
  if (countEl) {
    const label = App.allMode ? '已加载' : '已确认';
    countEl.innerHTML = `${label} <strong>${App.filterResults.length}</strong> 条${hasMoreRawResults() ? '（继续加载中…）' : ''}`;
  }
}

async function startFilterTable() {
  const tbody = $('#table-body');
  if (!tbody) return;
  const jobId = ++App.filterJobId;
  finishFilterRows();
  App.filterResults = [];
  App.filterRendered = 0;
  App.filterPage = 0;
  App.filterBusy = false;
  tbody.innerHTML = `<tr id="filter-loading-row"><td colspan="10" style="text-align:center;padding:var(--space-2xl);color:var(--color-text-muted);">正在加载筛选数据…</td></tr>`;
  const countEl = $('#result-count');
  if (countEl) countEl.innerHTML = '正在筛选…';

  try {
    await buildRawResults();
    if (jobId !== App.filterJobId) return;
    if (!hasMoreRawResults()) {
      tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:var(--space-2xl);color:var(--color-text-muted);">没有符合条件的结果</td></tr>`;
      if (countEl) countEl.innerHTML = '共 <strong>0</strong> 条结果';
      return;
    }

    App.filterBusy = true;
    try {
      await fillFilterRows();
    } finally {
      App.filterBusy = false;
    }
    if (jobId !== App.filterJobId) return;
    if (hasMoreRawResults()) appendFilterSentinel();
    else finishFilterRows();
  } catch (e) {
    App.filterBusy = false;
    console.error('筛选加载失败:', e);
    showToast('筛选数据加载失败: ' + e.message);
  }
}

// ============ 获取单字详情（懒加载，支持一字多音/多解释） ============
function registerCharReadings(char, readings) {
  if (!readings || readings.length === 0) return;
  const hex = getHexFromChar(char);
  const { folder, file } = getFolderAndFile(hex);
  const audio = `audio/char/${folder}/${file}.mp3`;
  const zgyAudio = `audio/zgy/${file}.mp3`;
  const sgyAudio = `audio/sgy/${file}.mp3`;
  readings.forEach(r => {
    if (!r.audio) r.audio = audio;
    if (!r.zgyAudio) r.zgyAudio = zgyAudio;
    if (!r.sgyAudio) r.sgyAudio = sgyAudio;
  });
  App.charReadings[char] = readings;
  App.charMap[char] = readings[0];
  readings.forEach(r => {
    const fq = (r.fanqie || '').replace(/切$/, '');
    if (fq && !App.fanqieMap[fq]) App.fanqieMap[fq] = char;
    if (r.ipa && !App.ipaMap[r.ipa]) App.ipaMap[r.ipa] = char;
  });
}

async function getCharReadings(char) {
  if (App.charReadings[char] && App.charReadings[char].length) return App.charReadings[char];
  const hex = getHexFromChar(char);
  const prefixMap = await loadDetailPrefix(getDetailPrefix(hex));
  const readings = prefixMap.get(char) || [];
  if (readings.length === 0) return [];
  registerCharReadings(char, readings);
  return readings;
}

async function getCharDetail(char) {
  if (App.charMap[char] && App.charMap[char].detailLoaded) {
    return App.charMap[char];
  }
  const readings = await getCharReadings(char);
  return readings.length ? readings[0] : null;
}

// ============ 导航 ============
function initNavigation() {
  $$('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const view = tab.dataset.view;
      switchView(view);
    });
  });
}
function switchView(view) {
  App.currentView = view;
  if (view === 'fanqie' && !$('#view-fanqie')) {
    window.location.href = 'fanqie.html';
    return;
  }
  if (view === 'browser' && !$('#view-browser')) {
    window.location.href = 'filter.html';
    return;
  }
  if (view === 'detail' && !$('#view-detail')) {
    window.location.href = 'detail.html';
    return;
  }
  $$('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
  $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${view}`));
  if (view === 'browser') {
    if ($('#chips-initial')) renderFilterChips();
    applyFilters();
  }
  stopBatchPlay();
}

// ============ 搜索 ============
function initSearch() {
  const input = $('#search-input');
  const btn = $('#btn-search');
  if (!input || !btn) return;
  input.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  btn.addEventListener('click', doSearch);
  const params = new URLSearchParams(window.location.search);
  if (params.has('q')) {
    input.value = params.get('q');
    doSearch();
  }
}
async function doSearch() {
  const input = $('#search-input');
  if (!input) {
    const queryFromUrl = new URLSearchParams(window.location.search).get('q') || '';
    if (queryFromUrl) window.location.href = `detail.html?q=${encodeURIComponent(queryFromUrl)}`;
    return;
  }
  const query = input.value.trim();
  if (!query) { showToast('请输入要检索的内容'); return; }
  if (query.length !== 1) {
    showToast('音韵详情仅支持输入单个汉字，反切请前往反切搜索');
    return;
  }
  const url = new URL(window.location);
  url.searchParams.set('q', query);
  window.history.pushState({}, '', url);
  if (App.currentView !== 'detail') switchView('detail');

  const char = query;
  App.currentChar = char;
  const readings = await getCharReadings(char);
  if (readings.length) await renderDetail(char, readings);
  else showToast('未找到匹配的字');
}

// ============ 渲染详情（支持一字多音/多解释） ============
function parseReconstructionText(text) {
  const list = [];
  const seen = new Set();
  text.split('\n').forEach(line => {
    const parts = line.split(',').map(s => s.trim().replace(/^"|"$/g, ''));
    if (parts.length < 2 || !parts[0] || !parts[1]) return;
    const key = parts[0] + '\u0001' + parts[1];
    if (seen.has(key)) return;
    seen.add(key);
    list.push({ school: parts[0], value: parts[1] });
  });
  return list;
}

async function loadReconstructionEntries(detail, kind) {
  const prop = kind === 'oc' ? 'sgy' : 'zgy';
  if (detail[prop] && detail[prop].length) return detail[prop];
  if (detail[prop + 'Loaded']) return detail[prop] || [];
  const cacheKey = `${kind}:${detail.char}`;
  const storageKey = `${DATA_CACHE_PREFIX}recon_${kind}_${getHexFromChar(detail.char)}`;
  if (App.cacheEnabled && typeof localStorage !== 'undefined') {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          detail[prop] = parsed;
          detail[prop + 'Loaded'] = true;
          App.reconCache[cacheKey] = parsed;
          return parsed;
        }
      }
    } catch (e) { /* 缓存损坏时重新加载 */ }
  }
  if (App.cacheEnabled && App.reconCache[cacheKey]) {
    detail[prop] = App.reconCache[cacheKey];
    detail[prop + 'Loaded'] = true;
    return detail[prop];
  }

  const hex = getHexFromChar(detail.char);
  const { file } = getFolderAndFile(hex);
  const prefix = getDetailPrefix(hex);
  const paths = [
    `data/${prop}/${prefix}/${file}.txt`
  ];
  let list = [];
  for (const path of paths) {
    try {
      const text = await fetchText(path);
      list = parseReconstructionText(text);
      if (list.length) break;
    } catch (e) {
      console.warn(`读取${kind === 'oc' ? '上古' : '中古'}音拟音失败: ${path}`, e);
    }
  }
  detail[prop] = list;
  detail[prop + 'Loaded'] = true;
  if (App.cacheEnabled) App.reconCache[cacheKey] = list;
  if (App.cacheEnabled && typeof localStorage !== 'undefined') {
    try { localStorage.setItem(storageKey, JSON.stringify(list)); } catch (e) { /* 超出存储上限时忽略 */ }
  }
  return list;
}

function buildSchoolIpaList(detail, kind) {
  const source = kind === 'oc' ? (detail.sgy || []) : (detail.zgy || []);
  const list = [];
  const seen = new Set();
  source.forEach(item => {
    if (!item || !item.school || !item.value) return;
    const key = item.school + '\u0001' + item.value;
    if (seen.has(key)) return;
    seen.add(key);
    list.push({ school: item.school, value: item.value });
  });
  return list;
}

function buildReconSectionHtml(readings, kind) {
  const title = kind === 'oc' ? '上古音拟音' : '中古音拟音';
  const list = [];
  const seen = new Set();
  readings.forEach(detail => {
    buildSchoolIpaList(detail, kind).forEach(item => {
      if (seen.has(item.school)) return;
      seen.add(item.school);
      list.push(item);
    });
  });
  const rows = list.length
    ? list.map(item => `
        <tr><td class="ipa-school">${escapeHtml(item.school)}</td><td class="ipa-value">/${escapeHtml(item.value)}/</td></tr>
      `).join('')
    : '<tr><td colspan="2" style="text-align:center;color:var(--color-text-muted);">暂无拟音数据</td></tr>';
  return `
    <div class="ipa-card">
      <div class="card-title">${title}</div>
      <table class="ipa-table">
        <thead><tr><th>学派</th><th>拟音</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function buildReadingHtml(detail, index, multiple) {
  const body = `
    <div class="tian-grid">
        <div class="phonology-card">
          <div class="card-title">音韵地位</div>
          <div class="tag-row">
            <span class="tag tag-initial" data-filter="sheng" data-value="${escapeHtml(detail.shengmu)}">
              <span class="tag-label">声</span> ${escapeHtml(detail.shengmu)}母
            </span>
            <span class="tag tag-final" data-filter="yun" data-value="${escapeHtml(detail.yunbu)}">
              <span class="tag-label">韵</span> ${escapeHtml(detail.yunbu)}韻
            </span>
            <span class="tag tag-deng" data-filter="deng" data-value="${escapeHtml(detail.deng)}">
              <span class="tag-label">等</span> ${escapeHtml(detail.deng)}等
            </span>
            <span class="tag tag-hu" data-filter="hu" data-value="${escapeHtml(detail.hu)}">
              <span class="tag-label">呼</span> ${escapeHtml(detail.hu)}口
            </span>
            <span class="tag tag-tone" data-filter="diao" data-value="${escapeHtml(detail.shengdiao)}">
              <span class="tag-label">调</span> ${escapeHtml(detail.shengdiao)}聲
            </span>
            <span class="tag tag-she" data-filter="yunshe" data-value="${escapeHtml(detail.she)}">
              <span class="tag-label">摄</span> ${escapeHtml(detail.she)}攝
            </span>
          </div>
        </div>
        <div class="fanqie-card">
          <div class="card-title">反切拼读</div>
          <div class="fanqie-formula">
            <div class="fanqie-part">
              <div class="fanqie-label">反切上字</div>
              <div class="fanqie-char">${escapeHtml(detail.upper || '-')}</div>
              <div class="fanqie-ipa">${detail.upper ? `/${escapeHtml(detail.ipa)}/` : '-'}</div>
              ${detail.upper ? `<button class="btn-audio btn-audio-upper" data-char="${escapeHtml(detail.upper)}">&#9654;</button>` : ''}
            </div>
            <div class="fanqie-plus">+</div>
            <div class="fanqie-part">
              <div class="fanqie-label">反切下字</div>
              <div class="fanqie-char">${escapeHtml(detail.lower || '-')}</div>
              <div class="fanqie-ipa">${detail.lower ? `/${escapeHtml(detail.ipa)}/` : '-'}</div>
              ${detail.lower ? `<button class="btn-audio btn-audio-lower" data-char="${escapeHtml(detail.lower)}">&#9654;</button>` : ''}
            </div>
            <div class="fanqie-equals">=</div>
            <div class="fanqie-part" id="target-part-${index}">
              <div class="fanqie-label">被切字</div>
              <div class="fanqie-char">${escapeHtml(detail.char)}</div>
              <div class="fanqie-ipa blind-target" id="target-ipa-${index}">/${escapeHtml(detail.ipa)}/</div>
              <button class="btn-audio btn-audio-target blind-target" data-char="${escapeHtml(detail.char)}">&#9654;</button>
            </div>
          </div>
          <div class="blind-mode-toggle">
            <button class="toggle-switch" id="toggle-blind-${index}"></button>
            <span class="toggle-label">盲猜模式</span>
          </div>
          <div class="blind-hint" id="blind-hint-${index}">
            关闭开关即可查看被切字的音标和发音
          </div>
        </div>
    </div>
  `;
  const heading = multiple ? `
    <button type="button" class="reading-toggle" data-reading-index="${index}" aria-expanded="false" aria-controls="reading-body-${index}">
      <span class="reading-index">读音 ${index + 1}</span>
      ${detail.fanqie ? `<span class="reading-fanqie">${escapeHtml(detail.fanqie)}切</span>` : ''}
      ${detail.definition ? `<span class="reading-definition">${escapeHtml(detail.definition)}</span>` : ''}
      <span class="reading-caret" aria-hidden="true">&#9656;</span>
    </button>
  ` : '';
  return `
    <section class="reading-block">
      ${heading}
      ${multiple ? `<div class="reading-body" id="reading-body-${index}" hidden>${body}</div>` : body}
    </section>
  `;
}

async function renderDetail(char, readings) {
  const empty = $('#detail-empty');
  const content = $('#detail-content');
  empty.style.display = 'none';
  content.style.display = 'block';

  const list = (Array.isArray(readings) ? readings : [readings]).filter(Boolean);
  if (list.length === 0) {
    showToast('加载详情失败');
    return;
  }
  const multiple = list.length > 1;
  const first = list[0];
  await Promise.all(['mc', 'oc'].map(kind => loadReconstructionEntries(first, kind)));
  list.forEach(detail => {
    if (detail === first) return;
    detail.zgy = first.zgy || [];
    detail.sgy = first.sgy || [];
    detail.zgyLoaded = true;
    detail.sgyLoaded = true;
  });
  const headerLines = [`<div class="char-display">${escapeHtml(char)}</div>`];
  if (multiple) {
    headerLines.push(`<div class="char-readings-badge">${list.length} 个读音 / 解释</div>`);
  } else {
    if (first.fanqie) headerLines.push(`<div class="char-fanqie">${escapeHtml(first.fanqie)}切</div>`);
    if (first.definition) headerLines.push(`<div class="char-definition">${escapeHtml(first.definition)}</div>`);
  }
  const readingsHtml = list.map((detail, i) => buildReadingHtml(detail, i, multiple)).join('');
  const reconHtml = `
    <div class="recon-section">
      <div class="recon-section-head">
        <span class="recon-section-title">拟音总览</span>
        <span class="recon-section-note">中古音 / 上古音</span>
      </div>
      <div class="tian-grid recon-grid">
        ${buildReconSectionHtml(list, 'mc')}
        ${buildReconSectionHtml(list, 'oc')}
      </div>
    </div>
  `;

  content.innerHTML = `
    <div class="char-header">
      ${headerLines.join('\n')}
    </div>
    ${readingsHtml}
    ${reconHtml}
    <div class="action-bar">
      <button class="btn-action ${isBookmarked(char) ? 'bookmarked' : ''}" id="btn-bookmark">
        ${isBookmarked(char) ? '&#11088; 已收藏' : '&#9734; 加入生字本'}
      </button>
    </div>
  `;
  bindDetailEvents(char, list);
}

function bindDetailEvents(char, readings) {
  $$('.reading-toggle').forEach(toggle => {
    toggle.addEventListener('click', () => {
      const body = $('#reading-body-' + toggle.dataset.readingIndex);
      if (!body) return;
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!expanded));
      toggle.classList.toggle('open', !expanded);
      body.hidden = expanded;
    });
  });

  $$('.tag[data-filter]').forEach(tag => {
    tag.addEventListener('click', () => {
      const filter = tag.dataset.filter;
      const value = tag.dataset.value;
      resetFilters();
      const map = { sheng: 'sheng', yun: 'yun', deng: 'deng', hu: 'hu', diao: 'diao', yunshe: 'yunshe' };
      const key = map[filter];
      if (key) {
        App.filters[key] = [value];
        $$('.filter-chip').forEach(chip => {
          if (chip.dataset.group === key && chip.dataset.value === value) chip.classList.add('selected');
          else if (chip.dataset.group === key) chip.classList.remove('selected');
        });
      }
      switchView('browser');
      applyFilters();
    });
  });

  $$('.btn-audio').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      playAudioForChar(btn.dataset.char, btn, btn.dataset.audio);
    });
  });

  readings.forEach((_, i) => {
    const toggle = $('#toggle-blind-' + i);
    if (!toggle) return;
    const hint = $('#blind-hint-' + i);
    const targetPart = $('#target-part-' + i);
    const blindTargets = targetPart.querySelectorAll('.blind-target');
    let blind = true;
    toggle.classList.add('active');
    blindTargets.forEach(el => {
      el.classList.add('blind-hidden');
      el.classList.remove('revealed');
    });
    toggle.addEventListener('click', () => {
      blind = !blind;
      toggle.classList.toggle('active', blind);
      blindTargets.forEach(el => {
        el.classList.toggle('blind-hidden', blind);
        el.classList.remove('revealed');
      });
    });
  });

  const bookmarkBtn = $('#btn-bookmark');
  if (bookmarkBtn) {
    bookmarkBtn.addEventListener('click', () => {
      toggleBookmark(char);
      const isBm = isBookmarked(char);
      bookmarkBtn.classList.toggle('bookmarked', isBm);
      bookmarkBtn.innerHTML = isBm ? '&#11088; 已收藏' : '&#9734; 加入生字本';
      updateBookmarkCount();
    });
  }
}

// ============ 音频播放 ============
function playAudioForChar(char, btnElement, explicitPath) {
  if (App.activeAudio) {
    App.activeAudio.pause();
    App.activeAudio = null;
  }
  $$('.btn-audio.playing, .btn-table-audio.playing').forEach(b => b.classList.remove('playing'));
  const hex = getHexFromChar(char);
  const { folder, file } = getFolderAndFile(hex);
  const audioPath = explicitPath || `audio/char/${folder}/${file}.mp3`;
  const audio = new Audio(audioPath);
  App.activeAudio = audio;
  if (btnElement) btnElement.classList.add('playing');
  audio.play().catch(err => {
    console.warn('音频播放失败:', audioPath, err.message);
    showToast('音频文件不存在或无法播放');
    if (btnElement) btnElement.classList.remove('playing');
  });
  audio.addEventListener('ended', () => {
    if (btnElement) btnElement.classList.remove('playing');
    App.activeAudio = null;
  });
  audio.addEventListener('error', () => {
    if (btnElement) btnElement.classList.remove('playing');
    App.activeAudio = null;
  });
}

// ============ 生字本 ============
function initBookmarks() {
  $('#btn-open-bookmarks').addEventListener('click', () => {
    $('#bookmark-panel').classList.toggle('open');
    const settingsPanel = $('#settings-panel');
    if (settingsPanel) settingsPanel.classList.remove('open');
    renderBookmarkList();
  });
  $('#btn-close-bookmarks').addEventListener('click', () => {
    $('#bookmark-panel').classList.remove('open');
  });
  const searchInput = $('#bookmark-search');
  if (searchInput) searchInput.addEventListener('input', renderBookmarkList);
}
function loadBookmarks() {
  try { App.bookmarks = JSON.parse(localStorage.getItem('phonology_bookmarks') || '[]'); } catch { App.bookmarks = []; }
  updateBookmarkCount();
}
function saveBookmarks() { localStorage.setItem('phonology_bookmarks', JSON.stringify(App.bookmarks)); }
function isBookmarked(char) { return App.bookmarks.includes(char); }
function toggleBookmark(char) {
  const idx = App.bookmarks.indexOf(char);
  if (idx >= 0) App.bookmarks.splice(idx, 1);
  else App.bookmarks.push(char);
  saveBookmarks();
  updateBookmarkCount();
}
function updateBookmarkCount() {
  const count = App.bookmarks.length;
  $('#bookmark-count').textContent = count > 0 ? `(${count})` : '(0)';
}
function renderBookmarkList() {
  const container = $('#bookmark-list');
  const searchInput = $('#bookmark-search');
  const q = searchInput
    ? searchInput.value.trim().toLowerCase().replace(/\.mp3$/i, '')
    : '';
  const chars = App.bookmarks.filter(char => {
    if (!q) return true;
    const hex = getHexFromChar(char).toLowerCase();
    return char === q || char.includes(q) || hex.includes(q);
  });
  if (chars.length === 0) {
    container.innerHTML = `<div class="bookmark-empty">${
      App.bookmarks.length === 0 ? '还没有收藏任何生字' : '没有匹配的生字'
    }</div>`;
    return;
  }
  let html = '';
  for (const char of chars) {
    const detail = App.charMap[char];
    if (!detail) continue;
    html += `
      <div class="bookmark-item" data-char="${char}">
        <div class="bookmark-char">${char}</div>
        <div class="bookmark-info">
          <div class="fanqie">${detail.fanqie}切</div>
          <div class="ipa">/${detail.ipa}/</div>
        </div>
        <button class="btn-remove-bookmark" data-char="${char}">&times;</button>
      </div>
    `;
  }
  container.innerHTML = html;
  container.querySelectorAll('.bookmark-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('.btn-remove-bookmark')) return;
      const char = item.dataset.char;
      openCharDetail(char);
      $('#bookmark-panel').classList.remove('open');
    });
  });
  container.querySelectorAll('.btn-remove-bookmark').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const char = btn.dataset.char;
      toggleBookmark(char);
      renderBookmarkList();
      updateBookmarkCount();
      if (App.currentChar === char) {
        getCharReadings(char).then(rs => renderDetail(char, rs));
      }
    });
  });
}

// ============ 筛选面板 ============
function renderFilterChips() {
  if (!App.filterParamsApplied) {
    App.filterParamsApplied = true;
    const params = new URLSearchParams(window.location.search);
    const paramMap = {
      sheng: 'sheng',
      yun: 'yun',
      deng: 'deng',
      hu: 'hu',
      diao: 'diao',
      yunshe: 'yunshe'
    };
    for (const [cat, param] of Object.entries(paramMap)) {
      const raw = params.get(param);
      if (raw) App.filters[cat] = raw.split(',').map(s => s.trim()).filter(Boolean);
    }
  }
  const categories = ['sheng', 'yun', 'deng', 'hu', 'diao', 'yunshe', 'shangqie', 'xiaqie'];
  const idMap = {
    sheng: 'chips-initial',
    yun: 'chips-final',
    deng: 'chips-deng',
    hu: 'chips-hu',
    diao: 'chips-tone',
    yunshe: 'chips-she',
    shangqie: 'chips-shangqie',
    xiaqie: 'chips-xiaqie'
  };
  categories.forEach(cat => {
    const container = $(`#${idMap[cat]}`);
    if (!container) return;
    const items = App.filterIndex[cat] || [];
    const countEl = container.closest('.filter-group').querySelector('.filter-group-count');
    if (countEl) countEl.textContent = `(${items.length})`;
    let html = '';
    items.forEach(item => {
      const selected = App.filters[cat] && App.filters[cat].includes(item) ? 'selected' : '';
      html += `<span class="filter-chip ${selected}" data-group="${cat}" data-value="${item}">${item}</span>`;
    });
    container.innerHTML = html;
  });
  $$('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      chip.classList.toggle('selected');
      const group = chip.dataset.group;
      if (group === 'shangqie' || group === 'xiaqie') {
        App.filters[group] = Array.from(chip.parentElement.querySelectorAll('.filter-chip.selected')).map(c => c.dataset.value);
        reorderFanqieChips(chip.parentElement, App.filterIndex[group] || []);
      }
    });
  });
  applyFilterSearch();
}

function reorderFanqieChips(container, items) {
  if (!container) return;
  const selected = new Set(Array.from(container.querySelectorAll('.filter-chip.selected')).map(c => c.dataset.value));
  const ordered = items.filter(v => selected.has(v)).concat(items.filter(v => !selected.has(v)));
  ordered.forEach(v => {
    const chip = container.querySelector(`.filter-chip[data-value="${v}"]`);
    if (chip) container.appendChild(chip);
  });
}

function filterGroupByQuery(group, query) {
  const q = (query || '').trim().toLowerCase();
  let visible = 0;
  group.querySelectorAll('.filter-chip').forEach(chip => {
    const match = !q || chip.textContent.toLowerCase().includes(q);
    chip.style.display = match ? '' : 'none';
    if (match) visible++;
  });
  if (!$('#chips-shangqie')) group.style.display = visible ? '' : 'none';
}

function applyFilterSearch(input) {
  if (input) {
    const group = input.closest('.filter-group');
    if (group) {
      filterGroupByQuery(group, input.value);
      return;
    }
    $$('.filter-group').forEach(g => {
      const local = g.querySelector('.filter-search');
      filterGroupByQuery(g, local ? local.value : input.value);
    });
    return;
  }
  $$('.filter-group').forEach(g => {
    const local = g.querySelector('.filter-search');
    const globalInput = $('#filter-search');
    filterGroupByQuery(g, local ? local.value : (globalInput ? globalInput.value : ''));
  });
}

function initFilterSearch() {
  $$('.filter-search').forEach(input => {
    input.addEventListener('input', () => applyFilterSearch(input));
  });
}

function initFilterGroupToggles() {
  $$('.filter-group-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const group = btn.closest('.filter-group');
      if (!group) return;
      group.classList.toggle('collapsed');
      btn.setAttribute('aria-expanded', String(!group.classList.contains('collapsed')));
    });
  });
}

function resetFilters() {
  App.filters = { sheng: [], yun: [], deng: [], hu: [], diao: [], yunshe: [], shangqie: [], xiaqie: [] };
  $$('.filter-chip').forEach(c => c.classList.remove('selected'));
}

function applyFilters() {
  if ($('#chips-shangqie')) {
    App.filters.shangqie = Array.from($$('#chips-shangqie .filter-chip.selected')).map(c => c.dataset.value);
    App.filters.xiaqie = Array.from($$('#chips-xiaqie .filter-chip.selected')).map(c => c.dataset.value);
    startFanqieSearch();
    return;
  }
  const groups = ['sheng', 'yun', 'deng', 'hu', 'diao', 'yunshe'];
  groups.forEach(g => {
    const selected = [];
    $$(`.filter-chip.selected[data-group="${g}"]`).forEach(chip => selected.push(chip.dataset.value));
    App.filters[g] = selected;
  });
  startFilterTable();
}

// ============ 核心：渲染表格 ============
function openCharDetail(char) {
  const input = $('#search-input');
  if (input && $('#view-detail')) {
    input.value = char;
    switchView('detail');
    doSearch();
  } else {
    window.location.href = `detail.html?q=${encodeURIComponent(char)}`;
  }
}

function buildFilterRowHtml(char) {
  const d = App.charMap[char] || {};
  const readings = App.charReadings[char] || [];
  const multiple = readings.length > 1;
  const multiBadge = multiple
    ? `<span class="multi-badge" title="${readings.length} 个读音 / 解释">${readings.length} 音</span>`
    : '';
  const fanqie = d.fanqie ? `${d.fanqie}切` : '加载中…';
  const shengmu = d.shengmu || '…';
  const yunbu = d.yunbu || '…';
  const deng = d.deng ? `${d.deng}等` : '…';
  const hu = d.hu || '…';
  const shengdiao = d.shengdiao || '…';
  const ipa = d.ipa ? `/${d.ipa}/` : '…';
  const she = d.she ? `${d.she}攝` : '…';
  const toggleBtn = multiple
    ? `<button type="button" class="row-toggle" title="${readings.length} 个读音，点击展开/折叠" aria-expanded="false">&#9656;</button>`
    : '';
  const detailRows = multiple ? `
    <tr class="row-detail" data-char-detail="${char}" hidden>
      <td colspan="10">
        <div class="row-detail-inner">
          <table class="detail-table">
            <thead>
              <tr><th>读音</th><th>反切</th><th>声母</th><th>韵母</th><th>等</th><th>呼</th><th>声调</th><th>IPA</th><th>韵摄</th><th>释义</th></tr>
            </thead>
            <tbody>
              ${readings.map((r, i) => `
                <tr>
                  <td>读音 ${i + 1}</td>
                  <td>${escapeHtml((r.fanqie || '') + '切')}</td>
                  <td>${escapeHtml(r.shengmu || '…')}</td>
                  <td>${escapeHtml((r.yunbu || '…') + '韻')}</td>
                  <td>${escapeHtml((r.deng || '…') + '等')}</td>
                  <td>${escapeHtml((r.hu || '…') + '口')}</td>
                  <td>${escapeHtml((r.shengdiao || '…') + '聲')}</td>
                  <td class="detail-ipa">/${escapeHtml(r.ipa || '…')}/</td>
                  <td>${escapeHtml((r.she || '…') + '攝')}</td>
                  <td class="detail-def">${escapeHtml(r.definition || '')}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </td>
    </tr>
  ` : '';
  return `
    <tr data-char="${char}">
      <td class="col-char">${toggleBtn}${char}${multiBadge}</td>
      <td class="col-fanqie">${fanqie}</td>
      <td><span class="mini-tag mini-tag-initial">${shengmu}</span></td>
      <td><span class="mini-tag mini-tag-final">${yunbu}</span></td>
      <td><span class="mini-tag mini-tag-deng">${deng}</span></td>
      <td><span class="mini-tag mini-tag-hu">${hu}</span></td>
      <td><span class="mini-tag mini-tag-tone">${shengdiao}</span></td>
      <td style="font-family:var(--font-ipa);">${ipa}</td>
      <td>${she}</td>
      <td class="col-audio">
        <button class="btn-table-audio" data-char="${char}" title="播放">&#9654;</button>
      </td>
    </tr>
    ${detailRows}
  `;
}

function updateFilterRow(char, detail) {
  let row = null;
  document.querySelectorAll('#table-body tr[data-char]').forEach(r => {
    if (r.dataset.char === char) row = r;
  });
  if (!row) return;
  const cells = row.querySelectorAll('td');
  if (cells.length < 9) return;
  cells[1].textContent = detail.fanqie + '切';
  cells[2].innerHTML = `<span class="mini-tag mini-tag-initial">${detail.shengmu}</span>`;
  cells[3].innerHTML = `<span class="mini-tag mini-tag-final">${detail.yunbu}</span>`;
  cells[4].innerHTML = `<span class="mini-tag mini-tag-deng">${detail.deng}等</span>`;
  cells[5].innerHTML = `<span class="mini-tag mini-tag-hu">${detail.hu}</span>`;
  cells[6].innerHTML = `<span class="mini-tag mini-tag-tone">${detail.shengdiao}</span>`;
  cells[7].textContent = '/' + detail.ipa + '/';
  cells[8].textContent = detail.she + '攝';
}

function bindFilterRowEvents(tbody, start, end) {
  const rows = Array.from(tbody.querySelectorAll('tr[data-char]'));
  for (let i = start; i < end; i++) {
    const row = rows[i];
    if (!row) continue;
    const char = row.dataset.char;
    const charCell = row.querySelector('.col-char');
    const audioBtn = row.querySelector('.btn-table-audio');
    if (charCell) charCell.addEventListener('click', () => openCharDetail(char));
    const toggleBtn = row.querySelector('.row-toggle');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const detailRow = tbody.querySelector(`tr.row-detail[data-char-detail="${char}"]`);
        if (!detailRow) return;
        const expanded = toggleBtn.getAttribute('aria-expanded') === 'true';
        toggleBtn.setAttribute('aria-expanded', String(!expanded));
        toggleBtn.classList.toggle('open', !expanded);
        detailRow.hidden = expanded;
      });
    }
    if (audioBtn) {
      audioBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        playAudioForChar(char, audioBtn);
      });
    }
  }
}

function removeFilterSentinel() {
  const sentinel = $('#filter-sentinel');
  if (sentinel) sentinel.remove();
}

function finishFilterRows() {
  removeFilterSentinel();
  if (App.filterObserver) {
    App.filterObserver.disconnect();
    App.filterObserver = null;
  }
  if (App.filterScrollHandler) {
    window.removeEventListener('scroll', App.filterScrollHandler);
    App.filterScrollHandler = null;
  }
}

function appendFilterSentinel() {
  const tbody = $('#table-body');
  if (!tbody) return;
  removeFilterSentinel();
  const tr = document.createElement('tr');
  tr.id = 'filter-sentinel';
  tr.innerHTML = '<td colspan="10" style="text-align:center;padding:16px;color:var(--color-text-muted);">加载中…</td>';
  tbody.appendChild(tr);

  if (App.filterObserver) {
    App.filterObserver.disconnect();
    App.filterObserver = null;
  }
  if ('IntersectionObserver' in window) {
    App.filterObserver = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) loadMoreFilterRows();
    }, { rootMargin: '160px 0px' });
    App.filterObserver.observe(tr);
  } else if (!App.filterScrollHandler) {
    App.filterScrollHandler = () => {
      const sentinel = $('#filter-sentinel');
      if (!sentinel) return;
      const rect = sentinel.getBoundingClientRect();
      if (rect.top < window.innerHeight + 160) loadMoreFilterRows();
    };
    window.addEventListener('scroll', App.filterScrollHandler, { passive: true });
  }
}

async function loadMoreFilterRows() {
  if (App.filterBusy || !hasMoreRawResults()) {
    if (!hasMoreRawResults()) finishFilterRows();
    return;
  }
  App.filterBusy = true;
  try {
    await fillFilterRows();
  } finally {
    App.filterBusy = false;
  }
  if (hasMoreRawResults()) {
    removeFilterSentinel();
    appendFilterSentinel();
  } else {
    finishFilterRows();
  }
}

// ============ 反切搜索 ============
async function ensureFanqieIndex() {
  if (App.fanqieShangqie && App.fanqieXiaqie) return;
  const text = await fetchText('data/fanqieindex.txt');
  const lines = text.split(/\r?\n/).filter(line => line.trim() !== '');
  if (lines.length < 2) throw new Error('fanqieindex 格式错误，需2行');
  App.filterIndex.shangqie = Array.from(lines[0].trim()).filter(ch => ch !== '0');
  App.filterIndex.xiaqie = Array.from(lines[1].trim()).filter(ch => ch !== '0');
  App.fanqieShangqie = new Set(App.filterIndex.shangqie);
  App.fanqieXiaqie = new Set(App.filterIndex.xiaqie);
}

async function loadFanqieCharList(side, chars) {
  const list = [];
  const seen = new Set();
  const parts = await Promise.all(chars.map(ch =>
    fetchText(`data/fanqie/${side}/${getHexFromChar(ch)}.txt`)
      .then(parseCharListText)
      .catch(e => {
        console.warn(`读取反切索引文件失败: ${side} / ${ch}`, e);
        return [];
      })
  ));
  parts.forEach(part => part.forEach(c => {
    if (!seen.has(c)) { seen.add(c); list.push(c); }
  }));
  return list;
}

async function loadFanqieCandidates(shangChars, xiaChars) {
  if (!shangChars.length && !xiaChars.length) return [];
  try {
    await ensureFanqieIndex();
  } catch (e) {
    console.warn('读取反切索引失败: data/fanqieindex.txt', e);
    return null;
  }
  if (shangChars.some(ch => !App.fanqieShangqie.has(ch)) ||
      xiaChars.some(ch => !App.fanqieXiaqie.has(ch))) {
    return [];
  }
  const [shangList, xiaList] = await Promise.all([
    shangChars.length ? loadFanqieCharList('shangqie', shangChars) : Promise.resolve([]),
    xiaChars.length ? loadFanqieCharList('xiaqie', xiaChars) : Promise.resolve([])
  ]);
  const xiaSet = new Set(xiaList);
  if (shangList.length && xiaList.length) return shangList.filter(ch => xiaSet.has(ch));
  return shangList.length ? shangList : xiaList;
}

async function startFanqieSearch() {
  const shangChars = App.filters.shangqie || [];
  const xiaChars = App.filters.xiaqie || [];
  if (!shangChars.length && !xiaChars.length) {
    showToast('请至少选择一个上切或下切');
    return;
  }
  const fanqie = (shangChars[0] || '') + (xiaChars[0] || '');
  const url = new URL(window.location);
  url.searchParams.delete('q');
  if (shangChars.length) url.searchParams.set('shang', shangChars.join(','));
  else url.searchParams.delete('shang');
  if (xiaChars.length) url.searchParams.set('xia', xiaChars.join(','));
  else url.searchParams.delete('xia');
  window.history.pushState({}, '', url);

  const tbody = $('#table-body');
  const countEl = $('#result-count');
  const jobId = ++App.fanqieJobId;
  finishFanqieRows();
  App.fanqieQuery = fanqie;
  App.fanqieQueue = [];
  App.fanqieResults = [];
  App.fanqieRendered = 0;
  App.fanqiePage = 0;
  App.fanqieBusy = false;
  if (tbody) tbody.innerHTML = `<tr id="fanqie-loading-row"><td colspan="10" style="text-align:center;padding:var(--space-2xl);color:var(--color-text-muted);">正在搜索反切「${escapeHtml(fanqie)}」…</td></tr>`;
  if (countEl) countEl.innerHTML = '正在搜索…';

  try {
    const chars = await loadFanqieCandidates(shangChars, xiaChars);
    if (jobId !== App.fanqieJobId) return;
    if (chars === null) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:var(--space-2xl);color:var(--color-text-muted);">未找到反切索引，无法搜索</td></tr>`;
      if (countEl) countEl.innerHTML = '共 <strong>0</strong> 条结果';
      return;
    }
    if (chars.length === 0) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:var(--space-2xl);color:var(--color-text-muted);">没有符合条件的结果</td></tr>`;
      if (countEl) countEl.innerHTML = '共 <strong>0</strong> 条结果';
      return;
    }
    App.fanqieQueue = chars;
    await loadMoreFanqieRows();
  } catch (e) {
    console.error('反切搜索失败:', e);
    showToast('反切搜索失败: ' + e.message);
  }
}

function applyFanqieUrlQuery() {
  if (!$('#chips-shangqie')) return;
  const params = new URLSearchParams(window.location.search);
  let shangList = (params.get('shang') || '').split(',').map(s => s.trim()).filter(Boolean);
  let xiaList = (params.get('xia') || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!shangList.length && !xiaList.length) {
    const q = params.get('q') || '';
    const fanqie = q.replace(/\s+/g, '').replace(/切$/, '').trim();
    if (fanqie.length !== 2) return;
    shangList = [fanqie[0]];
    xiaList = [fanqie[1]];
  }
  let selected = 0;
  shangList.forEach(ch => {
    const chip = $(`#chips-shangqie .filter-chip[data-value="${ch}"]`);
    if (chip) { chip.classList.add('selected'); selected++; }
  });
  xiaList.forEach(ch => {
    const chip = $(`#chips-xiaqie .filter-chip[data-value="${ch}"]`);
    if (chip) { chip.classList.add('selected'); selected++; }
  });
  if (selected) {
    App.filters.shangqie = shangList;
    App.filters.xiaqie = xiaList;
    reorderFanqieChips($('#chips-shangqie'), App.filterIndex.shangqie || []);
    reorderFanqieChips($('#chips-xiaqie'), App.filterIndex.xiaqie || []);
    startFanqieSearch();
  }
}

function hasMoreFanqieRaw() {
  return App.fanqiePage < App.fanqieQueue.length;
}

async function takeNextFanqieChar() {
  if (App.fanqiePage < App.fanqieQueue.length) {
    return App.fanqieQueue[App.fanqiePage++];
  }
  return null;
}

async function fillFanqieRows() {
  const target = App.fanqieRendered + 15;
  let processed = 0;
  while (App.fanqieResults.length < target && processed < FILTER_BATCH_CANDIDATES && hasMoreFanqieRaw()) {
    const char = await takeNextFanqieChar();
    if (!char) break;
    processed++;
    let readings = App.charReadings[char] && App.charReadings[char].length
      ? App.charReadings[char]
      : await getCharReadings(char);
    if (!readings || !readings.length) continue;
    App.fanqieResults.push(char);
  }
  renderNewFanqieRows();
}

function renderNewFanqieRows() {
  const tbody = $('#table-body');
  if (!tbody) return;
  let html = '';
  for (let i = App.fanqieRendered; i < App.fanqieResults.length; i++) {
    html += buildFilterRowHtml(App.fanqieResults[i]);
  }
  if (html) {
    const loadingRow = tbody.querySelector('#fanqie-loading-row');
    if (loadingRow) loadingRow.remove();
    const sentinel = $('#fanqie-sentinel');
    if (sentinel) sentinel.insertAdjacentHTML('beforebegin', html);
    else tbody.insertAdjacentHTML('beforeend', html);
    bindFilterRowEvents(tbody, App.fanqieRendered, App.fanqieResults.length);
    App.fanqieRendered = App.fanqieResults.length;
  }
  const countEl = $('#result-count');
  if (countEl) {
    countEl.innerHTML = `已确认 <strong>${App.fanqieResults.length}</strong> 条${
      hasMoreFanqieRaw() ? '（继续加载中…）' : ''
    }`;
  }
}

function removeFanqieSentinel() {
  const sentinel = $('#fanqie-sentinel');
  if (sentinel) sentinel.remove();
}

function finishFanqieRows() {
  removeFanqieSentinel();
  if (App.fanqieObserver) {
    App.fanqieObserver.disconnect();
    App.fanqieObserver = null;
  }
  if (App.fanqieScrollHandler) {
    window.removeEventListener('scroll', App.fanqieScrollHandler);
    App.fanqieScrollHandler = null;
  }
}

function appendFanqieSentinel() {
  const tbody = $('#table-body');
  if (!tbody) return;
  removeFanqieSentinel();
  const tr = document.createElement('tr');
  tr.id = 'fanqie-sentinel';
  tr.innerHTML = '<td colspan="10" style="text-align:center;padding:16px;color:var(--color-text-muted);">加载中…</td>';
  tbody.appendChild(tr);
  if ('IntersectionObserver' in window) {
    App.fanqieObserver = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) loadMoreFanqieRows();
    }, { rootMargin: '160px 0px' });
    App.fanqieObserver.observe(tr);
  } else if (!App.fanqieScrollHandler) {
    App.fanqieScrollHandler = () => {
      const sentinel = $('#fanqie-sentinel');
      if (!sentinel) return;
      const rect = sentinel.getBoundingClientRect();
      if (rect.top < window.innerHeight + 160) loadMoreFanqieRows();
    };
    window.addEventListener('scroll', App.fanqieScrollHandler, { passive: true });
  }
}

async function loadMoreFanqieRows() {
  if (App.fanqieBusy || !hasMoreFanqieRaw()) {
    if (!hasMoreFanqieRaw()) {
      const tbody = $('#table-body');
      if (tbody && App.fanqieResults.length === 0) {
        tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:var(--space-2xl);color:var(--color-text-muted);">没有符合条件的结果</td></tr>`;
      }
      const countEl = $('#result-count');
      if (countEl && App.fanqieResults.length === 0) countEl.innerHTML = '共 <strong>0</strong> 条结果';
      finishFanqieRows();
    }
    return;
  }
  App.fanqieBusy = true;
  try {
    await fillFanqieRows();
  } finally {
    App.fanqieBusy = false;
  }
  if (hasMoreFanqieRaw()) {
    removeFanqieSentinel();
    appendFanqieSentinel();
  } else {
    finishFanqieRows();
  }
}

// ============ 批量播放、导出、复制 ============
function initBrowserActions() {
  const batchBtn = $('#btn-batch-play');
  const exportBtn = $('#btn-export-csv');
  const copyBtn = $('#btn-copy-table');
  if (batchBtn) batchBtn.addEventListener('click', toggleBatchPlay);
  if (exportBtn) exportBtn.addEventListener('click', exportCSV);
  if (copyBtn) copyBtn.addEventListener('click', copyTable);
  const resetBtn = $('#btn-filter-reset');
  const applyBtn = $('#btn-filter-apply');
  if (resetBtn) resetBtn.addEventListener('click', () => { resetFilters(); applyFilters(); });
  if (applyBtn) applyBtn.addEventListener('click', applyFilters);
}

function toggleBatchPlay() {
  if (App.batchTimer) { stopBatchPlay(); return; }
  startBatchPlay();
}
function startBatchPlay() {
  const rows = $$('#table-body tr[data-char]');
  if (rows.length === 0) { showToast('没有可播放的数据'); return; }
  const btn = $('#btn-batch-play');
  btn.innerHTML = '&#9632; 停止播放';
  btn.classList.add('primary');
  App.batchIndex = 0;
  playBatchNext(rows);
}
function playBatchNext(rows) {
  if (App.batchIndex >= rows.length) { stopBatchPlay(); return; }
  const row = rows[App.batchIndex];
  const char = row.dataset.char;
  $$('#table-body tr').forEach(r => r.style.background = '');
  row.style.background = 'var(--color-primary-bg)';
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const btn = row.querySelector('.btn-table-audio');
  if (btn) {
    playAudioForChar(char, btn);
    const audio = App.activeAudio;
    if (audio) {
      const endedHandler = () => {
        audio.removeEventListener('ended', endedHandler);
        App.batchIndex++;
        App.batchTimer = setTimeout(() => playBatchNext(rows), 400);
      };
      audio.addEventListener('ended', endedHandler);
      const errHandler = () => {
        audio.removeEventListener('error', errHandler);
        App.batchIndex++;
        App.batchTimer = setTimeout(() => playBatchNext(rows), 200);
      };
      audio.addEventListener('error', errHandler);
    } else {
      App.batchIndex++;
      App.batchTimer = setTimeout(() => playBatchNext(rows), 200);
    }
  } else {
    App.batchIndex++;
    App.batchTimer = setTimeout(() => playBatchNext(rows), 200);
  }
}
function stopBatchPlay() {
  if (App.batchTimer) { clearTimeout(App.batchTimer); App.batchTimer = null; }
  if (App.activeAudio) { App.activeAudio.pause(); App.activeAudio = null; }
  App.batchIndex = 0;
  const btn = $('#btn-batch-play');
  if (!btn) return;
  btn.innerHTML = '&#9654; 顺序播放';
  btn.classList.remove('primary');
  $$('#table-body tr').forEach(r => r.style.background = '');
  $$('.btn-table-audio.playing').forEach(b => b.classList.remove('playing'));
}

function exportCSV() {
  const rows = $$('#table-body tr[data-char]');
  if (rows.length === 0) { showToast('没有可导出的数据'); return; }
  let csv = '\uFEFF字头,反切,声母,韵母,等,呼,声调,IPA,韵摄\n';
  rows.forEach(row => {
    const char = row.dataset.char;
    const d = App.charMap[char];
    if (!d) return;
    csv += `${d.char},${d.fanqie},${d.shengmu},${d.yunbu},${d.deng},${d.hu},${d.shengdiao},${d.ipa},${d.she}\n`;
  });
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '音韵数据导出.csv';
  a.click();
  URL.revokeObjectURL(url);
  showToast('导出成功');
}

function copyTable() {
  const rows = $$('#table-body tr[data-char]');
  if (rows.length === 0) { showToast('没有可复制的数据'); return; }
  let text = '字头\t反切\t声母\t韵母\t等\t呼\t声调\tIPA\t韵摄\n';
  rows.forEach(row => {
    const char = row.dataset.char;
    const d = App.charMap[char];
    if (!d) return;
    text += `${d.char}\t${d.fanqie}\t${d.shengmu}\t${d.yunbu}\t${d.deng}\t${d.hu}\t${d.shengdiao}\t${d.ipa}\t${d.she}\n`;
  });
  navigator.clipboard.writeText(text).then(() => showToast('已复制到剪贴板'))
    .catch(() => showToast('复制失败，请尝试导出CSV'));
}

// ============ 初始化 ============
document.addEventListener('DOMContentLoaded', async () => {
  const activeView = document.querySelector('.view.active');
  if (activeView) App.currentView = activeView.id.replace('view-', '');
  initCacheControl();
  initSettings();
  await loadData();
  initNavigation();
  initSearch();
  initBookmarks();
  initBrowserActions();
  initFilterSearch();
  initFilterGroupToggles();
  if ($('#chips-initial') || $('#chips-shangqie')) renderFilterChips();
  applyFanqieUrlQuery();
  // 默认显示浏览器时，应用一次筛选（无筛选时显示所有字）
  if (App.currentView === 'browser') {
    applyFilters();
  }
});
