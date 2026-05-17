# perdimilibro v0.3 — login + storage en la nube

## Qué cambió respecto a v0.2

- **Login con email + contraseña** (Supabase Auth). Sin sesión, la app redirige a `/login.html`.
- **Backend real con Postgres + Row Level Security**. Cada cuenta solo ve sus libros. Ningún chequeo de seguridad pasa por el browser: lo enforza la DB.
- **Auto-migración de IndexedDB → Supabase al primer signup**. Quien venía de v0.2 con libros locales no pierde nada.
- **Forgot password + reset password** vía link de email (gratis con Supabase).
- **Service worker bumpeado a v0.3.0**: invalida cache viejo.

## Modelo de cuentas

**1 user = 1 biblioteca.** Cada cuenta tiene exactamente un household propio. Lo enforza un `unique index` en Postgres. Si en el futuro queremos abrir a múltiples bibliotecas por user o invitar a otros, basta con dropear ese índice y agregar tabla `household_members`.

## Archivos del paquete

```
api/scan-libro.js          ← SIN CAMBIOS (sigue gateando Claude multimodal)
icons/                     ← SIN CAMBIOS
styles.css                 ← SIN CAMBIOS
manifest.json              ← SIN CAMBIOS
terminos.html              ← SIN CAMBIOS
privacidad.html            ← SIN CAMBIOS
vercel.json                ← SIN CAMBIOS

index.html                 ← MODIFICADO: fast auth guard + botón Salir
service-worker.js          ← MODIFICADO: v0.3.0 + precache de archivos nuevos
app.js                     ← MODIFICADO: importa db/auth en vez de IndexedDB inline

supabase-schema.sql        ← NUEVO: schema completo con RLS y trigger
config.example.js          ← NUEVO: template de credenciales (renombrar a config.js)
supabase.js                ← NUEVO: cliente Supabase compartido
auth.js                    ← NUEVO: signup/login/logout/reset
db.js                      ← NUEVO: reemplazo del db de IndexedDB
migrate.js                 ← NUEVO: IndexedDB → Supabase one-shot
auth.css                   ← NUEVO: estilos de las páginas de auth
login.html                 ← NUEVO
signup.html                ← NUEVO
forgot-password.html       ← NUEVO
reset-password.html        ← NUEVO
```

## Setup paso a paso

### 1. Crear proyecto en Supabase

1. Ir a https://supabase.com → **Start your project** → loguearse con GitHub.
2. **New project**.
   - Name: `perdimilibro` (o lo que sea)
   - Database Password: generar uno fuerte y guardarlo en tu password manager. **No vas a usarlo a diario**, pero lo vas a necesitar si querés conectarte por SQL directo.
   - Region: **South America (São Paulo)** — es la más cercana, menor latencia desde BA.
   - Plan: **Free**.
3. Esperar 1-2 minutos a que termine de provisionar.

### 2. Correr el schema SQL

1. Dashboard del proyecto → **SQL Editor** (icono de hoja con código en el menú izquierdo) → **+ New query**.
2. Pegar todo el contenido de `supabase-schema.sql`.
3. **Run** (o `Ctrl/Cmd + Enter`).
4. Verificar abajo que diga `Success. No rows returned`.
5. Para confirmar que las tablas están: **Table Editor** → tenés que ver `households`, `members`, `locations`, `books`, `loans`, `isbn_cache`, `user_settings`.

### 3. Desactivar email confirmation (para MVP)

Por defecto Supabase pide que el user confirme su email antes de poder loguearse. Para el MVP esto agrega fricción innecesaria. Lo desactivamos:

1. Dashboard → **Authentication** → **Sign In / Up** (o **Providers** → **Email**).
2. Buscar **Confirm email** y **desactivar**.
3. Save.

Cuando llegue el momento de salir a producción real (con UP, p.ej.), reactivalo. La app ya maneja ambos casos sin cambios.

### 4. Conseguir las credenciales

1. Dashboard → **Project Settings** (engranaje abajo a la izquierda) → **API**.
2. Anotar:
   - **Project URL**: `https://xxxxxxxxxxxxx.supabase.co`
   - **anon / public key** (es un JWT largo que empieza con `eyJ...`)

⚠ La que NO debe ir al frontend nunca es la `service_role` key. Esa bypassea RLS y es admin total. La `anon` key es pública por diseño, la seguridad la da RLS.

### 5. Crear `config.js`

En la carpeta de la app:

```bash
cp config.example.js config.js
```

Editar `config.js` y pegar tu URL y anon key:

```js
export const SUPABASE_URL      = 'https://xxxxxxxxxxxxx.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJI...........';
```

**Importante para el repo:** agregar `config.js` al `.gitignore` si querés evitar pegarla en GitHub. La key es pública, pero igual conviene no tenerla viajando en commits.

Alternativa más limpia (opcional): committear `config.js` con las credenciales reales — son públicas, no es un secreto. La protección está en RLS.

### 6. Pegar los archivos en el repo

Reemplazá los viejos con los nuevos. Lo que se modificó: `index.html`, `app.js`, `service-worker.js`. Lo nuevo: todos los `.html`/`.js`/`.css`/`.sql` que no estaban antes.

Lo que NO cambió y queda igual: `api/scan-libro.js`, `icons/`, `styles.css`, `manifest.json`, `terminos.html`, `privacidad.html`, `vercel.json`.

### 7. Deploy

```bash
git add .
git commit -m "v0.3: login con Supabase + storage en la nube"
git push
```

Vercel autodeploya en 1-2 min.

### 8. Probar

1. Abrir https://perdimilibro.com.
2. Debería redirigir a `/login.html`.
3. Click en **Crear cuenta** → poner email + contraseña → **Crear cuenta**.
4. **Si ya tenías libros en IndexedDB en ese browser**: se muestra "Importando tu biblioteca…" y migra todo. Tarda 1-5 segundos según cuántos libros.
5. Caes en la app con tus libros (o vacía si era una cuenta nueva).
6. Probar logout (botón **Salir** arriba a la derecha) y volver a entrar.
7. Probar en otro browser (incognito): debería pedir login, y al loguearte aparecen los mismos libros.

## Costos

- **Supabase Free**: 500 MB de DB, 50,000 MAU, 5 GB de transferencia/mes, 1 GB de storage. Sobra para 200+ usuarios activos. Cuando crezca: Pro = USD 25/mes.
- **Anthropic** (scan-libro): igual que v0.2, ~USD 0.01-0.03 por scan. Cap en USD 5/mes en el dashboard.
- **Vercel**: igual, hobby gratis.

Total proyectado para el MVP de UP (50 usuarios activos): **USD 0-5/mes**. Free tier alcanza tranquilo.

## Seguridad — qué garantiza qué

| Capa | Qué protege |
|------|-------------|
| **Supabase Auth** | Identidad del usuario (JWT firmado por Supabase) |
| **RLS en Postgres** | Que un user solo lea/escriba *su* household |
| **Trigger `on_auth_user_created`** | Que cada cuenta nueva tenga setup limpio (1 household + member + location) |
| **Unique index `households_owner_unique`** | Que no se puedan crear bibliotecas extra por accidente |
| **`config.js` con anon key** | NO es seguridad, es identificación del proyecto. RLS hace el trabajo real. |

Si alguien manipula el JS del browser y reemplaza el client por uno propio, RLS sigue bloqueando: para insertar libros tendría que estar autenticado *con sesión válida*, y solo puede tocar rows de *su* household. El peor caso es que un attacker autenticado borre sus propios libros, lo cual ya podía hacer antes.

## Casos límite que ya están manejados

- **Email confirmation activado**: signup muestra "revisá tu inbox" y no rompe.
- **Token de password reset en la URL**: el fast auth guard de `index.html` reconoce el hash y deja pasar al SDK para procesar.
- **User se loguea sin nada que migrar**: `markMigrationDone()` previene migración futura cruzada de cuentas.
- **Trigger no instalado (DB mal configurada)**: `init()` tiene fallback que crea household manualmente y warneá en consola.
- **Migración falla a mitad**: el flag de localStorage no se setea, el user puede reintentar. La data parcial queda en Supabase pero el user puede limpiarla manualmente desde Table Editor.
- **2 tabs abiertas, una hace logout**: la otra detecta sesión inválida en el próximo write y redirige.

## Cosas que NO están y son follow-up

1. **Per-user rate limit en `/api/scan-libro`**: hoy sigue siendo por IP. Si querés que el endpoint valide JWT y limite por user, son ~30 líneas. No urgente, el cap de Anthropic sigue protegiendo el bolsillo.
2. **Multi-device sync de IndexedDB existente**: si tenías libros en Device A pero te creás cuenta en Device B, Device A se queda con su IndexedDB hasta que entres ahí. Para MVP es aceptable.
3. **Compartir biblioteca con otra persona**: requiere romper el modelo 1:1. Cuando llegue UP y pidan "cuenta de cátedra compartida", lo abrimos.
4. **Esconder el `household-switcher` dropdown** ahora que siempre tiene 1 opción: cosmético, no rompe nada.

## Si algo falla

**Redirige a login.html en loop** → revisar console del browser. Probable causa: `config.js` mal armado (URL o anon key incorrectas). Las credenciales correctas están en Project Settings → API del dashboard de Supabase.

**Error en consola: `db: sin sesión activa`** → la sesión expiró o el SDK no la cargó. Hacer logout manual borrando localStorage y volver a loguearse.

**Después de signup el user no tiene household** → el trigger no corrió. Volver a correr `supabase-schema.sql` (es idempotente). Verificar en **Authentication → Users** que el user existe, y en **Table Editor → households** que tiene un row con su `owner_user_id`.

**Migración no encuentra mis libros viejos** → el flag `perdimilibro_migrated` ya está en `localStorage`. Para forzar: en el devtools, `localStorage.removeItem('perdimilibro_migrated')` y recargar.

**"Email rate limit exceeded"** → Supabase free permite 3-4 emails/hora por proyecto. Esperar o usar `signInWithPassword` directo (la sesión ya está activa después de signup si email confirmation está desactivada).

**RLS rechaza inserts (mensaje tipo "new row violates row-level security policy")** → el user está autenticado pero su household no existe (trigger falló). Ver punto anterior.
