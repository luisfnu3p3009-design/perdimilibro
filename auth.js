// ============================================================
// perdimilibro · auth.js
// ------------------------------------------------------------
// Wrapper sobre supabase.auth con mensajes de error en español
// y manejo de la migración IndexedDB → Supabase al primer signup.
// ============================================================

import { supabase } from './supabase.js';

// Map de errores comunes de Supabase a español
const ERR_MAP = {
  'Invalid login credentials':        'Email o contraseña incorrectos.',
  'Email not confirmed':              'Tenés que confirmar tu email antes de entrar.',
  'User already registered':          'Ya existe una cuenta con ese email.',
  'Password should be at least 6 characters': 'La contraseña tiene que tener al menos 6 caracteres.',
  'Unable to validate email address: invalid format': 'El email no tiene un formato válido.',
  'Email rate limit exceeded':        'Demasiados intentos. Esperá un rato y volvé a probar.',
  'New password should be different from the old password': 'La contraseña nueva tiene que ser distinta a la actual.'
};

function traducirError(err) {
  if (!err) return null;
  const msg = err.message || String(err);
  return ERR_MAP[msg] || msg;
}

// ---------- API pública ----------

export async function signUp(email, password) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      // emailRedirectTo es a dónde manda Supabase al usuario después de
      // confirmar el email (si tenés email confirmation activado).
      emailRedirectTo: `${window.location.origin}/`
    }
  });
  if (error) throw new Error(traducirError(error));
  return data;
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(traducirError(error));
  return data;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw new Error(traducirError(error));

  // Limpiar IndexedDB local (sino el próximo usuario en este browser
  // verá datos del anterior en el cache local).
  try {
    indexedDB.deleteDatabase('perdimilibro');
  } catch (e) { /* OK si falla */ }
}

export async function getUser() {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user) return null;
  return data.user;
}

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data?.session || null;
}

export async function requestPasswordReset(email) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/reset-password.html`
  });
  if (error) throw new Error(traducirError(error));
}

export async function updatePassword(newPassword) {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw new Error(traducirError(error));
}

// Llamar al inicio de páginas que requieren login.
// Si no hay sesión, redirige a /login.html.
export async function requireAuth() {
  const session = await getSession();
  if (!session) {
    window.location.replace('/login.html');
    return null;
  }
  return session.user;
}

// Inverso: llamar en login.html / signup.html. Si ya hay sesión, manda a la app.
export async function redirectIfAuthed() {
  const session = await getSession();
  if (session) {
    window.location.replace('/');
  }
}
