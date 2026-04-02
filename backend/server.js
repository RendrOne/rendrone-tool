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

const ENHANCE_PROMPT = `Transform this architectural rendering into a photorealistic image that looks like it was taken with a professional camera.

Make these enhancements dramatically visible:
- Convert all surfaces from CG/rendered appearance to real photographic texture and depth
- Enhance material realism: wood grain, concrete texture, stone, glass reflections, metal finishes
- Add photographic lighting quality: natural shadows, realistic highlights, subtle ambient occlusion
- Increase overall sharpness and detail to the maximum
- Remove any Twinmotion UI elements, buttons, or overlays from the image

Keep these exactly the same:
- All colors — do not shift or alter any material or surface colors
- All lighting fixtures — keep their exact shape, position, and design
- The composition, camera angle, and framing
- All architectural elements, landscaping, and objects in their exact positions

The result should look strikingly more realistic and photographic than the input while being the same scene.`;



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
