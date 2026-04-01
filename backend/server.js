require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const RENDER_LIMIT = 15;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'renders.db');

// ── DATABASE ──────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS render_counts (
    project_id  TEXT PRIMARY KEY,
    used        INTEGER DEFAULT 0,
    reserved    INTEGER DEFAULT 0,
    created_at  TEXT    DEFAULT (datetime('now'))
  )
`);

function getOrCreate(projectId) {
  let row = db.prepare('SELECT * FROM render_counts WHERE project_id = ?').get(projectId);
  if (!row) {
    db.prepare('INSERT OR IGNORE INTO render_counts (project_id) VALUES (?)').run(projectId);
    row = db.prepare('SELECT * FROM render_counts WHERE project_id = ?').get(projectId);
  }
  return row;
}

function calcRemaining(row) {
  return Math.max(0, RENDER_LIMIT - (row.used + row.reserved));
}

// Atomically reserve one credit; returns remaining after reservation or null if none left
const tryReserve = db.transaction((projectId) => {
  const row = getOrCreate(projectId);
  if (calcRemaining(row) <= 0) return null;
  db.prepare('UPDATE render_counts SET reserved = reserved + 1 WHERE project_id = ?').run(projectId);
  return calcRemaining(db.prepare('SELECT * FROM render_counts WHERE project_id = ?').get(projectId));
});

// ── CORS ──────────────────────────────────────────────────────
const allowed = (process.env.ALLOWED_ORIGINS || 'https://rendrone.github.io')
  .split(',').map(o => o.trim());

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowed.includes(origin) || allowed.includes('*')) cb(null, true);
    else cb(new Error('CORS: origin not allowed'));
  }
}));
app.use(express.json({ limit: '25mb' }));

// ── HEALTH ────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── GET /renders/status ───────────────────────────────────────
app.get('/renders/status', (req, res) => {
  const { project } = req.query;
  if (!project) return res.status(400).json({ error: 'project param required' });
  const row = getOrCreate(project);
  res.json({
    project,
    remaining: calcRemaining(row),
    used: row.used,
    reserved: row.reserved,
    total: RENDER_LIMIT
  });
});

// ── POST /ai-enhance ──────────────────────────────────────────
const ENHANCE_PROMPT = `Upscale this image to ultra high resolution (4K–8K+) while preserving the exact same composition, layout, proportions, geometry, and camera angle.

Do NOT add, remove, move, or redesign anything in the scene. The structure, architecture, landscaping, and all elements must remain 100% identical.

Strictly preserve all original materials and finishes. Do not alter siding types, textures, colors, patterns, or material definitions in any way.

Remove any non-scene UI elements, overlays, or artifacts such as buttons, navigation icons, interface controls, or Twinmotion display elements. The final image should contain only the architectural scene itself.

Convert the image from a rendered/CG appearance into a true-to-life photograph. Replace any artificial or "animated" look with real-world photographic realism.

Enhance materials with physically accurate behavior:
- Natural light interaction (correct reflections, roughness, and shading)
- Subtle real-world imperfections (micro-texture, slight variation, natural wear)
- No artificial smoothing or plastic appearance

Simulate real camera characteristics:
- Realistic exposure and dynamic range
- Natural depth of field (very subtle, not stylized)
- Accurate contrast and color balance
- Soft, physically correct shadows and highlight roll-off
- Real lens behavior without distortion of composition

Eliminate all CGI artifacts, overly clean surfaces, and rendering noise. Replace with grounded, tactile realism.

The final result must look like a real photograph taken with a professional camera of the exact same scene — clearly more lifelike and believable — while remaining completely identical in design, materials, and composition.`;

app.post('/ai-enhance', async (req, res) => {
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not configured on server' });
  }

  const { image, mimeType = 'image/jpeg', projectId } = req.body;
  if (!image)     return res.status(400).json({ error: '"image" field required' });
  if (!projectId) return res.status(400).json({ error: '"projectId" field required' });

  // Atomically reserve a render credit before touching the AI
  const remaining = tryReserve(projectId);
  if (remaining === null) {
    return res.status(429).json({
      error: 'Render limit reached for this project',
      remaining: 0
    });
  }

  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: process.env.IMAGE_MODEL || 'gemini-2.5-flash',
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

    // Mark credit as used (move from reserved → used)
    db.prepare('UPDATE render_counts SET used = used + 1, reserved = MAX(0, reserved - 1) WHERE project_id = ?')
      .run(projectId);

    const row = db.prepare('SELECT * FROM render_counts WHERE project_id = ?').get(projectId);
    res.json({
      enhanced: imgPart.inlineData.data,
      mimeType:  imgPart.inlineData.mimeType || 'image/jpeg',
      remaining: calcRemaining(row)
    });

  } catch (err) {
    // Return the reserved credit on failure so it's not wasted
    db.prepare('UPDATE render_counts SET reserved = MAX(0, reserved - 1) WHERE project_id = ?')
      .run(projectId);
    console.error('[ai-enhance]', err.message);
    res.status(500).json({ error: err.message || 'Enhancement failed' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`RendrOne backend running on :${PORT}`));
