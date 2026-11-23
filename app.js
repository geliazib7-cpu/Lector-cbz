(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const IMG_RE = /\.(jpe?g|png|webp|gif|avif|bmp)$/i;
  const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp' };
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

  /* ---------------- Almacenamiento local (IndexedDB) ---------------- */
  let dbPromise = null;
  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const r = indexedDB.open('lector-cbz', 2);
        r.onupgradeneeded = () => {
          const d = r.result;
          if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'id' });
          if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs');
          if (!d.objectStoreNames.contains('folders')) d.createObjectStore('folders', { keyPath: 'id' });
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    }
    return dbPromise;
  }
  const wrap = (req) => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const txDone = (tx) => new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

  async function getAllMeta() {
    const d = await db();
    const list = await wrap(d.transaction('meta').objectStore('meta').getAll());
    return list.sort((a, b) => collator.compare(a.name, b.name));
  }
  async function getAllFolders() {
    const d = await db();
    const list = await wrap(d.transaction('folders').objectStore('folders').getAll());
    return list.sort((a, b) => collator.compare(a.name, b.name));
  }
  async function putFolder(folder) {
    const d = await db();
    const tx = d.transaction('folders', 'readwrite');
    tx.objectStore('folders').put(folder);
    return txDone(tx);
  }
  async function putMeta(meta) {
    const d = await db();
    const tx = d.transaction('meta', 'readwrite');
    tx.objectStore('meta').put(meta);
    return txDone(tx);
  }
  async function getBlob(id) {
    const d = await db();
    return wrap(d.transaction('blobs').objectStore('blobs').get(id));
  }
  async function saveBook(meta, blob) {
    const d = await db();
    const tx = d.transaction(['meta', 'blobs'], 'readwrite');
    tx.objectStore('meta').put(meta);
    tx.objectStore('blobs').put(blob, meta.id);
    return txDone(tx);
  }
  async function hasBook(id) {
    const d = await db();
    return !!(await wrap(d.transaction('meta').objectStore('meta').getKey(id)));
  }
  async function deleteBooks(ids) {
    const d = await db();
    const tx = d.transaction(['meta', 'blobs'], 'readwrite');
    ids.forEach((id) => { tx.objectStore('meta').delete(id); tx.objectStore('blobs').delete(id); });
    return txDone(tx);
  }
  async function deleteFolder(folderId, bookIds) {
    await deleteBooks(bookIds);
    const d = await db();
    const tx = d.transaction('folders', 'readwrite');
    tx.objectStore('folders').delete(folderId);
    return txDone(tx);
  }

  /* ---------------- Progreso y ajustes (solo este dispositivo) ---------------- */
  function readJSON(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch (e) { return fallback; }
  }
  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* sin espacio o bloqueado */ }
  }
  const progress = readJSON('lcbz-progress', {});
  const settings = Object.assign(
    { rtl: true, fit: 'height', mode: 'page', theme: 'dark', bright: 100, awake: true },
    readJSON('lcbz-settings', {})
  );
  const saveProgress = (id, page) => { progress[id] = page; writeJSON('lcbz-progress', progress); };
  // Último capítulo leído en cada carpeta (para el botón Reanudar)
  const lastRead = readJSON('lcbz-last', {});
  const setLastRead = (folderId, bookId) => { lastRead[folderId] = bookId; writeJSON('lcbz-last', lastRead); };
  const saveSettings = () => writeJSON('lcbz-settings', settings);

  /* ---------------- Utilidades ---------------- */
  let toastTimer = null;
  function toast(msg, ms = 2200) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }
  function setStatus(msg) {
    const el = $('#status');
    el.textContent = msg || '';
    el.hidden = !msg;
  }
  const prettyName = (n) => n.replace(/\.(cbz|zip)$/i, '');
  // Nombre que se muestra: el que el usuario le puso o, si no, el del archivo
  const displayName = (b) => b.title || prettyName(b.name);
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  function listImages(zip) {
    return Object.values(zip.files)
      .filter((f) => !f.dir && IMG_RE.test(f.name) && !/(^|\/)__MACOSX\//.test(f.name) && !/(^|\/)\._/.test(f.name))
      .sort((a, b) => collator.compare(a.name, b.name));
  }
  async function entryBlob(entry) {
    const ext = entry.name.split('.').pop().toLowerCase();
    const buf = await entry.async('arraybuffer');
    return new Blob([buf], { type: MIME[ext] || 'image/jpeg' });
  }
  async function makeCover(blob, w = 260) {
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = reject;
        i.src = url;
      });
      if (!img.naturalWidth) return null;
      const h = Math.round((img.naturalHeight * w) / img.naturalWidth);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      return await new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.8));
    } catch (e) {
      return null;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /* ---------------- Estado de la biblioteca ---------------- */
  let folders = [];
  let allBooks = [];
  const view = { folderId: null };
  let folderPushed = false;
  let coverUrls = [];

  const currentFolder = () => folders.find((f) => f.id === view.folderId) || null;
  const booksIn = (folderId) => allBooks.filter((b) => b.folderId === folderId);

  // Los capítulos importados con la versión anterior (sin carpeta) se agrupan en una carpeta
  async function migrateLoose() {
    const metas = await getAllMeta();
    const loose = metas.filter((m) => !m.folderId);
    if (!loose.length) return;
    const existing = await getAllFolders();
    let target = existing.find((f) => f.name === 'Sin carpeta');
    if (!target) {
      target = { id: newId(), name: 'Sin carpeta', created: Date.now() };
      await putFolder(target);
    }
    for (const m of loose) await putMeta(Object.assign({}, m, { folderId: target.id }));
  }

  /* ---------------- Importar ---------------- */
  async function importFiles(files) {
    const folderId = view.folderId;
    if (!folderId) { toast('Primero abre una carpeta'); return; }
    const list = Array.from(files);
    let ok = 0;
    for (let n = 0; n < list.length; n++) {
      const file = list[n];
      const label = `(${n + 1}/${list.length}) ${file.name}`;
      if (/\.cbr$|\.rar$/i.test(file.name)) {
        toast('Los .cbr (RAR) no se pueden leer. Conviértelo a .cbz.', 3500);
        continue;
      }
      try {
        const id = `${folderId}|${file.name}|${file.size}|${file.lastModified}`;
        if (await hasBook(id)) { setStatus(`Ya estaba en esta carpeta: ${file.name}`); continue; }
        setStatus(`Importando ${label}…`);
        const zip = await JSZip.loadAsync(file);
        const pages = listImages(zip);
        if (!pages.length) { toast(`"${file.name}" no tiene imágenes.`, 3000); continue; }
        const cover = await makeCover(await entryBlob(pages[0]));
        await saveBook({ id, folderId, name: file.name, pages: pages.length, cover, size: file.size, added: Date.now() }, file);
        ok++;
      } catch (e) {
        console.error(e);
        toast(`No se pudo importar "${file.name}".`, 3500);
      }
    }
    setStatus('');
    if (ok) toast(ok === 1 ? 'Capítulo importado' : `${ok} capítulos importados`);
    await renderLibrary();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  }

  /* ---------------- Carpetas ---------------- */
  async function createFolder() {
    const raw = prompt('Nombre del manga (será una carpeta):');
    if (raw === null) return;
    const name = raw.trim();
    if (!name) { toast('Escribe un nombre'); return; }
    if (folders.some((f) => f.name.toLowerCase() === name.toLowerCase())) { toast('Ya existe una carpeta con ese nombre', 3000); return; }
    await putFolder({ id: newId(), name, created: Date.now() });
    await renderLibrary();
    toast(`Carpeta "${name}" creada`);
  }

  async function renameFolder() {
    const f = currentFolder();
    if (!f) return;
    const raw = prompt('Nuevo nombre de la carpeta:', f.name);
    if (raw === null) return;
    const name = raw.trim();
    if (!name || name === f.name) return;
    if (folders.some((o) => o.id !== f.id && o.name.toLowerCase() === name.toLowerCase())) { toast('Ya existe una carpeta con ese nombre', 3000); return; }
    await putFolder(Object.assign({}, f, { name }));
    await renderLibrary();
  }

  function openFolder(id) {
    view.folderId = id;
    history.pushState({ folder: id }, '');
    folderPushed = true;
    renderLibrary();
    window.scrollTo(0, 0);
  }
  function leaveFolder() {
    if (folderPushed) history.back();
    else { view.folderId = null; renderLibrary(); }
  }

  /* ---------------- Dibujar la biblioteca ---------------- */
  function makeCard({ coverBlob, title, meta, percent, onOpen, onDelete, onRename, onCover, blankIcon }) {
    const card = document.createElement('div');
    card.className = 'card';

    let cover;
    if (coverBlob) {
      cover = document.createElement('img');
      cover.className = 'cover';
      cover.alt = '';
      const u = URL.createObjectURL(coverBlob);
      coverUrls.push(u);
      cover.src = u;
    } else {
      cover = document.createElement('div');
      cover.className = 'cover blank';
      cover.textContent = blankIcon;
    }

    const info = document.createElement('div');
    info.className = 'info';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = title;
    const m = document.createElement('div');
    m.className = 'meta';
    m.textContent = meta;
    info.append(name, m);
    if (percent !== null && percent !== undefined) {
      const bar = document.createElement('div');
      bar.className = 'bar';
      const fill = document.createElement('i');
      fill.style.width = `${percent}%`;
      bar.appendChild(fill);
      info.appendChild(bar);
    }

    const del = document.createElement('button');
    del.className = 'del';
    del.type = 'button';
    del.textContent = '✕';
    del.setAttribute('aria-label', 'Eliminar');
    del.addEventListener('click', (ev) => { ev.stopPropagation(); onDelete(); });

    card.append(cover, info, del);
    if (onRename) {
      const edit = document.createElement('button');
      edit.className = 'edit';
      edit.type = 'button';
      edit.textContent = '✎';
      edit.setAttribute('aria-label', 'Cambiar nombre');
      edit.addEventListener('click', (ev) => { ev.stopPropagation(); onRename(); });
      card.appendChild(edit);
    }
    if (onCover) {
      const pic = document.createElement('button');
      pic.className = 'pic';
      pic.type = 'button';
      pic.textContent = '🖼';
      pic.setAttribute('aria-label', 'Cambiar portada');
      pic.addEventListener('click', (ev) => { ev.stopPropagation(); onCover(); });
      card.appendChild(pic);
    }
    card.addEventListener('click', onOpen);
    return card;
  }

  function updateHeader() {
    const f = currentFolder();
    $('#btn-back').hidden = !f;
    $('#btn-rename').hidden = !f;
    $('#btn-new').hidden = !!f;
    $('#btn-import').hidden = !f;
    $('#btn-cover').hidden = !f;
    $('#btn-settings').hidden = !!f;
    $('#top-title').textContent = f ? f.name : 'Lector CBZ';
  }

  /* ---------------- Portadas elegidas por el usuario ---------------- */
  let coverTarget = null; // { kind: 'book' | 'folder', id }
  function pickCover(kind, id) {
    coverTarget = { kind, id };
    $('#cover-input').click();
  }
  async function applyCover(file) {
    const t = coverTarget;
    coverTarget = null;
    if (!t || !file) return;
    const small = await makeCover(file);
    if (!small) { toast('No se pudo usar esa imagen', 3000); return; }
    if (t.kind === 'book') {
      const b = allBooks.find((x) => x.id === t.id);
      if (!b) return;
      await putMeta(Object.assign({}, b, { cover: small, customCover: true }));
    } else {
      const f = folders.find((x) => x.id === t.id);
      if (!f) return;
      await putFolder(Object.assign({}, f, { cover: small }));
    }
    await renderLibrary();
    toast('Portada actualizada');
  }

  /* ---------------- Botón Reanudar ---------------- */
  function updateResume() {
    const btn = $('#btn-resume');
    const f = currentFolder();
    const book = f ? allBooks.find((b) => b.id === lastRead[f.id] && b.folderId === f.id) : null;
    if (!book) { btn.hidden = true; btn.dataset.id = ''; return; }
    const p = progress[book.id];
    $('#resume-sub').textContent = `${displayName(book)}${Number.isInteger(p) ? ` · pág. ${p + 1}` : ''}`;
    btn.dataset.id = book.id;
    btn.hidden = false;
  }

  async function renderLibrary() {
    [folders, allBooks] = await Promise.all([getAllFolders(), getAllMeta()]);
    if (view.folderId && !currentFolder()) view.folderId = null;

    coverUrls.forEach((u) => URL.revokeObjectURL(u));
    coverUrls = [];
    updateHeader();

    const grid = $('#library');
    const empty = $('#empty');
    grid.textContent = '';
    const f = currentFolder();

    if (!f) {
      empty.hidden = folders.length > 0;
      empty.innerHTML = 'Aún no tienes carpetas.<br>Toca <b>+ Nueva carpeta</b> y ponle el nombre de un manga.<br>Dentro de la carpeta importas sus capítulos (.cbz).';
      for (const folder of folders) {
        const inside = booksIn(folder.id);
        grid.appendChild(makeCard({
          coverBlob: folder.cover || (inside.length ? inside[0].cover : null),
          title: folder.name,
          meta: inside.length === 1 ? '1 capítulo' : `${inside.length} capítulos`,
          percent: null,
          blankIcon: '📁',
          onOpen: () => openFolder(folder.id),
          onDelete: async () => {
            const n = inside.length;
            const msg = n
              ? `¿Eliminar la carpeta "${folder.name}" y sus ${n} capítulos de este dispositivo?`
              : `¿Eliminar la carpeta "${folder.name}"?`;
            if (!confirm(msg)) return;
            await deleteFolder(folder.id, inside.map((b) => b.id));
            inside.forEach((b) => { delete progress[b.id]; });
            writeJSON('lcbz-progress', progress);
            delete lastRead[folder.id];
            writeJSON('lcbz-last', lastRead);
            renderLibrary();
          },
        }));
      }
      updateResume();
      return;
    }

    const inside = booksIn(f.id);
    empty.hidden = inside.length > 0;
    empty.innerHTML = 'Esta carpeta está vacía.<br>Toca <b>+ Importar .cbz</b> y elige los capítulos de este manga.';
    for (const b of inside) {
      const last = progress[b.id];
      grid.appendChild(makeCard({
        coverBlob: b.cover,
        title: displayName(b),
        meta: Number.isInteger(last) ? `Pág. ${last + 1} de ${b.pages}` : `${b.pages} págs.`,
        percent: Number.isInteger(last) ? Math.min(100, ((last + 1) / b.pages) * 100) : 0,
        blankIcon: '📖',
        onOpen: () => openReader(b.id),
        onCover: () => openCoverPicker(b.id),
        onRename: async () => {
          const raw = prompt('Nombre del capítulo (déjalo vacío para volver al nombre del archivo):', displayName(b));
          if (raw === null) return;
          const title = raw.trim();
          const updated = Object.assign({}, b);
          if (title && title !== prettyName(b.name)) updated.title = title; else delete updated.title;
          await putMeta(updated);
          renderLibrary();
        },
        onDelete: async () => {
          if (!confirm(`¿Eliminar "${displayName(b)}" de este dispositivo?`)) return;
          await deleteBooks([b.id]);
          delete progress[b.id];
          writeJSON('lcbz-progress', progress);
          if (lastRead[b.folderId] === b.id) { delete lastRead[b.folderId]; writeJSON('lcbz-last', lastRead); }
          renderLibrary();
        },
      }));
    }
    updateResume();
  }

  /* ---------------- Elegir portada entre las páginas del capítulo ---------------- */
  const CP = { token: 0, urls: [], bookId: null };

  async function openCoverPicker(bookId) {
    const token = ++CP.token;
    CP.bookId = bookId;
    const modal = $('#covers');
    const grid = $('#covers-grid');
    grid.textContent = '';
    modal.hidden = false;
    let entries;
    try {
      const blob = await getBlob(bookId);
      if (!blob) throw new Error('sin archivo');
      entries = listImages(await JSZip.loadAsync(blob));
    } catch (e) {
      console.error(e);
      closeCoverPicker();
      toast('No se pudo abrir el capítulo', 3000);
      return;
    }
    for (let i = 0; i < entries.length; i++) {
      if (token !== CP.token) return;
      const entry = entries[i];
      let thumb = null;
      try { thumb = await makeCover(await entryBlob(entry), 150); } catch (e) { /* se queda sin miniatura */ }
      if (token !== CP.token) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      if (thumb) {
        const img = document.createElement('img');
        const u = URL.createObjectURL(thumb);
        CP.urls.push(u);
        img.src = u;
        img.alt = '';
        btn.appendChild(img);
      }
      const label = document.createElement('span');
      label.textContent = String(i + 1);
      btn.appendChild(label);
      btn.addEventListener('click', async () => {
        try {
          const full = await makeCover(await entryBlob(entry));
          const b = allBooks.find((x) => x.id === bookId);
          if (!full || !b) { toast('No se pudo usar esa página', 3000); return; }
          await putMeta(Object.assign({}, b, { cover: full, customCover: true }));
          closeCoverPicker();
          await renderLibrary();
          toast('Portada actualizada');
        } catch (e) {
          console.error(e);
          toast('No se pudo usar esa página', 3000);
        }
      });
      grid.appendChild(btn);
    }
  }
  function closeCoverPicker() {
    CP.token++;
    $('#covers').hidden = true;
    $('#covers-grid').textContent = '';
    CP.urls.forEach((u) => URL.revokeObjectURL(u));
    CP.urls = [];
  }
  $('#covers-close').addEventListener('click', closeCoverPicker);
  $('#covers').querySelector('.sheet-backdrop').addEventListener('click', closeCoverPicker);
  $('#covers-device').addEventListener('click', () => {
    const id = CP.bookId;
    closeCoverPicker();
    pickCover('book', id);
  });

  /* ---------------- Lector ---------------- */
  const R = { open: false, id: null, meta: null, zip: null, entries: [], siblings: [], i: 0, cache: new Map(), token: 0, pushed: false };
  const els = {
    reader: $('#reader'), stage: $('#stage'), img: $('#page'), strip: $('#strip'), loading: $('#loading'),
    title: $('#reader-title'), info: $('#page-info'), slider: $('#slider'),
  };
  const S = { obs: null, items: [], urls: new Map(), token: 0, raf: 0 };
  const sheet = $('#settings');

  function applySettings() {
    document.documentElement.dataset.theme = settings.theme;
    const tc = document.querySelector('meta[name="theme-color"]');
    if (tc) tc.setAttribute('content', settings.theme === 'light' ? '#f4f5f8' : '#111318');
    $('#dim').style.opacity = String(Math.max(0, Math.min(0.8, (100 - settings.bright) / 100)));
    const strip = settings.mode === 'strip';
    els.stage.classList.toggle('strip-mode', strip);
    els.stage.classList.toggle('fit-height', !strip && settings.fit === 'height');
    els.stage.classList.toggle('fit-width', !strip && settings.fit === 'width');
    els.slider.style.direction = (!strip && settings.rtl) ? 'rtl' : 'ltr';
  }

  function setPageUI(i) {
    els.info.textContent = `${i + 1} / ${R.entries.length}`;
    els.slider.value = i + 1;
  }

  /* --- Modo página --- */
  function pageUrl(i) {
    if (!R.cache.has(i)) {
      const p = entryBlob(R.entries[i]).then((b) => URL.createObjectURL(b));
      R.cache.set(i, p);
    }
    return R.cache.get(i);
  }
  function evict(center) {
    for (const [k, p] of R.cache) {
      if (k < center - 2 || k > center + 4) {
        p.then((u) => URL.revokeObjectURL(u)).catch(() => {});
        R.cache.delete(k);
      }
    }
  }
  function clearCache() {
    for (const p of R.cache.values()) p.then((u) => URL.revokeObjectURL(u)).catch(() => {});
    R.cache.clear();
  }

  async function showPage(i) {
    i = Math.max(0, Math.min(R.entries.length - 1, i));
    R.i = i;
    const token = ++R.token;
    setPageUI(i);
    saveProgress(R.id, i);
    setLastRead(R.meta.folderId, R.id);
    els.loading.hidden = false;
    try {
      const url = await pageUrl(i);
      if (token !== R.token) return;
      els.img.onload = () => { els.loading.hidden = true; };
      els.img.src = url;
      els.stage.scrollTo(0, 0);
      evict(i);
      if (i + 1 < R.entries.length) pageUrl(i + 1).catch(() => {});
      if (i + 2 < R.entries.length) pageUrl(i + 2).catch(() => {});
    } catch (e) {
      console.error(e);
      els.loading.hidden = true;
      toast('No se pudo cargar esta página');
    }
  }

  /* --- Modo tira (lectura continua hacia abajo) --- */
  function stripUrl(i) {
    if (!S.urls.has(i)) S.urls.set(i, entryBlob(R.entries[i]).then((b) => URL.createObjectURL(b)));
    return S.urls.get(i);
  }
  function stripRelease(i) {
    const p = S.urls.get(i);
    if (p) { S.urls.delete(i); p.then((u) => URL.revokeObjectURL(u)).catch(() => {}); }
  }
  async function stripLoad(i) {
    const el = S.items[i];
    if (!el || el.dataset.state) return;
    el.dataset.state = 'loading';
    const token = S.token;
    try {
      const url = await stripUrl(i);
      if (token !== S.token || el.dataset.state !== 'loading') return;
      const img = new Image();
      img.alt = '';
      img.onload = () => { el.style.height = 'auto'; };
      img.src = url;
      el.textContent = '';
      el.appendChild(img);
      el.dataset.state = 'loaded';
    } catch (e) {
      if (token === S.token) el.dataset.state = '';
    }
  }
  function stripUnload(i) {
    const el = S.items[i];
    if (!el || !el.dataset.state) return;
    const h = el.offsetHeight;
    if (h > 0) el.style.height = `${h}px`; // conserva el alto para que no salte el scroll
    el.textContent = '';
    el.dataset.state = '';
    stripRelease(i);
  }
  function stripUpdateCurrent() {
    S.raf = 0;
    if (!R.open || settings.mode !== 'strip' || !S.items.length) return;
    const stage = els.stage;
    let ans = 0;
    if (stage.scrollHeight > stage.clientHeight + 20 && stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 6) {
      ans = S.items.length - 1;
    } else {
      const limit = stage.getBoundingClientRect().top + stage.clientHeight * 0.35;
      let lo = 0, hi = S.items.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (S.items[mid].getBoundingClientRect().top <= limit) { ans = mid; lo = mid + 1; } else hi = mid - 1;
      }
    }
    if (ans !== R.i) {
      R.i = ans;
      setPageUI(ans);
      saveProgress(R.id, ans);
      setLastRead(R.meta.folderId, R.id);
    }
  }
  function stripScroll(dir) {
    els.stage.scrollBy({ top: dir * els.stage.clientHeight * 0.85, behavior: 'smooth' });
  }
  function stripGoto(i) {
    const el = S.items[Math.max(0, Math.min(S.items.length - 1, i))];
    if (el) el.scrollIntoView({ block: 'start' });
  }
  function edgeButton(kind) {
    const idx = R.siblings.findIndex((x) => x.id === R.id);
    const nb = R.siblings[idx + (kind === 'next' ? 1 : -1)];
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'edge';
    if (!nb) {
      if (kind === 'prev') return null;
      b.textContent = 'Fin de la carpeta';
      b.disabled = true;
      return b;
    }
    b.textContent = kind === 'next' ? `Siguiente: ${displayName(nb)} ›` : `‹ Anterior: ${displayName(nb)}`;
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (kind === 'next') { saveProgress(R.id, R.entries.length - 1); openReader(nb.id); }
      else openReader(nb.id, true);
    });
    return b;
  }
  function teardownStrip() {
    S.token++;
    if (S.obs) { S.obs.disconnect(); S.obs = null; }
    for (const p of S.urls.values()) p.then((u) => URL.revokeObjectURL(u)).catch(() => {});
    S.urls.clear();
    S.items = [];
    els.strip.textContent = '';
  }
  function buildStrip(start) {
    teardownStrip();
    const strip = els.strip;
    const w = strip.clientWidth || window.innerWidth;
    const ph = Math.round(w * 1.45);
    const prev = edgeButton('prev');
    if (prev) strip.appendChild(prev);
    for (let i = 0; i < R.entries.length; i++) {
      const d = document.createElement('div');
      d.className = 'sp';
      d.dataset.i = String(i);
      d.style.height = `${ph}px`;
      strip.appendChild(d);
      S.items.push(d);
    }
    strip.appendChild(edgeButton('next'));
    S.obs = new IntersectionObserver((list) => {
      for (const en of list) {
        const i = Number(en.target.dataset.i);
        if (en.isIntersecting) stripLoad(i); else stripUnload(i);
      }
    }, { root: els.stage, rootMargin: '200% 0px 200% 0px' });
    S.items.forEach((d) => S.obs.observe(d));
    R.i = start;
    setPageUI(start);
    saveProgress(R.id, start);
    setLastRead(R.meta.folderId, R.id);
    stripGoto(start);
  }
  els.stage.addEventListener('scroll', () => {
    if (R.open && settings.mode === 'strip' && !S.raf) S.raf = requestAnimationFrame(stripUpdateCurrent);
  }, { passive: true });

  /* --- Abrir / cerrar --- */
  async function startView(start) {
    teardownStrip();
    applySettings();
    if (settings.mode === 'strip') {
      els.img.removeAttribute('src');
      els.loading.hidden = true;
      buildStrip(start);
    } else {
      await showPage(start);
    }
  }
  function switchMode() {
    if (!R.open) return;
    R.token++;
    clearCache();
    startView(R.i);
  }

  // Mantener la pantalla encendida mientras lees
  let wake = null;
  async function updateWake() {
    try {
      if (R.open && settings.awake && navigator.wakeLock) {
        if (!wake) {
          wake = await navigator.wakeLock.request('screen');
          wake.addEventListener('release', () => { wake = null; });
        }
      } else if (wake) {
        await wake.release();
        wake = null;
      }
    } catch (e) { wake = null; }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') updateWake(); });

  async function openReader(id, startAtEnd) {
    const meta = allBooks.find((b) => b.id === id);
    if (!meta) return;
    try {
      const blob = await getBlob(id);
      if (!blob) { toast('Archivo no encontrado, impórtalo otra vez.', 3000); return; }
      const zip = await JSZip.loadAsync(blob);
      const entries = listImages(zip);
      if (!entries.length) { toast('Este archivo no tiene imágenes.'); return; }

      clearCache();
      Object.assign(R, { id, meta, zip, entries, siblings: booksIn(meta.folderId) });
      els.title.textContent = displayName(meta);
      els.slider.max = entries.length;
      applySettings();
      els.reader.classList.add('hide-bars');
      els.reader.hidden = false;
      document.body.style.overflow = 'hidden';

      if (!R.open) {
        R.open = true;
        history.pushState({ reader: true }, '');
        R.pushed = true;
      }
      const saved = progress[id];
      const start = startAtEnd ? entries.length - 1 : (Number.isInteger(saved) ? Math.min(saved, entries.length - 1) : 0);
      R.i = start;
      updateWake();
      await startView(start);
    } catch (e) {
      console.error(e);
      toast('No se pudo abrir este archivo.', 3000);
    }
  }

  function closeReader() {
    if (!R.open) return;
    R.open = false;
    R.pushed = false;
    R.token++;
    teardownStrip();
    sheet.hidden = true;
    els.reader.hidden = true;
    els.img.removeAttribute('src');
    document.body.style.overflow = '';
    clearCache();
    R.zip = null; R.entries = [];
    updateWake();
    renderLibrary();
  }

  // dir: +1 = avanzar en la lectura, -1 = retroceder (modo página)
  function go(dir) {
    if (!R.open) return;
    const next = R.i + dir;
    const idx = R.siblings.findIndex((b) => b.id === R.id);
    if (next >= R.entries.length) {
      const following = R.siblings[idx + 1];
      if (following) {
        toast(`Siguiente: ${displayName(following)}`);
        saveProgress(R.id, R.entries.length - 1);
        openReader(following.id);
      } else toast('Fin de la carpeta');
      return;
    }
    if (next < 0) {
      const previous = R.siblings[idx - 1];
      if (previous) { toast(`Anterior: ${displayName(previous)}`); openReader(previous.id, true); }
      return;
    }
    showPage(next);
  }

  // Zonas de toque
  let ignoreClickUntil = 0;
  els.stage.addEventListener('click', (ev) => {
    if (Date.now() < ignoreClickUntil) return;
    if (settings.mode === 'strip') {
      // Tira: arriba sube, abajo baja, centro muestra/oculta la barra
      const y = ev.clientY / window.innerHeight;
      if (y > 0.3 && y < 0.7) { els.reader.classList.toggle('hide-bars'); return; }
      stripScroll(y >= 0.7 ? 1 : -1);
      return;
    }
    const x = ev.clientX / window.innerWidth;
    if (x > 0.33 && x < 0.67) { els.reader.classList.toggle('hide-bars'); return; }
    const right = x >= 0.67;
    go(right ? (settings.rtl ? -1 : 1) : (settings.rtl ? 1 : -1));
  });

  // Deslizar para cambiar de página (solo modo página)
  let t0 = null;
  els.stage.addEventListener('touchstart', (ev) => {
    t0 = ev.touches.length === 1 ? { x: ev.touches[0].clientX, y: ev.touches[0].clientY } : null;
  }, { passive: true });
  els.stage.addEventListener('touchend', (ev) => {
    if (!t0 || !ev.changedTouches.length) return;
    const dx = ev.changedTouches[0].clientX - t0.x;
    const dy = ev.changedTouches[0].clientY - t0.y;
    t0 = null;
    if (settings.mode === 'strip') return;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 2) {
      // Con el zoom del navegador activo no cambiamos de página
      if (window.visualViewport && window.visualViewport.scale > 1.05) return;
      ignoreClickUntil = Date.now() + 400;
      go(dx < 0 ? (settings.rtl ? -1 : 1) : (settings.rtl ? 1 : -1));
    }
  }, { passive: true });

  document.addEventListener('keydown', (ev) => {
    const k = ev.key;
    if (k === 'Escape') {
      if (!$('#covers').hidden) { closeCoverPicker(); return; }
      if (!sheet.hidden) { sheet.hidden = true; return; }
    }
    if (!R.open) return;
    if (settings.mode === 'strip') {
      if (k === 'ArrowDown' || k === 'PageDown' || k === ' ') { ev.preventDefault(); stripScroll(1); }
      else if (k === 'ArrowUp' || k === 'PageUp') { ev.preventDefault(); stripScroll(-1); }
      else if (k === 'Escape') history.back();
      return;
    }
    if (k === 'ArrowRight') go(settings.rtl ? -1 : 1);
    else if (k === 'ArrowLeft') go(settings.rtl ? 1 : -1);
    else if (k === ' ' || k === 'PageDown') { ev.preventDefault(); go(1); }
    else if (k === 'PageUp') go(-1);
    else if (k === 'Escape') history.back();
  });

  $('#btn-close').addEventListener('click', () => { if (R.pushed) history.back(); else closeReader(); });

  // El botón "atrás" del teléfono: primero cierra el lector, luego sale de la carpeta
  window.addEventListener('popstate', () => {
    sheet.hidden = true;
    if (!$('#covers').hidden) closeCoverPicker();
    if (R.open) { closeReader(); return; }
    if (view.folderId) {
      view.folderId = null;
      folderPushed = false;
      renderLibrary();
    }
  });

  els.slider.addEventListener('change', () => {
    const i = Number(els.slider.value) - 1;
    if (settings.mode === 'strip') stripGoto(i); else showPage(i);
  });
  els.slider.addEventListener('input', () => { els.info.textContent = `${els.slider.value} / ${R.entries.length}`; });

  /* ---------------- Configuración ---------------- */
  function syncSheet() {
    sheet.dataset.mode = settings.mode;
    sheet.querySelectorAll('.seg').forEach((seg) => {
      const v = settings[seg.dataset.key];
      const cur = typeof v === 'boolean' ? (v ? '1' : '0') : String(v);
      seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.val === cur));
    });
    $('#set-bright').value = settings.bright;
    $('#set-bright-out').textContent = `${settings.bright}%`;
  }
  function openSettings() { syncSheet(); sheet.hidden = false; }
  function closeSettings() { sheet.hidden = true; }

  sheet.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-close]') || ev.target.closest('#set-close')) { closeSettings(); return; }
    const b = ev.target.closest('.seg button');
    if (!b) return;
    const key = b.parentElement.dataset.key;
    let val = b.dataset.val;
    if (typeof settings[key] === 'boolean') val = val === '1';
    const prev = settings[key];
    settings[key] = val;
    saveSettings();
    applySettings();
    syncSheet();
    if (key === 'mode' && val !== prev) switchMode();
    if (key === 'awake') updateWake();
    if (key === 'fit' && R.open) els.stage.scrollTo(0, 0);
  });
  $('#set-bright').addEventListener('input', (ev) => {
    settings.bright = Number(ev.target.value);
    $('#set-bright-out').textContent = `${settings.bright}%`;
    saveSettings();
    applySettings();
  });
  $('#btn-set').addEventListener('click', openSettings);
  $('#btn-settings').addEventListener('click', openSettings);

  /* ---------------- Arranque ---------------- */
  $('#btn-new').addEventListener('click', createFolder);
  $('#btn-rename').addEventListener('click', renameFolder);
  $('#btn-back').addEventListener('click', leaveFolder);
  $('#btn-cover').addEventListener('click', () => { const f = currentFolder(); if (f) pickCover('folder', f.id); });
  $('#cover-input').addEventListener('change', async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (file) await applyCover(file);
  });
  $('#btn-resume').addEventListener('click', () => {
    const id = $('#btn-resume').dataset.id;
    if (id) openReader(id);
  });
  $('#file-input').addEventListener('change', async (ev) => {
    const files = ev.target.files;
    if (files && files.length) await importFiles(files);
    ev.target.value = '';
  });

  applySettings();
  migrateLoose()
    .then(renderLibrary)
    .catch((e) => {
      console.error(e);
      setStatus('No se pudo abrir el almacenamiento local del navegador.');
    });

  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !reloaded) { reloaded = true; location.reload(); }
    });
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }
})();
