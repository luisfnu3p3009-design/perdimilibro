// ============================================================
// perdimilibro · db.js
// ------------------------------------------------------------
// Reemplaza el objeto `db` que estaba inline en app.js. Misma API
// (open, put, get, all, del, clear) pero ahora backeada por Supabase
// en vez de IndexedDB.
//
// La seguridad (que un usuario solo vea sus libros) la garantiza
// Row Level Security en la DB, no este archivo. Si alguien manipula
// este código en el browser, RLS sigue protegiendo.
// ============================================================

import { supabase } from './supabase.js';

// Mapa de "store name" (como lo llama el código viejo) → "table name"
// y campo de primary key.
const TABLES = {
  households:   { table: 'households',    pk: 'id' },
  members:      { table: 'members',       pk: 'id' },
  locations:    { table: 'locations',     pk: 'id' },
  books:        { table: 'books',         pk: 'id' },
  loans:        { table: 'loans',         pk: 'id' },
  isbn_cache:   { table: 'isbn_cache',    pk: 'isbn' },
  settings:     { table: 'user_settings', pk: 'key' }   // user_id se inyecta
};

function tableFor(store) {
  const t = TABLES[store];
  if (!t) throw new Error(`db: store desconocido '${store}'`);
  return t;
}

async function currentUserId() {
  const { data } = await supabase.auth.getUser();
  if (!data?.user) throw new Error('db: sin sesión activa');
  return data.user.id;
}

export const db = {
  // Compat con la API vieja. No hace falta abrir nada con Supabase.
  async open() { return true; },

  // INSERT / UPDATE (upsert por primary key)
  async put(store, value) {
    const { table, pk } = tableFor(store);

    if (table === 'user_settings') {
      const user_id = await currentUserId();
      const row = { user_id, key: value.key, value: value.value };
      const { error } = await supabase
        .from(table)
        .upsert(row, { onConflict: 'user_id,key' });
      if (error) throw new Error(`db.put(${store}): ${error.message}`);
      return value;
    }

    const { error } = await supabase
      .from(table)
      .upsert(value, { onConflict: pk });
    if (error) throw new Error(`db.put(${store}): ${error.message}`);
    return value;
  },

  // SELECT single por primary key
  async get(store, key) {
    const { table, pk } = tableFor(store);

    if (table === 'user_settings') {
      const user_id = await currentUserId();
      const { data, error } = await supabase
        .from(table)
        .select('key, value')
        .eq('user_id', user_id)
        .eq('key', key)
        .maybeSingle();
      if (error) throw new Error(`db.get(${store}): ${error.message}`);
      return data; // {key, value} o null
    }

    const { data, error } = await supabase
      .from(table)
      .select('*')
      .eq(pk, key)
      .maybeSingle();
    if (error) throw new Error(`db.get(${store}): ${error.message}`);
    return data;
  },

  // SELECT all (RLS limita al household propio)
  async all(store) {
    const { table } = tableFor(store);

    if (table === 'user_settings') {
      const user_id = await currentUserId();
      const { data, error } = await supabase
        .from(table)
        .select('key, value')
        .eq('user_id', user_id);
      if (error) throw new Error(`db.all(${store}): ${error.message}`);
      return data || [];
    }

    const { data, error } = await supabase.from(table).select('*');
    if (error) throw new Error(`db.all(${store}): ${error.message}`);
    return data || [];
  },

  // DELETE por primary key
  async del(store, key) {
    const { table, pk } = tableFor(store);

    if (table === 'user_settings') {
      const user_id = await currentUserId();
      const { error } = await supabase
        .from(table)
        .delete()
        .eq('user_id', user_id)
        .eq('key', key);
      if (error) throw new Error(`db.del(${store}): ${error.message}`);
      return;
    }

    const { error } = await supabase.from(table).delete().eq(pk, key);
    if (error) throw new Error(`db.del(${store}): ${error.message}`);
  },

  // CLEAR (borrar todo). Solo usado por importAll en app.js. RLS limita
  // al household propio así que esto es seguro.
  async clear(store) {
    const { table, pk } = tableFor(store);

    if (table === 'user_settings') {
      const user_id = await currentUserId();
      const { error } = await supabase
        .from(table)
        .delete()
        .eq('user_id', user_id);
      if (error) throw new Error(`db.clear(${store}): ${error.message}`);
      return;
    }

    // Postgres no permite DELETE sin WHERE → usamos un filtro tautológico.
    // RLS sigue limitando al household del user.
    const { error } = await supabase.from(table).delete().not(pk, 'is', null);
    if (error) throw new Error(`db.clear(${store}): ${error.message}`);
  }
};
