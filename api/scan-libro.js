// ============================================================
// perdimilibro — /api/scan-libro
// ============================================================

const MODELO = 'claude-sonnet-4-6';

const buckets = new Map();
const LIMITE = 30;
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

const PROMPT = `Sos un asistente experto en catalogación bibliográfica. Mirá la imagen del lomo, tapa o portada del libro y extraé los siguientes datos.

Devolvé SOLO un JSON válido (sin texto antes ni después, sin markdown, sin backticks) con esta estructura exacta:

{
  "autor": "Apellido, Nombre",
  "titulo": "Título exacto del libro",
  "subtitulo": null,
  "editorial": "Nombre completo de la editorial",
  "anio": "AAAA",
  "edicion": null,
  "tomo": null,
  "isbn": null,
  "idioma": "Espanol"
}

REGLAS INNEGOCIABLES:
1. Si un campo NO se ve claramente, devolvé null para ese campo. NUNCA inventes datos.
2. El autor SIEMPRE en formato "Apellido, Nombre" (no "Nombre Apellido"). Si hay múltiples autores, ponelos separados por " ; ".
3. La editorial con su nombre completo y canónico (ej. "Penguin Random House", "Sudamericana", "Abeledo-Perrot").
4. Si hay varios libros en la imagen, devolvé los datos del más prominente o central y agregá un campo "nota": "Hay varios libros, identificado el central".
5. Si la imagen NO muestra un libro reconocible, devolvé exactamente: {"error": "No se identifica un libro en la imagen"}.
6. El idioma se devuelve como nombre en español: "Espanol", "Ingles", "Frances", "Italiano", "Portugues", "Aleman", etc. (sin tilde, sin "ñ").

Devolvé SOLO el JSON.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Solo POST' });
  }

  const API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!API_KEY) {
    console.error('Falta ANTHROPIC_API_KEY en Environment Variables');
    return res.status(500).json({
      error: 'El servidor no tiene la API key configurada. Ir a Vercel → Settings → Environment Variables.'
    });
  }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
          || req.headers['x-real-ip']
          || 'unknown';
  if (!permitido(ip)) {
    return res.status(429).json({
      error: 'Demasiados escaneos en la última hora. Esperá un rato.'
    });
  }

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

  if (imagen_base64.length > 4_500_000) {
    return res.status(413).json({ error: 'Imagen demasiado grande. Probá con otra foto.' });
  }

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
        max_tokens: 1024,
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

    let texto = bloque.text.trim();
    if (texto.startsWith('```')) {
      texto = texto.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    }

    let datos;
    try {
      datos = JSON.parse(texto);
    } catch {
      return res.status(502).json({
        error: 'El modelo no devolvió JSON válido.',
        raw: texto.slice(0, 200),
      });
    }

    return res.status(200).json(datos);

  } catch (err) {
    console.error('Error en /api/scan-libro:', err);
    return res.status(500).json({ error: err.message || 'Error interno' });
  }
}

export const config = {
  api: {
    bodyParser: { sizeLimit: '8mb' },
  },
};
