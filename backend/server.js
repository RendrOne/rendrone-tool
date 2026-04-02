require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

const app = express();
const RENDER_LIMIT = 15;
const DEMO_RENDER_LIMIT = 1;

function getRenderLimit(projectId) {
  return projectId && projectId.toUpperCase().includes('DEMO') ? DEMO_RENDER_LIMIT : RENDER_LIMIT;
}

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
function calcRemaining(pid, rec) {
  return Math.max(0, getRenderLimit(pid) - (rec.used + rec.reserved));
}
function tryReserve(pid) {
  const rec = getProject(pid);
  if (calcRemaining(pid, rec) <= 0) return null;
  rec.reserved += 1;
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
    remaining: calcRemaining(project, rec),
    used:      rec.used,
    reserved:  rec.reserved,
    total:     getRenderLimit(project)
  });
});

const ENHANCE_PROMPT = `Replicate this image exactly but make it look like a real life photograph. Every material, color, texture, finish, surface, spatial layout, furniture, fixtures, lighting position, and design detail must be identical to the source image. Do not add, remove, or change anything about the scene.

Remove any software UI elements, overlays, watermarks, Twinmotion buttons, navigation icons, or rendering interface artifacts. The final image should contain only the architectural space itself.

Shot on a professional full-frame camera, photographic depth of field, authentic sensor noise, subtle film grain. All surfaces show real-world material behavior: micro-texture, natural light falloff, realistic reflections, and authentic shadow gradients.

Enhance realism with the following: chromatic aberration on lens edges, slight barrel distortion, subtle vignetting toward frame corners, imperceptible focus breathing, real specular highlights with slight bloom on light sources, contact shadows where objects meet surfaces, ambient occlusion in corners and crevices, translucency in thin materials like curtains or foliage, natural color grading with slight warm-to-cool gradient, microscopic dust particles visible in light beams, imperfect parallel lines from handheld camera sway.

No CGI artifacts, no artificial perfection. Indistinguishable from a photograph taken by a professional architectural photographer. Award-winning architectural photography. MLS and editorial quality.`;



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
    const model = genAI.getGenerativeModel(
      { model: process.env.IMAGE_MODEL || 'gemini-3.1-flash-image-preview',
        generationConfig: { responseModalities: ['image', 'text'] } },
      { timeout: 180000 }
    );

    // Retry up to 2 times on 503 timeout errors
    let result, lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        result = await model.generateContent([
          { inlineData: { data: image, mimeType } },
          ENHANCE_PROMPT
        ]);
        break;
      } catch(e) {
        lastErr = e;
        if (attempt < 2 && (e.message?.includes('503') || e.message?.includes('Deadline'))) {
          await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
          continue;
        }
        throw e;
      }
    }
    if (!result) throw lastErr;

    const candidates = result.response?.candidates;
    if (!candidates?.length) throw new Error('No response from AI model');

    const imgPart = candidates[0].content.parts.find(p => p.inlineData?.data);
    if (!imgPart) throw new Error('AI model did not return an image');

    commitRender(projectId);
    const rec = getProject(projectId);

    res.json({
      enhanced:  imgPart.inlineData.data,
      mimeType:  imgPart.inlineData.mimeType || 'image/jpeg',
      remaining: calcRemaining(projectId, rec)
    });

  } catch (err) {
    returnReserved(projectId);
    console.error('[ai-enhance]', err.message);
    res.status(500).json({ error: err.message || 'Enhancement failed' });
  }
});

const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, () => console.log(`RendrOne backend running on :${PORT}`));
server.timeout = 210000; // 3.5 min — longer than the 3-min Gemini timeout
