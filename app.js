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
  async function getFolderRec(id) {
    const d = await db();
    return wrap(d.transaction('folders').objectStore('folders').get(id));
  }
  async function getMetaRec(id) {
    const d = await db();
    return wrap(d.transaction('meta').objectStore('meta').get(id));
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
  async function deleteBooks(ids) {
    const d = await db();
    const tx = d.transaction(['meta', 'blobs'], 'readwrite');
    ids.forEach((id) => { tx.objectStore('meta').delete(id); tx.objectStore('blobs').delete(id); });
    return txDone(tx);
  }
  async function deleteFolderRec(id) {
    const d = await db();
    const tx = d.transaction('folders', 'readwrite');
    tx.objectStore('folders').delete(id);
    return txDone(tx);
  }
  async function deleteFolder(folderId, bookIds) {
    await deleteBooks(bookIds);
    await deleteFolderRec(folderId);
  }
  // Quita solo el archivo del dispositivo; el capítulo queda "en la nube"
  async function removeFromDevice(book) {
    const d = await db();
    const tx = d.transaction(['meta', 'blobs'], 'readwrite');
    tx.objectStore('blobs').delete(book.id);
    tx.objectStore('meta').put(Object.assign({}, book, { remoteOnly: true }));
    return txDone(tx);
  }

  /* ---------------- Progreso y ajustes (solo este dispositivo, se sincronizan aparte) ---------------- */
  function readJSON(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch (e) { return fallback; }
  }
  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* sin espacio o bloqueado */ }
  }
  const progress = readJSON('lcbz-progress', {});     // { idCapítulo: página }
  const ptime = readJSON('lcbz-ptime', {});           // { idCapítulo: momento del último cambio }
  const lastRead = readJSON('lcbz-last', {});         // { idCarpeta: idCapítulo }
  const lastT = readJSON('lcbz-lastt', {});           // { idCarpeta: momento }
  const settings = Object.assign(
    { rtl: true, fit: 'height', mode: 'page', theme: 'dark', bright: 100, awake: true },
    readJSON('lcbz-settings', {})
  );
  const persistProgress = () => { writeJSON('lcbz-progress', progress); writeJSON('lcbz-ptime', ptime); };
  const persistLast = () => { writeJSON('lcbz-last', lastRead); writeJSON('lcbz-lastt', lastT); };
  const saveProgress = (id, page) => {
    progress[id] = page;
    ptime[id] = Date.now();
    persistProgress();
    scheduleSync(2000);
  };
  // Último capítulo leído en cada carpeta (para el botón Reanudar)
  const setLastRead = (folderId, bookId) => {
    lastRead[folderId] = bookId;
    lastT[folderId] = Date.now();
    persistLast();
  };
  const forgetProgress = (ids) => {
    ids.forEach((id) => { delete progress[id]; delete ptime[id]; });
    persistProgress();
  };
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

  // Claves iguales en todos los dispositivos: salen del nombre (base64 seguro para la base de datos)
  const b64 = (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const fKey = (name) => `f_${b64(name.trim().toLowerCase())}`;
  const cKey = (fileName) => `c_${b64(fileName)}`;
  const chapKey = (b) => b.key || cKey(b.name);

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
  async function makeCover(blob, w = 260, quality = 0.8) {
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
      return await new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', quality));
    } catch (e) {
      return null;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const blobToDataURL = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

  /* ---------------- Estado de la biblioteca ---------------- */
  let folders = [];
  let allBooks = [];
  const view = { folderId: null };
  let folderPushed = false;
  let coverUrls = [];

  const currentFolder = () => folders.find((f) => f.id === view.folderId) || null;
  const booksIn = (folderId) => allBooks.filter((b) => b.folderId === folderId);

  // Pasa todo lo de una carpeta a otra (también sirve para renombrar, porque el id sale del nombre)
  async function moveFolder(oldId, newId, patch) {
    const old = await getFolderRec(oldId);
    if (!old) return;
    const target = await getFolderRec(newId);
    const metas = await getAllMeta();
    const moving = metas.filter((m) => m.folderId === oldId);
    const inTarget = metas.filter((m) => m.folderId === newId);
    if (!target) await putFolder(Object.assign({}, old, patch || {}, { id: newId }));
    for (const m of moving) {
      const dup = inTarget.find((x) => x.name === m.name);
      if (!dup) { await putMeta(Object.assign({}, m, { folderId: newId })); continue; }
      // El mismo capítulo estaba en las dos carpetas: nos quedamos con el que tiene archivo
      let keep = dup;
      let drop = m;
      if (dup.remoteOnly && !m.remoteOnly) {
        const blob = await getBlob(m.id);
        await deleteBooks([dup.id]);
        await saveBook(Object.assign({}, m, { folderId: newId }), blob);
        keep = m; drop = dup;
      } else {
        await deleteBooks([m.id]);
      }
      if (progress[drop.id] !== undefined && (ptime[drop.id] || 0) >= (ptime[keep.id] || 0)) {
        progress[keep.id] = progress[drop.id];
        ptime[keep.id] = ptime[drop.id] || 0;
      }
      delete progress[drop.id];
      delete ptime[drop.id];
      if (lastRead[oldId] === drop.id) lastRead[oldId] = keep.id;
    }
    await deleteFolderRec(oldId);
    if (lastRead[oldId] !== undefined) {
      if (lastRead[newId] === undefined) { lastRead[newId] = lastRead[oldId]; lastT[newId] = lastT[oldId] || 0; }
      delete lastRead[oldId];
      delete lastT[oldId];
    }
    persistProgress();
    persistLast();
  }

  async function touchFolder(id) {
    const f = await getFolderRec(id);
    if (f) await putFolder(Object.assign({}, f, { upd: Date.now() }));
  }

  // Los capítulos importados con la versión anterior (sin carpeta) se agrupan en una carpeta
  async function migrateLoose() {
    const metas = await getAllMeta();
    const loose = metas.filter((m) => !m.folderId);
    if (!loose.length) return;
    const id = fKey('Sin carpeta');
    if (!(await getFolderRec(id))) await putFolder({ id, name: 'Sin carpeta', created: Date.now(), upd: Date.now() });
    for (const m of loose) await putMeta(Object.assign({}, m, { folderId: id }));
  }

  // Versiones anteriores usaban ids al azar: ahora salen del nombre para que coincidan entre dispositivos
  async function migrateIds() {
    for (const f of await getAllFolders()) {
      const want = fKey(f.name);
      if (f.id !== want) await moveFolder(f.id, want, { name: f.name });
    }
    const now = Date.now();
    for (const m of await getAllMeta()) {
      const n = Object.assign({}, m);
      let changed = false;
      if (!n.key) { n.key = cKey(n.name); changed = true; }
      if (!n.upd) { n.upd = n.added || now; changed = true; }
      if (n.cover && !n.covT) { n.covT = n.added || now; changed = true; }
      if (changed) await putMeta(n);
    }
    for (const f of await getAllFolders()) {
      if (!f.upd) await putFolder(Object.assign({}, f, { upd: f.created || now }));
    }
  }

  /* ---------------- Importar ---------------- */
  let pendingPlaceholder = null; // capítulo de la nube que el usuario tocó para importar

  function importPlaceholder(book) {
    pendingPlaceholder = book;
    toast(`Elige el archivo «${book.name}»`, 3500);
    $('#file-input').click();
  }

  async function importFiles(files) {
    const folderId = view.folderId;
    if (!folderId) { toast('Primero abre una carpeta'); return; }
    const list = Array.from(files);
    const wanted = pendingPlaceholder;
    pendingPlaceholder = null;
    const known = booksIn(folderId);
    let ok = 0;
    let mismatch = false;
    for (let n = 0; n < list.length; n++) {
      const file = list[n];
      const label = `(${n + 1}/${list.length}) ${file.name}`;
      if (/\.cbr$|\.rar$/i.test(file.name)) {
        toast('Los .cbr (RAR) no se pueden leer. Conviértelo a .cbz.', 3500);
        continue;
      }
      try {
        const existing = known.find((b) => b.name === file.name);
        if (existing && !existing.remoteOnly) { setStatus(`Ya estaba en esta carpeta: ${file.name}`); continue; }
        setStatus(`Importando ${label}…`);
        const zip = await JSZip.loadAsync(file);
        const pages = listImages(zip);
        if (!pages.length) { toast(`"${file.name}" no tiene imágenes.`, 3000); continue; }
        const now = Date.now();
        let meta;
        if (existing) {
          // Era un capítulo de la nube: se llena con el archivo, conserva su avance y su nombre
          meta = Object.assign({}, existing, { remoteOnly: false, pages: pages.length, size: file.size });
          if (!existing.cover) {
            const cover = await makeCover(await entryBlob(pages[0]));
            if (cover) { meta.cover = cover; meta.covT = now; }
          }
        } else {
          const cover = await makeCover(await entryBlob(pages[0]));
          meta = {
            id: `${folderId}|${file.name}`, folderId, name: file.name, key: cKey(file.name),
            pages: pages.length, cover, size: file.size, added: now, upd: now, covT: cover ? now : 0,
          };
          if (wanted && wanted.name !== file.name) mismatch = true;
        }
        await saveBook(meta, file);
        known.push(meta);
        ok++;
      } catch (e) {
        console.error(e);
        toast(`No se pudo importar "${file.name}".`, 3500);
      }
    }
    setStatus('');
    if (ok) {
      await touchFolder(folderId);
      toast(mismatch ? `Ese archivo no se llama «${wanted.name}»; se agregó como capítulo nuevo.` : (ok === 1 ? 'Capítulo importado' : `${ok} capítulos importados`), mismatch ? 4000 : 2200);
      scheduleSync(300);
    }
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
    const now = Date.now();
    await putFolder({ id: fKey(name), name, created: now, upd: now });
    scheduleSync(300);
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
    const newId = fKey(name);
    const now = Date.now();
    if (newId === f.id) {
      await putFolder(Object.assign({}, f, { name, upd: now }));
    } else {
      await cloudDeleteFolder(f.id, booksIn(f.id)); // la carpeta con el nombre viejo desaparece de la nube
      await moveFolder(f.id, newId, { name, upd: now });
      view.folderId = newId;
    }
    scheduleSync(300);
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
  function makeCard({ coverBlob, title, meta, percent, onOpen, onDelete, onRename, onCover, blankIcon, cloud }) {
    const card = document.createElement('div');
    card.className = cloud ? 'card cloud' : 'card';

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
    if (cloud) {
      const badge = document.createElement('span');
      badge.className = 'cloud-badge';
      badge.textContent = '☁';
      card.appendChild(badge);
    }
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
    $('#top-title').textContent = f ? f.name : (Cloud.user ? 'Lector CBZ ☁' : 'Lector CBZ');
    $('#login-hint').hidden = !!f || !Cloud.configured || !!Cloud.user;
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
    const now = Date.now();
    if (t.kind === 'book') {
      const b = allBooks.find((x) => x.id === t.id);
      if (!b) return;
      await putMeta(Object.assign({}, b, { cover: small, customCover: true, covT: now }));
    } else {
      const f = folders.find((x) => x.id === t.id);
      if (!f) return;
      await putFolder(Object.assign({}, f, { cover: small, covT: now }));
    }
    scheduleSync(500);
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
    $('#resume-sub').textContent = `${book.remoteOnly ? '☁ ' : ''}${displayName(book)}${Number.isInteger(p) ? ` · pág. ${p + 1}` : ''}`;
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
        const here = inside.filter((b) => !b.remoteOnly).length;
        const firstCover = inside.find((b) => b.cover);
        const count = inside.length === 1 ? '1 capítulo' : `${inside.length} capítulos`;
        grid.appendChild(makeCard({
          coverBlob: folder.cover || (firstCover ? firstCover.cover : null),
          title: folder.name,
          meta: here < inside.length ? `${count} · ${here} aquí` : count,
          percent: null,
          blankIcon: '📁',
          onOpen: () => openFolder(folder.id),
          onDelete: async () => {
            const n = inside.length;
            let msg;
            if (Cloud.user) {
              msg = `¿Eliminar la carpeta "${folder.name}"${n ? ` y sus ${n} capítulos` : ''} de TODOS tus dispositivos? No se puede deshacer.`;
            } else {
              msg = n
                ? `¿Eliminar la carpeta "${folder.name}" y sus ${n} capítulos de este dispositivo?`
                : `¿Eliminar la carpeta "${folder.name}"?`;
            }
            if (!confirm(msg)) return;
            await cloudDeleteFolder(folder.id, inside);
            await deleteFolder(folder.id, inside.map((b) => b.id));
            forgetProgress(inside.map((b) => b.id));
            delete lastRead[folder.id];
            delete lastT[folder.id];
            persistLast();
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
      const ph = !!b.remoteOnly;
      const hasLast = Number.isInteger(last);
      let metaText;
      if (ph) metaText = hasLast ? `☁ En la nube · pág. ${last + 1}` : '☁ En la nube · toca para importar';
      else metaText = hasLast ? `Pág. ${last + 1} de ${b.pages}` : `${b.pages} págs.`;
      grid.appendChild(makeCard({
        coverBlob: b.cover,
        title: displayName(b),
        meta: metaText,
        percent: hasLast && b.pages ? Math.min(100, ((last + 1) / b.pages) * 100) : 0,
        blankIcon: '📖',
        cloud: ph,
        onOpen: () => (ph ? importPlaceholder(b) : openReader(b.id)),
        onCover: () => (ph ? pickCover('book', b.id) : openCoverPicker(b.id)),
        onRename: async () => {
          const raw = prompt('Nombre del capítulo (déjalo vacío para volver al nombre del archivo):', displayName(b));
          if (raw === null) return;
          const title = raw.trim();
          const updated = Object.assign({}, b, { upd: Date.now() });
          if (title && title !== prettyName(b.name)) updated.title = title; else delete updated.title;
          await putMeta(updated);
          scheduleSync(500);
          renderLibrary();
        },
        onDelete: async () => {
          if (Cloud.user && !ph) {
            if (!confirm(`¿Quitar "${displayName(b)}" de este dispositivo?\nSeguirá en tu nube y podrás volver a importarlo.`)) return;
            await removeFromDevice(b);
          } else {
            const msg = Cloud.user
              ? `¿Eliminar "${displayName(b)}" de tu cuenta, en todos tus dispositivos?`
              : `¿Eliminar "${displayName(b)}" de este dispositivo?`;
            if (!confirm(msg)) return;
            await cloudDeleteChapter(b);
            await deleteBooks([b.id]);
            forgetProgress([b.id]);
            if (lastRead[b.folderId] === b.id) { delete lastRead[b.folderId]; delete lastT[b.folderId]; persistLast(); }
          }
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
          await putMeta(Object.assign({}, b, { cover: full, customCover: true, covT: Date.now() }));
          scheduleSync(500);
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
    if (meta.remoteOnly) { importPlaceholder(meta); return; }
    try {
      const blob = await getBlob(id);
      if (!blob) { toast('Archivo no encontrado, impórtalo otra vez.', 3000); return; }
      const zip = await JSZip.loadAsync(blob);
      const entries = listImages(zip);
      if (!entries.length) { toast('Este archivo no tiene imágenes.'); return; }

      clearCache();
      Object.assign(R, { id, meta, zip, entries, siblings: booksIn(meta.folderId).filter((b) => !b.remoteOnly) });
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

  /* ---------------- Cuenta y sincronización (Firebase) ---------------- */
  const Cloud = {
    configured: false, user: null, online: undefined, status: 'off', msg: '',
    got: { lib: false, prog: false, last: false },
    lib: {}, prog: {}, last: {},
    unsubs: [], timer: null, running: false, again: false, tried: new Set(),
  };
  const cloudPrefix = () => `users/${Cloud.user.uid}/`;

  function cloudConfigured() {
    const c = window.FIREBASE_CONFIG;
    return !!(window.FB && c && c.apiKey && c.databaseURL && !/PEGA/i.test(`${c.apiKey}${c.databaseURL}`));
  }

  function statusText() {
    if (Cloud.status === 'error') return `⚠ ${Cloud.msg}`;
    if (Cloud.online === false) return '☁ Sin conexión. Se sincroniza al volver internet.';
    if (Cloud.status === 'syncing') return '☁ Sincronizando…';
    return '☁ Sincronizado';
  }
  function updateAccountUI() {
    const t = $('#acct-text');
    const btn = $('#acct-btn');
    const sync = $('#acct-sync');
    if (!Cloud.configured) {
      t.textContent = 'Sin activar. Falta pegar la configuración de Firebase en el archivo firebase-config.js.';
      btn.textContent = 'Cómo activarlo';
      sync.hidden = true;
    } else if (!Cloud.user) {
      t.textContent = 'Sin sesión: tus mangas solo están en este dispositivo.';
      btn.textContent = 'Iniciar sesión';
      sync.hidden = true;
    } else {
      t.textContent = `${Cloud.user.email || 'Cuenta'}\n${statusText()}`;
      btn.textContent = 'Cerrar sesión';
      sync.hidden = false;
    }
    updateHeader();
  }
  function setCloudStatus(status, msg) {
    Cloud.status = status;
    Cloud.msg = msg || '';
    updateAccountUI();
  }
  const syncError = (e) => {
    console.error(e);
    const code = String((e && (e.code || e.message)) || '');
    setCloudStatus('error', /permission/i.test(code) ? 'Sin permiso: revisa las reglas de la base de datos.' : 'No se pudo sincronizar.');
  };

  /* --- Conexión con Firebase --- */
  function startCloud() {
    Cloud.configured = cloudConfigured();
    if (!Cloud.configured) { updateAccountUI(); return; }
    try {
      FB.init(window.FIREBASE_CONFIG);
      FB.listen('.info/connected', (v) => {
        Cloud.online = !!v;
        updateAccountUI();
        if (v) scheduleSync(500);
      }, () => {});
      FB.onAuth(onAuthChange);
    } catch (e) {
      console.error(e);
      Cloud.configured = false;
    }
    updateAccountUI();
  }

  function stopListeners() {
    Cloud.unsubs.forEach((u) => { try { u(); } catch (e) { /* nada */ } });
    Cloud.unsubs = [];
    Cloud.got = { lib: false, prog: false, last: false };
    Cloud.lib = {}; Cloud.prog = {}; Cloud.last = {};
    clearTimeout(Cloud.timer);
  }

  function onAuthChange(user) {
    stopListeners();
    Cloud.user = user;
    if (!user) {
      setCloudStatus('off');
      renderLibrary();
      return;
    }
    setCloudStatus('syncing');
    for (const key of ['lib', 'prog', 'last']) {
      Cloud.unsubs.push(FB.listen(`${cloudPrefix()}${key}`, (v) => {
        Cloud[key] = v || {};
        Cloud.got[key] = true;
        scheduleSync(250);
      }, syncError));
    }
    renderLibrary();
  }

  function scheduleSync(delay = 1500) {
    if (!Cloud.user) return;
    clearTimeout(Cloud.timer);
    Cloud.timer = setTimeout(runSync, delay);
  }
  async function runSync() {
    if (!Cloud.user || !(Cloud.got.lib && Cloud.got.prog && Cloud.got.last)) return;
    if (Cloud.running) { Cloud.again = true; return; }
    Cloud.running = true;
    try {
      do {
        Cloud.again = false;
        await reconcile();
      } while (Cloud.again);
      if (Cloud.status !== 'ok') setCloudStatus('ok');
    } catch (e) {
      syncError(e);
    } finally {
      Cloud.running = false;
    }
  }

  // Envía cambios a la nube sin esperar: si no hay internet, Firebase los guarda y los manda al volver
  function cloudSend(obj) {
    if (!Cloud.user) return;
    const p = cloudPrefix();
    const o = {};
    for (const [k, v] of Object.entries(obj)) o[`${p}${k}`] = v;
    Promise.resolve(FB.update(o)).catch(syncError);
  }
  // Borrar = marcar como eliminado, para que los demás dispositivos también lo quiten
  async function cloudDeleteFolder(fid, books) {
    if (!Cloud.user) return;
    const t = Date.now();
    const o = { [`lib/${fid}/d`]: t };
    const keys = new Set(books.map(chapKey));
    Object.keys((Cloud.lib[fid] && Cloud.lib[fid].ch) || {}).forEach((k) => keys.add(k));
    keys.forEach((ck) => { o[`lib/${fid}/ch/${ck}/d`] = t; });
    cloudSend(o);
  }
  async function cloudDeleteChapter(b) {
    if (!Cloud.user) return;
    cloudSend({ [`lib/${b.folderId}/ch/${chapKey(b)}/d`]: Date.now() });
  }

  /* --- Poner de acuerdo este dispositivo con la nube (gana el cambio más reciente) --- */
  async function reconcile() {
    if (!Cloud.user) return;
    const RL = Cloud.lib;
    const RP = Cloud.prog;
    const RLAST = Cloud.last;
    const now = Date.now();
    const up = {};
    let changed = false;
    let progChanged = false;
    let lastChanged = false;

    const folderRec = (f) => {
      up[`lib/${f.id}/n`] = f.name;
      up[`lib/${f.id}/c`] = f.created || now;
      up[`lib/${f.id}/u`] = f.upd || now;
      up[`lib/${f.id}/d`] = null;
    };
    const chapterRec = (fid, b) => {
      const p = `lib/${fid}/ch/${chapKey(b)}`;
      up[`${p}/n`] = b.name;
      up[`${p}/t`] = b.title || null;
      up[`${p}/p`] = b.pages || 0;
      up[`${p}/s`] = b.size || 0;
      up[`${p}/a`] = b.added || now;
      up[`${p}/u`] = b.upd || now;
      up[`${p}/d`] = null;
    };

    /* 1. Carpetas */
    const fmap = new Map((await getAllFolders()).map((f) => [f.id, f]));
    let books = await getAllMeta();
    for (const [fid, rf] of Object.entries(RL)) {
      if (!rf || typeof rf !== 'object') continue;
      const loc = fmap.get(fid);
      if (rf.d) {
        if (loc && (loc.upd || 0) <= rf.d) {
          // la eliminaron desde otro dispositivo
          const ids = books.filter((b) => b.folderId === fid).map((b) => b.id);
          await deleteFolder(fid, ids);
          forgetProgress(ids);
          delete lastRead[fid]; delete lastT[fid]; persistLast();
          books = books.filter((b) => b.folderId !== fid);
          fmap.delete(fid);
          changed = true;
        } else if (loc) {
          folderRec(loc); // la volviste a crear después: revive
        }
        continue;
      }
      if (!rf.n) { if (loc) folderRec(loc); continue; }
      if (!loc) {
        const nf = { id: fid, name: rf.n, created: rf.c || now, upd: rf.u || now };
        await putFolder(nf);
        fmap.set(fid, nf);
        changed = true;
      } else if ((rf.u || 0) > (loc.upd || 0)) {
        const nf = Object.assign({}, loc, { name: rf.n, upd: rf.u });
        await putFolder(nf);
        fmap.set(fid, nf);
        changed = true;
      } else if ((loc.upd || 0) > (rf.u || 0)) {
        folderRec(loc);
      }
    }
    for (const loc of fmap.values()) if (!RL[loc.id]) folderRec(loc);

    /* 2. Capítulos */
    for (const fid of fmap.keys()) {
      const rch = (RL[fid] && RL[fid].ch) || {};
      const mine = new Map(books.filter((b) => b.folderId === fid).map((b) => [chapKey(b), b]));
      for (const [ck, rc] of Object.entries(rch)) {
        if (!rc || typeof rc !== 'object') continue;
        const b = mine.get(ck);
        if (rc.d) {
          if (b && (b.upd || 0) <= rc.d) {
            await deleteBooks([b.id]);
            forgetProgress([b.id]);
            if (lastRead[fid] === b.id) { delete lastRead[fid]; delete lastT[fid]; persistLast(); }
            mine.delete(ck);
            changed = true;
          } else if (b) {
            chapterRec(fid, b);
          }
          continue;
        }
        if (!rc.n) { if (b) chapterRec(fid, b); continue; }
        if (!b) {
          await putMeta({
            id: `${fid}|${rc.n}`, folderId: fid, name: rc.n, key: ck, title: rc.t || undefined,
            pages: rc.p || 0, size: rc.s || 0, cover: null, remoteOnly: true,
            added: rc.a || now, upd: rc.u || now, covT: 0,
          });
          changed = true;
        } else if ((rc.u || 0) > (b.upd || 0)) {
          const nb = Object.assign({}, b, { upd: rc.u });
          if (rc.t) nb.title = rc.t; else delete nb.title;
          await putMeta(nb);
          changed = true;
        } else if ((b.upd || 0) > (rc.u || 0)) {
          chapterRec(fid, b);
        }
      }
      for (const [ck, b] of mine) if (!rch[ck]) chapterRec(fid, b);
    }

    /* 3. Avance de lectura y último capítulo */
    books = (await getAllMeta()).filter((b) => fmap.has(b.folderId));
    for (const b of books) {
      const ck = chapKey(b);
      const rp = RP[b.folderId] && RP[b.folderId][ck];
      const lp = progress[b.id];
      const hasL = Number.isInteger(lp);
      const lt = ptime[b.id] || 0;
      const path = `prog/${b.folderId}/${ck}`;
      if (rp && Number.isInteger(rp.p)) {
        if (hasL && lt === 0) {
          // avance de antes de la sincronización: nos quedamos con el más adelantado
          const best = Math.max(lp, rp.p);
          progress[b.id] = best; ptime[b.id] = now; progChanged = true;
          if (best !== rp.p) up[path] = { p: best, t: now };
          if (best !== lp) changed = true;
        } else if ((rp.t || 0) > lt) {
          progress[b.id] = rp.p; ptime[b.id] = rp.t || now; progChanged = true; changed = true;
        } else if (hasL && lt > (rp.t || 0)) {
          up[path] = { p: lp, t: lt };
        }
      } else if (hasL) {
        if (!lt) { ptime[b.id] = now; progChanged = true; }
        up[path] = { p: lp, t: ptime[b.id] || now };
      }
    }
    for (const fid of fmap.keys()) {
      const rl = RLAST[fid];
      const lb = lastRead[fid] ? books.find((b) => b.id === lastRead[fid] && b.folderId === fid) : null;
      const lt = lastT[fid] || 0;
      if (rl && rl.c) {
        const target = books.find((b) => b.folderId === fid && chapKey(b) === rl.c);
        if (target && (rl.t || 0) > lt) {
          lastRead[fid] = target.id; lastT[fid] = rl.t || now; lastChanged = true; changed = true;
        } else if (lb && lt > (rl.t || 0)) {
          up[`last/${fid}`] = { c: chapKey(lb), t: lt };
        }
      } else if (lb) {
        if (!lt) { lastT[fid] = now; lastChanged = true; }
        up[`last/${fid}`] = { c: chapKey(lb), t: lastT[fid] || now };
      }
    }
    if (progChanged) persistProgress();
    if (lastChanged) persistLast();
    if (Object.keys(up).length) cloudSend(up);

    /* 4. Portadas (se mandan pocas a la vez y chiquitas) */
    const toUpload = [];
    const toDownload = [];
    for (const fid of fmap.keys()) {
      const f = fmap.get(fid);
      const rf = RL[fid] || {};
      const rcv = rf.cv || 0;
      if (f.cover && (f.covT || 0) > rcv) {
        if (!Cloud.tried.has(`u/f/${fid}/${f.covT}`)) toUpload.push({ f });
      } else if (rcv > (f.covT || 0) && !Cloud.tried.has(`d/f/${fid}/${rcv}`)) {
        toDownload.push({ kind: 'f', fid, rcv });
      }
      const rch = rf.ch || {};
      for (const b of books.filter((x) => x.folderId === fid)) {
        const ck = chapKey(b);
        const rc = rch[ck];
        const rcv2 = (rc && rc.cv) || 0;
        if (b.cover && (b.covT || 0) > rcv2) {
          if (!Cloud.tried.has(`u/${fid}/${ck}/${b.covT}`)) toUpload.push({ b, ck });
        } else if (rcv2 > (b.covT || 0) && !Cloud.tried.has(`d/${fid}/${ck}/${rcv2}`)) {
          toDownload.push({ kind: 'c', fid, ck, id: b.id, rcv: rcv2 });
        }
      }
    }
    let more = false;
    for (const u of toUpload.slice(0, 8)) {
      const b = u.b;
      const f = u.f;
      Cloud.tried.add(b ? `u/${b.folderId}/${u.ck}/${b.covT}` : `u/f/${f.id}/${f.covT}`);
      try {
        const small = await makeCover(b ? b.cover : f.cover, 160, 0.6);
        if (!small) continue;
        const v = await blobToDataURL(small);
        if (b) {
          cloudSend({ [`cov/${b.folderId}/${u.ck}`]: { v, t: b.covT }, [`lib/${b.folderId}/ch/${u.ck}/cv`]: b.covT });
        } else {
          cloudSend({ [`fcov/${f.id}`]: { v, t: f.covT }, [`lib/${f.id}/cv`]: f.covT });
        }
      } catch (e) { console.error(e); }
    }
    if (toUpload.length > 8) more = true;
    for (const dl of toDownload.slice(0, 8)) {
      Cloud.tried.add(dl.kind === 'f' ? `d/f/${dl.fid}/${dl.rcv}` : `d/${dl.fid}/${dl.ck}/${dl.rcv}`);
      try {
        const node = await FB.get(dl.kind === 'f' ? `${cloudPrefix()}fcov/${dl.fid}` : `${cloudPrefix()}cov/${dl.fid}/${dl.ck}`);
        if (!node || !node.v) continue;
        const blob = await (await fetch(node.v)).blob();
        if (dl.kind === 'f') {
          const f = await getFolderRec(dl.fid);
          if (f) await putFolder(Object.assign({}, f, { cover: blob, covT: node.t || dl.rcv }));
        } else {
          const b = await getMetaRec(dl.id);
          if (b) await putMeta(Object.assign({}, b, { cover: blob, covT: node.t || dl.rcv }));
        }
        changed = true;
      } catch (e) { console.error(e); }
    }
    if (toDownload.length > 8) more = true;
    if (more) Cloud.again = true;
    if (changed) await renderLibrary();
  }

  /* --- Pantalla de inicio de sesión --- */
  const loginEl = $('#login');
  function loginMsg(text, ok) {
    const m = $('#login-msg');
    m.textContent = text || '';
    m.hidden = !text;
    m.classList.toggle('ok', !!ok);
  }
  function openLogin() {
    loginMsg('');
    loginEl.hidden = false;
    setTimeout(() => $('#login-email').focus(), 60);
  }
  function closeLogin() { loginEl.hidden = true; }
  function authError(e) {
    const c = String((e && (e.code || e.message)) || '');
    if (/invalid-email/.test(c)) return 'El correo no es válido.';
    if (/email-already-in-use/.test(c)) return 'Ese correo ya tiene cuenta. Toca «Entrar».';
    if (/weak-password/.test(c)) return 'La contraseña es muy corta (mínimo 6 caracteres).';
    if (/invalid-credential|wrong-password|user-not-found|invalid-login/.test(c)) return 'Correo o contraseña incorrectos. Si todavía no tienes cuenta, toca «Crear cuenta».';
    if (/too-many-requests/.test(c)) return 'Demasiados intentos. Espera unos minutos.';
    if (/network/.test(c)) return 'Sin conexión. Revisa tu internet.';
    if (/operation-not-allowed|configuration-not-found/.test(c)) return 'En Firebase falta activar «Correo electrónico/contraseña» en Authentication.';
    return `No se pudo completar (${c || 'error desconocido'}).`;
  }
  function setLoginBusy(busy) {
    loginEl.querySelectorAll('button, input').forEach((el) => { el.disabled = busy; });
  }
  async function doAuth(mode) {
    const email = $('#login-email').value.trim();
    const pass = $('#login-pass').value;
    if (!email || pass.length < 6) { loginMsg('Escribe tu correo y una contraseña de al menos 6 caracteres.'); return; }
    setLoginBusy(true);
    loginMsg('');
    try {
      if (mode === 'up') await FB.signUp(email, pass); else await FB.signIn(email, pass);
      $('#login-pass').value = '';
      closeLogin();
      toast(mode === 'up' ? 'Cuenta creada' : 'Sesión iniciada');
    } catch (e) {
      loginMsg(authError(e));
    } finally {
      setLoginBusy(false);
    }
  }
  $('#login-form').addEventListener('submit', (ev) => { ev.preventDefault(); doAuth('in'); });
  $('#login-signup').addEventListener('click', () => doAuth('up'));
  $('#login-reset').addEventListener('click', async () => {
    const email = $('#login-email').value.trim();
    if (!email) { loginMsg('Escribe tu correo arriba y vuelve a tocar esta opción.'); return; }
    try {
      await FB.resetPassword(email);
      loginMsg('Listo: te enviamos un correo para cambiar la contraseña.', true);
    } catch (e) {
      loginMsg(authError(e));
    }
  });
  $('#login-close').addEventListener('click', closeLogin);
  loginEl.querySelector('.sheet-backdrop').addEventListener('click', closeLogin);
  $('#login-hint').addEventListener('click', openLogin);

  $('#acct-btn').addEventListener('click', async () => {
    if (!Cloud.configured) {
      toast('Falta pegar tu configuración de Firebase en firebase-config.js', 4500);
      return;
    }
    if (!Cloud.user) { closeSettings(); openLogin(); return; }
    if (confirm('¿Cerrar sesión? Tus mangas se quedan en este dispositivo.')) {
      try { await FB.signOut(); toast('Sesión cerrada'); } catch (e) { console.error(e); }
    }
  });
  $('#acct-sync').addEventListener('click', () => {
    toast('Sincronizando…');
    scheduleSync(0);
  });
  window.addEventListener('online', () => scheduleSync(500));

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
    const b = id && allBooks.find((x) => x.id === id);
    if (!b) return;
    if (b.remoteOnly) importPlaceholder(b); else openReader(id);
  });
  $('#btn-import').addEventListener('click', () => { pendingPlaceholder = null; });
  $('#file-input').addEventListener('change', async (ev) => {
    const files = ev.target.files;
    if (files && files.length) await importFiles(files);
    ev.target.value = '';
  });

  applySettings();
  migrateLoose()
    .then(migrateIds)
    .then(renderLibrary)
    .then(startCloud)
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
