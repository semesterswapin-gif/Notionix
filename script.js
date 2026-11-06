(() => {
  'use strict';

  /* ==========================================================
     STORAGE
     Schema (v2), stored under one key:
       { version: 2, notes: [{ id, title, body(html), created, updated }] }
     Migration: v1 stored a bare array of {id, title, text} under
     "notes". migrate() converts it on first load, then v1 is left
     untouched as a backup. Add future versions as new `if` steps.
     ========================================================== */
  const KEY = 'marginalia.v2';
  const LEGACY_KEY = 'notes';

  const esc = s => s.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

  function migrate() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const data = JSON.parse(raw);
        if (data && Array.isArray(data.notes)) return data.notes;
      }
      const old = JSON.parse(localStorage.getItem(LEGACY_KEY) || 'null');
      if (Array.isArray(old)) {
        const now = Date.now();
        return old.map(n => ({
          id: String(n.id || now + Math.random()),
          title: n.title || '',
          body: esc(n.text || '').replace(/\n/g, '<br>'),
          created: n.created || now, updated: n.updated || now
        }));
      }
    } catch (e) { console.warn('Could not read saved notes', e); }
    return [];
  }

  let notes = migrate();
  let currentId = null;
  let query = '';
  let saveTimer = null;
  let lastDeleted = null, toastTimer = null;

  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify({ version: 2, notes })); setStatus('Saved'); }
    catch (e) { setStatus('Storage full or blocked – changes not saved'); }
  }
  // Debounced autosave: edits are batched ~300ms so typing stays smooth.
  function queueSave() { setStatus('Saving…'); clearTimeout(saveTimer); saveTimer = setTimeout(persist, 300); }
  window.addEventListener('beforeunload', () => { clearTimeout(saveTimer); persist(); });

  /* ==========================================================
     SANITISING — contenteditable HTML is reduced to a small
     whitelist before it is stored or re-inserted.
     ========================================================== */
  const ALLOWED = new Set(['B','STRONG','I','EM','U','UL','OL','LI','BR','DIV','P']);
  function sanitize(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    (function walk(node) {
      [...node.children].forEach(el => {
        walk(el);
        if (!ALLOWED.has(el.tagName)) el.replaceWith(...el.childNodes);
        else [...el.attributes].forEach(a => el.removeAttribute(a.name));
      });
    })(tpl.content);
    return tpl.innerHTML;
  }
  const plain = html => { const d = document.createElement('div'); d.innerHTML = html;
    d.querySelectorAll('br,div,p,li').forEach(n => n.before(' ')); return d.textContent.replace(/\s+/g,' ').trim(); };

  /* ==========================================================
     DOM REFERENCES
     ========================================================== */
  const $ = id => document.getElementById(id);
  const listEl = $('list'), titleEl = $('title'), bodyEl = $('body');
  const editor = $('editor'), blank = $('blank'), statusEl = $('status');
  function setStatus(t) { statusEl.textContent = t; }

  /* ==========================================================
     RENDER — sidebar list (filtered by search, newest first)
     ========================================================== */
  const fmt = ts => new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  function highlight(text) {
    const safe = esc(text);
    if (!query) return safe;
    const re = new RegExp('(' + query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig');
    return safe.replace(re, '<mark>$1</mark>');
  }
  function renderList() {
    const q = query.toLowerCase();
    const shown = notes
      .filter(n => !q || n.title.toLowerCase().includes(q) || plain(n.body).toLowerCase().includes(q))
      .sort((a, b) => b.updated - a.updated);
    $('count').textContent = notes.length + (notes.length === 1 ? ' note' : ' notes');
    listEl.innerHTML = '';
    if (!shown.length) {
      listEl.innerHTML = '<li class="empty">' + (notes.length
        ? 'No notes match “' + esc(query) + '”.'
        : 'No notes yet. Press the + button to write your first one.') + '</li>';
      return;
    }
    shown.forEach(n => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.className = 'item';
      if (n.id === currentId) b.setAttribute('aria-current', 'true');
      b.innerHTML = '<div class="t">' + highlight(n.title || 'Untitled note') + '</div>' +
        '<div class="s">' + highlight(plain(n.body).slice(0, 140) || 'Empty note') + '</div>' +
        '<div class="d">' + fmt(n.updated) + '</div>';
      b.addEventListener('click', () => openNote(n.id));
      li.appendChild(b); listEl.appendChild(li);
    });
  }

  /* ==========================================================
     CRUD
     ========================================================== */
  function openNote(id) {
    const n = notes.find(x => x.id === id);
    if (!n) return closeNote();
    currentId = id;
    titleEl.value = n.title;
    bodyEl.innerHTML = sanitize(n.body);
    blank.classList.add('hidden'); editor.classList.remove('hidden');
    document.body.classList.add('editing');           // mobile: switch to editor pane
    setStatus(''); renderList(); syncTools();
  }
  function closeNote() {
    currentId = null;
    editor.classList.add('hidden'); blank.classList.remove('hidden');
    document.body.classList.remove('editing');
    renderList();
  }
  function createNote() {
    const now = Date.now();
    const n = { id: 'n' + now.toString(36) + Math.random().toString(36).slice(2, 6),
                title: '', body: '', created: now, updated: now };
    notes.push(n); persist(); openNote(n.id); titleEl.focus();
  }
  function updateCurrent() {
    const n = notes.find(x => x.id === currentId);
    if (!n) return;
    n.title = titleEl.value;
    n.body = sanitize(bodyEl.innerHTML);
    n.updated = Date.now();
    queueSave(); renderList();
  }
  function deleteCurrent() {
    const i = notes.findIndex(x => x.id === currentId);
    if (i < 0) return;
    lastDeleted = { note: notes[i], index: i };
    notes.splice(i, 1); persist(); closeNote();
    // Undo toast instead of a blocking confirm() dialog.
    $('toast').classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $('toast').classList.add('hidden'); lastDeleted = null; }, 6000);
  }
  function undoDelete() {
    if (!lastDeleted) return;
    notes.splice(lastDeleted.index, 0, lastDeleted.note);
    persist(); openNote(lastDeleted.note.id);
    lastDeleted = null; $('toast').classList.add('hidden');
  }

  /* ==========================================================
     FORMATTING — document.execCommand is deprecated on paper but
     is still the simplest dependency-free option, supported in
     every browser. Pasting is forced to plain text for safety.
     ========================================================== */
  function syncTools() {
    document.querySelectorAll('.tool[data-cmd]').forEach(b => {
      let on = false; try { on = document.queryCommandState(b.dataset.cmd); } catch (e) {}
      b.setAttribute('aria-pressed', on);
    });
  }
  document.querySelectorAll('.tool[data-cmd]').forEach(b => {
    b.addEventListener('mousedown', e => e.preventDefault());   // keep selection in the editor
    b.addEventListener('click', () => { bodyEl.focus(); document.execCommand(b.dataset.cmd); updateCurrent(); syncTools(); });
  });
  bodyEl.addEventListener('paste', e => {
    e.preventDefault();
    document.execCommand('insertText', false, (e.clipboardData || window.clipboardData).getData('text/plain'));
  });
  document.addEventListener('selectionchange', () => { if (document.activeElement === bodyEl) syncTools(); });

  /* ==========================================================
     EVENTS & KEYBOARD
     ========================================================== */
  titleEl.addEventListener('input', updateCurrent);
  bodyEl.addEventListener('input', updateCurrent);
  titleEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); bodyEl.focus(); } });
  $('add').addEventListener('click', createNote);
  $('delete').addEventListener('click', deleteCurrent);
  $('undo').addEventListener('click', undoDelete);
  $('back').addEventListener('click', closeNote);
  $('search').addEventListener('input', e => { query = e.target.value.trim(); renderList(); });

  document.addEventListener('keydown', e => {
    if (e.altKey && e.key.toLowerCase() === 'n') { e.preventDefault(); createNote(); }
    else if (e.key === '/' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName) && !document.activeElement.isContentEditable) {
      e.preventDefault(); $('search').focus();
    }
    else if (e.key === 'Escape') {
      if (document.activeElement === $('search')) { $('search').value = ''; query = ''; renderList(); }
      else if (currentId && window.matchMedia('(max-width: 760px)').matches) closeNote();
    }
  });

  /* ---------- Boot: open the most recent note on wide screens ---------- */
  renderList();
  if (notes.length && !window.matchMedia('(max-width: 760px)').matches) {
    openNote([...notes].sort((a, b) => b.updated - a.updated)[0].id);
  }
})();