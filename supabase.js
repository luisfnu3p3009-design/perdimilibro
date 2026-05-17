// ============================================================
// perdimilibro · supabase.js
// ------------------------------------------------------------
// Cliente Supabase compartido entre todos los módulos.
// Importa la SDK desde esm.sh para evitar build step.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true   // necesario para que reset-password.html capture el token del link de email
  }
});
