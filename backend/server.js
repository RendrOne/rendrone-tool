require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs   = require('fs');
const path = require('path');

const app = express();
const RENDER_LIMIT      = 15;
const DEMO_RENDER_LIMIT = 1;

function getRenderLimit(pid) {
  return pid && pid.toUpperCase().includes('DEMO') ? DEMO_RENDER_LIMIT : RENDER_LIMIT;
}

const DATA_DIR  = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'renders.json');

function loadStore() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return {}; }
}
function saveStore(s) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(s), 'utf8'); }
  catch(e) { console.error('[store] write error:', e.message); }
}
let store = loadStore();

function getProject(pid) {
  if (!store[pid]) store[pid] = { used: 0, reserved: 0 };
  return store[pid];
}
function calcRemaining(pid, rec) {
  return Math.max(0, getRenderLimit(pid) - (rec.used + rec.reserved));
}
function tryReserve(pid) {
  const rec = getProject(pid);
  if (calcRemaining(pid, rec) <= 0) return null;
  rec.reserved++;
  saveStore(store);
  return calcRemaining(pid, rec);
}
function commitRender(pid) {
  const rec = getProject(pid);
  rec.used     = (rec.used || 0) + 1;
  rec.reserved = Math.max(0, (rec.reserved || 0) - 1);
  saveStore(store);
}
function returnReserved(pid) {
  const rec = getProject(pid);
  rec.reserved = Math.max(0, (rec.reserved || 0) - 1);
  saveStore(store);
}

const allowed = (process.env.ALLOWED_ORIGINS || 'https://rendrone.github.io')
  .split(',').map(o => o.trim());

app.use(cors({
  origin: (origin, cb) =>
    (!origin || allowed.includes(origin) || allowed.includes('*'))
      ? cb(null, true) : cb(new Error('CORS: blocked'))
}));
app.use(express.json({ limit: '25mb' }));

app.get('/health', (_req, res) =>
  res.json({ status: 'ok', ts: new Date().toISOString() }));

app.get('/renders/status', (req, res) => {
  const { project } = req.query;
  if (!project) return res.status(400).json({ error: 'project param required' });
  const rec = getProject(project);
  res.json({
    project,
    remaining: calcRemaining(project, rec),
    used:      rec.used,
    reserved:  rec.reserved,
    total:     getRenderLimit(project)
  });
});

// ── Prompt ────────────────────────────────────────────────────────────────────
const ENHANCE_PROMPT = `You are a photorealism texture filter. Your only job is to make this architectural rendering look like it was photographed with a professional camera. You are NOT allowed to add, remove, or move anything.

STRICT RULES — NEVER BREAK THESE:
- Every object in the output must exist in exactly the same position as the input. Do not add any new objects, furniture, plants, people, decor, or anything else.
- Do not remove anything from the scene. Every element present in the input must appear in the output.
- Do not change any colors. Every surface, wall, floor, ceiling, material, and object must be the exact same color as in the input image.
- Do not change any materials. A wood floor stays wood, concrete stays concrete, tile stays tile. Only add photographic texture — do not swap or reinterpret materials.
- Do not change the architecture. Walls, windows, doors, ceilings, and structural elements must be identical in shape and position.
- Do not change the lighting setup. Light sources must remain in the same positions. You may add subtle natural shadows and reflections from existing lights only.
- Do not change the camera angle, crop, or composition in any way.
- Do not add sky, landscape, or background content that was not in the original.
- Remove any visible software UI, watermarks, or rendering interface overlays.

WHAT YOU ARE ALLOWED TO DO:
- Add photographic surface texture and micro-detail to existing materials (grain in wood, roughness in concrete, weave in fabric)
- Add subtle photographic imperfections: lens vignette, mild chromatic aberration, realistic sensor noise, slight depth-of-field blur
- Add realistic shadows and reflections that are physically consistent with the existing light sources in the scene
- Increase overall sharpness and definition

Think of this as: take the render, print it, photograph it with a professional architectural camera. Same exact scene — just real-looking.

Output only the enhanced image. Do not describe or explain anything.`;

// ── AI enhance endpoint ────────────────────────────────────────────────────────
app.post('/ai-enhance', async (req, res) => {
  if (!process.env.GEMINI_API_KEY)
    return res.status(500).json({ error: 'GEMINI_API_KEY not set on server' });

  const { image, mimeType = 'image/jpeg', projectId } = req.body;
  if (!image)     return res.status(400).json({ error: '"image" required' });
  if (!projectId) return res.status(400).json({ error: '"projectId" required' });

  const reserved = tryReserve(projectId);
  if (reserved === null)
    return res.status(429).json({ error: 'Render limit reached', remaining: 0 });

  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

    // ── EXACT format from last confirmed-working version ──────────────────────
    // generationConfig in getGenerativeModel, array-of-parts to generateContent
    const model = genAI.getGenerativeModel({
      model: process.env.IMAGE_MODEL || 'gemini-3.1-flash-image-preview',
      generationConfig: { responseModalities: ['image', 'text'] }
    });

    let imgPart = null;
    let lastErr  = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        const wait = attempt * 5000; // 5 s, 10 s
        console.log(`[ai-enhance] retry ${attempt} in ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
      }
      try {
        // Array-of-parts call — matches the SDK's formatNewContent path
        const result = await model.generateContent([
          { inlineData: { data: image, mimeType } },
          ENHANCE_PROMPT
        ]);

        const parts = result.response?.candidates?.[0]?.content?.parts ?? [];
        imgPart = parts.find(p => p.inlineData?.data) ?? null;

        if (imgPart) break;

        // Model replied but no image — log what it said and retry
        const txt = (parts.find(p => p.text)?.text ?? 'no image in response').slice(0, 150);
        console.warn(`[ai-enhance] attempt ${attempt + 1}: no image — "${txt}"`);
        lastErr = new Error(`No image returned: ${txt}`);

      } catch (e) {
        lastErr = e;
        console.warn(`[ai-enhance] attempt ${attempt + 1} threw: ${e.message}`);
        // Hard errors — don't retry
        if (/API_KEY|PERMISSION|invalid|400|401|403/i.test(e.message)) break;
      }
    }

    if (!imgPart) throw lastErr ?? new Error('Model returned no image after 3 attempts');

    commitRender(projectId);
    res.json({
      enhanced:  imgPart.inlineData.data,
      mimeType:  imgPart.inlineData.mimeType || 'image/jpeg',
      remaining: calcRemaining(projectId, getProject(projectId))
    });

  } catch (err) {
    returnReserved(projectId);
    console.error('[ai-enhance] final error:', err.message);
    res.status(500).json({ error: err.message || 'Enhancement failed' });
  }
});

const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, () =>
  console.log(`RendrOne backend on :${PORT}`));
server.timeout = 210000; // 3.5 min
