/**
 * Proto Viewer — Comment Widget (standalone)
 * Injected by the service worker into every proto page opened directly.
 * Shares localStorage + GitHub Gist storage with the main viewer (index.html).
 * Comment key = "protos/FileName.html#InternalHash"  (matches viewer key format)
 */
(function () {
  'use strict';

  // Prevent double-init (e.g. if the widget is included twice)
  if (window.__PV_WIDGET_INIT) return;
  window.__PV_WIDGET_INIT = true;

  // ── CONFIG injected by the service worker ──────────────────────────────────
  // sw.js sets window.__PV_REPO (e.g. "/proto-viewer/") before this script loads.
  const repoBase = window.__PV_REPO || location.pathname.replace(/\/protos\/.*$/, '/');

  // ── CONSTANTS ──────────────────────────────────────────────────────────────
  const STORAGE_KEY   = 'pv_comments_v2';
  const TOKEN_KEY     = 'pv_gist_token';
  const GIST_FILENAME = 'comments.json';

  // ── STATE ──────────────────────────────────────────────────────────────────
  let commentsDB   = {};  // { 'protos/X.html#hash': [{id,num,x,y,text,date}] }
  let commentNums  = {};  // { key: lastNum }
  let commentTombs = {};  // { key: [{id, deletedAt}] }
  let gistId       = null;
  let gistToken    = null;
  let commentMode  = false;
  let openBubbleId = null;
  let syncTimer    = null;
  let syncInFlight = false;
  let syncPending  = false;

  // ── KEY ─────────────────────────────────────────────────────────────────────
  // "protos/Espace-Gestion.html#Contact"  — identical to the viewer's key
  function getPageKey() {
    const rel = location.pathname.slice(repoBase.length); // "protos/Espace-Gestion.html"
    return rel + location.hash;                            // + "#Contact" or ""
  }
  let currentKey = getPageKey();

  // ── LOCAL STORAGE ───────────────────────────────────────────────────────────
  function loadFromLocal() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        return { db: p.db || {}, counter: p.counter || {}, tombs: p.tombs || {} };
      }
    } catch {}
    return { db: {}, counter: {}, tombs: {} };
  }

  function saveToLocal() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        db: commentsDB, counter: commentNums, tombs: commentTombs
      }));
    } catch {}
  }

  // ── MERGE (same logic as viewer) ────────────────────────────────────────────
  function mergeStores(a, b) {
    const db = {}, counter = {}, tombs = {};
    const keys = new Set([
      ...Object.keys(a.db    || {}), ...Object.keys(b.db    || {}),
      ...Object.keys(a.tombs || {}), ...Object.keys(b.tombs || {}),
    ]);
    keys.forEach(k => {
      // Tombstones — union, keep latest deletedAt per id
      const tombMap = new Map();
      [...((a.tombs && a.tombs[k]) || []), ...((b.tombs && b.tombs[k]) || [])]
        .forEach(t => {
          const prev = tombMap.get(t.id);
          if (!prev || (t.deletedAt || 0) > (prev.deletedAt || 0)) tombMap.set(t.id, t);
        });
      tombs[k] = [...tombMap.values()];
      const deadIds = new Set(tombs[k].map(t => t.id));

      // Comments — union by id, tombstones win
      const seen = new Map();
      [...((a.db && a.db[k]) || []), ...((b.db && b.db[k]) || [])]
        .forEach(c => {
          if (deadIds.has(c.id)) return;
          const prev = seen.get(c.id);
          if (!prev || (c.date || 0) > (prev.date || 0)) seen.set(c.id, c);
        });
      db[k] = [...seen.values()].sort((x, y) => (x.num || 0) - (y.num || 0));
      counter[k] = Math.max(
        (a.counter && a.counter[k]) || 0,
        (b.counter && b.counter[k]) || 0,
        ...db[k].map(c => c.num || 0),
      );
    });
    return { db, counter, tombs };
  }

  // ── GIST API ─────────────────────────────────────────────────────────────────
  function gistOk() { return !!(gistId && gistToken); }

  async function fetchGist() {
    if (!gistOk()) return null;
    const res = await fetch(`https://api.github.com/gists/${gistId}`, {
      headers: { Authorization: `Bearer ${gistToken}`, Accept: 'application/vnd.github+json' },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = await res.json();
    const file = data.files && data.files[GIST_FILENAME];
    if (!file) return { db: {}, counter: {}, tombs: {} };
    let content = file.content;
    if (file.truncated && file.raw_url) {
      content = await (await fetch(file.raw_url, { cache: 'no-store' })).text();
    }
    try {
      const p = JSON.parse(content);
      return { db: p.db || {}, counter: p.counter || {}, tombs: p.tombs || {} };
    } catch { return null; }
  }

  async function writeGist(payload) {
    if (!gistOk()) return;
    await fetch(`https://api.github.com/gists/${gistId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${gistToken}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        files: {
          [GIST_FILENAME]: {
            content: JSON.stringify({
              version: 3, updatedAt: Date.now(),
              db: payload.db, counter: payload.counter, tombs: payload.tombs,
            }, null, 2),
          },
        },
      }),
    });
  }

  async function pushToGist() {
    if (!gistOk() || !navigator.onLine) return;
    if (syncInFlight) { syncPending = true; return; }
    syncInFlight = true;
    try {
      let remote = { db: {}, counter: {}, tombs: {} };
      try { remote = (await fetchGist()) || remote; } catch {}
      const merged = mergeStores(remote, { db: commentsDB, counter: commentNums, tombs: commentTombs });
      commentsDB = merged.db; commentNums = merged.counter; commentTombs = merged.tombs;
      saveToLocal();
      await writeGist({ db: commentsDB, counter: commentNums, tombs: commentTombs });
      renderPins(); updateBadge();
    } catch (e) { console.warn('[pv-widget] Gist sync failed:', e.message); }
    finally {
      syncInFlight = false;
      if (syncPending) { syncPending = false; schedulePush(300); }
    }
  }

  function schedulePush(delay = 1200) {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => { syncTimer = null; pushToGist(); }, delay);
  }

  function saveComments() { saveToLocal(); schedulePush(); }

  // ── INIT ─────────────────────────────────────────────────────────────────────
  async function init() {
    // Load local store immediately (fast)
    const local = loadFromLocal();
    commentsDB = local.db; commentNums = local.counter; commentTombs = local.tombs;

    // Fetch config.json for gistId
    try {
      const res = await fetch(repoBase + 'config.json?t=' + Date.now());
      if (res.ok) { const cfg = await res.json(); gistId = cfg.gistId || null; }
    } catch {}
    gistToken = localStorage.getItem(TOKEN_KEY) || null;

    // Merge with remote Gist
    if (gistOk()) {
      try {
        const remote = await fetchGist();
        if (remote) {
          const merged = mergeStores(remote, local);
          commentsDB = merged.db; commentNums = merged.counter; commentTombs = merged.tombs;
          saveToLocal();
        }
      } catch {}
    }

    renderPins();
    updateBadge();
    setSyncHint();
  }

  // ── STYLES ───────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('pv-widget-styles')) return;
    const s = document.createElement('style');
    s.id = 'pv-widget-styles';
    s.textContent = `
      #pv-fab-wrap {
        position: fixed; bottom: 20px; right: 20px; z-index: 2147483640;
        display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
        font-family: 'DM Sans', system-ui, sans-serif;
      }
      #pv-sync-hint {
        background: #1c1d22; border: 1px solid #27282e; color: #8b8d97;
        font-size: 11px; padding: 4px 10px; border-radius: 20px;
        white-space: nowrap; cursor: default; user-select: none;
        display: none;
      }
      #pv-sync-hint.pv-warn { color: #f0b85e; border-color: rgba(240,184,94,.4); cursor: pointer; }
      #pv-sync-hint.pv-ok   { color: #4cd58a; border-color: rgba(76,213,138,.35); }
      #pv-fab {
        width: 46px; height: 46px; border-radius: 50%;
        background: #636bff; color: #fff; border: none;
        cursor: pointer; box-shadow: 0 4px 18px rgba(99,107,255,.55);
        display: flex; align-items: center; justify-content: center;
        transition: transform .18s, box-shadow .18s, background .18s;
        position: relative;
      }
      #pv-fab:hover { transform: scale(1.08); box-shadow: 0 6px 24px rgba(99,107,255,.75); }
      #pv-fab.pv-active { background: #ff8c42; box-shadow: 0 4px 18px rgba(255,140,66,.55); }
      #pv-fab-badge {
        position: absolute; top: -4px; right: -4px;
        background: #fff; color: #636bff;
        border-radius: 10px; font-size: 10px; font-weight: 700;
        min-width: 18px; height: 18px;
        display: flex; align-items: center; justify-content: center;
        padding: 0 4px; font-family: monospace;
        box-shadow: 0 1px 4px rgba(0,0,0,.3);
      }
      #pv-overlay {
        position: fixed; inset: 0; z-index: 2147483630;
        cursor: crosshair; display: none;
        background: rgba(99,107,255,.04);
      }
      .pv-pin {
        position: fixed; z-index: 2147483635;
        width: 28px; height: 28px;
        background: #636bff; border-radius: 50% 50% 0 50%;
        transform: rotate(-45deg);
        cursor: pointer; border: 2px solid #fff;
        box-shadow: 0 2px 10px rgba(0,0,0,.45);
        display: flex; align-items: center; justify-content: center;
        margin-left: -4px; margin-top: -28px;
        transition: background .18s, box-shadow .18s;
        pointer-events: all;
      }
      .pv-pin:hover  { background: #818aff; box-shadow: 0 4px 16px rgba(99,107,255,.5); }
      .pv-pin.pv-sel { background: #ff8c42; }
      .pv-pin-num {
        transform: rotate(45deg);
        font-size: 11px; font-weight: 700; color: #fff;
        font-family: monospace; pointer-events: none; line-height: 1;
      }
      .pv-bubble {
        position: fixed; z-index: 2147483637;
        background: #1c1d22; border: 1px solid #27282e;
        border-radius: 12px; padding: 14px; width: 264px;
        box-shadow: 0 8px 32px rgba(0,0,0,.65);
        font-family: 'DM Sans', system-ui, sans-serif;
        font-size: 13px; color: #e8e9ed;
        animation: pvIn .15s cubic-bezier(.4,0,.2,1);
        pointer-events: all;
      }
      @keyframes pvIn { from { opacity:0; transform:scale(.93) translateY(4px); } to { opacity:1; transform:scale(1) translateY(0); } }
      .pv-bubble textarea {
        width: 100%; background: #0e0f11; border: 1px solid #27282e;
        border-radius: 8px; color: #e8e9ed; font-family: inherit;
        font-size: 13px; padding: 9px 11px; resize: none; outline: none;
        height: 76px; display: block; line-height: 1.5;
      }
      .pv-bubble textarea:focus { border-color: #636bff; }
      .pv-bubble textarea::placeholder { color: #555660; }
      .pv-ba { display: flex; gap: 6px; margin-top: 10px; justify-content: flex-end; }
      .pv-btn { padding: 6px 12px; border-radius: 7px; font-family: inherit; font-size: 12px; font-weight: 500; cursor: pointer; border: 1px solid transparent; transition: all .15s; }
      .pv-btn-cancel  { background: transparent; color: #8b8d97; border-color: #27282e; }
      .pv-btn-cancel:hover  { color: #e8e9ed; }
      .pv-btn-confirm { background: #636bff; color: #fff; }
      .pv-btn-confirm:hover { background: #818aff; }
      .pv-btn-delete  { background: transparent; color: #ff4d6a; border-color: #ff4d6a; }
      .pv-btn-delete:hover  { background: rgba(255,77,106,.12); }
      .pv-btn-close   { background: rgba(52,211,153,.1); color: #34d399; border-color: #34d399; }
      .pv-btn-close:hover   { background: rgba(52,211,153,.2); }
      .pv-comment-text { line-height: 1.6; word-break: break-word; margin-bottom: 4px; }
      .pv-comment-date { font-size: 11px; color: #555660; font-family: monospace; margin-bottom: 10px; }
      /* Token modal */
      #pv-token-modal {
        display: none; position: fixed; inset: 0; z-index: 2147483645;
        align-items: center; justify-content: center; padding: 20px;
      }
      #pv-token-modal.pv-open { display: flex; }
      .pv-token-bd { position: absolute; inset: 0; background: rgba(0,0,0,.55); backdrop-filter: blur(4px); }
      .pv-token-card {
        position: relative; background: #16171b; border: 1px solid #27282e;
        border-radius: 16px; padding: 26px 26px 20px; max-width: 440px; width: 100%;
        color: #e8e9ed; box-shadow: 0 20px 60px rgba(0,0,0,.6);
        font-family: 'DM Sans', system-ui, sans-serif;
      }
      .pv-token-card h2 { font-size: 15px; font-weight: 700; margin: 0 0 8px; }
      .pv-token-card p  { font-size: 13px; color: #8b8d97; line-height: 1.5; margin: 0 0 14px; }
      .pv-token-card input {
        width: 100%; padding: 10px 13px; background: #0e0f11;
        border: 1px solid #27282e; border-radius: 8px; color: #e8e9ed;
        font-family: monospace; font-size: 13px; outline: none; margin-bottom: 6px;
      }
      .pv-token-card input:focus { border-color: #636bff; }
      .pv-token-err { font-size: 12px; color: #ff4d6a; margin-bottom: 6px; display: none; }
      .pv-token-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 10px; }
    `;
    document.head.appendChild(s);
  }

  // ── UI CREATION ──────────────────────────────────────────────────────────────
  function createUI() {
    // FAB wrapper
    const wrap = document.createElement('div');
    wrap.id = 'pv-fab-wrap';

    // Sync hint pill
    const hint = document.createElement('div');
    hint.id = 'pv-sync-hint';
    wrap.appendChild(hint);

    // FAB button
    const fab = document.createElement('button');
    fab.id = 'pv-fab';
    fab.title = 'Commentaires (mode review)';
    fab.innerHTML = `<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
    fab.onclick = toggleCommentMode;
    wrap.appendChild(fab);

    document.body.appendChild(wrap);

    // Click overlay
    const overlay = document.createElement('div');
    overlay.id = 'pv-overlay';
    overlay.addEventListener('click', onOverlayClick);
    document.body.appendChild(overlay);

    // Token modal
    createTokenModal();
  }

  function createTokenModal() {
    const modal = document.createElement('div');
    modal.id = 'pv-token-modal';
    modal.innerHTML = `
      <div class="pv-token-bd" id="pv-token-bd"></div>
      <div class="pv-token-card">
        <h2>Activer la synchro des commentaires</h2>
        <p>Colle le token GitHub pour partager les commentaires avec ton équipe. Il est stocké sur ce navigateur uniquement.</p>
        <input type="password" id="pv-token-input" placeholder="ghp_xxxxxxxxxxxxxxxx" autocomplete="off" spellcheck="false">
        <div class="pv-token-err" id="pv-token-err"></div>
        <div class="pv-token-actions">
          <button class="pv-btn pv-btn-cancel" id="pv-token-cancel">Plus tard</button>
          <button class="pv-btn pv-btn-confirm" id="pv-token-save">Enregistrer</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    document.getElementById('pv-token-bd').onclick     = closeTokenModal;
    document.getElementById('pv-token-cancel').onclick = closeTokenModal;
    document.getElementById('pv-token-save').onclick   = handleTokenSave;
    document.getElementById('pv-token-input').addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); handleTokenSave(); }
      if (e.key === 'Escape') closeTokenModal();
    });
  }

  function setSyncHint() {
    const hint = document.getElementById('pv-sync-hint');
    if (!hint) return;
    if (!gistId) { hint.style.display = 'none'; return; }
    hint.style.display = 'block';
    if (gistToken) {
      hint.textContent = '⬤ Synchro active';
      hint.className = 'pv-ok';
      hint.title = 'Commentaires synchronisés avec l\'équipe via Gist';
      hint.onclick = null;
    } else {
      hint.textContent = '⚠ Token manquant';
      hint.className = 'pv-warn';
      hint.title = 'Clique pour saisir le token GitHub et activer la synchro';
      hint.onclick = openTokenModal;
    }
  }

  function openTokenModal() {
    const modal = document.getElementById('pv-token-modal');
    const input = document.getElementById('pv-token-input');
    const err   = document.getElementById('pv-token-err');
    if (!modal) return;
    input.value = gistToken || '';
    err.style.display = 'none';
    modal.classList.add('pv-open');
    setTimeout(() => input.focus(), 60);
  }

  function closeTokenModal() {
    document.getElementById('pv-token-modal')?.classList.remove('pv-open');
  }

  async function handleTokenSave() {
    const input  = document.getElementById('pv-token-input');
    const err    = document.getElementById('pv-token-err');
    const saveBtn = document.getElementById('pv-token-save');
    const t = (input.value || '').trim();
    if (!t) { showErr(err, 'Colle un token avant d\'enregistrer.'); return; }
    if (!gistId) { showErr(err, 'Aucun gistId dans config.json.'); return; }
    saveBtn.disabled = true; saveBtn.textContent = 'Vérification…';
    try {
      const res = await fetch(`https://api.github.com/gists/${gistId}`, {
        headers: { Authorization: `Bearer ${t}`, Accept: 'application/vnd.github+json' },
        cache: 'no-store',
      });
      if (res.status === 401 || res.status === 403) { showErr(err, `Token invalide (${res.status}).`); return; }
      if (res.status === 404)  { showErr(err, 'Gist introuvable. Vérifie l\'ID dans config.json.'); return; }
      if (!res.ok)             { showErr(err, `Erreur ${res.status}.`); return; }
      localStorage.setItem(TOKEN_KEY, t);
      gistToken = t;
      closeTokenModal();
      setSyncHint();
      // Pull comments from Gist now that we have the token
      const remote = await fetchGist();
      if (remote) {
        const merged = mergeStores(remote, { db: commentsDB, counter: commentNums, tombs: commentTombs });
        commentsDB = merged.db; commentNums = merged.counter; commentTombs = merged.tombs;
        saveToLocal(); renderPins(); updateBadge();
      }
    } catch (e) { showErr(err, 'Erreur réseau : ' + (e.message || e)); }
    finally { saveBtn.disabled = false; saveBtn.textContent = 'Enregistrer'; }
  }

  function showErr(el, msg) { el.textContent = msg; el.style.display = 'block'; }

  // ── COMMENT MODE ─────────────────────────────────────────────────────────────
  function toggleCommentMode() {
    commentMode = !commentMode;
    document.getElementById('pv-fab').classList.toggle('pv-active', commentMode);
    document.getElementById('pv-overlay').style.display = commentMode ? 'block' : 'none';
    if (!commentMode) { closeAllBubbles(); cancelPending(); }
    renderPins();
  }

  // ── ADD COMMENT ──────────────────────────────────────────────────────────────
  function onOverlayClick(e) {
    closeAllBubbles(); cancelPending();
    // Coordinates as fraction of viewport (same convention as viewer)
    const x = e.clientX / window.innerWidth;
    const y = e.clientY / window.innerHeight;
    showInputBubble(x, y);
  }

  function showInputBubble(x, y) {
    // Pending pin
    const pin = document.createElement('div');
    pin.className = 'pv-pin'; pin.id = 'pv-pending-pin';
    applyPinPos(pin, x, y);
    pin.innerHTML = '<span class="pv-pin-num">+</span>';
    document.body.appendChild(pin);

    // Input bubble
    const bubble = document.createElement('div');
    bubble.className = 'pv-bubble'; bubble.id = 'pv-pending-bubble';
    bubble.innerHTML = `
      <textarea id="pv-ta" placeholder="Votre commentaire… (Ctrl+Entrée pour valider)"></textarea>
      <div class="pv-ba">
        <button class="pv-btn pv-btn-cancel" id="pv-cancel-btn">Annuler</button>
        <button class="pv-btn pv-btn-confirm" id="pv-ok-btn">
          <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 12 12"><path d="M2 6l3 3 5-5"/></svg>
          Valider
        </button>
      </div>`;
    applyBubblePos(bubble, x, y);
    document.body.appendChild(bubble);

    document.getElementById('pv-cancel-btn').onclick = cancelPending;
    document.getElementById('pv-ok-btn').onclick = () => confirmComment(x, y);

    const ta = document.getElementById('pv-ta');
    setTimeout(() => ta && ta.focus(), 40);
    ta && ta.addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') confirmComment(x, y);
      if (e.key === 'Escape') cancelPending();
    });
  }

  function applyPinPos(el, x, y) {
    el.style.left = (x * 100) + 'vw';
    el.style.top  = (y * 100) + 'vh';
  }

  function applyBubblePos(el, xFrac, yFrac) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const bw = 264, bh = 170;
    const px = xFrac * vw, py = yFrac * vh;
    let left = px + 30, top = py - 10;
    if (left + bw > vw - 12) left = px - bw - 12;
    if (top  + bh > vh - 12) top  = vh - bh - 12;
    if (top  < 10) top  = 10;
    if (left < 10) left = 10;
    el.style.left = left + 'px';
    el.style.top  = top  + 'px';
  }

  function cancelPending() {
    document.getElementById('pv-pending-pin')?.remove();
    document.getElementById('pv-pending-bubble')?.remove();
  }

  function confirmComment(x, y) {
    const ta = document.getElementById('pv-ta');
    if (!ta) return;
    const text = ta.value.trim();
    if (!text) { ta.focus(); return; }
    const key = getPageKey();
    if (!commentsDB[key])  commentsDB[key]  = [];
    if (!commentNums[key]) commentNums[key] = 0;
    commentNums[key]++;
    commentsDB[key].push({
      id:   Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      num:  commentNums[key],
      x, y, text, date: Date.now(),
    });
    saveComments();
    cancelPending();
    renderPins(); updateBadge();
  }

  // ── RENDER PINS ──────────────────────────────────────────────────────────────
  function renderPins() {
    document.querySelectorAll('.pv-pin:not(#pv-pending-pin), .pv-bubble:not(#pv-pending-bubble)')
      .forEach(el => el.remove());
    if (!commentMode) return;
    const key  = getPageKey();
    const list = commentsDB[key] || [];
    list.forEach(c => {
      const pin = document.createElement('div');
      pin.className  = 'pv-pin';
      pin.dataset.id = c.id;
      applyPinPos(pin, c.x, c.y);
      pin.innerHTML  = `<span class="pv-pin-num">${c.num}</span>`;
      pin.onclick    = e => { e.stopPropagation(); openBubble(c, pin); };
      document.body.appendChild(pin);
    });
  }

  function openBubble(comment, pinEl) {
    closeAllBubbles();
    pinEl.classList.add('pv-sel');
    openBubbleId = comment.id;
    const d = new Date(comment.date);
    const dateStr = d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })
                  + ' · ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    const bubble = document.createElement('div');
    bubble.className = 'pv-bubble';
    bubble.dataset.for = comment.id;
    bubble.innerHTML = `
      <div class="pv-comment-text">${escHtml(comment.text)}</div>
      <div class="pv-comment-date">${dateStr}</div>
      <div class="pv-ba">
        <button class="pv-btn pv-btn-delete" id="pv-del-${comment.id}">
          <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 12 12"><path d="M2 4h8M4 4V2h4v2M3 4l.5 7a1 1 0 0 0 1 .9h3a1 1 0 0 0 1-.9L9 4"/></svg>
          Supprimer
        </button>
        <button class="pv-btn pv-btn-close" id="pv-cls-${comment.id}">
          <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 12 12"><path d="M2 6l3 3 5-5"/></svg>
          Fermer
        </button>
      </div>`;
    applyBubblePos(bubble, comment.x, comment.y);
    document.body.appendChild(bubble);
    document.getElementById(`pv-del-${comment.id}`).onclick = () => deleteComment(comment.id);
    document.getElementById(`pv-cls-${comment.id}`).onclick = closeAllBubbles;
  }

  function closeAllBubbles() {
    document.querySelectorAll('.pv-bubble:not(#pv-pending-bubble)').forEach(el => el.remove());
    document.querySelectorAll('.pv-pin:not(#pv-pending-pin)').forEach(el => el.classList.remove('pv-sel'));
    openBubbleId = null;
  }

  function deleteComment(id) {
    const key = getPageKey();
    commentsDB[key] = (commentsDB[key] || []).filter(c => c.id !== id);
    if (!commentTombs[key]) commentTombs[key] = [];
    if (!commentTombs[key].some(t => t.id === id))
      commentTombs[key].push({ id, deletedAt: Date.now() });
    saveComments(); renderPins(); updateBadge();
  }

  function updateBadge() {
    const key   = getPageKey();
    const count = (commentsDB[key] || []).length;
    const fab   = document.getElementById('pv-fab');
    if (!fab) return;
    let badge = fab.querySelector('#pv-fab-badge');
    if (count > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.id = 'pv-fab-badge';
        fab.appendChild(badge);
      }
      badge.textContent = count;
    } else {
      badge?.remove();
    }
  }

  function escHtml(str) {
    const d = document.createElement('div'); d.textContent = str; return d.innerHTML;
  }

  // ── HASH CHANGE — update comment scope when proto navigates ──────────────────
  window.addEventListener('hashchange', () => {
    const newKey = getPageKey();
    if (newKey === currentKey) return;
    currentKey = newKey;
    closeAllBubbles(); cancelPending();
    renderPins(); updateBadge();
    // Refresh from Gist so team comments for this screen appear immediately
    if (gistOk()) {
      fetchGist().then(remote => {
        if (!remote) return;
        const merged = mergeStores(remote, { db: commentsDB, counter: commentNums, tombs: commentTombs });
        commentsDB = merged.db; commentNums = merged.counter; commentTombs = merged.tombs;
        saveToLocal(); renderPins(); updateBadge();
      }).catch(() => {});
    }
  });

  // Close open bubble on outside click
  document.addEventListener('click', e => {
    if (openBubbleId &&
        !e.target.closest('.pv-bubble') &&
        !e.target.closest('.pv-pin') &&
        !e.target.closest('#pv-fab'))
      closeAllBubbles();
  }, true);

  // ── BOOT ─────────────────────────────────────────────────────────────────────
  function boot() {
    injectStyles();
    createUI();
    init();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
