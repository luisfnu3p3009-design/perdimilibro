# perdimilibro · v0.1 MVP

PWA para organizar tu biblioteca física. Escaneo ISBN, ubicaciones jerárquicas, préstamos, modo familiar multi-usuario.

## Qué incluye este MVP

- ✅ PWA instalable (manifest + service worker, funciona offline)
- ✅ Scanner ISBN real con cámara (html5-qrcode)
- ✅ Enriquecimiento automático con Google Books API + fallback a Open Library
- ✅ ISBN manual si no anda la cámara
- ✅ Biblioteca local en IndexedDB (no se pierde al recargar)
- ✅ Vistas: Lista / Galería / Por ubicación / Préstamos activos
- ✅ Búsqueda + filtros (ubicación, estado, dueño)
- ✅ Ubicaciones jerárquicas (Living → Biblioteca → Estante 3 → Posición 12)
- ✅ Préstamos con fecha esperada de devolución y aviso de vencidos
- ✅ Modo familiar: múltiples miembros del hogar, múltiples hogares
- ✅ Export/Import JSON (backup)
- ✅ Términos y Condiciones + Política de Privacidad (Ley 25.326 AR)
- ✅ Mobile-first responsive

## Stack

- HTML/CSS/JS vanilla — **sin build step**
- IndexedDB para persistencia local
- html5-qrcode para scanner
- Google Books + Open Library APIs
- Fuentes Fraunces + Karla desde Google Fonts

## Cómo correrlo localmente

Necesitás un servidor HTTP local (no podés abrir `index.html` directo porque service workers y getUserMedia no funcionan sobre `file://`).

```bash
# Opción 1: Python
python3 -m http.server 8000

# Opción 2: Node
npx serve

# Opción 3: PHP
php -S localhost:8000
```

Luego abrí <http://localhost:8000> en el navegador. Para que la cámara funcione en mobile necesitás HTTPS o `localhost`.

## Deploy a Vercel

1. Subí esta carpeta a un repo en GitHub (`gh repo create perdimilibro --public`).
2. En [vercel.com](https://vercel.com) → New Project → importá el repo.
3. Framework Preset: **Other** (es estático).
4. Build Command: dejá vacío. Output Directory: `./`.
5. Deploy.
6. En Settings → Domains, agregá `perdimilibro.com` (configurá DNS en Namecheap apuntando a Vercel).

Una vez vivo, podés instalarlo en el celular: abrir en Chrome → menú → "Agregar a pantalla de inicio".

## Próximos pasos (en orden)

1. **Probarlo vos**. Cargá 20-30 libros tuyos reales. Si después de 30 todavía querés cargar el 31, andamos bien.
2. **Compartir con los 3-5 design partners conocidos** que tienen bibliotecas gigantes. Mandales el link y nada más — no les digas qué probar. Mirá analytics simples (Vercel los da gratis): ¿vuelven a entrar sin que les escribas?
3. **Iterar en base a lo que ves**, no a lo que te dicen.
4. **Conectar Supabase** cuando 3 de 5 design partners hayan cargado ≥30 libros cada uno por su cuenta. Recién ahí vale la pena el laburo de auth + sync.
5. **INPI** cuando tengas el primer usuario pago.

## Antes de habilitar cobros

Recordá: como sos PEP por filiación, cuando habilites Mercado Pago/Stripe vas a tener que pasar por KYC más estricto. Hablá con tu mamá *antes* de eso para que sepa que se va a declarar la actividad. También vas a necesitar inscripción a monotributo o similar para facturar.

## Estructura del proyecto

```
perdimilibro/
├── index.html           # PWA principal (SPA)
├── styles.css           # Sistema de diseño completo
├── app.js               # Toda la lógica (IndexedDB, scanner, vistas)
├── manifest.json        # PWA manifest
├── service-worker.js    # Offline cache
├── terminos.html        # T&C (Ley argentina)
├── privacidad.html      # Política de Privacidad (Ley 25.326)
├── icons/
│   ├── icon.svg
│   ├── icon-192.png
│   └── icon-512.png
└── README.md
```

## Decisiones técnicas que importan para el futuro

- **IndexedDB ahora, Supabase después**: la capa `db` en `app.js` (líneas ~15-80) es la única que cambia cuando migremos. El resto del código habla con `db.put/get/all/del`, así que el reemplazo es localizado.
- **No hay router**: las "vistas" son sólo divs que se muestran/ocultan. Cuando crezca, vale meter un router (page.js o navegación nativa con `history.pushState`).
- **No hay auth**: los "miembros" son sólo nombres locales. Cuando llegue Supabase Auth, cada miembro se asocia a un `auth.users.id`.
- **Caché de ISBN**: las consultas a Google Books se cachean en IndexedDB para no re-pegarle a la API. Útil cuando los usuarios escanean colecciones grandes offline.

## Limitaciones conocidas del MVP

- Datos sólo en este dispositivo (no hay sync entre celular y notebook todavía).
- No hay auth real (cualquiera con acceso al dispositivo ve la biblioteca).
- Si limpiás caché del navegador, perdés todo (¡por eso el botón de Exportar!).
- Cámara de iPhone < iOS 14.3 puede tener problemas; navegadores muy viejos también.
- No hay tests automatizados (es MVP, los tests son los design partners).

---

Hecho en Buenos Aires · v0.1 · mayo 2026
