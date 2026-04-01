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
// Body: { image: "<base64>", mimeType: "image/jpeg" }
// Response: { enhanced: "<base64>", mimeType: "image/jpeg" }
app.post('/ai-enhance', async (req, res) => {
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not set on server' });
  }

  const { image, mimeType = 'image/jpeg' } = req.body;
  if (!image) return res.status(400).json({ error: '"image" field is required (base64 string)' });

  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash-preview-image-generation',
      generationConfig: { responseModalities: ['image'] }
    });

    const result = await model.generateContent([
      { inlineData: { data: image, mimeType } },
      `You are an expert architectural visualization artist and photo retoucher.
Enhance this 3D architectural visualization screenshot to look more photorealistic.
- Improve material textures, surface detail, and tactile quality
- Enhance lighting, shadows, reflections, and ambient occlusion
- Add subtle atmospheric depth and environmental realism
- Preserve the exact composition, camera angle, room layout, and color palette
- Do not change or move any design elements — only improve visual fidelity
Output only the enhanced image, no text.`
    ]);

    const candidates = result.response?.candidates;
    if (!candidates?.length) throw new Error('No response from Gemini');

    const imgPart = candidates[0].content.parts.find(p => p.inlineData?.data);
    if (!imgPart) throw new Error('Gemini did not return an image — try a different prompt or model');

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
