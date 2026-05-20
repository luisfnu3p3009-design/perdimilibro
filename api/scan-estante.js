// ============================================================
// perdimilibro — /api/scan-estante
// ------------------------------------------------------------
// Recibe una imagen de un estante con varios libros y devuelve
// los datos bibliográficos de cada uno, con un confidence score
// por libro para que el usuario pueda revisar antes de guardar.
//
// Hard cap: 12 libros por foto. Más que eso, la precisión cae
// abruptamente (los lomos quedan demasiado chicos en la imagen
// que el modelo procesa internamente, ~1568px de lado mayor).
// El prompt instruye al modelo a priorizar los más legibles si
// hay más en la foto.
//
// Body (JSON):
//   { imagen_base64: "...", media_type: "image/jpeg" }
//
// Respuesta exitosa (JSON):
//   {
//     libros: [
//       { autor, titulo, subtitulo, editorial, anio, edicion,
//         tomo, isbn, idioma, posicion, confidence },
//       ...
//     ],
//     total_detectados: 8,
//     nota_general: null | "..."
//   }
//
// Respuesta de error:
//   { error: "mensaje" }   con status 4xx/5xx
// ============================================================

const MODELO = 'claude-sonnet-4-6';
const MAX_LIBROS = 12;
const MAX_TOKENS = 4096;

// Rate limit más estricto que single: cada multi-scan consume
// 5-10x más tokens que un single. 10/hora por IP alcanza para uso
// real y corta abuso. Se resetea en cold start.
const buckets = new Map();
const LIMITE = 10;
const VENTANA_MS = 60 * 60 * 1000;

function permitido(ip) {
  const ahora = Date.now();
  const b = buckets.get(ip) || { count: 0, reset: ahora + VENTANA_MS };
  if (ahora > b.reset) {
    b.count = 0;
    b.reset = ahora + VENTANA_MS;
  }
  b.count++;
  buckets.set(ip, b);
  return b.count <= LIMITE;
}

const CONFIDENCES_VALIDAS = new Set(['high', 'medium', 'low']);

const PROMPT = `Sos un asistente experto en catalogación bibliográfica. La imagen muestra varios libros (típicamente un estante con lomos hacia la cámara, o una pila vista de costado). Tu tarea es identificar cada libro individual y extraer sus datos.

Devolvé SOLO un JSON válido (sin texto antes ni después, sin markdown, sin backticks) con esta estructura exacta:

{
  "libros": [
    {
      "posicion": "1 desde la izquierda",
      "autor": "Apellido, Nombre",
      "titulo": "Título exacto del libro",
      "subtitulo": null,
      "editorial": "Nombre completo de la editorial",
      "anio": "AAAA",
      "edicion": null,
      "tomo": null,
      "isbn": null,
      "idioma": "Espanol",
      "confidence": "high"
    }
  ],
  "total_detectados": 1,
  "nota_general": null
}

REGLAS INNEGOCIABLES:

1. **NO inventes libros ni datos.** Si un campo no se ve con claridad, devolvé null para ese campo. Si dudás de un libro entero, ponelo igual pero con confidence: "low" — el usuario va a revisar antes de guardar. Es muchísimo peor inventar datos plausibles que admitir que no se ve.

2. **Confidence calibrada honestamente:**
   - "high" → todos los campos visibles claramente, título y autor sin ambigüedad.
   - "medium" → título legible, pero algún campo (autor / año / editorial) dudoso o ilegible.
   - "low" → texto borroso, lomo parcialmente tapado, dudás si lo que leés es realmente lo que escribís, o solo se distingue una parte del título.

3. **Máximo ${MAX_LIBROS} libros** en el array libros. Si en la imagen hay más, devolvé los ${MAX_LIBROS} más legibles y poné el resto en nota_general: "Hay aproximadamente N libros más que no son legibles a esta resolución. Probá tomando la foto en partes."

4. **Posición:** describí la ubicación de cada libro de forma que el usuario pueda identificarlo en su foto. Ejemplos válidos: "1 desde la izquierda", "3 desde la izquierda, estante superior", "primero de la pila", "lomo rojo en el centro". Empezá numerando desde la izquierda y desde arriba.

5. **Autor SIEMPRE en formato "Apellido, Nombre"** (no "Nombre Apellido"). Múltiples autores separados por " ; ".

6. **Editorial:** nombre completo y canónico (ej. "Penguin Random House", "Sudamericana", "Abeledo-Perrot", no abreviaturas ni siglas).

7. **Idioma como nombre en español** sin tilde ni "ñ": "Espanol", "Ingles", "Frances", "Italiano", "Portugues", "Aleman", "Catalan".

8. **Si la imagen NO muestra libros reconocibles** (es una foto de otra cosa, está toda borrosa, etc.), devolvé exactamente: {"error": "No se identifican libros en la imagen"}.

9. **total_detectados** debe coincidir con la cantidad de libros en el array libros.

10. **nota_general** es null por default. Usalo solo si: (a) hay más de ${MAX_LIBROS} libros visibles, (b) la foto tiene problemas de calidad que merecen aviso al usuario, (c) algún libro está parcialmente tapado por otro objeto.

Devolvé SOLO el JSON. Sin preámbulo, sin explicación, sin markdown.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Solo POST' });
  }

  // ----- API key check -----
  const API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!API_KEY) {
    console.error('Falta ANTHROPIC_API_KEY en Environment Variables');
    return res.status(500).json({
      error: 'El servidor no tiene la API key configurada.'
    });
  }

  // ----- Rate limit por IP -----
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
          || req.headers['x-real-ip']
          || 'unknown';
  if (!permitido(ip)) {
    return res.status(429).json({
      error: 'Demasiados escaneos de estante en la última hora. Esperá un rato.'
    });
  }

  // ----- Body parsing -----
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: 'JSON inválido en el body' }); }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Falta body' });
  }

  const { imagen_base64, media_type } = body;
  if (!imagen_base64 || typeof imagen_base64 !== 'string') {
    return res.status(400).json({ error: 'Falta imagen_base64' });
  }
  const mt = (media_type || 'image/jpeg').toLowerCase();
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mt)) {
    return res.status(400).json({ error: 'media_type debe ser jpeg/png/webp/gif' });
  }

  // Defensa contra payloads enormes. El frontend hace resize a 2400px /
  // quality 0.85, que da imágenes típicas de 800KB-1.5MB. En base64 son
  // ~1.1MB-2MB. Cap defensivo a 6MB base64 (~4.5MB raw) por las dudas.
  if (imagen_base64.length > 6_500_000) {
    return res.status(413).json({ error: 'Imagen demasiado grande. Probá con otra foto.' });
  }

  // ----- Llamada a la API de Anthropic -----
  try {
    const apiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODELO,
        max_tokens: MAX_TOKENS,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mt, data: imagen_base64 },
            },
            { type: 'text', text: PROMPT },
          ],
        }],
      }),
    });

    if (!apiResp.ok) {
      const errText = await apiResp.text();
      console.error('Anthropic API error', apiResp.status, errText);
      return res.status(502).json({
        error: `La API de Claude devolvió error ${apiResp.status}. Probá de nuevo en unos segundos.`,
      });
    }

    const data = await apiResp.json();
    const bloque = (data.content || []).find(c => c.type === 'text');
    if (!bloque) {
      return res.status(502).json({ error: 'El modelo no devolvió texto.' });
    }

    // El modelo a veces envuelve en ```json ... ``` aunque le pidamos que no.
    let texto = bloque.text.trim();
    if (texto.startsWith('```')) {
      texto = texto.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    }

    let datos;
    try {
      datos = JSON.parse(texto);
    } catch {
      console.error('JSON inválido del modelo:', texto.slice(0, 500));
      return res.status(502).json({
        error: 'El modelo no devolvió JSON válido.',
        raw: texto.slice(0, 200),
      });
    }

    // Pass-through del caso "no son libros".
    if (datos.error) {
      return res.status(200).json(datos);
    }

    // ----- Validación / saneamiento del shape -----
    // El modelo es generalmente confiable pero nos defendemos por las dudas:
    // truncar al cap, normalizar confidence, no romper si falta total_detectados.
    if (!Array.isArray(datos.libros)) {
      return res.status(502).json({
        error: 'El modelo no devolvió un array de libros.',
      });
    }

    // Truncar al cap defensivamente (el prompt lo pide pero por las dudas).
    if (datos.libros.length > MAX_LIBROS) {
      const sobrante = datos.libros.length - MAX_LIBROS;
      datos.libros = datos.libros.slice(0, MAX_LIBROS);
      datos.nota_general = datos.nota_general
        ? `${datos.nota_general} (se truncaron ${sobrante} libros adicionales)`
        : `Se truncaron ${sobrante} libros adicionales que el modelo había detectado de más.`;
    }

    // Normalizar confidence: cualquier valor inválido cae a "low" (conservador).
    datos.libros = datos.libros.map(libro => ({
      ...libro,
      confidence: CONFIDENCES_VALIDAS.has(libro.confidence) ? libro.confidence : 'low',
    }));

    // Recalcular total_detectados por consistencia.
    datos.total_detectados = datos.libros.length;

    // Defaults para campos opcionales que el modelo a veces omite.
    if (datos.nota_general === undefined) datos.nota_general = null;

    return res.status(200).json(datos);

  } catch (err) {
    console.error('Error en /api/scan-estante:', err);
    return res.status(500).json({ error: err.message || 'Error interno' });
  }
}

// Body parser un poco más generoso que single (imágenes 2400px vs 1600px).
export const config = {
  api: {
    bodyParser: { sizeLimit: '10mb' },
  },
};
