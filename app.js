/* Liva — static shell. All state lives in your private repo; this file only
   reads and writes it through the GitHub Contents API. */

const AREAS = ['work', 'career', 'learning', 'personal', 'health'];
const ICON = { work: '💼', career: '🚀', learning: '📚', personal: '🏡', health: '💪' };
const TASKS_PATH = 'data/tasks.json';
const CACHE_KEY = 'liva.cache';

const $ = id => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/* ---------- config ---------- */

const cfg = {
  get repo() { return localStorage.getItem('liva.repo') || ''; },
  get branch() { return localStorage.getItem('liva.branch') || 'main'; },
  get token() { return localStorage.getItem('liva.token') || ''; },
  set(repo, branch, token) {
    localStorage.setItem('liva.repo', repo);
    localStorage.setItem('liva.branch', branch || 'main');
    localStorage.setItem('liva.token', token);
  },
  clear() { ['repo', 'branch', 'token'].forEach(k => localStorage.removeItem(`liva.${k}`)); }
};

/* ---------- base64 (unicode-safe, chunked) ---------- */

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/* ---------- GitHub API ---------- */

async function gh(path, options = {}) {
  // Without a deadline a stalled request leaves the save lock held for good,
  // and every later edit returns quietly having saved nothing.
  const ctl = new AbortController();
  const deadline = setTimeout(() => ctl.abort(), 20000);
  let res;
  try {
    res = await fetch(`https://api.github.com/repos/${cfg.repo}/contents/${path}`, {
      ...options,
      signal: ctl.signal,
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(options.body ? { 'Content-Type': 'application/json' } : {})
      }
    });
  } finally {
    clearTimeout(deadline);
  }
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`GitHub ${res.status}: ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function getFile(path) {
  const j = await gh(`${path}?ref=${encodeURIComponent(cfg.branch)}`);
  return { data: JSON.parse(b64decode(j.content)), sha: j.sha };
}

async function putFile(path, data, sha, message) {
  return gh(path, {
    method: 'PUT',
    body: JSON.stringify({
      message,
      content: b64encode(JSON.stringify(data, null, 2) + '\n'),
      branch: cfg.branch,
      ...(sha ? { sha } : {})
    })
  });
}

/* ---------- dates ---------- */

let TZ = 'Asia/Colombo';
const todayStr = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());

function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const daysBetween = (a, b) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

const dowOf = date => new Date(`${date}T00:00:00Z`).getUTCDay();
const overdueDays = (t, date) => (t.due ? daysBetween(t.due, date) : 0);
const isOpen = t => t.status !== 'done' && t.status !== 'dropped';

/* ---------- capture syntax (mirrors lib/parse.js) ---------- */

const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function parseDate(tok, today) {
  const t = tok.toLowerCase();
  if (t === 'today') return today;
  if (t === 'tomorrow' || t === 'tmr') return addDays(today, 1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  if (/^\+\d+$/.test(t)) return addDays(today, Number(t.slice(1)));
  const d = DOW.indexOf(t.slice(0, 3));
  if (d >= 0) {
    let out = addDays(today, 1);
    while (dowOf(out) !== d) out = addDays(out, 1);
    return out;
  }
  return null;
}

function parseTask(input, today, fallbackArea) {
  let text = input.trim();
  let area = fallbackArea || 'personal';
  const m = text.match(/^(\w+)\s*:\s*(.+)$/s);
  if (m && AREAS.includes(m[1].toLowerCase())) { area = m[1].toLowerCase(); text = m[2]; }

  const t = { area, priority: 2, due: null, recur: null, project: null };
  text = text.replace(/(?:^|\s)!([123])(?=\s|$)/g, (_, p) => { t.priority = Number(p); return ' '; });
  text = text.replace(/(?:^|\s)~(\S+)(?=\s|$)/g, (_, r) => { t.recur = r.toLowerCase(); return ' '; });
  text = text.replace(/(?:^|\s)#(\S+)(?=\s|$)/g, (_, g) => { t.project = g; return ' '; });
  text = text.replace(/(?:^|\s)@(\S+)(?=\s|$)/g, (_, d) => {
    const p = parseDate(d, today);
    if (p) { t.due = p; return ' '; }
    return ` @${d}`;
  });
  t.title = text.replace(/\s+/g, ' ').trim();
  if (t.recur && !t.due) t.due = today;
  return t;
}

function nextDue(recur, from) {
  const [kind, arg] = String(recur).split(':');
  if (kind === 'daily') return addDays(from, 1);
  if (kind === 'weekdays') {
    let d = addDays(from, 1);
    while (dowOf(d) === 0 || dowOf(d) === 6) d = addDays(d, 1);
    return d;
  }
  if (kind === 'weekly') {
    const target = arg ? DOW.indexOf(arg.slice(0, 3).toLowerCase()) : -1;
    if (target < 0) return addDays(from, 7);
    let d = addDays(from, 1);
    while (dowOf(d) !== target) d = addDays(d, 1);
    return d;
  }
  if (kind === 'monthly') {
    const day = Number(arg) || Number(from.slice(8, 10));
    const d = new Date(`${from}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + 1, 1);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
    return d.toISOString().slice(0, 10);
  }
  return addDays(from, 1);
}

const newId = p => `${p}_${Math.random().toString(36).slice(2, 8)}`;

/* Mirrors normalize() in lib/store.js. The cron jobs, the CLI and this page all
   write the same file, so each has to tolerate an older shape rather than
   assume someone else migrated first. */
function normalize(d) {
  if (d.goals && !d.projects) {
    const rename = new Map(d.goals.map(g => [g.id, g.id.replace(/^g_/, 'p_')]));
    d.projects = d.goals.map(g => ({
      id: rename.get(g.id), title: g.title, area: g.area || 'work',
      horizon: g.horizon || null, status: 'active', created: g.created || null
    }));
    for (const t of d.tasks || []) {
      if (t.goal) t.project = rename.get(t.goal) || t.goal;
      delete t.goal;
    }
    delete d.goals;
  }
  d.version = 4;
  d.projects ??= [];
  d.tasks ??= [];
  d.columns ??= defaultColumns();
  for (const c of d.columns) c.label ??= c.id;

  const shared = new Set(d.columns.map(c => c.id));
  for (const p of d.projects) {
    p.status ??= 'active';
    p.touched ??= p.created ?? null;
    // v3 stored every column on the project; anything now shared is dropped,
    // leaving only that project's own extras behind.
    p.columns = Array.isArray(p.columns) ? p.columns.filter(c => !shared.has(c.id)) : [];
    for (const c of p.columns) c.label ??= c.id;
  }
  for (const t of d.tasks) {
    t.subtasks ??= [];
    if (t.project === undefined) t.project = t.goal ?? null;
    delete t.goal;
  }
  return d;
}

/* Columns are per project and purely presentational: a card's `status` is just
   the id of the column it sits in. Two ids keep their meaning everywhere,
   because the rest of the system is built on them — `done` completes the task
   and rolls a recurring one forward, `doing` earns the planner's boost. Labels
   are free text, so renaming a column never changes behaviour. */

const DEFAULT_COLUMNS = [
  { id: 'todo', label: 'Todo' },
  { id: 'doing', label: 'In progress' },
  { id: 'done', label: 'Done' }
];

const defaultColumns = () => DEFAULT_COLUMNS.map(c => ({ ...c }));

/** Extras go before Done, which reads as the end of a board. */
function spliceColumns(shared, extras) {
  if (!extras?.length) return [...shared];
  const at = shared.findIndex(c => c.id === 'done');
  return at < 0
    ? [...shared, ...extras]
    : [...shared.slice(0, at), ...extras, ...shared.slice(at)];
}

/** What one project's board shows: the shared columns plus its own extras. */
const columnsFor = projectId => {
  const p = projectId ? db.projects.find(x => x.id === projectId) : null;
  return spliceColumns(db.columns, p?.columns);
};

/** Every column that exists anywhere, for the boards that span projects. */
function unionColumns() {
  const extras = [];
  const seen = new Set(db.columns.map(c => c.id));
  for (const p of db.projects) {
    if (p.status === 'archived') continue;
    for (const c of p.columns || []) {
      if (!seen.has(c.id)) { seen.add(c.id); extras.push(c); }
    }
  }
  return spliceColumns(db.columns, extras);
}

/* ---------- state ---------- */

let db = null;
let sha = null;
let plan = null;
let offline = false;

/** 'today' | 'all' | 'unassigned' | 'project:<id>' — remembered across reloads. */
let view = localStorage.getItem('liva.view') || 'today';

let dragging = null;            // id of the card currently being dragged
let showArchived = false;
const expanded = new Set();     // cards showing their subtasks

/* Debounced last-write-wins save. One person, one repo — on a conflict we
   refetch the sha and re-push our copy rather than trying to merge. */
let saveTimer = null;
let saving = false;
let pending = false;
let dirty = false;      // edits made here that the repo has not accepted yet

function setStatus(text, cls = '') {
  const s = $('status');
  s.textContent = text;
  s.className = `status ${cls}`;
}

/* Engagement tracking. The cron jobs stay silent when these say you've already
   been here today, so every mutation must record it. */

function markChanged() {
  db.activity ??= { lastOpened: null, lastChanged: null };
  db.activity.lastChanged = todayStr();
  db.activity.lastOpened = todayStr();
}

const touchTask = t => { t.touched = todayStr(); };

/** One quiet commit the first time the app is opened each day. */
async function noteOpened() {
  db.activity ??= { lastOpened: null, lastChanged: null };
  if (db.activity.lastOpened === todayStr() || offline) return;
  db.activity.lastOpened = todayStr();
  await flush();
}

function scheduleSave() {
  markChanged();
  dirty = true;
  render();
  if (offline) { setStatus('offline', 'failed'); return; }
  setStatus('•••', 'saving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 1200);
}

/**
 * Fold whatever changed on the server into what's in this tab.
 *
 * Records are merged by id and the later `touched` wins, so a tab that has been
 * open for hours can't push a stale whole-document copy over work done from the
 * CLI, the cron jobs, or another tab. Records only one side knows about are
 * kept: resurrecting a deleted card is a nuisance, losing a live one is not.
 */
function mergeById(mine, theirs, newer) {
  const out = new Map(theirs.map(r => [r.id, r]));
  for (const m of mine) {
    const t = out.get(m.id);
    out.set(m.id, t ? newer(t, m) : m);
  }
  return [...out.values()];
}

const laterDate = (a, b) => ((a || '') > (b || '') ? a : b);

function mergeDb(server, mine) {
  normalize(server);
  const out = { ...server };

  // Settings live in the repo and are edited by hand, so the server wins.
  out.activity = {
    lastOpened: laterDate(server.activity?.lastOpened, mine.activity?.lastOpened),
    lastChanged: laterDate(server.activity?.lastChanged, mine.activity?.lastChanged)
  };
  // Projects compare the same way tasks do. They used to let the local copy win
  // unconditionally, which meant a stale tab silently reverted project edits
  // made from the CLI on every save.
  const newer = (t, m) => ((m.touched || '') >= (t.touched || '') ? m : t);
  out.projects = mergeById(mine.projects, server.projects, newer);
  out.tasks = mergeById(mine.tasks, server.tasks, newer);
  // Shared columns merge the same way; Done is pushed back to the end so a
  // column added on either side can't end up sitting after it.
  const cols = mergeById(mine.columns || [], server.columns || [], newer);
  const at = cols.findIndex(c => c.id === 'done');
  out.columns = at < 0 ? cols : [...cols.slice(0, at), ...cols.slice(at + 1), cols[at]];
  return out;
}

/** Adopt server state, keeping this tab's edits, and re-render. */
/**
 * `force` matters on a retry: a 409 can come back even when our sha looks
 * current, and skipping the refresh then re-sends the same sha and conflicts
 * again, so the retries are guaranteed to fail.
 */
async function reconcile(force = false) {
  const fresh = await getFile(TASKS_PATH);
  if (force || fresh.sha !== sha) {
    db = mergeDb(fresh.data, db);
    sha = fresh.sha;
    render();
  }
  return fresh.sha;
}

async function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;              // the debounce has fired; idle refresh may resume
  if (saving) { pending = true; return; }
  saving = true;
  setStatus('saving', 'saving');
  try {
    let conflict = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        // Always write against current server state rather than whatever this
        // tab loaded, however long ago that was.
        await reconcile(attempt > 0);
        const r = await putFile(TASKS_PATH, db, sha, 'chore: update from phone');
        sha = r.content.sha;
        dirty = false;
        conflict = null;
        cacheLocal();
        setStatus('saved', 'saved');
        setTimeout(() => { if (!saving && !pending && !dirty) setStatus(''); }, 2000);
        break;
      } catch (e) {
        if (e.status !== 409 && e.status !== 422) throw e;
        conflict = e;                                  // raced; reconcile and retry
        await new Promise(r => setTimeout(r, 250 * (attempt + 1)));
      }
    }
    // Running out of retries used to fall through silently, leaving the status
    // on "saving" and the edit only in memory.
    if (conflict) throw conflict;
  } catch (e) {
    console.error(e);
    setStatus('unsaved', 'failed');   // stays dirty; the idle tick retries
  } finally {
    saving = false;
    if (pending) { pending = false; flush(); }
  }
}

/* A tab left open all day drifts from the repo. Pull in changes while idle so
   the board shows reality and there is less to merge on the next write. */
setInterval(() => {
  if (!db || saving || pending || saveTimer || offline) return;
  if (document.visibilityState !== 'visible') return;
  // A save that failed leaves the work in memory only — keep trying.
  if (dirty) flush().catch(() => {});
  else reconcile().catch(() => {});
}, 60000);

function cacheLocal() {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ db, plan, at: Date.now() })); } catch {}
}

/* ---------- load ---------- */

async function loadAll() {
  setStatus('…', 'saving');
  try {
    const f = await getFile(TASKS_PATH);
    db = f.data;
    sha = f.sha;
    TZ = db.timezone || TZ;
    normalize(db);
    try {
      plan = (await getFile(`data/plan/${todayStr()}.json`)).data;
    } catch { plan = null; }
    offline = false;
    cacheLocal();
    setStatus('');
  } catch (e) {
    console.error(e);
    if (e.status === 401 || e.status === 403 || e.status === 404) {
      showSetup(e.status === 404
        ? 'Repo, branch or file not found. Check owner/name and that data/tasks.json exists.'
        : 'GitHub rejected the token. Check it has Contents: read & write on this repo.');
      return;
    }
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) {
      const c = JSON.parse(cached);
      db = c.db; plan = c.plan; offline = true;
      TZ = db.timezone || TZ;
      setStatus('offline', 'failed');
    } else {
      showSetup('Could not reach GitHub and nothing is cached yet.');
      return;
    }
  }
  render();
  await noteOpened();
}

/* ---------- mutations ---------- */

function completeTask(t) {
  const date = todayStr();
  touchTask(t);
  if (t.recur) {
    t.due = nextDue(t.recur, t.due && t.due > date ? t.due : date);
    t.status = 'todo';
    t.nudgedOn = null;
    for (const s of t.subtasks) s.done = false;
  } else {
    t.status = 'done';
    t.completed = date;
  }
  scheduleSave();
}

function reopenTask(t) {
  t.status = 'todo';
  t.completed = null;
  touchTask(t);
  scheduleSave();
}


function setProject(t, projectId) {
  t.project = projectId || null;
  // Columns are per project, so a card can arrive holding a status the new
  // board has no column for. Without this it would vanish from every view.
  const cols = columnsFor(t.project);
  if (t.status !== 'dropped' && !cols.some(c => c.id === t.status)) {
    t.status = cols[0].id;
    t.completed = null;
  }
  touchTask(t);
  scheduleSave();
}

/** Moving a card into Done completes it; recurring tasks roll forward instead. */
function setStatus_(t, status) {
  if (t.status === status) return;
  if (status === 'done') { completeTask(t); return; }
  t.status = status;
  if (status !== 'done') t.completed = null;
  touchTask(t);
  scheduleSave();
}

/* ---------- projects ---------- */

const projectOf = id => db.projects.find(p => p.id === id) || null;

function projectProgress(id) {
  const linked = db.tasks.filter(t => t.project === id && t.status !== 'dropped');
  const done = linked.filter(t => t.status === 'done').length;
  return { done, total: linked.length, open: linked.length - done };
}

function createProject() {
  const title = prompt('Project name');
  if (!title || !title.trim()) return;
  const area = prompt(`Area for "${title.trim()}"\n(${AREAS.join(' / ')})`, 'work');
  const p = {
    id: 'p_' + Math.random().toString(36).slice(2, 8),
    title: title.trim(),
    area: AREAS.includes((area || '').trim()) ? area.trim() : 'work',
    horizon: null,
    status: 'active',
    created: todayStr()
  };
  db.projects.push(p);
  scheduleSave();
  setView(`project:${p.id}`);
}

function renameProject(p) {
  const title = prompt('Rename project', p.title);
  if (title && title.trim()) { p.title = title.trim(); scheduleSave(); }
}

function archiveProject(p) {
  const open = projectProgress(p.id).open;
  const msg = open
    ? `Archive "${p.title}"? ${open} open task(s) stay, but the project is hidden.`
    : `Archive "${p.title}"?`;
  if (!confirm(msg)) return;
  p.status = p.status === 'archived' ? 'active' : 'archived';
  scheduleSave();
  if (p.status === 'archived') setView('today');
}

/* ---------- render: cards ---------- */

const formatDuration = mins => {
  const h = Math.floor(mins / 60), m = mins % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
};

function dueChip(t, date) {
  if (!t.due) return null;
  const od = overdueDays(t, date);
  const cls = od > 0 ? 'chip due-over' : od === 0 ? 'chip due-today' : 'chip';
  return el('span', cls, od > 0 ? `overdue ${od}d` : od === 0 ? 'due today' : t.due);
}

/**
 * Let text inside a card be selected and copied.
 *
 * `draggable="true"` on the card makes the browser start a drag from any text
 * inside it, so a click-and-sweep never selects anything. Dropping draggability
 * for the duration of the press hands that gesture back to the text; the
 * document-level mouseup below restores it.
 */
/**
 * Plain text with its http(s) URLs as links. Built from nodes rather than
 * HTML, so whatever is typed into a subtask can never become markup.
 */
function linkify(str) {
  const frag = document.createDocumentFragment();
  const re = /https?:\/\/[^\s<>"]+/g;
  let last = 0;
  let m;
  while ((m = re.exec(str))) {
    // Sentence punctuation after a URL belongs to the sentence, not the link.
    const url = m[0].replace(/[).,;:!?'"]+$/, '');
    if (m.index > last) frag.append(str.slice(last, m.index));
    const a = el('a', 'sub-link', url);
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    frag.append(a);
    last = m.index + url.length;
    re.lastIndex = last;
  }
  if (last < str.length) frag.append(str.slice(last));
  return frag;
}

function selectable(text, card) {
  // An inline span, so the I-beam covers the glyphs and not the empty space its
  // block-level parent stretches across.
  const node = el('span', 'sel-text', text);
  node.addEventListener('mousedown', () => { card.draggable = false; });
  return node;
}

document.addEventListener('mouseup', () => {
  for (const c of document.querySelectorAll('.card[draggable="false"]')) c.draggable = true;
});

/** A board card. Compact by default; click the title to expand subtasks. */
function taskCard(t, opts = {}) {
  const date = todayStr();
  const od = overdueDays(t, date);
  const done = t.status === 'done';

  const card = el('div', `card${done ? ' done' : ''}${od > 0 && !done ? ' overdue' : ''}`);
  card.draggable = true;
  card.dataset.id = t.id;

  card.addEventListener('dragstart', e => {
    dragging = t.id;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', t.id);
  });
  card.addEventListener('dragend', () => {
    dragging = null;
    card.classList.remove('dragging');
    document.querySelectorAll('.col.over').forEach(c => c.classList.remove('over'));
  });

  const top = el('div', 'card-top');
  const check = el('button', `check${done ? ' on' : ''}`, '✓');
  check.title = done ? 'Reopen' : 'Complete';
  check.onclick = e => { e.stopPropagation(); done ? reopenTask(t) : completeTask(t); };
  top.append(check);

  const title = el('div', 'card-title');
  title.append(selectable(t.title, card));
  title.onclick = () => {
    // A drag-select ending on the title shouldn't also toggle the card.
    if (!window.getSelection()?.isCollapsed) return;
    expanded.has(t.id) ? expanded.delete(t.id) : expanded.add(t.id);
    render();
  };
  top.append(title);
  card.append(top);

  const meta = el('div', 'card-meta');
  meta.append(el('span', 'chip area', `${ICON[t.area] || '•'} ${t.area}`));
  if (t.priority === 1) meta.append(el('span', 'chip p1', '!1'));
  const due = dueChip(t, date);
  if (due) meta.append(due);
  if (t.recur) meta.append(el('span', 'chip', `↻ ${t.recur}`));
  if (t.subtasks.length) {
    const n = t.subtasks.filter(s => s.done).length;
    meta.append(el('span', `chip${n === t.subtasks.length ? ' all-done' : ''}`, `☑ ${n}/${t.subtasks.length}`));
  }
  if (opts.showProject && t.project) {
    const p = projectOf(t.project);
    if (p) meta.append(el('span', 'chip proj', p.title));
  }
  card.append(meta);

  if (expanded.has(t.id)) {
    const body = el('div', 'card-body');

    if (t.subtasks.length) {
      const ul = el('ul', 'subs');
      for (const s of t.subtasks) {
        const li = el('li');
        const c = el('button', `check sm${s.done ? ' on' : ''}`, '✓');
        c.onclick = () => { s.done = !s.done; touchTask(t); scheduleSave(); };
        const label = el('span', `st${s.done ? ' on' : ''}`);
        const text = selectable('', card);
        text.append(linkify(s.title));
        label.append(text);
        const del = el('button', 'ghost sm', '×');
        del.title = 'Remove subtask';
        del.onclick = () => {
          t.subtasks = t.subtasks.filter(x => x !== s);
          touchTask(t);
          scheduleSave();
        };
        li.append(c, label, del);
        ul.append(li);
      }
      body.append(ul);
    }

    const acts = el('div', 'card-acts');

    const addSub = el('button', '', '+ subtask');
    addSub.onclick = () => {
      const v = prompt('Subtask');
      if (v && v.trim()) {
        t.subtasks.push({ id: 's_' + Math.random().toString(36).slice(2, 8), title: v.trim(), done: false });
        touchTask(t);
        scheduleSave();
      }
    };
    acts.append(addSub);

    const push = el('button', '', '⏭ tomorrow');
    push.onclick = () => {
      const d = todayStr();
      t.due = addDays(t.due && t.due > d ? t.due : d, 1);
      t.nudgedOn = null;
      touchTask(t);
      scheduleSave();
    };
    acts.append(push);

    // Move between projects without leaving the board.
    const sel = el('select', 'proj-select');
    const none = el('option', '', 'No project');
    none.value = '';
    sel.append(none);
    for (const p of db.projects.filter(p => p.status !== 'archived')) {
      const o = el('option', '', p.title);
      o.value = p.id;
      sel.append(o);
    }
    sel.value = t.project || '';
    sel.onchange = () => setProject(t, sel.value);
    acts.append(sel);

    const drop = el('button', 'danger', '✗ drop');
    drop.onclick = () => {
      if (confirm(`Drop "${t.title}"?`)) { t.status = 'dropped'; touchTask(t); scheduleSave(); }
    };
    acts.append(drop);

    body.append(acts);
    card.append(body);
  }

  return card;
}

/* ---------- render: board ---------- */

const byDue = (a, b) =>
  (a.due || '9999').localeCompare(b.due || '9999') || a.priority - b.priority;

/* ---------- column management ---------- */

/* A board's `owner` is whatever holds the columns you may edit there: the
   project on a project board, or `db` on the cross-project boards, where the
   shared columns are the ones that belong. Columns from the other layer still
   render — so no card is ever hidden — they just aren't editable from there. */

const isShared = col => db.columns.includes(col);
const owns = (owner, col) => (owner === db ? isShared(col) : owner.columns.includes(col));

/** todo/doing/done carry behaviour elsewhere, so they can be renamed, not removed. */
const RESERVED = ['todo', 'doing', 'done'];

function addColumn(owner) {
  const label = prompt(owner === db ? 'New column (shown on every project)' : 'New column (this project only)');
  if (!label || !label.trim()) return;
  const col = { id: 'c_' + Math.random().toString(36).slice(2, 8), label: label.trim(), touched: todayStr() };
  if (owner === db) {
    // Keep Done last.
    const at = db.columns.findIndex(c => c.id === 'done');
    db.columns.splice(at < 0 ? db.columns.length : at, 0, col);
  } else {
    owner.columns.push(col);
    touchTask(owner);
  }
  scheduleSave();
}

function renameColumn(owner, col) {
  const label = prompt('Rename column', col.label);
  if (!label || !label.trim()) return;
  col.label = label.trim();
  touchTask(col);
  if (owner !== db) touchTask(owner);
  scheduleSave();
}

function deleteColumn(owner, col, count) {
  // Refuse rather than silently relocating work — the cards would be hard to find.
  if (count) {
    alert(`"${col.label}" still holds ${count} card(s).\n\nMove them to another column first, then delete it.`);
    return;
  }
  const where = owner === db ? ' from every project' : '';
  if (!confirm(`Delete the "${col.label}" column${where}?`)) return;
  if (owner === db) db.columns = db.columns.filter(c => c !== col);
  else { owner.columns = owner.columns.filter(c => c !== col); touchTask(owner); }
  scheduleSave();
}

/**
 * Render one board. `owner` holds the columns editable here — a project on a
 * project board, `db` on the cross-project boards.
 */
function board(tasks, columns, owner, opts = {}) {
  const wrap = el('div', 'board');
  // The add-column rail is deliberately narrow — a full-width track would push
  // a real column off screen on a laptop.
  wrap.style.gridTemplateColumns =
    `repeat(${columns.length}, minmax(230px, 1fr))${owner ? ' 44px' : ''}`;

  for (const col of columns) {
    const items = tasks.filter(t => t.status === col.id).sort(byDue);
    const node = el('section', 'col');
    node.dataset.status = col.id;

    const head = el('div', 'col-head');
    head.append(el('span', 'col-name', col.label));
    head.append(el('span', 'col-count', String(items.length)));

    if (owner && owns(owner, col)) {
      const tools = el('span', 'col-tools');
      const ren = el('button', 'ghost sm', '✎');
      ren.title = owner === db ? 'Rename (shown on every project)' : 'Rename column';
      ren.onclick = () => renameColumn(owner, col);
      tools.append(ren);
      if (!RESERVED.includes(col.id)) {
        const del = el('button', 'ghost sm', '×');
        del.title = 'Delete column';
        // A shared column is only empty once no project still has a card in it.
        const held = isShared(col)
          ? db.tasks.filter(t => t.status === col.id).length
          : items.length;
        del.onclick = () => deleteColumn(owner, col, held);
        tools.append(del);
      }
      head.append(tools);
    }
    node.append(head);

    const body = el('div', 'col-body');
    for (const t of items) body.append(taskCard(t, opts));
    if (!items.length) body.append(el('div', 'col-empty', 'Drop a card here'));
    node.append(body);

    node.addEventListener('dragover', e => {
      if (!dragging) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      node.classList.add('over');
    });
    node.addEventListener('dragleave', e => {
      if (!node.contains(e.relatedTarget)) node.classList.remove('over');
    });
    node.addEventListener('drop', e => {
      e.preventDefault();
      node.classList.remove('over');
      const id = e.dataTransfer.getData('text/plain') || dragging;
      const t = db.tasks.find(x => x.id === id);
      if (t) setStatus_(t, col.id);
    });

    wrap.append(node);
  }

  if (owner) {
    const add = el('button', 'col-add', '+');
    add.title = owner === db ? 'Add a column shown on every project' : 'Add a column to this project';
    add.setAttribute('aria-label', 'Add column');
    add.onclick = () => addColumn(owner);
    wrap.append(add);
  }
  return wrap;
}

/* ---------- render: views ---------- */

function calendarCard(cal) {
  if (!cal || cal.failed) return null;
  const card = el('div', 'cal-card');
  const head = el('div', 'cal-head');
  head.append(el('span', 'h1-ico', '📅'));
  if (!cal.events.length) {
    head.append(document.createTextNode('No meetings today — the day is yours'));
    card.append(head);
    return card;
  }
  const free = Math.max(0, 9 * 60 - cal.busyMinutes);
  head.append(document.createTextNode(
    `${formatDuration(cal.busyMinutes)} booked · ${formatDuration(free)} free`));
  card.append(head);
  const list = el('ul', 'cal-events');
  for (const e of cal.events) {
    const li = el('li', e.busy ? '' : 'free');
    li.append(el('span', 'cal-time', e.allDay ? 'all day' : `${e.from}–${e.to}`));
    li.append(el('span', 'cal-title', e.title));
    list.append(li);
  }
  card.append(list);
  return card;
}

function viewToday(head, content) {
  const date = todayStr();
  const byId = new Map(db.tasks.map(t => [t.id, t]));
  let picks = plan?.picks?.map(id => byId.get(id)).filter(Boolean) || [];

  head.append(el('h1', '', new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB',
    { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })));

  const st = stats();
  head.append(el('p', 'sub',
    `${st.open} open${st.overdue ? ` · ${st.overdue} overdue` : ''}${offline ? ' · offline' : ''}`));

  const cal = calendarCard(plan?.calendar);
  if (cal) content.append(cal);

  if (!picks.length) {
    picks = db.tasks
      .filter(t => isOpen(t) && (t.status === 'doing' || (t.due && overdueDays(t, date) >= 0)))
      .sort(byDue);
  }

  if (!picks.length) {
    content.append(el('p', 'empty', 'Nothing due today. Add something below, or enjoy it.'));
    return;
  }

  content.append(el('p', 'section-title', plan?.picks?.length ? "Today's plan" : 'Due now'));
  if (plan?.trimmed) content.append(el('p', 'sub', 'Trimmed — the rest of today is spoken for.'));

  const list = el('div', 'stack');
  for (const t of picks) list.append(taskCard(t, { showProject: true }));
  content.append(list);
}

function viewAll(head, content) {
  head.append(el('h1', '', 'All tasks'));
  const open = db.tasks.filter(isOpen).length;
  head.append(el('p', 'sub', `${open} open across ${db.projects.filter(p => p.status !== 'archived').length} project(s)`));
  content.append(board(db.tasks.filter(t => t.status !== 'dropped'), unionColumns(), db, { showProject: true }));
}

function viewUnassigned(head, content) {
  head.append(el('h1', '', 'No project'));
  const tasks = db.tasks.filter(t => !t.project && t.status !== 'dropped');
  head.append(el('p', 'sub', `${tasks.filter(isOpen).length} open`));
  content.append(board(tasks, columnsFor(null), db));
}

function viewProject(head, content, id) {
  const p = projectOf(id);
  if (!p) { setView('today'); return; }
  const { done, total } = projectProgress(id);
  const pct = total ? Math.round((done / total) * 100) : 0;

  const row = el('div', 'head-row');
  const h = el('h1', '');
  h.append(el('span', 'h1-ico', ICON[p.area] || '•'), document.createTextNode(p.title));
  row.append(h);

  const tools = el('div', 'head-tools');
  const ren = el('button', 'ghost', 'Rename');
  ren.onclick = () => renameProject(p);
  const arc = el('button', 'ghost', p.status === 'archived' ? 'Unarchive' : 'Archive');
  arc.onclick = () => archiveProject(p);
  tools.append(ren, arc);
  row.append(tools);
  head.append(row);

  const bar = el('div', 'progress');
  const fill = el('div', 'progress-fill');
  fill.style.width = `${pct}%`;
  bar.append(fill);
  head.append(bar);
  head.append(el('p', 'sub',
    `${done}/${total} done · ${pct}%${p.horizon ? ` · ${p.horizon}` : ''}${p.status === 'archived' ? ' · archived' : ''}`));

  content.append(board(db.tasks.filter(t => t.project === id && t.status !== 'dropped'), columnsFor(id), p));
}

/* ---------- render: shell ---------- */

function stats() {
  const date = todayStr();
  const open = db.tasks.filter(isOpen);
  return { open: open.length, overdue: open.filter(t => overdueDays(t, date) > 0).length };
}

function renderSidebar() {
  const date = todayStr();
  const byId = new Map(db.tasks.map(t => [t.id, t]));
  const todayCount = (plan?.picks || []).map(id => byId.get(id)).filter(t => t && isOpen(t)).length;
  $('c-today').textContent = todayCount || '';
  $('c-all').textContent = db.tasks.filter(isOpen).length || '';

  const nav = $('project-nav');
  nav.textContent = '';

  const active = db.projects.filter(p => p.status !== 'archived');
  for (const p of active) {
    const { open } = projectProgress(p.id);
    const b = el('button', `nav-item${view === `project:${p.id}` ? ' active' : ''}`);
    b.append(el('span', 'nav-ico', ICON[p.area] || '•'));
    b.append(el('span', 'nav-label', p.title));
    b.append(el('span', 'nav-count', open ? String(open) : ''));
    b.onclick = () => setView(`project:${p.id}`);

    // Dropping a card on a project reassigns it.
    b.addEventListener('dragover', e => {
      if (!dragging) return;
      e.preventDefault();
      b.classList.add('drop-target');
    });
    b.addEventListener('dragleave', () => b.classList.remove('drop-target'));
    b.addEventListener('drop', e => {
      e.preventDefault();
      b.classList.remove('drop-target');
      const t = db.tasks.find(x => x.id === (e.dataTransfer.getData('text/plain') || dragging));
      if (t) setProject(t, p.id);
    });
    nav.append(b);
  }

  const loose = db.tasks.filter(t => !t.project && isOpen(t)).length;
  if (loose || view === 'unassigned') {
    const b = el('button', `nav-item${view === 'unassigned' ? ' active' : ''}`);
    b.append(el('span', 'nav-ico', '○'));
    b.append(el('span', 'nav-label', 'No project'));
    b.append(el('span', 'nav-count', loose ? String(loose) : ''));
    b.onclick = () => setView('unassigned');
    b.addEventListener('dragover', e => { if (dragging) { e.preventDefault(); b.classList.add('drop-target'); } });
    b.addEventListener('dragleave', () => b.classList.remove('drop-target'));
    b.addEventListener('drop', e => {
      e.preventDefault();
      b.classList.remove('drop-target');
      const t = db.tasks.find(x => x.id === (e.dataTransfer.getData('text/plain') || dragging));
      if (t) setProject(t, null);
    });
    nav.append(b);
  }

  const archived = db.projects.filter(p => p.status === 'archived');
  if (archived.length) {
    const b = el('button', 'nav-item muted-item');
    b.append(el('span', 'nav-ico', '🗄'));
    b.append(el('span', 'nav-label', `${archived.length} archived`));
    b.onclick = () => { showArchived = !showArchived; render(); };
    nav.append(b);
    if (showArchived) {
      for (const p of archived) {
        const a = el('button', `nav-item sub-item${view === `project:${p.id}` ? ' active' : ''}`);
        a.append(el('span', 'nav-ico', ICON[p.area] || '•'));
        a.append(el('span', 'nav-label', p.title));
        a.onclick = () => setView(`project:${p.id}`);
        nav.append(a);
      }
    }
  }

  for (const b of document.querySelectorAll('.nav-item[data-view]')) {
    b.classList.toggle('active', b.dataset.view === view);
  }
}

function render() {
  if (!db) return;
  renderSidebar();

  const head = $('main-head');
  const content = $('content');
  head.textContent = '';
  content.textContent = '';

  if (view === 'today') viewToday(head, content);
  else if (view === 'all') viewAll(head, content);
  else if (view === 'unassigned') viewUnassigned(head, content);
  else if (view.startsWith('project:')) viewProject(head, content, view.slice(8));
}

function setView(v) {
  view = v;
  expanded.clear();
  localStorage.setItem('liva.view', v);
  render();
}

/* ---------- setup screen ---------- */

function showSetup(message = '') {
  $('app').classList.add('hidden');
  $('setup').classList.remove('hidden');
  $('s-error').textContent = message;
  $('s-repo').value = cfg.repo;
  $('s-branch').value = cfg.branch;
  $('s-token').value = cfg.token;
}

function showApp() {
  $('setup').classList.add('hidden');
  $('app').classList.remove('hidden');
}

/* ---------- wiring ---------- */

$('s-save').onclick = async () => {
  const repo = $('s-repo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, '');
  const token = $('s-token').value.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { $('s-error').textContent = 'Repo must look like owner/name.'; return; }
  if (!token) { $('s-error').textContent = 'A token is required.'; return; }
  cfg.set(repo, $('s-branch').value.trim() || 'main', token);
  $('s-error').textContent = 'Connecting…';
  showApp();
  await loadAll();
};

$('settings').onclick = () => showSetup();
$('refresh').onclick = () => loadAll();
$('new-project').onclick = () => createProject();

for (const b of document.querySelectorAll('.nav-item[data-view]')) {
  b.onclick = () => setView(b.dataset.view);
}

$('quick').onsubmit = e => {
  e.preventDefault();
  const raw = $('q-text').value.trim();
  if (!raw) return;
  const p = parseTask(raw, todayStr(), $('q-area').value);
  if (!p.title) return;

  // Adding while a project is open files the task there automatically.
  const current = view.startsWith('project:') ? view.slice(8) : null;
  db.tasks.push({
    id: 't_' + Math.random().toString(36).slice(2, 8),
    title: p.title, area: p.area, status: 'todo',
    priority: p.priority, due: p.due, recur: p.recur,
    project: p.project || current,
    subtasks: [], created: todayStr(), touched: todayStr(), nudgedOn: null,
    completed: null, notes: ''
  });
  $('q-text').value = '';
  scheduleSave();
};

window.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && saveTimer) { clearTimeout(saveTimer); flush(); }
});
window.addEventListener('online', () => { offline = false; loadAll(); });
window.addEventListener('offline', () => { offline = true; setStatus('offline', 'failed'); });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

if (cfg.repo && cfg.token) { showApp(); loadAll(); } else { showSetup(); }
