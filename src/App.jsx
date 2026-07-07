import { useState, useEffect, useRef } from 'react';
import Database from '@tauri-apps/plugin-sql';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { save, open } from '@tauri-apps/plugin-dialog';
import { writeTextFile, readTextFile } from '@tauri-apps/plugin-fs';
import { availableMonitors, cursorPosition, getCurrentWindow, monitorFromPoint } from '@tauri-apps/api/window';
import { LogicalSize, PhysicalPosition } from '@tauri-apps/api/dpi';
import { pinyin } from 'pinyin-pro';
import './App.css';

const WINDOW_W = 420;
const COMPACT_H = 350;
const FULL_H = 580;

// 缓存的是初始化 Promise，而不是 db 实例：
// 多个并发 getDb() 在 Database.load 返回前都会看到 null，
// 缓存 Promise 可保证只触发一次 load + 一次建表。
let dbPromise = null;

async function getDb() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const database = await Database.load('sqlite:clipmate.db');
      await database.execute(`
        CREATE TABLE IF NOT EXISTS templates (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          tags TEXT DEFAULT '[]',
          is_pinned INTEGER DEFAULT 0,
          use_count INTEGER DEFAULT 0,
          last_used_at TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);
      try {
        await database.execute('ALTER TABLE templates ADD COLUMN is_pinned INTEGER DEFAULT 0');
      } catch (_) {
        // Column already exists on upgraded databases.
      }
      await database.execute(`
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);
      return database;
    })().catch(err => {
      // 初始化失败时清空缓存，下次调用可重试，避免永久卡死
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

function parseTags(raw) {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v : [];
  } catch (_) {
    return [];
  }
}

// 生成拼音检索串：全拼 + 首字母，便于「rb → 日报」这类模糊匹配。
// 非中文原样保留（consecutive 让连续英文合并成一段）。
function pinyinForms(text) {
  if (!text) return '';
  try {
    const full = pinyin(text, { toneType: 'none', type: 'array', nonZh: 'consecutive' }).join('');
    const initials = pinyin(text, { pattern: 'first', toneType: 'none', type: 'array', nonZh: 'consecutive' }).join('');
    return `${full} ${initials}`;
  } catch (_) {
    return '';
  }
}

// 预建每条模板的检索索引（标题/正文/标签的字面 + 标题和标签的拼音）。
// 正文只取字面、不做拼音，避免长文本拼音开销。
function buildSearchIndex(title, content, tags) {
  const tagText = tags.join(' ');
  const py = pinyinForms(`${title} ${tagText}`);
  return `${title}\n${content}\n${tagText}\n${py}`.toLowerCase();
}

// 在文本中高亮命中的查询子串（仅字面匹配，拼音命中不参与高亮）。
function highlightText(text, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q || !text) return text;
  const lower = text.toLowerCase();
  let idx = lower.indexOf(q);
  if (idx === -1) return text;

  const parts = [];
  let i = 0;
  let key = 0;
  while (idx !== -1) {
    if (idx > i) parts.push(text.slice(i, idx));
    parts.push(<mark className="hl" key={key++}>{text.slice(idx, idx + q.length)}</mark>);
    i = idx + q.length;
    idx = lower.indexOf(q, i);
  }
  if (i < text.length) parts.push(text.slice(i));
  return parts;
}

function normalizeTemplate(template) {
  const tags = parseTags(template.tags);
  return {
    ...template,
    tags,
    is_pinned: Number(template.is_pinned) === 1 ? 1 : 0,
    use_count: Number(template.use_count) || 0,
    _search: buildSearchIndex(template.title || '', template.content || '', tags),
  };
}

function orderTemplates(templates, savedOrder = []) {
  const order = savedOrder.map(Number).filter(Number.isFinite);
  const orderIndex = new Map(order.map((id, index) => [id, index]));
  return [...templates].sort((a, b) => {
    if (b.is_pinned !== a.is_pinned) return b.is_pinned - a.is_pinned;

    const aIndex = orderIndex.has(a.id) ? orderIndex.get(a.id) : Number.MAX_SAFE_INTEGER;
    const bIndex = orderIndex.has(b.id) ? orderIndex.get(b.id) : Number.MAX_SAFE_INTEGER;
    if (aIndex !== bIndex) return aIndex - bIndex;

    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
}

function dateScore(value) {
  if (!value) return 0;
  const time = new Date(value.replace(' ', 'T')).getTime();
  if (!Number.isFinite(time)) return 0;
  const ageHours = Math.max(0, (Date.now() - time) / 36e5);
  return Math.max(0, 120 - ageHours);
}

function buildSmartTemplates(templates) {
  return [...templates]
    .filter(t => t.is_pinned || t.use_count > 0 || t.last_used_at)
    .sort((a, b) => {
      const aScore = (a.is_pinned ? 10000 : 0) + a.use_count * 90 + dateScore(a.last_used_at);
      const bScore = (b.is_pinned ? 10000 : 0) + b.use_count * 90 + dateScore(b.last_used_at);
      if (bScore !== aScore) return bScore - aScore;
      return new Date(b.last_used_at || b.created_at).getTime() - new Date(a.last_used_at || a.created_at).getTime();
    })
    .slice(0, 5);
}

function parseSavedPosition(raw) {
  try {
    const { x, y } = JSON.parse(raw);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      return { x, y };
    }
  } catch (_) {
    // handled by caller
  }
  return null;
}

function isPositionOnVisibleDisplay(pos, monitors) {
  const minVisible = 80;
  return monitors.some(monitor => {
    const area = monitor.workArea ?? { position: monitor.position, size: monitor.size };
    const left = area.position.x;
    const top = area.position.y;
    const right = left + area.size.width;
    const bottom = top + area.size.height;

    return (
      pos.x < right - minVisible &&
      pos.x + WINDOW_W > left + minVisible &&
      pos.y < bottom - minVisible &&
      pos.y + COMPACT_H > top + minVisible
    );
  });
}

async function restoreSavedPosition(appWindow) {
  const saved = localStorage.getItem('clipmate-position');
  if (!saved) return;

  const pos = parseSavedPosition(saved);
  if (!pos) {
    localStorage.removeItem('clipmate-position');
    return;
  }

  try {
    const monitors = await availableMonitors();
    if (monitors.length > 0 && !isPositionOnVisibleDisplay(pos, monitors)) {
      localStorage.removeItem('clipmate-position');
      return;
    }
    await appWindow.setPosition(new PhysicalPosition(pos.x, pos.y));
  } catch (_) {
    localStorage.removeItem('clipmate-position');
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

async function moveNearCurrentPointer(appWindow, expanded = false) {
  const height = expanded ? FULL_H : COMPACT_H;
  const gap = 16;

  try {
    const cursor = await cursorPosition();
    const monitor = await monitorFromPoint(cursor.x, cursor.y);
    if (!monitor) return;

    const area = monitor.workArea ?? { position: monitor.position, size: monitor.size };
    const left = area.position.x;
    const top = area.position.y;
    const right = left + area.size.width;
    const bottom = top + area.size.height;

    let x = cursor.x - WINDOW_W / 2;
    let y = cursor.y + gap;
    if (y + height > bottom - gap) {
      y = cursor.y - height - gap;
    }

    x = clamp(x, left + gap, right - WINDOW_W - gap);
    y = clamp(y, top + gap, bottom - height - gap);
    await appWindow.setPosition(new PhysicalPosition(Math.round(x), Math.round(y)));
  } catch (_) {
    restoreSavedPosition(appWindow);
  }
}

export default function App() {
  const [templates, setTemplates] = useState([]);
  const [startupError, setStartupError] = useState(null);
  const [search, setSearch] = useState('');
  const [selectedTag, setSelectedTag] = useState(null);
  const [recentTemplates, setRecentTemplates] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState(null);
  const [allTags, setAllTags] = useState([]);
  const [copiedId, setCopiedId] = useState(null);
  const [copyError, setCopyError] = useState(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem('clipmate-theme') || 'dark');
  const [toast, setToast] = useState(null);        // { type: 'ok' | 'err', msg }
  const [menuOpen, setMenuOpen] = useState(false);
  const toastTimerRef = useRef(null);

  // 拖动排序状态
  const [draggingId, setDraggingId] = useState(null);
  const dragActiveRef = useRef(false);
  const longPressTimerRef = useRef(null);
  const pressStartRef = useRef({ x: 0, y: 0 });
  const wasLongPressRef = useRef(false);
  const draggingIdRef = useRef(null);
  const templatesRef = useRef([]);

  // 键盘导航
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const selectedIndexRef = useRef(-1);
  const filteredRef = useRef([]);
  const mainListRef = useRef(null);

  const searchRef = useRef(null);
  const modalOpenRef = useRef(false);
  const isExpandedRef = useRef(false);

  // 保持 templatesRef 与 templates state 同步，供拖拽事件处理器读取
  useEffect(() => { templatesRef.current = templates; }, [templates]);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    // StrictMode 下 effect 可能 mount/unmount 重放：如果 cleanup 先于
    // Promise resolve 跑，unlisten 还没赋值，监听器就泄漏了。
    // 用 disposed 标记：resolve 后若已 cleanup，立即调用 fn 解绑。
    let unlisten;
    let disposed = false;
    appWindow.onFocusChanged(({ payload: focused }) => {
      if (focused) {
        moveNearCurrentPointer(appWindow, isExpandedRef.current);
        setTimeout(() => searchRef.current?.focus(), 60);
      }
      // 永久固定，失焦不隐藏
    }).then(fn => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // 初始化
  useEffect(() => {
    loadTemplates().catch(err => {
      console.error('initial template load failed', err);
      setStartupError('初始化失败，可能是数据库或 Tauri 运行时没有准备好。');
    });

    const appWindow = getCurrentWindow();
    const handleKey = (e) => {
      if (e.key === 'Escape') {
        if (modalOpenRef.current) {
          closeModal();
        } else {
          appWindow.hide();
        }
        return;
      }

      // Modal 打开时不接管列表导航键
      if (modalOpenRef.current) return;

      // ⌘1–⌘9 / Ctrl+1–9：直接复制第 N 条（用修饰键避开搜索框输入数字的冲突）
      if ((e.metaKey || e.ctrlKey) && !e.altKey && /^[1-9]$/.test(e.key)) {
        const idx = Number(e.key) - 1;
        const list = filteredRef.current;
        if (idx < list.length) {
          e.preventDefault();
          copyTemplate(list[idx]).then(ok => { if (ok) appWindow.hide(); });
        }
        return;
      }

      if (e.key === 'ArrowDown') {
        const len = filteredRef.current.length;
        if (len === 0) return;
        e.preventDefault();
        const cur = selectedIndexRef.current;
        setSelectedIndex(cur < 0 ? 0 : (cur + 1) % len);
      } else if (e.key === 'ArrowUp') {
        const len = filteredRef.current.length;
        if (len === 0) return;
        e.preventDefault();
        const cur = selectedIndexRef.current;
        setSelectedIndex(cur < 0 ? len - 1 : (cur - 1 + len) % len);
      } else if (e.key === 'Enter') {
        const list = filteredRef.current;
        const i = selectedIndexRef.current;
        if (i >= 0 && i < list.length) {
          e.preventDefault();
          // 复制失败时不隐藏窗口，让用户看到错误高亮
          copyTemplate(list[i]).then(ok => { if (ok) appWindow.hide(); });
        }
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  // 同步 selectedIndex 到 ref（供全局 keydown 闭包读取）
  useEffect(() => { selectedIndexRef.current = selectedIndex; }, [selectedIndex]);

  // 搜索或标签筛选变化时，重置选中到第一项
  useEffect(() => {
    setSelectedIndex(-1);
  }, [search, selectedTag]);

  // 选中项变化时滚动到可见区域
  useEffect(() => {
    if (selectedIndex < 0 || !mainListRef.current) return;
    const t = filteredRef.current[selectedIndex];
    if (!t) return;
    const el = mainListRef.current.querySelector(`[data-card-id="${t.id}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  useEffect(() => {
    modalOpenRef.current = showModal;
  }, [showModal]);

  // 位置记忆
  useEffect(() => {
    const appWindow = getCurrentWindow();
    restoreSavedPosition(appWindow);
    let unlistenMove;
    let disposed = false;
    appWindow.onMoved(({ payload: pos }) => {
      localStorage.setItem('clipmate-position', JSON.stringify({ x: pos.x, y: pos.y }));
    }).then(fn => {
      if (disposed) fn();
      else unlistenMove = fn;
    });
    return () => {
      disposed = true;
      unlistenMove?.();
    };
  }, []);

  async function toggleSize() {
    const next = !isExpanded;
    setIsExpanded(next);
    isExpandedRef.current = next;
    await getCurrentWindow().setSize(new LogicalSize(WINDOW_W, next ? FULL_H : COMPACT_H)).catch(() => {});
  }

  function toggleTheme() {
    setTheme(prev => {
      const next = prev === 'dark' ? 'light' : 'dark';
      localStorage.setItem('clipmate-theme', next);
      return next;
    });
  }

  function showToast(msg, type = 'ok') {
    setToast({ msg, type });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 2200);
  }

  // 导出：按当前显示顺序写出 JSON 备份文件。
  // 不导出数据库 id（导入后会变），顺序由数组次序决定，导入时按序重建。
  async function exportTemplates() {
    setMenuOpen(false);
    try {
      const rows = templates.map(t => ({
        title: t.title,
        content: t.content,
        tags: t.tags,
        is_pinned: t.is_pinned,
        use_count: t.use_count,
        last_used_at: t.last_used_at ?? null,
        created_at: t.created_at ?? null,
      }));
      const payload = {
        app: 'ClipMate',
        schema: 1,
        exported_at: new Date().toISOString(),
        templates: rows,
      };
      const stamp = new Date().toISOString().slice(0, 10);
      const path = await save({
        defaultPath: `clipmate-backup-${stamp}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (!path) return; // 用户取消
      await writeTextFile(path, JSON.stringify(payload, null, 2));
      showToast(`已导出 ${rows.length} 条模板`, 'ok');
    } catch (err) {
      console.error('export failed', err);
      showToast('导出失败', 'err');
    }
  }

  // 导入：非破坏性追加，不覆盖已有模板；无效条目跳过。
  async function importTemplates() {
    setMenuOpen(false);
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (!selected) return;
      const path = Array.isArray(selected) ? selected[0] : selected;
      const text = await readTextFile(path);
      const data = JSON.parse(text);
      const list = Array.isArray(data) ? data : data?.templates;
      if (!Array.isArray(list)) {
        showToast('文件格式不正确', 'err');
        return;
      }

      const database = await getDb();
      const newIds = [];
      let skipped = 0;
      for (const item of list) {
        const title = typeof item?.title === 'string' ? item.title.trim() : '';
        const content = typeof item?.content === 'string' ? item.content : '';
        if (!title || !content) { skipped++; continue; }
        const tags = Array.isArray(item.tags) ? item.tags : parseTags(item.tags);
        const res = await database.execute(
          `INSERT INTO templates (title, content, tags, is_pinned, use_count, last_used_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
          [title, content, JSON.stringify(tags), item.is_pinned ? 1 : 0, Number(item.use_count) || 0, item.last_used_at ?? null, item.created_at ?? null]
        );
        if (res.lastInsertId != null) newIds.push(res.lastInsertId);
      }

      // 追加到现有排序末尾
      if (newIds.length > 0) {
        const orderRow = await database.select("SELECT value FROM settings WHERE key = 'template_order'");
        let oldOrder = [];
        if (orderRow.length > 0) {
          try { oldOrder = JSON.parse(orderRow[0].value); } catch (_) { oldOrder = []; }
        }
        const merged = [...oldOrder.filter(id => !newIds.includes(id)), ...newIds];
        await database.execute(
          "INSERT OR REPLACE INTO settings (key, value) VALUES ('template_order', ?)",
          [JSON.stringify(merged)]
        );
      }

      await loadTemplates();
      const msg = skipped > 0
        ? `导入 ${newIds.length} 条（跳过 ${skipped} 条无效）`
        : `导入 ${newIds.length} 条模板`;
      showToast(msg, newIds.length > 0 ? 'ok' : 'err');
    } catch (err) {
      console.error('import failed', err);
      showToast('导入失败：文件无法解析', 'err');
    }
  }

  function openModal(template) {
    modalOpenRef.current = true;
    setEditingTemplate(template ?? null);
    setShowModal(true);
  }

  function closeModal() {
    modalOpenRef.current = false;
    setShowModal(false);
    setEditingTemplate(null);
  }

  async function loadTemplates() {
    const database = await getDb();
    const all = await database.select('SELECT * FROM templates ORDER BY created_at DESC');
    const parsed = all.map(normalizeTemplate);

    // 读取保存的排序
    const orderRow = await database.select("SELECT value FROM settings WHERE key = 'template_order'");
    let savedOrder = [];
    if (orderRow.length > 0) {
      try {
        savedOrder = JSON.parse(orderRow[0].value);
      } catch (_) {
        savedOrder = [];
      }
    }

    const ordered = orderTemplates(parsed, savedOrder);
    setTemplates(ordered);
    setRecentTemplates(buildSmartTemplates(ordered));

    const tags = new Set();
    all.forEach(t => parseTags(t.tags).forEach(tag => tags.add(tag)));
    setAllTags(Array.from(tags));
    setStartupError(null);
  }

  async function saveOrder(ordered) {
    const database = await getDb();
    const ids = ordered.map(t => t.id);
    await database.execute(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('template_order', ?)",
      [JSON.stringify(ids)]
    );
  }

  async function copyTemplate(template) {
    try {
      await writeText(template.content);
    } catch (err) {
      console.error('clipboard write failed', err);
      setCopyError(template.id);
      setTimeout(() => setCopyError(null), 1600);
      return false;
    }
    try {
      const database = await getDb();
      await database.execute(
        'UPDATE templates SET use_count = use_count + 1, last_used_at = datetime("now") WHERE id = ?',
        [template.id]
      );
    } catch (err) {
      // 复制本身已成功，DB 统计失败不影响主流程
      console.warn('use_count update failed', err);
    }
    setCopiedId(template.id);
    setTimeout(() => setCopiedId(null), 700);
    loadTemplates();
    return true;
  }

  async function togglePinned(template) {
    const next = template.is_pinned ? 0 : 1;
    const database = await getDb();
    await database.execute('UPDATE templates SET is_pinned = ? WHERE id = ?', [next, template.id]);
    loadTemplates();
  }

  async function saveTemplate(data) {
    const database = await getDb();
    if (editingTemplate) {
      await database.execute(
        'UPDATE templates SET title = ?, content = ?, tags = ? WHERE id = ?',
        [data.title, data.content, JSON.stringify(data.tags), editingTemplate.id]
      );
    } else {
      const result = await database.execute(
        'INSERT INTO templates (title, content, tags) VALUES (?, ?, ?)',
        [data.title, data.content, JSON.stringify(data.tags)]
      );
      // 新模板插入到 template_order 最前，避免永远沉底
      const newId = result.lastInsertId;
      if (newId != null) {
        const orderRow = await database.select("SELECT value FROM settings WHERE key = 'template_order'");
        let oldOrder = [];
        if (orderRow.length > 0) {
          try { oldOrder = JSON.parse(orderRow[0].value); } catch (_) { oldOrder = []; }
        }
        const newOrder = [newId, ...oldOrder.filter(id => id !== newId)];
        await database.execute(
          "INSERT OR REPLACE INTO settings (key, value) VALUES ('template_order', ?)",
          [JSON.stringify(newOrder)]
        );
      }
    }
    closeModal();
    loadTemplates();
  }

  async function deleteTemplate(id) {
    const database = await getDb();
    await database.execute('DELETE FROM templates WHERE id = ?', [id]);
    // 从保存的排序中也移除
    const newTemplates = templates.filter(t => t.id !== id);
    await saveOrder(newTemplates);
    loadTemplates();
  }

  // ── 拖动排序（实时重排，50ms 触发）──────────────────────────────
  function clearPendingDrag() {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }

  function removeDragListeners() {
    document.removeEventListener('pointermove', onDocPointerMove);
    document.removeEventListener('pointerup', onDocPointerUp);
    document.removeEventListener('pointercancel', onDocPointerUp);
  }

  function handleCardPointerDown(template, e) {
    if (e.target.closest('.card-btns')) return;
    wasLongPressRef.current = false;

    // 只有点击拖拽手柄才进入拖拽模式
    if (!e.target.closest('.drag-hint')) return;

    pressStartRef.current = { x: e.clientX, y: e.clientY };
    clearPendingDrag();
    removeDragListeners();

    document.addEventListener('pointermove', onDocPointerMove);
    document.addEventListener('pointerup', onDocPointerUp);
    document.addEventListener('pointercancel', onDocPointerUp);

    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null;
      wasLongPressRef.current = true;
      dragActiveRef.current = true;
      draggingIdRef.current = template.id;
      setDraggingId(template.id);
    }, 80);
  }

  function handleCardPointerMove(e) {
    if (dragActiveRef.current) return;
    const dx = Math.abs(e.clientX - pressStartRef.current.x);
    const dy = Math.abs(e.clientY - pressStartRef.current.y);
    if (dx > 6 || dy > 6) clearTimeout(longPressTimerRef.current);
  }

  function onDocPointerMove(e) {
    if (!dragActiveRef.current) {
      const dx = Math.abs(e.clientX - pressStartRef.current.x);
      const dy = Math.abs(e.clientY - pressStartRef.current.y);
      if (dx > 6 || dy > 6) clearPendingDrag();
      return;
    }

    const el = document.elementFromPoint(e.clientX, e.clientY);
    const card = el?.closest('[data-card-id]');
    if (!card) return;
    // 最近使用区也有 data-card-id 但不参与排序：拖到那里时忽略，
    // 否则会误改主列表 template_order
    if (!mainListRef.current?.contains(card)) return;
    const overId = parseInt(card.dataset.cardId);
    if (overId === draggingIdRef.current) return;

    // 实时重排列表
    const list = [...templatesRef.current];
    const fromIdx = list.findIndex(t => t.id === draggingIdRef.current);
    const toIdx = list.findIndex(t => t.id === overId);
    if (fromIdx !== -1 && toIdx !== -1) {
      const [moved] = list.splice(fromIdx, 1);
      list.splice(toIdx, 0, moved);
      templatesRef.current = list;
      setTemplates(list);
    }
  }

  async function onDocPointerUp() {
    clearPendingDrag();
    removeDragListeners();

    if (!dragActiveRef.current) return;
    dragActiveRef.current = false;

    const fromId = draggingIdRef.current;
    draggingIdRef.current = null;
    setDraggingId(null);

    if (fromId) {
      setTimeout(() => { wasLongPressRef.current = false; }, 0);
      await saveOrder(templatesRef.current);
    }
  }

  // 过滤
  const filtered = templates.filter(t => {
    const q = search.trim().toLowerCase();
    const qNoSpace = q.replace(/\s+/g, '');
    const idx = t._search || '';
    const matchSearch = !q || idx.includes(q) || (qNoSpace && idx.includes(qNoSpace));
    const matchTag = selectedTag === null || t.tags.includes(selectedTag);
    return matchSearch && matchTag;
  });

  filteredRef.current = filtered;

  const showRecent = recentTemplates.length > 0 && !search && selectedTag === null;

  return (
    <div className={`app ${isExpanded ? 'app--expanded' : ''} ${theme === 'light' ? 'app--light' : ''}`}>

      {/* 标题栏 */}
      <div
        className="titlebar"
        onMouseDown={(e) => {
          if (e.target.closest('button')) return;
          getCurrentWindow().startDragging().catch(() => {});
        }}
      >
        <span className="titlebar-name">ClipMate</span>
        <div className="titlebar-actions">
          <div className="tb-menu-wrap">
            <button
              className="tb-btn"
              onClick={() => setMenuOpen(o => !o)}
              title="更多"
            >
              <svg viewBox="0 0 14 14" fill="none" width="12" height="12">
                <circle cx="3" cy="7" r="1.2" fill="currentColor"/>
                <circle cx="7" cy="7" r="1.2" fill="currentColor"/>
                <circle cx="11" cy="7" r="1.2" fill="currentColor"/>
              </svg>
            </button>
            {menuOpen && (
              <>
                <div
                  className="menu-backdrop"
                  onMouseDown={(e) => { e.stopPropagation(); setMenuOpen(false); }}
                />
                <div className="tb-menu" onMouseDown={(e) => e.stopPropagation()}>
                  <button className="menu-item" onClick={exportTemplates}>导出备份…</button>
                  <button className="menu-item" onClick={importTemplates}>导入备份…</button>
                </div>
              </>
            )}
          </div>
          <button
            className="tb-btn"
            onClick={toggleTheme}
            title={theme === 'dark' ? '切换到浅色模式' : '切换到夜间模式'}
          >
            {theme === 'dark'
              ? (
                <svg viewBox="0 0 14 14" fill="none" width="12" height="12">
                  <circle cx="7" cy="7" r="3" stroke="currentColor" strokeWidth="1.35"/>
                  <path d="M7 1.8v1.1M7 11.1v1.1M1.8 7h1.1M11.1 7h1.1M3.3 3.3l.8.8M9.9 9.9l.8.8M10.7 3.3l-.8.8M4.1 9.9l-.8.8" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round"/>
                </svg>
              )
              : (
                <svg viewBox="0 0 14 14" fill="none" width="12" height="12">
                  <path d="M11.3 8.7A4.8 4.8 0 0 1 5.3 2.7 5 5 0 1 0 11.3 8.7z" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round"/>
                </svg>
              )
            }
          </button>
          <button className="tb-btn" onClick={toggleSize} title={isExpanded ? '收起' : '展开'}>
            {isExpanded
              ? <svg viewBox="0 0 14 14" fill="none" width="12" height="12"><path d="M2 9l5-5 5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
              : <svg viewBox="0 0 14 14" fill="none" width="12" height="12"><path d="M2 5l5 5 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
            }
          </button>
          <button
            className="tb-btn tb-btn--add"
            onClick={() => openModal(null)}
            title="新建模板"
          >
            <svg viewBox="0 0 14 14" fill="none" width="12" height="12">
              <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
      </div>

      {/* 主体 */}
      <div className="app-body">
        {/* 标签侧栏 */}
        <div className="sidebar">
          <button
            className={`sidebar-tag ${selectedTag === null ? 'active' : ''}`}
            onClick={() => setSelectedTag(null)}
            title="全部"
          >
            全部
          </button>
          {allTags.map(tag => (
            <button
              key={tag}
              className={`sidebar-tag ${selectedTag === tag ? 'active' : ''}`}
              onClick={() => setSelectedTag(tag)}
              title={tag}
            >
              {tag}
            </button>
          ))}
        </div>

        {/* 右侧内容 */}
        <div className="main-area">
          <div className="search-row">
            <div className="search-bar">
              <svg className="search-icon" viewBox="0 0 20 20" fill="none">
                <circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.5"/>
                <path d="M13 13L17 17" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
              <input
                ref={searchRef}
                type="text"
                placeholder="搜索模板..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="search-input"
              />
              {search && (
                <button className="clear-btn" onClick={() => setSearch('')}>×</button>
              )}
            </div>
          </div>

          <div className="content">
            {startupError && (
              <div className="empty">
                {startupError}
                <button className="clear-btn" onClick={() => {
                  loadTemplates().catch(err => {
                    console.error('retry template load failed', err);
                    setStartupError('初始化失败，可能是数据库或 Tauri 运行时没有准备好。');
                  });
                }}>
                  重试
                </button>
              </div>
            )}
            {showRecent && isExpanded && (
              <div className="section">
                <div className="section-label">
                  <svg viewBox="0 0 14 14" fill="none" width="10" height="10">
                    <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.3"/>
                    <path d="M7 4.5V7l2 1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  常用推荐
                </div>
                {recentTemplates.map(t => (
                  <TemplateCard
                    key={`r-${t.id}`}
                    template={t}
                    query={search}
                    copiedId={copiedId}
                    errorId={copyError}
                    compact={!isExpanded}
                    draggingId={draggingId}
                    draggable={false}
                    wasLongPressRef={wasLongPressRef}
                    onCopy={copyTemplate}
                    onTogglePin={togglePinned}
                    onEdit={t => openModal(t)}
                    onDelete={deleteTemplate}
                  />
                ))}
              </div>
            )}

            <div className="section" ref={mainListRef}>
              {showRecent && isExpanded && (
                <div className="section-label">
                  <svg viewBox="0 0 14 14" fill="none" width="10" height="10">
                    <rect x="2" y="2" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.3"/>
                    <path d="M4.5 7h5M4.5 5h5M4.5 9h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                  </svg>
                  所有模板
                </div>
              )}
              {!startupError && filtered.length === 0 ? (
                <div className="empty">
                  {search ? <>没有找到 "{search}"</> : <>暂无模板 — 点击 + 新建</>}
                </div>
              ) : !startupError && (
                filtered.map((t, idx) => (
                  <TemplateCard
                    key={t.id}
                    template={t}
                    query={search}
                    hotkey={idx < 9 ? idx + 1 : null}
                    copiedId={copiedId}
                    errorId={copyError}
                    compact={!isExpanded}
                    draggingId={draggingId}
                    isSelected={idx === selectedIndex}
                    wasLongPressRef={wasLongPressRef}
                    onCopy={copyTemplate}
                    onTogglePin={togglePinned}
                    onEdit={t => openModal(t)}
                    onDelete={deleteTemplate}
                    onPointerDown={handleCardPointerDown}
                    onPointerMove={handleCardPointerMove}
                  />
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      {showModal && (
        <TemplateModal
          template={editingTemplate}
          allTags={allTags}
          onSave={saveTemplate}
          onClose={closeModal}
        />
      )}

      {toast && (
        <div className={`toast toast--${toast.type}`}>{toast.msg}</div>
      )}

    </div>
  );
}

function TemplateCard({
  template, query = '', hotkey = null, copiedId, errorId, compact, draggingId, isSelected = false, draggable = true,
  wasLongPressRef, onCopy, onTogglePin, onEdit, onDelete, onPointerDown, onPointerMove
}) {
  const [confirmDel, setConfirmDel] = useState(false);
  const isCopied = copiedId === template.id;
  const isError = errorId === template.id;
  const isDragging = draggable && draggingId === template.id;
  const isPinned = template.is_pinned === 1;

  function handleDelete(e) {
    e.stopPropagation();
    if (confirmDel) {
      onDelete(template.id);
    } else {
      setConfirmDel(true);
      setTimeout(() => setConfirmDel(false), 2500);
    }
  }

  function handleClick(e) {
    if (wasLongPressRef.current) {
      wasLongPressRef.current = false;
      return;
    }
    onCopy(template);
  }

  return (
    <div
      className={`card ${isCopied ? 'card--copied' : ''} ${isError ? 'card--error' : ''} ${compact ? 'card--compact' : ''} ${isDragging ? 'card--dragging' : ''} ${isSelected ? 'card--selected' : ''}`}
      data-card-id={template.id}
      onClick={handleClick}
      onPointerDown={draggable ? (e) => onPointerDown(template, e) : undefined}
      onPointerMove={draggable ? onPointerMove : undefined}
    >
      <div className="card-row">
        {/* 左侧引导位：常态显示 ⌘序号，悬停切换为拖拽手柄（最近使用区不显示） */}
        {draggable && (
          <div className="card-lead">
            {hotkey != null && (
              <span className="hotkey-badge" title={`⌘${hotkey} 复制`}>{hotkey}</span>
            )}
            <span className="drag-hint" title="长按拖动排序">
              <svg viewBox="0 0 8 14" fill="none" width="8" height="14">
                <circle cx="2" cy="2.5" r="1.2" fill="currentColor"/>
                <circle cx="6" cy="2.5" r="1.2" fill="currentColor"/>
                <circle cx="2" cy="7" r="1.2" fill="currentColor"/>
                <circle cx="6" cy="7" r="1.2" fill="currentColor"/>
                <circle cx="2" cy="11.5" r="1.2" fill="currentColor"/>
                <circle cx="6" cy="11.5" r="1.2" fill="currentColor"/>
              </svg>
            </span>
          </div>
        )}

        <div className="card-text">
          <div className="card-title">{highlightText(template.title, query)}</div>
          <div className="card-preview">
            {highlightText(template.content, query)}
          </div>
        </div>
        <div className="card-btns" onClick={e => e.stopPropagation()}>
          <button
            className={`crd-btn crd-btn--pin ${isPinned ? 'crd-btn--pinned' : ''}`}
            onClick={(e) => { e.stopPropagation(); onTogglePin(template); }}
            title={isPinned ? '取消固定' : '固定模板'}
          >
            <svg viewBox="0 0 13 13" fill={isPinned ? 'currentColor' : 'none'} width="11" height="11">
              <path d="M6.5 1.7l1.4 2.9 3.2.5-2.3 2.2.5 3.2-2.8-1.5-2.8 1.5.5-3.2-2.3-2.2 3.2-.5 1.4-2.9z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/>
            </svg>
          </button>
          <button className="crd-btn" onClick={(e) => { e.stopPropagation(); onEdit(template); }} title="编辑">
            <svg viewBox="0 0 13 13" fill="none" width="11" height="11">
              <path d="M8.5 2l2.5 2.5L4 11H1.5V8.5L8.5 2z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
            </svg>
          </button>
          <button
            className={`crd-btn ${confirmDel ? 'crd-btn--confirm' : 'crd-btn--del'}`}
            onClick={handleDelete}
            title={confirmDel ? '再次点击确认删除' : '删除'}
          >
            {confirmDel
              ? <svg viewBox="0 0 13 13" fill="none" width="11" height="11"><path d="M2 6.5l3 3 6-6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
              : <svg viewBox="0 0 13 13" fill="none" width="11" height="11"><path d="M2 3.5h9M4.5 3.5V2h4v1.5M3.5 3.5V11h6V3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
            }
          </button>
        </div>
      </div>

      {!compact && template.tags.length > 0 && (
        <div className="card-tags">
          {template.tags.map(tag => <span key={tag} className="chip">{tag}</span>)}
        </div>
      )}

      <div className={`copy-flash ${isCopied ? 'copy-flash--show' : ''}`}>
        <svg viewBox="0 0 14 14" fill="none" width="12" height="12">
          <path d="M2.5 7l3 3 6-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        已复制
      </div>

      <div className={`copy-flash copy-flash--error ${isError ? 'copy-flash--show' : ''}`}>
        <svg viewBox="0 0 14 14" fill="none" width="12" height="12">
          <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
        复制失败
      </div>

      {confirmDel && <div className="del-hint">再次点击确认删除</div>}
    </div>
  );
}

function TemplateModal({ template, allTags, onSave, onClose }) {
  const [title, setTitle] = useState(template?.title || '');
  const [content, setContent] = useState(template?.content || '');
  const [tags, setTags] = useState(template?.tags || []);
  const [saving, setSaving] = useState(false);
  const newTagRef = useRef(null);

  async function handleSave() {
    if (saving || !title.trim() || !content.trim()) return;
    setSaving(true);
    try {
      await onSave({ title: title.trim(), content: content.trim(), tags });
    } finally {
      setSaving(false);
    }
  }

  function toggleTag(tag) {
    setTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]);
  }

  function handleNewTagKey(e) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const val = e.target.value.trim().replace(/,$/, '');
      if (val && !tags.includes(val)) setTags(prev => [...prev, val]);
      e.target.value = '';
    }
  }

  const suggestedTags = allTags;

  return (
    <div
      className="overlay"
      onClick={onClose}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) getCurrentWindow().startDragging().catch(() => {});
      }}
    >
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div
          className="modal-head"
          onMouseDown={(e) => {
            if (e.target.closest('button')) return;
            getCurrentWindow().startDragging().catch(() => {});
          }}
        >
          <h3>{template ? '编辑模板' : '新建模板'}</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="modal-scroll">
          <label className="field-label">标题</label>
          <input
            type="text"
            placeholder="给模板起个名字..."
            value={title}
            onChange={e => setTitle(e.target.value)}
            className="field-input"
            autoFocus
          />

          <label className="field-label">内容</label>
          <textarea
            placeholder="输入模板正文..."
            value={content}
            onChange={e => setContent(e.target.value)}
            className="field-textarea"
            rows={10}
          />

          <label className="field-label">标签</label>
          {suggestedTags.length > 0 && (
            <div className="tag-suggestions">
              {suggestedTags.map(tag => (
                <button
                  key={tag}
                  type="button"
                  className={`tag-chip ${tags.includes(tag) ? 'tag-chip--on' : ''}`}
                  onClick={() => toggleTag(tag)}
                >
                  {tag}
                </button>
              ))}
            </div>
          )}
          <input
            ref={newTagRef}
            type="text"
            placeholder="输入新标签，按 Enter 添加..."
            className="field-input"
            onKeyDown={handleNewTagKey}
          />
          {tags.length > 0 && (
            <div className="selected-tags">
              {tags.map(tag => (
                <span key={tag} className="selected-chip">
                  {tag}
                  <button type="button" onClick={() => toggleTag(tag)}>×</button>
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button className="btn-ghost" onClick={onClose} disabled={saving}>取消</button>
          <button
            className="btn-solid"
            onClick={handleSave}
            disabled={saving || !title.trim() || !content.trim()}
          >
            {saving ? '保存中…' : '保存模板'}
          </button>
        </div>
      </div>
    </div>
  );
}
