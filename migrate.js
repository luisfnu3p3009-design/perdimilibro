// ============================================================
// perdimilibro · migrate.js
// ------------------------------------------------------------
// Migración de IndexedDB local → Supabase. Se ejecuta una sola
// vez por browser al primer signup (auto-disparada desde signup.html).
//
// Flujo:
//   1. Leer toda la data vieja del IndexedDB 'perdimilibro'.
//   2. Borrar los rows default que creó el trigger de Supabase
//      (member "Yo" y location "Living") para no duplicar.
//   3. Generar UUIDs nuevos y mapear IDs viejos → UUIDs (las
//      FKs tienen que apuntar correcto).
//   4. Subir todo a Supabase en orden de dependencia.
//   5. Borrar el IndexedDB viejo (ya migrado).
//   6. Setear flag en localStorage para no re-ejecutar.
// ============================================================

import { supabase } from './supabase.js';

const OLD_DB_NAME = 'perdimilibro';
const MIGRATION_FLAG = 'perdimilibro_migrated';

// ----- helpers de IndexedDB viejo -----

function openOldDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(OLD_DB_NAME);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    // Si no existe la DB, esto crea una vacía. Lo manejamos chequeando stores.
  });
}

async function getAllFromOld(idb, store) {
  if (!idb.objectStoreNames.contains(store)) return [];
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(store, 'readonly').objectStore(store);
    const req = tx.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function deleteOldDB() {
  return new Promise(resolve => {
    const req = indexedDB.deleteDatabase(OLD_DB_NAME);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

// ----- API pública -----

/**
 * ¿Hay data vieja que valga la pena migrar?
 * Criterio: algún libro, o más de 1 member, o más de 1 location.
 * (1 member + 1 location es el seed default del app viejo, no vale la pena).
 */
export async function hasLocalDataToMigrate() {
  if (localStorage.getItem(MIGRATION_FLAG) === 'done') return false;
  try {
    const old = await openOldDB();
    const books     = await getAllFromOld(old, 'books');
    const members   = await getAllFromOld(old, 'members');
    const locations = await getAllFromOld(old, 'locations');
    old.close();
    return books.length > 0 || members.length > 1 || locations.length > 1;
  } catch (e) {
    console.warn('No se pudo chequear IndexedDB viejo:', e);
    return false;
  }
}

/**
 * Migra todo. Asume que el user ya está logueado y el trigger
 * ya creó su household + defaults.
 *
 * Devuelve {members, locations, books, loans} con los counts subidos.
 */
export async function migrateLocalToSupabase() {
  // 1. Leer data vieja
  let oldMembers = [], oldLocations = [], oldBooks = [], oldLoans = [];
  try {
    const old = await openOldDB();
    oldMembers   = await getAllFromOld(old, 'members');
    oldLocations = await getAllFromOld(old, 'locations');
    oldBooks     = await getAllFromOld(old, 'books');
    oldLoans     = await getAllFromOld(old, 'loans');
    old.close();
  } catch (e) {
    throw new Error(`No se pudo leer la data local: ${e.message}`);
  }

  // 2. Obtener household creado por el trigger
  const { data: hhData, error: hhErr } = await supabase
    .from('households')
    .select('id')
    .limit(1);
  if (hhErr) throw new Error(`No se pudo leer el household: ${hhErr.message}`);
  if (!hhData || hhData.length === 0) {
    throw new Error('No se creó el household. Probablemente el trigger SQL no está instalado. Revisar supabase-schema.sql.');
  }
  const householdId = hhData[0].id;

  // 3. Borrar defaults creados por el trigger (los reemplazamos con la data real)
  await supabase.from('members').delete().eq('household_id', householdId);
  await supabase.from('locations').delete().eq('household_id', householdId);

  // 4. ID map: old_id (string tipo 'id_xxx') → new UUID
  const idMap = new Map();
  const newId = () => crypto.randomUUID();

  // 5. Members
  let memberRows = oldMembers.map(m => {
    const id = newId();
    idMap.set(m.id, id);
    return { id, household_id: householdId, name: m.name, color: m.color || '#1d2d44' };
  });
  if (memberRows.length === 0) {
    // Sin data vieja de members → re-insertamos el default
    memberRows = [{ id: newId(), household_id: householdId, name: 'Yo', color: '#1d2d44' }];
  }
  {
    const { error } = await supabase.from('members').insert(memberRows);
    if (error) throw new Error(`Migración members: ${error.message}`);
  }

  // 6. Locations (en dos pasadas por la FK parent_id)
  let locRows = oldLocations.map(l => {
    const id = newId();
    idMap.set(l.id, id);
    return {
      id,
      household_id: householdId,
      parent_id: null,                              // pass 1
      _oldParentId: l.parent_id || null,            // pass 2
      name: l.name,
      position: l.position || 0
    };
  });
  if (locRows.length === 0) {
    locRows = [{ id: newId(), household_id: householdId, parent_id: null, _oldParentId: null, name: 'Living', position: 0 }];
  }
  {
    const inserts = locRows.map(({ _oldParentId, ...row }) => row);
    const { error } = await supabase.from('locations').insert(inserts);
    if (error) throw new Error(`Migración locations: ${error.message}`);

    // Pass 2: setear parent_id donde corresponda
    for (const row of locRows) {
      if (row._oldParentId && idMap.has(row._oldParentId)) {
        const { error: upErr } = await supabase
          .from('locations')
          .update({ parent_id: idMap.get(row._oldParentId) })
          .eq('id', row.id);
        if (upErr) console.warn(`Parent location de ${row.id} no se pudo setear:`, upErr.message);
      }
    }
  }

  // 7. Books (batch de a 50 para no pegarle a límites)
  if (oldBooks.length > 0) {
    const bookRows = oldBooks.map(b => {
      const id = newId();
      idMap.set(b.id, id);
      return {
        id,
        household_id:   householdId,
        owner_id:       b.owner_id    && idMap.get(b.owner_id)    || null,
        location_id:    b.location_id && idMap.get(b.location_id) || null,
        isbn:           b.isbn || null,
        title:          b.title || 'Sin título',
        authors:        Array.isArray(b.authors)    ? b.authors    : [],
        cover_url:      b.cover_url || null,
        publisher:      b.publisher || '',
        published_year: b.published_year || null,
        language:       b.language || 'es',
        status:         b.status || 'home',
        notes:          b.notes || '',
        categories:     Array.isArray(b.categories) ? b.categories : [],
        added_at:       b.added_at || new Date().toISOString()
      };
    });
    for (let i = 0; i < bookRows.length; i += 50) {
      const chunk = bookRows.slice(i, i + 50);
      const { error } = await supabase.from('books').insert(chunk);
      if (error) throw new Error(`Migración books (chunk ${i}): ${error.message}`);
    }
  }

  // 8. Loans (best effort: si un loan apunta a un book que no migró, se descarta)
  if (oldLoans.length > 0) {
    const loanRows = oldLoans
      .filter(l => idMap.has(l.book_id))
      .map(l => ({
        id:               newId(),
        book_id:          idMap.get(l.book_id),
        borrower_name:    l.borrower_name || 'Sin nombre',
        borrower_contact: l.borrower_contact || null,
        lent_at:          l.lent_at || new Date().toISOString().slice(0, 10),
        expected_return:  l.expected_return || null,
        returned_at:      l.returned_at || null,
        notes:            l.notes || null
      }));
    if (loanRows.length > 0) {
      const { error } = await supabase.from('loans').insert(loanRows);
      if (error) console.warn(`Loans no migrados: ${error.message}`); // no fatal
    }
  }

  // 9. Borrar IndexedDB viejo
  await deleteOldDB();

  // 10. Flag
  localStorage.setItem(MIGRATION_FLAG, 'done');

  return {
    members:   memberRows.length,
    locations: locRows.length,
    books:     oldBooks.length,
    loans:     oldLoans.length
  };
}

/**
 * Marca la migración como ya hecha sin migrar nada. Se llama cuando
 * el user se loguea (no signup) y no hay nada que migrar — para que
 * el chequeo no vuelva a correr.
 */
export function markMigrationDone() {
  localStorage.setItem(MIGRATION_FLAG, 'done');
}
