// ============================================================
// perdimilibro — app.js
// ============================================================
// Arquitectura: vanilla JS + IndexedDB. Sin build step.
// Estado global mutable + render manual. Cuando se conecte
// a Supabase, las funciones db.* son las únicas que cambian.
// ============================================================

// ============================================================
// IndexedDB layer
// ============================================================

const DB_NAME = 'perdimilibro';
const DB_VERSION = 1;

const db = {
  _db: null,

  async open() {
    if (this._db) return this._db;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => { this._db = req.result; resolve(this._db); };
      req.onupgradeneeded = (e) => {
        const _db = e.target.result;
        if (!_db.objectStoreNames.contains('households'))   _db.createObjectStore('households',   { keyPath: 'id' });
        if (!_db.objectStoreNames.contains('members'))      _db.createObjectStore('members',      { keyPath: 'id' });
        if (!_db.objectStoreNames.contains('locations'))    _db.createObjectStore('locations',    { keyPath: 'id' });
        if (!_db.objectStoreNames.contains('books'))        _db.createObjectStore('books',        { keyPath: 'id' });
        if (!_db.objectStoreNames.contains('loans'))        _db.createObjectStore('loans',        { keyPath: 'id' });
        if (!_db.objectStoreNames.contains('isbn_cache'))   _db.createObjectStore('isbn_cache',   { keyPath: 'isbn' });
        if (!_db.objectStoreNames.contains('settings'))     _db.createObjectStore('settings',     { keyPath: 'key' });
      };
    });
  },

  async _tx(store, mode = 'readonly') {
    const _db = await this.open();
    return _db.transaction(store, mode).objectStore(store);
  },

  async put(store, value) {
    return new Promise(async (resolve, reject) => {
      const tx = await this._tx(store, 'readwrite');
      const req = tx.put(value);
      req.onsuccess = () => resolve(value);
      req.onerror = () => reject(req.error);
    });
  },

  async get(store, key) {
    return new Promise(async (resolve, reject) => {
      const tx = await this._tx(store);
      const req = tx.get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  },

  async all(store) {
    return new Promise(async (resolve, reject) => {
      const tx = await this._tx(store);
      const req = tx.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  },

  async del(store, key) {
    return new Promise(async (resolve, reject) => {
      const tx = await this._tx(store, 'readwrite');
      const req = tx.delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  },

  async clear(store) {
    return new Promise(async (resolve, reject) => {
      const tx = await this._tx(store, 'readwrite');
      const req = tx.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }
};

// ============================================================
// State
// ============================================================

const state = {
  currentHouseholdId: null,
  households: [],
  members: [],
  locations: [],
  books: [],
  loans: [],
  view: 'list',
  filters: { search: '', location: '', status: '', owner: '' }
};

const uid = () => 'id_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ============================================================
// Initialization & seed
// ============================================================

async function init() {
  await db.open();

  // Migración: primera carga
  state.households = await db.all('households');
  if (state.households.length === 0) {
    const home = {
      id: uid(),
      name: 'Mi biblioteca',
      created_at: new Date().toISOString()
    };
    await db.put('households', home);
    state.households = [home];

    // Primer miembro
    const me = {
      id: uid(),
      household_id: home.id,
      name: 'Yo',
      color: '#1d2d44',
      created_at: new Date().toISOString()
    };
    await db.put('members', me);

    // Ubicación raíz por defecto
    const root = {
      id: uid(),
      household_id: home.id,
      parent_id: null,
      name: 'Living',
      position: 0,
      created_at: new Date().toISOString()
    };
    await db.put('locations', root);
  }

  // Pick current household
  const lastHH = await db.get('settings', 'current_household');
  state.currentHouseholdId = lastHH?.value || state.households[0].id;

  await refreshAll();
  renderHouseholdSwitcher();
  renderFilters();
  renderEmptyShelves();
  render();
  bindEvents();
}

async function refreshAll() {
  state.households = await db.all('households');
  state.members    = (await db.all('members')).filter(m => m.household_id === state.currentHouseholdId);
  state.locations  = (await db.all('locations')).filter(l => l.household_id === state.currentHouseholdId);
  state.books      = (await db.all('books')).filter(b => b.household_id === state.currentHouseholdId);
  const allLoans   = await db.all('loans');
  const bookIds    = new Set(state.books.map(b => b.id));
  state.loans      = allLoans.filter(l => bookIds.has(l.book_id));
}

async function setCurrentHousehold(id) {
  state.currentHouseholdId = id;
  await db.put('settings', { key: 'current_household', value: id });
  await refreshAll();
  renderFilters();
  render();
}

// ============================================================
// External APIs
// ============================================================

async function fetchIsbnMetadata(isbn) {
  // Cache primero
  const cached = await db.get('isbn_cache', isbn);
  if (cached) return cached.data;

  // Google Books
  try {
    const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`);
    if (r.ok) {
      const json = await r.json();
      if (json.totalItems > 0) {
        const v = json.items[0].volumeInfo;
        const meta = {
          isbn,
          title: v.title || 'Sin título',
          authors: v.authors || [],
          publisher: v.publisher || '',
          published_year: v.publishedDate ? parseInt(v.publishedDate.slice(0, 4)) : null,
          language: v.language || 'es',
          cover_url: v.imageLinks?.thumbnail?.replace('http:', 'https:') || null,
          description: v.description || '',
          categories: v.categories || []
        };
        await db.put('isbn_cache', { isbn, data: meta, source: 'google_books', cached_at: new Date().toISOString() });
        return meta;
      }
    }
  } catch (e) { console.warn('Google Books error', e); }

  // Open Library fallback
  try {
    const r = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`);
    if (r.ok) {
      const json = await r.json();
      const v = json[`ISBN:${isbn}`];
      if (v) {
        const meta = {
          isbn,
          title: v.title || 'Sin título',
          authors: (v.authors || []).map(a => a.name),
          publisher: v.publishers?.[0]?.name || '',
          published_year: v.publish_date ? parseInt(v.publish_date.slice(-4)) : null,
          language: 'es',
          cover_url: v.cover?.medium || v.cover?.small || null,
          description: v.notes || '',
          categories: (v.subjects || []).slice(0, 3).map(s => s.name)
        };
        await db.put('isbn_cache', { isbn, data: meta, source: 'open_library', cached_at: new Date().toISOString() });
        return meta;
      }
    }
  } catch (e) { console.warn('Open Library error', e); }

  return null;
}

// ============================================================
// CRUD operations
// ============================================================

async function addBook(data) {
  const book = {
    id: uid(),
    household_id: state.currentHouseholdId,
    owner_id: data.owner_id || (state.members[0]?.id ?? null),
    isbn: data.isbn || null,
    title: data.title || 'Sin título',
    authors: data.authors || [],
    cover_url: data.cover_url || null,
    publisher: data.publisher || '',
    published_year: data.published_year || null,
    language: data.language || 'es',
    location_id: data.location_id || null,
    status: data.status || 'home',
    notes: data.notes || '',
    categories: data.categories || [],
    added_at: new Date().toISOString()
  };
  await db.put('books', book);
  await refreshAll();
  render();
  toast('Libro agregado', 'success');
  return book;
}

async function updateBook(id, patch) {
  const book = await db.get('books', id);
  if (!book) return;
  Object.assign(book, patch);
  await db.put('books', book);
  await refreshAll();
  render();
}

async function deleteBook(id) {
  await db.del('books', id);
  // borrar préstamos asociados
  const loans = (await db.all('loans')).filter(l => l.book_id === id);
  for (const l of loans) await db.del('loans', l.id);
  await refreshAll();
  render();
  toast('Libro eliminado');
}

async function addLocation(data) {
  const loc = {
    id: uid(),
    household_id: state.currentHouseholdId,
    parent_id: data.parent_id || null,
    name: data.name,
    position: data.position || 0,
    created_at: new Date().toISOString()
  };
  await db.put('locations', loc);
  await refreshAll();
  render();
  return loc;
}

async function deleteLocation(id) {
  // Reasignar libros a parent o null
  const loc = state.locations.find(l => l.id === id);
  for (const b of state.books.filter(b => b.location_id === id)) {
    await updateBook(b.id, { location_id: loc?.parent_id || null });
  }
  // Borrar hijos recursivo
  const children = state.locations.filter(l => l.parent_id === id);
  for (const c of children) await deleteLocation(c.id);
  await db.del('locations', id);
  await refreshAll();
  render();
}

async function addLoan(bookId, data) {
  const loan = {
    id: uid(),
    book_id: bookId,
    borrower_name: data.borrower_name,
    borrower_contact: data.borrower_contact || '',
    lent_at: data.lent_at || new Date().toISOString().slice(0, 10),
    expected_return: data.expected_return || null,
    returned_at: null,
    notes: data.notes || ''
  };
  await db.put('loans', loan);
  await updateBook(bookId, { status: 'lent' });
}

async function returnLoan(loanId) {
  const loan = await db.get('loans', loanId);
  if (!loan) return;
  loan.returned_at = new Date().toISOString().slice(0, 10);
  await db.put('loans', loan);
  await updateBook(loan.book_id, { status: 'home' });
  toast('Libro devuelto', 'success');
}

async function addMember(data) {
  const colors = ['#1d2d44', '#b85c38', '#6b7a3d', '#c89090', '#b0a0c0', '#a8b08b'];
  const member = {
    id: uid(),
    household_id: state.currentHouseholdId,
    name: data.name,
    color: data.color || colors[state.members.length % colors.length],
    created_at: new Date().toISOString()
  };
  await db.put('members', member);
  await refreshAll();
  render();
}

async function addHousehold(name) {
  const home = {
    id: uid(),
    name,
    created_at: new Date().toISOString()
  };
  await db.put('households', home);
  state.households.push(home);
  await setCurrentHousehold(home.id);
  renderHouseholdSwitcher();
}

// ============================================================
// Helpers
// ============================================================

function getLocation(id) { return state.locations.find(l => l.id === id); }
function getMember(id)   { return state.members.find(m => m.id === id); }
function getBook(id)     { return state.books.find(b => b.id === id); }

function locationPath(id) {
  const parts = [];
  let cur = getLocation(id);
  let safety = 0;
  while (cur && safety++ < 20) {
    parts.unshift(cur.name);
    cur = cur.parent_id ? getLocation(cur.parent_id) : null;
  }
  return parts.join(' › ');
}

function filteredBooks() {
  const { search, location, status, owner } = state.filters;
  const term = search.trim().toLowerCase();
  return state.books.filter(b => {
    if (term) {
      const hay = `${b.title} ${(b.authors || []).join(' ')} ${b.notes || ''} ${b.isbn || ''}`.toLowerCase();
      if (!hay.includes(term)) return false;
    }
    if (location && b.location_id !== location) return false;
    if (status && b.status !== status) return false;
    if (owner && b.owner_id !== owner) return false;
    return true;
  });
}

function activeLoans() {
  return state.loans.filter(l => !l.returned_at);
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function coverHTML(book, size = 'normal') {
  if (book.cover_url) {
    return `<img class="cover" src="${escapeHtml(book.cover_url)}" alt="${escapeHtml(book.title)}" loading="lazy" onerror="this.outerHTML='<div class=&quot;cover-placeholder&quot;>${escapeHtml(book.title.slice(0, 20))}</div>'">`;
  }
  return `<div class="cover-placeholder">${escapeHtml(book.title.slice(0, 30))}</div>`;
}

const STATUS_LABELS = {
  home: 'En casa',
  lent: 'Prestado',
  reading: 'Leyendo',
  lost: 'Perdido',
  wishlist: 'Deseado'
};

// ============================================================
// Toast
// ============================================================

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  document.getElementById('toastRoot').appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

// ============================================================
// Rendering
// ============================================================

function renderHouseholdSwitcher() {
  const sel = document.getElementById('householdSelect');
  sel.innerHTML = state.households.map(h =>
    `<option value="${h.id}" ${h.id === state.currentHouseholdId ? 'selected' : ''}>${escapeHtml(h.name)}</option>`
  ).join('');
}

function renderFilters() {
  // Ubicación
  const locSel = document.getElementById('filterLocation');
  locSel.innerHTML = `<option value="">Todas las ubicaciones</option>` +
    state.locations.map(l => `<option value="${l.id}">${escapeHtml(locationPath(l.id))}</option>`).join('');

  // Dueños
  const ownerSel = document.getElementById('filterOwner');
  ownerSel.innerHTML = `<option value="">Todos los dueños</option>` +
    state.members.map(m => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('');
}

function render() {
  // Stats
  document.getElementById('statTotal').textContent = state.books.length;
  document.getElementById('statShowing').textContent = filteredBooks().length;
  document.getElementById('statLent').textContent = activeLoans().length;
  document.getElementById('statLocations').textContent = state.locations.length;

  const empty = document.getElementById('emptyState');
  const viewList = document.getElementById('viewList');
  const viewGallery = document.getElementById('viewGallery');
  const viewLocation = document.getElementById('viewLocation');
  const viewLoans = document.getElementById('viewLoans');

  [empty, viewList, viewGallery, viewLocation, viewLoans].forEach(el => el.classList.add('hidden'));

  if (state.books.length === 0 && state.view !== 'loans') {
    empty.classList.remove('hidden');
    return;
  }

  if (state.view === 'list') {
    viewList.classList.remove('hidden');
    viewList.innerHTML = renderListView();
  } else if (state.view === 'gallery') {
    viewGallery.classList.remove('hidden');
    viewGallery.innerHTML = renderGalleryView();
  } else if (state.view === 'location') {
    viewLocation.classList.remove('hidden');
    viewLocation.innerHTML = renderLocationView();
  } else if (state.view === 'loans') {
    viewLoans.classList.remove('hidden');
    viewLoans.innerHTML = renderLoansView();
  }
  attachBookHandlers();
}

function renderListView() {
  const books = filteredBooks();
  if (books.length === 0) return `<div class="text-center text-muted italic" style="padding: 3rem;">No hay libros que coincidan con los filtros.</div>`;
  return `<div class="book-list">${books.map(b => `
    <div class="book-row" data-id="${b.id}">
      ${coverHTML(b)}
      <div class="book-info">
        <h4>${escapeHtml(b.title)}</h4>
        <div class="authors">${escapeHtml((b.authors || []).join(', ') || '—')}</div>
      </div>
      <div class="book-meta location">${b.location_id ? escapeHtml(locationPath(b.location_id)) : '—'}</div>
      <div class="book-meta">${getMember(b.owner_id)?.name || ''}</div>
      <span class="badge ${b.status}">${STATUS_LABELS[b.status] || b.status}</span>
    </div>
  `).join('')}</div>`;
}

function renderGalleryView() {
  const books = filteredBooks();
  if (books.length === 0) return `<div class="text-center text-muted italic" style="padding: 3rem;">No hay libros que coincidan con los filtros.</div>`;
  return `<div class="book-gallery">${books.map(b => `
    <div class="gallery-card" data-id="${b.id}">
      <div class="cover-wrap">${coverHTML(b)}</div>
      <div class="title">${escapeHtml(b.title)}</div>
      <div class="author">${escapeHtml((b.authors || [])[0] || '')}</div>
    </div>
  `).join('')}</div>`;
}

function renderLocationView() {
  // Agrupa por ubicación raíz; si no tiene ubicación, "Sin ubicación"
  const groups = new Map();
  for (const b of filteredBooks()) {
    const key = b.location_id || 'none';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }
  if (groups.size === 0) return `<div class="text-center text-muted italic" style="padding: 3rem;">Aún no hay libros con ubicación.</div>`;
  const sections = [];
  for (const [locId, books] of groups) {
    const name = locId === 'none' ? '— Sin ubicación —' : locationPath(locId);
    sections.push(`
      <section class="group-section">
        <div class="group-header">
          <h3>${escapeHtml(name)}</h3>
          <span class="count">${books.length} libro${books.length === 1 ? '' : 's'}</span>
        </div>
        <div class="book-list">${books.map(b => `
          <div class="book-row" data-id="${b.id}">
            ${coverHTML(b)}
            <div class="book-info">
              <h4>${escapeHtml(b.title)}</h4>
              <div class="authors">${escapeHtml((b.authors || []).join(', ') || '—')}</div>
            </div>
            <div class="book-meta">${getMember(b.owner_id)?.name || ''}</div>
            <span class="badge ${b.status}">${STATUS_LABELS[b.status]}</span>
            <div></div>
          </div>
        `).join('')}</div>
      </section>
    `);
  }
  return sections.join('');
}

function renderLoansView() {
  const loans = activeLoans();
  if (loans.length === 0) return `
    <div class="text-center" style="padding: 4rem 1rem;">
      <h2 style="color:var(--navy); font-style:italic; margin-bottom:1rem;">No hay préstamos activos</h2>
      <p class="text-muted serif italic">Cuando prestes un libro, va a aparecer acá con la fecha y a quién se lo prestaste.</p>
    </div>
  `;
  const today = new Date().toISOString().slice(0, 10);
  return `<div class="loans-list">${loans.map(loan => {
    const book = getBook(loan.book_id);
    if (!book) return '';
    const overdue = loan.expected_return && loan.expected_return < today;
    return `
      <div class="loan-card ${overdue ? 'overdue' : ''}">
        <div class="loan-info">
          <h4>${escapeHtml(book.title)}</h4>
          <div class="meta">
            Prestado a <strong>${escapeHtml(loan.borrower_name)}</strong> el ${loan.lent_at}
            ${loan.expected_return ? ` · debe volver el ${loan.expected_return}` : ''}
            ${overdue ? ' · <strong style="color:#8a2418;">VENCIDO</strong>' : ''}
          </div>
        </div>
        <div>
          <button class="btn small primary" onclick="window.returnLoanFromUI('${loan.id}')">Devuelto ✓</button>
        </div>
      </div>
    `;
  }).join('')}</div>`;
}

function attachBookHandlers() {
  document.querySelectorAll('[data-id]').forEach(el => {
    el.addEventListener('click', () => openBookDetail(el.dataset.id));
  });
}

// Empty state: dibuja libros decorativos en las estanterías
function renderEmptyShelves() {
  const palette = ['#a8b08b', '#c89090', '#b0a0c0', '#d4825a', '#1d2d44', '#6b7a3d'];
  const draw = (groupId, y) => {
    const g = document.getElementById(groupId);
    if (!g) return;
    let x = 20;
    let html = '';
    while (x < 1180) {
      const w = 14 + Math.random() * 22;
      const h = 60 + Math.random() * 50;
      const color = palette[Math.floor(Math.random() * palette.length)];
      const tilt = (Math.random() - 0.5) * 4;
      html += `<rect x="${x}" y="${y - h}" width="${w}" height="${h}" fill="${color}" opacity="${0.5 + Math.random() * 0.4}" transform="rotate(${tilt} ${x + w / 2} ${y})"/>`;
      x += w + 2;
    }
    g.innerHTML = html;
  };
  draw('row1', 120);
  draw('row2', 280);
  draw('row3', 440);
}

// ============================================================
// Modales
// ============================================================

function modal({ title, body, footer }) {
  const root = document.getElementById('modalRoot');
  root.innerHTML = `
    <div class="modal-overlay" id="overlay">
      <div class="modal">
        <div class="modal-header">
          <h2>${title}</h2>
          <button class="modal-close" id="closeModal">×</button>
        </div>
        <div class="modal-body">${body}</div>
        ${footer ? `<div class="modal-footer">${footer}</div>` : ''}
      </div>
    </div>
  `;
  document.getElementById('overlay').addEventListener('click', e => {
    if (e.target.id === 'overlay') closeModal();
  });
  document.getElementById('closeModal').addEventListener('click', closeModal);
}

function closeModal() {
  document.getElementById('modalRoot').innerHTML = '';
}

// ----- Scanner -----

let html5QrCode = null;

function openScanner() {
  modal({
    title: 'Escanear código de barras',
    body: `
      <div id="reader"></div>
      <div class="scanner-status" id="scannerStatus">Apuntá la cámara al código de barras (ISBN-13)</div>
      <div class="text-center text-muted" style="font-size:0.85rem;">
        ¿Sin cámara o no anda? <a href="#" id="manualFromScanner">Cargá el ISBN a mano</a>
      </div>
    `,
    footer: `<button class="btn ghost" onclick="window.closeModal()">Cancelar</button>`
  });

  document.getElementById('manualFromScanner').addEventListener('click', e => {
    e.preventDefault();
    stopScanner();
    openManualISBN();
  });

  html5QrCode = new Html5Qrcode('reader');
  const config = { fps: 10, qrbox: { width: 280, height: 120 } };

  html5QrCode.start(
    { facingMode: 'environment' },
    config,
    onScanSuccess,
    () => { /* ignore frame fails */ }
  ).catch(err => {
    document.getElementById('scannerStatus').textContent = 'No se pudo acceder a la cámara. Probá con "ISBN a mano".';
    console.error(err);
  });
}

async function onScanSuccess(decoded) {
  if (!/^\d{10,13}$/.test(decoded)) return;
  const status = document.getElementById('scannerStatus');
  status.textContent = `✓ Detectado: ${decoded}. Buscando datos…`;
  status.classList.add('found');
  await stopScanner();
  await handleISBNFound(decoded);
}

async function stopScanner() {
  if (html5QrCode) {
    try { await html5QrCode.stop(); html5QrCode.clear(); } catch (e) {}
    html5QrCode = null;
  }
}

async function handleISBNFound(isbn) {
  closeModal();
  toast('Buscando datos del libro…');
  const meta = await fetchIsbnMetadata(isbn);
  if (meta) {
    openBookForm(meta);
  } else {
    toast('No encontrado en las bases. Cargalo manual.', 'error');
    openBookForm({ isbn });
  }
}

// ----- Manual ISBN -----

function openManualISBN() {
  modal({
    title: 'Cargar ISBN manualmente',
    body: `
      <div class="field">
        <label>ISBN (10 o 13 dígitos, sin guiones)</label>
        <input type="text" id="manualIsbnInput" autofocus inputmode="numeric" placeholder="9788437604947">
        <div class="field-hint">Está en la contraportada del libro, debajo del código de barras.</div>
      </div>
    `,
    footer: `
      <button class="btn ghost" onclick="window.closeModal()">Cancelar</button>
      <button class="btn primary" id="manualIsbnGo">Buscar</button>
    `
  });
  document.getElementById('manualIsbnGo').addEventListener('click', async () => {
    const v = document.getElementById('manualIsbnInput').value.replace(/[^0-9X]/gi, '');
    if (!/^\d{10}$|^\d{13}$/.test(v)) {
      toast('ISBN inválido', 'error');
      return;
    }
    await handleISBNFound(v);
  });
}

// ----- Book form (add / edit) -----

function openBookForm(initial = {}, editingId = null) {
  const owners = state.members.map(m =>
    `<option value="${m.id}" ${initial.owner_id === m.id ? 'selected' : ''}>${escapeHtml(m.name)}</option>`
  ).join('');
  const locs = state.locations.map(l =>
    `<option value="${l.id}" ${initial.location_id === l.id ? 'selected' : ''}>${escapeHtml(locationPath(l.id))}</option>`
  ).join('');

  modal({
    title: editingId ? 'Editar libro' : 'Agregar libro',
    body: `
      <div style="display:grid; grid-template-columns:120px 1fr; gap:1.5rem; margin-bottom:1.5rem;">
        <div class="cover-wrap" style="aspect-ratio:2/3; background:var(--paper-deep); border-radius:4px; overflow:hidden;">
          ${initial.cover_url
            ? `<img src="${escapeHtml(initial.cover_url)}" style="width:100%; height:100%; object-fit:cover;" onerror="this.style.display='none'">`
            : `<div style="height:100%; display:flex; align-items:center; justify-content:center; color:var(--ink-soft); font-style:italic; font-family:var(--serif); padding:0.5rem; text-align:center;">Sin portada</div>`}
        </div>
        <div>
          <div class="field">
            <label>Título</label>
            <input type="text" id="f_title" value="${escapeHtml(initial.title || '')}" required>
          </div>
          <div class="field">
            <label>Autor(es) — separados por coma</label>
            <input type="text" id="f_authors" value="${escapeHtml((initial.authors || []).join(', '))}">
          </div>
        </div>
      </div>

      <div class="field-row">
        <div class="field">
          <label>Editorial</label>
          <input type="text" id="f_publisher" value="${escapeHtml(initial.publisher || '')}">
        </div>
        <div class="field">
          <label>Año</label>
          <input type="number" id="f_year" value="${initial.published_year || ''}">
        </div>
      </div>

      <div class="field-row">
        <div class="field">
          <label>ISBN</label>
          <input type="text" id="f_isbn" value="${escapeHtml(initial.isbn || '')}">
        </div>
        <div class="field">
          <label>Estado</label>
          <select id="f_status">
            ${Object.entries(STATUS_LABELS).map(([k, v]) =>
              `<option value="${k}" ${(initial.status || 'home') === k ? 'selected' : ''}>${v}</option>`
            ).join('')}
          </select>
        </div>
      </div>

      <div class="field-row">
        <div class="field">
          <label>Ubicación</label>
          <select id="f_location"><option value="">— Sin ubicación —</option>${locs}</select>
        </div>
        <div class="field">
          <label>Dueño</label>
          <select id="f_owner">${owners}</select>
        </div>
      </div>

      <div class="field">
        <label>Notas</label>
        <textarea id="f_notes" rows="2">${escapeHtml(initial.notes || '')}</textarea>
      </div>
    `,
    footer: `
      <button class="btn ghost" onclick="window.closeModal()">Cancelar</button>
      ${editingId ? `<button class="btn danger" id="btnDelete">Eliminar</button>` : ''}
      <button class="btn primary" id="btnSave">${editingId ? 'Guardar cambios' : 'Agregar a la biblioteca'}</button>
    `
  });

  document.getElementById('btnSave').addEventListener('click', async () => {
    const data = {
      title: document.getElementById('f_title').value.trim(),
      authors: document.getElementById('f_authors').value.split(',').map(s => s.trim()).filter(Boolean),
      publisher: document.getElementById('f_publisher').value.trim(),
      published_year: parseInt(document.getElementById('f_year').value) || null,
      isbn: document.getElementById('f_isbn').value.trim() || null,
      status: document.getElementById('f_status').value,
      location_id: document.getElementById('f_location').value || null,
      owner_id: document.getElementById('f_owner').value || null,
      notes: document.getElementById('f_notes').value.trim(),
      cover_url: initial.cover_url || null
    };
    if (!data.title) { toast('Falta el título', 'error'); return; }
    if (editingId) {
      await updateBook(editingId, data);
      toast('Cambios guardados', 'success');
    } else {
      await addBook(data);
    }
    closeModal();
  });

  if (editingId) {
    document.getElementById('btnDelete').addEventListener('click', async () => {
      if (!confirm('¿Eliminar este libro? Esta acción no se puede deshacer.')) return;
      await deleteBook(editingId);
      closeModal();
    });
  }
}

// ----- Book detail -----

function openBookDetail(id) {
  const book = getBook(id);
  if (!book) return;
  const loan = state.loans.find(l => l.book_id === id && !l.returned_at);

  modal({
    title: 'Detalle del libro',
    body: `
      <div class="book-detail">
        <div class="cover-wrap">${coverHTML(book)}</div>
        <div>
          <h2>${escapeHtml(book.title)}</h2>
          <div class="authors">${escapeHtml((book.authors || []).join(', ') || 'Autor desconocido')}</div>

          <dl class="detail-grid">
            <dt>Estado</dt>           <dd><span class="badge ${book.status}">${STATUS_LABELS[book.status]}</span></dd>
            <dt>Ubicación</dt>        <dd>${book.location_id ? escapeHtml(locationPath(book.location_id)) : '<span class="text-muted italic">sin ubicación</span>'}</dd>
            <dt>Dueño</dt>            <dd>${escapeHtml(getMember(book.owner_id)?.name || '—')}</dd>
            <dt>Editorial</dt>        <dd>${escapeHtml(book.publisher || '—')}</dd>
            <dt>Año</dt>              <dd>${book.published_year || '—'}</dd>
            <dt>ISBN</dt>             <dd>${escapeHtml(book.isbn || '—')}</dd>
            ${book.notes ? `<dt>Notas</dt><dd>${escapeHtml(book.notes)}</dd>` : ''}
            ${loan ? `<dt>Préstamo</dt><dd>A <strong>${escapeHtml(loan.borrower_name)}</strong> desde el ${loan.lent_at}</dd>` : ''}
          </dl>
        </div>
      </div>
    `,
    footer: `
      <button class="btn ghost" onclick="window.closeModal()">Cerrar</button>
      ${loan
        ? `<button class="btn accent" onclick="window.returnLoanFromUI('${loan.id}')">Marcar como devuelto</button>`
        : (book.status !== 'lent' ? `<button class="btn accent" onclick="window.openLendDialog('${book.id}')">Prestar</button>` : '')
      }
      <button class="btn primary" onclick="window.editBook('${book.id}')">Editar</button>
    `
  });
}

window.editBook = (id) => {
  const book = getBook(id);
  closeModal();
  openBookForm(book, id);
};

window.returnLoanFromUI = async (loanId) => {
  await returnLoan(loanId);
  closeModal();
  await refreshAll();
  render();
};

window.openLendDialog = (bookId) => {
  closeModal();
  modal({
    title: 'Prestar libro',
    body: `
      <div class="field">
        <label>¿A quién se lo prestás?</label>
        <input type="text" id="l_name" placeholder="Nombre y apellido, o apodo">
      </div>
      <div class="field">
        <label>Contacto (opcional)</label>
        <input type="text" id="l_contact" placeholder="WhatsApp, email, lo que sea">
      </div>
      <div class="field-row">
        <div class="field">
          <label>Fecha del préstamo</label>
          <input type="date" id="l_lent" value="${new Date().toISOString().slice(0, 10)}">
        </div>
        <div class="field">
          <label>Devolución esperada (opcional)</label>
          <input type="date" id="l_return">
        </div>
      </div>
      <div class="field">
        <label>Notas</label>
        <textarea id="l_notes" rows="2" placeholder="Ej: edición especial, no manchar"></textarea>
      </div>
    `,
    footer: `
      <button class="btn ghost" onclick="window.closeModal()">Cancelar</button>
      <button class="btn primary" id="btnLend">Registrar préstamo</button>
    `
  });
  document.getElementById('btnLend').addEventListener('click', async () => {
    const name = document.getElementById('l_name').value.trim();
    if (!name) { toast('Falta el nombre', 'error'); return; }
    await addLoan(bookId, {
      borrower_name: name,
      borrower_contact: document.getElementById('l_contact').value.trim(),
      lent_at: document.getElementById('l_lent').value,
      expected_return: document.getElementById('l_return').value || null,
      notes: document.getElementById('l_notes').value.trim()
    });
    closeModal();
    await refreshAll();
    render();
    toast('Préstamo registrado', 'success');
  });
};

window.closeModal = closeModal;

// ----- Locations manager -----

function openLocationsManager() {
  const renderTree = (parentId = null, level = 0) => {
    const children = state.locations.filter(l => l.parent_id === parentId);
    if (children.length === 0 && level === 0) return `<div class="text-center text-muted italic" style="padding:1rem;">Aún no hay ubicaciones. Creá la primera abajo.</div>`;
    return `<ul class="locations-tree">${children.map(loc => {
      const count = state.books.filter(b => b.location_id === loc.id).length;
      return `
        <li>
          <div class="location-row">
            <span class="name">${escapeHtml(loc.name)}</span>
            <span class="count">${count} libro${count === 1 ? '' : 's'}</span>
            <button class="btn small ghost" onclick="window.addSubLocation('${loc.id}')">+ sub</button>
            <button class="btn small danger" onclick="window.removeLocation('${loc.id}')">🗑</button>
          </div>
          ${renderTree(loc.id, level + 1)}
        </li>
      `;
    }).join('')}</ul>`;
  };

  modal({
    title: 'Ubicaciones',
    body: `
      <p class="text-muted italic" style="margin-bottom:1rem;">
        Armá la jerarquía como tenés tu casa: por ej. Living → Biblioteca grande → Estante 3 → Posición 12.
      </p>
      <div id="locTree">${renderTree()}</div>
      <hr class="divider">
      <div class="field-row">
        <div class="field">
          <label>Nueva ubicación raíz</label>
          <input type="text" id="newLocName" placeholder="Ej: Living, Cuarto, Estudio">
        </div>
        <div class="field" style="display:flex; align-items:flex-end;">
          <button class="btn primary" id="btnAddLoc">Agregar</button>
        </div>
      </div>
    `,
    footer: `<button class="btn ghost" onclick="window.closeModal()">Listo</button>`
  });

  document.getElementById('btnAddLoc').addEventListener('click', async () => {
    const name = document.getElementById('newLocName').value.trim();
    if (!name) return;
    await addLocation({ name, parent_id: null });
    openLocationsManager(); // re-render
    renderFilters();
  });
}

window.addSubLocation = async (parentId) => {
  const name = prompt('Nombre de la sub-ubicación:');
  if (!name) return;
  await addLocation({ name: name.trim(), parent_id: parentId });
  openLocationsManager();
  renderFilters();
};

window.removeLocation = async (id) => {
  const loc = state.locations.find(l => l.id === id);
  const count = state.books.filter(b => b.location_id === id).length;
  const childCount = state.locations.filter(l => l.parent_id === id).length;
  let msg = `¿Eliminar "${loc.name}"?`;
  if (count > 0) msg += `\n\n${count} libro(s) van a quedar sin ubicación (o pasar al nivel superior).`;
  if (childCount > 0) msg += `\n\nTambién se borran ${childCount} sub-ubicación(es).`;
  if (!confirm(msg)) return;
  await deleteLocation(id);
  openLocationsManager();
  renderFilters();
};

// ----- Household manager -----

function openHouseholdManager() {
  modal({
    title: 'Gestionar hogares y miembros',
    body: `
      <h3 style="font-family:var(--serif); font-style:italic; color:var(--navy); margin-bottom:0.8rem;">Hogares</h3>
      <ul style="list-style:none; padding:0; margin:0 0 1.5rem 0;">
        ${state.households.map(h => `
          <li style="padding:0.5rem 0; border-bottom:1px dashed var(--line); display:flex; justify-content:space-between; align-items:center;">
            <span class="${h.id === state.currentHouseholdId ? 'serif italic' : ''}">${escapeHtml(h.name)}${h.id === state.currentHouseholdId ? ' · <span style="color:var(--olive)">actual</span>' : ''}</span>
            <button class="btn small" onclick="window.switchHousehold('${h.id}')">Usar</button>
          </li>
        `).join('')}
      </ul>
      <div class="field-row">
        <div class="field">
          <label>Nuevo hogar</label>
          <input type="text" id="newHHName" placeholder="Ej: Casa de los abuelos">
        </div>
        <div class="field" style="display:flex; align-items:flex-end;">
          <button class="btn primary" id="btnAddHH">Crear hogar</button>
        </div>
      </div>

      <hr class="divider">

      <h3 style="font-family:var(--serif); font-style:italic; color:var(--navy); margin-bottom:0.8rem;">Miembros del hogar actual</h3>
      <ul style="list-style:none; padding:0; margin:0 0 1.5rem 0;">
        ${state.members.map(m => `
          <li style="padding:0.5rem 0; border-bottom:1px dashed var(--line); display:flex; align-items:center; gap:0.5rem;">
            <span style="display:inline-block; width:14px; height:14px; border-radius:50%; background:${m.color};"></span>
            ${escapeHtml(m.name)}
          </li>
        `).join('')}
      </ul>
      <div class="field-row">
        <div class="field">
          <label>Nuevo miembro</label>
          <input type="text" id="newMemberName" placeholder="Nombre">
        </div>
        <div class="field" style="display:flex; align-items:flex-end;">
          <button class="btn primary" id="btnAddMember">Agregar miembro</button>
        </div>
      </div>
    `,
    footer: `<button class="btn ghost" onclick="window.closeModal()">Listo</button>`
  });

  document.getElementById('btnAddHH').addEventListener('click', async () => {
    const name = document.getElementById('newHHName').value.trim();
    if (!name) return;
    await addHousehold(name);
    closeModal();
    renderHouseholdSwitcher();
    renderFilters();
    render();
    toast('Hogar creado', 'success');
  });

  document.getElementById('btnAddMember').addEventListener('click', async () => {
    const name = document.getElementById('newMemberName').value.trim();
    if (!name) return;
    await addMember({ name });
    openHouseholdManager();
    renderFilters();
  });
}

window.switchHousehold = async (id) => {
  await setCurrentHousehold(id);
  closeModal();
  renderHouseholdSwitcher();
  toast('Hogar cambiado');
};

// ----- About -----

function openAbout() {
  modal({
    title: 'Acerca de perdimilibro',
    body: `
      <p class="serif italic" style="font-size:1.1rem; color:var(--navy); margin-bottom:1rem;">
        Una app casual para no perder nunca más un libro de tu biblioteca física.
      </p>
      <p>Versión: <strong>0.1 (MVP design partners)</strong></p>
      <p>Hecho en Buenos Aires.</p>
      <hr class="divider">
      <p style="font-size:0.9rem; color:var(--ink-soft);">
        Esta es una versión muy temprana. Tus datos se guardan localmente en este dispositivo. Para hacer copia de seguridad, usá el botón ⤓ Exportar de la barra superior.
      </p>
      <p style="font-size:0.85rem; color:var(--ink-soft); margin-top:1rem;">
        <a href="terminos.html">Términos y Condiciones</a> · <a href="privacidad.html">Política de Privacidad</a>
      </p>
    `,
    footer: `<button class="btn primary" onclick="window.closeModal()">Cerrar</button>`
  });
}

// ============================================================
// Export / Import
// ============================================================

async function exportAll() {
  const data = {
    version: 1,
    exported_at: new Date().toISOString(),
    households: await db.all('households'),
    members: await db.all('members'),
    locations: await db.all('locations'),
    books: await db.all('books'),
    loans: await db.all('loans')
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `perdimilibro-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Backup exportado', 'success');
}

async function importAll(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data.version || !Array.isArray(data.books)) throw new Error('Formato inválido');
    if (!confirm('Esto va a fusionar los datos del archivo con los actuales. ¿Continuar?')) return;
    for (const h of (data.households || [])) await db.put('households', h);
    for (const m of (data.members   || [])) await db.put('members', m);
    for (const l of (data.locations || [])) await db.put('locations', l);
    for (const b of (data.books     || [])) await db.put('books', b);
    for (const l of (data.loans     || [])) await db.put('loans', l);
    await refreshAll();
    renderHouseholdSwitcher();
    renderFilters();
    render();
    toast('Datos importados', 'success');
  } catch (e) {
    toast('Error al importar: ' + e.message, 'error');
  }
}

// ============================================================
// Event binding
// ============================================================

function bindEvents() {
  document.getElementById('scanBtn').addEventListener('click', openScanner);
  document.getElementById('addManualBtn').addEventListener('click', () => openBookForm({}));
  document.getElementById('locationsBtn').addEventListener('click', openLocationsManager);
  document.getElementById('manageHouseholdBtn').addEventListener('click', openHouseholdManager);
  document.getElementById('aboutLink').addEventListener('click', e => { e.preventDefault(); openAbout(); });

  document.getElementById('householdSelect').addEventListener('change', async e => {
    await setCurrentHousehold(e.target.value);
  });

  document.getElementById('searchInput').addEventListener('input', e => {
    state.filters.search = e.target.value;
    render();
  });
  document.getElementById('filterLocation').addEventListener('change', e => {
    state.filters.location = e.target.value;
    render();
  });
  document.getElementById('filterStatus').addEventListener('change', e => {
    state.filters.status = e.target.value;
    render();
  });
  document.getElementById('filterOwner').addEventListener('change', e => {
    state.filters.owner = e.target.value;
    render();
  });

  document.querySelectorAll('#viewToggle button').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#viewToggle button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      state.view = b.dataset.view;
      render();
    });
  });

  document.getElementById('exportBtn').addEventListener('click', exportAll);
  document.getElementById('importBtn').addEventListener('click', () => document.getElementById('importFile').click());
  document.getElementById('importFile').addEventListener('change', e => {
    if (e.target.files[0]) importAll(e.target.files[0]);
  });
}

// ============================================================
// Go
// ============================================================

init().catch(err => {
  console.error(err);
  toast('Error al iniciar: ' + err.message, 'error');
});
