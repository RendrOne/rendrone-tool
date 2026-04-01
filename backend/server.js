require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();

// Allow requests from the GitHub Pages frontend (and localhost for dev)
const allowed = (process.env.ALLOWED_ORIGINS || 'https://rendrone.github.io')
  .split(',')
  .map(o => o.trim());

app.use(cors({
  origin: function (origin, cb) {
    if (!origin || allowed.includes(origin) || allowed.includes('*')) cb(null, true);
    else cb(new Error('CORS: origin not allowed'));
  }
}));

app.use(express.json({ limit: '25mb' }));

// ── HEALTH CHECK ──────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── AI ENHANCE ───────────────────────────────────────────────
// POST /ai-enhance
// Body:     { image: "<base64>", mimeType: "image/jpeg", prompt?: "custom prompt" }
// Response: { enhanced: "<base64>", mimeType: "image/jpeg" }
//
// Model:  Imagen 4 Fast  — $0.02 / image (pay-as-you-go, no free tier)
// Upgrade: set IMAGE_MODEL=imagen-4.0-generate-001  ($0.04/image, higher quality)
//          set IMAGE_MODEL=imagen-4.0-ultra-generate-001  ($0.06/image, best quality)

const DEFAULT_ENHANCE_PROMPT = `You are an expert architectural visualization artist.
Enhance this 3D architectural visualization screenshot to look photorealistic.
Rules you must follow:
- Preserve the EXACT same composition, camera angle, room layout, and color scheme
- Do NOT remove, add, or move any objects, furniture, or architectural elements
- Do NOT change any colors or materials — only make them look more realistic
- Improve: material textures, surface detail, lighting, shadows, reflections, ambient occlusion
- Add subtle atmospheric depth, realistic imperfections, and environmental believability
- Remove any obvious 3D rendering artifacts (overly smooth surfaces, flat lighting, plastic-looking materials)
Output only the enhanced image.`;

app.post('/ai-enhance', async (req, res) => {
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not set on server' });
  }

  const { image, mimeType = 'image/jpeg', prompt } = req.body;
  if (!image) return res.status(400).json({ error: '"image" field is required (base64 string)' });

  const model = process.env.IMAGE_MODEL || 'imagen-4.0-fast-generate-001';
  const enhancePrompt = prompt || DEFAULT_ENHANCE_PROMPT;

  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const imageModel = genAI.getGenerativeModel({ model });

    // Imagen 4 image editing: input image + instruction prompt → output image
    const result = await imageModel.generateContent([
      { inlineData: { data: image, mimeType } },
      enhancePrompt
    ]);

    const candidates = result.response?.candidates;
    if (!candidates?.length) throw new Error('No response from Imagen');

    const imgPart = candidates[0].content.parts.find(p => p.inlineData?.data);
    if (!imgPart) throw new Error('Imagen did not return an image');

    res.json({
      enhanced: imgPart.inlineData.data,
      mimeType: imgPart.inlineData.mimeType || 'image/jpeg'
    });

  } catch (err) {
    console.error('[ai-enhance]', err.message);
    res.status(500).json({ error: err.message || 'Enhancement failed' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`RendrOne backend running on :${PORT}`));
