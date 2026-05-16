# perdimilibro · v0.2 — escaneo visual del lomo con Claude multimodal

## Qué cambió respecto a v0.1

- **Botón nuevo "📷 Escanear lomo (foto)"**: usa la cámara del celular para
  sacar foto del lomo / tapa, manda la imagen a `/api/scan-libro`, y rellena
  los campos del libro con lo que extrae Claude Sonnet 4.6 multimodal.
- **El scanner viejo de ISBN sigue ahí**: queda como botón secundario "📊 ISBN"
  para libros con buen código de barras (es gratis vía Google Books).
- **Endpoint serverless `/api/scan-libro`**: corre en Vercel, guarda la API
  key en variable de entorno, hace rate limit 30 req/hora por IP.
- **Service worker bumpeado a v0.2.0**: invalida el cache viejo para que los
  cambios se vean al instante.

## Archivos del paquete

```
api/
  scan-libro.js       ← NUEVO: endpoint serverless
index.html            ← MODIFICADO: botones nuevos
app.js                ← MODIFICADO: funciones de scan visual
service-worker.js     ← MODIFICADO: versión + no cachear /api/
vercel.json           ← NUEVO: config del endpoint
styles.css            ← SIN CAMBIOS
manifest.json         ← SIN CAMBIOS
terminos.html         ← SIN CAMBIOS
privacidad.html       ← SIN CAMBIOS
icons/                ← SIN CAMBIOS
```

## Deploy paso a paso

### 1. Conseguir API key de Anthropic

1. Ir a https://console.anthropic.com → crear cuenta si no tenés.
2. **Settings → Limits → Monthly spend limit**: poné USD 5 (o lo que estés
   dispuesto a perder en el peor caso). **HACELO ANTES DE GENERAR LA KEY.**
3. **API Keys → Create Key** → copiala (empieza con `sk-ant-api03-`).
   No la guardes en GitHub ni la mandes por chat.

### 2. Pegar los archivos en el repo

Reemplazá los archivos viejos con los modificados y agregá:
- la carpeta `api/` con `scan-libro.js`
- `vercel.json` en la raíz

### 3. Configurar la API key en Vercel

1. Vercel Dashboard → tu proyecto `perdimilibro` → **Settings** →
   **Environment Variables**.
2. Add:
   - Name: `ANTHROPIC_API_KEY`
   - Value: `sk-ant-api03-...` (la key que copiaste)
   - Environments: marcá **Production, Preview, Development** (los tres).
3. Save.

### 4. Push y deploy

```bash
git add .
git commit -m "scanner visual con Claude multimodal"
git push
```

Vercel autodeploya. En 1-2 minutos perdimilibro.com tiene la versión nueva.

### 5. Probar

En el celular, abrí perdimilibro.com (si tenés el PWA instalado, cerralo y
volvelo a abrir para que cargue el SW nuevo). Tocá "📷 Escanear lomo" →
enfocá un libro → esperá 5-10 seg → revisá los campos → guardá.

## Costo

- ~USD 0.01-0.03 por escaneo con Sonnet 4.6.
- 100 libros = USD 1-3.
- Con el cap mensual de USD 5 que pusiste en Anthropic, no podés pasarte aunque
  alguien abuse del endpoint.

## Seguridad

El endpoint `/api/scan-libro` está abierto en internet (perdimilibro.com es
público). Las defensas que tenés:

1. **Rate limit por IP**: 30 escaneos/hora. Para uso personal es muchísimo;
   para un atacante es poco.
2. **Spending cap en Anthropic**: si pasás los USD 5 del mes, Anthropic corta
   las requests por su cuenta.
3. **Logs de Vercel**: si ves tráfico raro, ahí lo detectás.

Si en algún momento querés más seguridad, opciones:
- Subir a Vercel Pro y activar Password Protection en el proyecto.
- Agregar un header secreto en el frontend que el backend valide.

## Si algo falla

**"El servidor no tiene la API key configurada"** → te falta agregar
`ANTHROPIC_API_KEY` en Environment Variables de Vercel y redeployar.

**Error 502 / "La API de Claude devolvió error"** → puede ser que la key
esté inválida, o que pasaste el spending cap. Mirar logs en Vercel y
billing en console.anthropic.com.

**"No se identifica un libro en la imagen"** → la foto está muy borrosa o
no se ve un lomo. Probá con más luz, más cerca, o usá el botón ISBN si el
libro tiene código de barras.

**Timeout (la app se queda colgada >10 seg)** → estás en plan hobby con
límite de 10 seg. Si te pasa seguido, en `app.js` bajar `reducirImagen(file, 1600, ...)`
a `reducirImagen(file, 1200, ...)`. O subir a Vercel Pro (60 seg).

**El PWA viejo no se actualiza** → en el celular, cerrar la app, ir a
Configuración del sitio en el browser y borrar el cache, o desinstalar y
reinstalar el PWA. El nuevo service worker se va a cargar.
