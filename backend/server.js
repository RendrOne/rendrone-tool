require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

const app = express();
const RENDER_LIMIT = 15;

const DATA_DIR  = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'renders.json');

function loadStore() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch(e) { return {}; }
}
function saveStore(store) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(store), 'utf8'); }
  catch(e) { console.error('[store] write failed:', e.message); }
}

let store = loadStore();

function getProject(pid) {
  if (!store[pid]) store[pid] = { used: 0, reserved: 0 };
  return store[pid];
}
function calcRemaining(rec) {
  return Math.max(0, RENDER_LIMIT - (rec.used + rec.reserved));
}
function tryReserve(pid) {
  const rec = getProject(pid);
  if (calcRemaining(rec) <= 0) return null;
  rec.reserved += 1;
  saveStore(store);
  return calcRemaining(rec);
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
  origin: (origin, cb) => {
    if (!origin || allowed.includes(origin) || allowed.includes('*')) cb(null, true);
    else cb(new Error('CORS: origin not allowed'));
  }
}));
app.use(express.json({ limit: '25mb' }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/renders/status', (req, res) => {
  const { project } = req.query;
  if (!project) return res.status(400).json({ error: 'project param required' });
  const rec = getProject(project);
  res.json({
    project,
    remaining: calcRemaining(rec),
    used:      rec.used,
    reserved:  rec.reserved,
    total:     RENDER_LIMIT
  });
});

const ENHANCE_PROMPT = `You are upscaling and photo-realifying an architectural rendering. Follow these rules absolutely:

PRESERVE WITH ZERO CHANGES:
- Every color, material, finish, and texture exactly as shown — no exceptions
- All lighting fixtures, their shape, position, and design must remain pixel-identical
- Every architectural element: walls, rooflines, windows, doors, columns, overhangs
- All landscaping, hardscape, furniture, and objects — exact positions and appearances
- The camera angle, composition, framing, and perspective — do not shift anything
- Existing lighting mood, time of day, and shadow direction

REMOVE ONLY:
- Any Twinmotion UI overlays, navigation buttons, icons, or interface elements that appear on top of the scene
- Any on-screen watermarks or control icons that are not part of the architecture

ENHANCE ONLY:
- Overall image resolution and sharpness (upscale to maximum quality)
- Surface texture detail and micro-detail to look photographic
- Reduce flat or plastic CGI appearance while keeping all colors identical
- Make shadows and highlights feel physically real without shifting their direction or intensity

DO NOT:
- Change any colors — not walls, not roofs, not wood, not metal, not glass, not plants
- Alter any lighting fixtures or add/remove any light sources
- Redesign, move, add, or remove any element of the scene
- Apply any creative interpretation — this is a strict upscale and realism pass only

The output must look like a professional photograph of the exact same scene with no creative changes whatsoever.`;


app.post('/ai-enhance', async (req, res) => {
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not configured on server' });
  }

  const { image, mimeType = 'image/jpeg', projectId } = req.body;
  if (!image)     return res.status(400).json({ error: '"image" field required' });
  if (!projectId) return res.status(400).json({ error: '"projectId" field required' });

  const remaining = tryReserve(projectId);
  if (remaining === null) {
    return res.status(429).json({ error: 'Render limit reached for this project', remaining: 0 });
  }

  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: process.env.IMAGE_MODEL || 'gemini-3.1-flash-image-preview',
      generationConfig: { responseModalities: ['image', 'text'] }
    });

    const result = await model.generateContent([
      { inlineData: { data: image, mimeType } },
      ENHANCE_PROMPT
    ]);

    const candidates = result.response?.candidates;
    if (!candidates?.length) throw new Error('No response from AI model');

    const imgPart = candidates[0].content.parts.find(p => p.inlineData?.data);
    if (!imgPart) throw new Error('AI model did not return an image');

    commitRender(projectId);
    const rec = getProject(projectId);

    res.json({
      enhanced:  imgPart.inlineData.data,
      mimeType:  imgPart.inlineData.mimeType || 'image/jpeg',
      remaining: calcRemaining(rec)
    });

  } catch (err) {
    returnReserved(projectId);
    console.error('[ai-enhance]', err.message);
    res.status(500).json({ error: err.message || 'Enhancement failed' });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`RendrOne backend running on :${PORT}`));
