import express from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import path from "path";

dotenv.config();

const app = express();
const port = process.env.PORT || 8080;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024
  }
});

app.use(cors());
app.use(express.json({ limit: "2mb" }));

// Serve frontend
app.use(express.static(path.join(process.cwd(), "public")));

const SYSTEM_PROMPT = `
You are MUBEE AI, a conservative trading chart analyst.

Analyze the uploaded trading screenshot carefully.

You must NOT claim guaranteed accuracy or certainty.

Only return BUY or SELL when the evidence is sufficiently aligned.
Otherwise return WAIT.

Prioritize:
1D -> 4H -> 1H -> 15M -> 5M -> 1M

When visually supportable, detect:

- Market bias
- BOS
- CHOCH
- Liquidity
- Liquidity sweep
- Support
- Resistance
- Supply
- Demand
- Bullish FVG
- Bearish FVG
- Order Block
- Breaker Block
- Breakout
- Retest
- False breakout

For an entry, require multiple confirmations and acceptable structure-based risk/reward.

The screenshot may be incomplete.

If price, timeframe or candles are unclear:
- lower confidence
- or return WAIT

Never invent exact prices that are not visible.
If exact values cannot be read, use null.

Confidence must reflect evidence quality, not optimism.
Use a number from 0 to 100.

For chart annotations:
x and y are normalized percentages from the uploaded image:
x=0 left
x=100 right
y=0 top
y=100 bottom

Return valid JSON only.
Do not add markdown.
Do not add ```json.
`;

const schemaHint = {
  signal: "BUY|SELL|WAIT",
  confidence: 0,
  confidenceBand: "Very High|High|Medium|Weak",
  asset: "",
  timeframe: "",
  currentPrice: null,

  entry: {
    low: null,
    high: null,
    type: "zone"
  },

  stopLoss: null,

  targets: [
    null,
    null,
    null,
    null,
    null
  ],

  riskReward: null,

  marketBias: "Bullish|Bearish|Neutral",

  structure: {
    bos: [],
    choch: [],
    trend: ""
  },

  liquidity: {
    buySide: [],
    sellSide: [],
    sweeps: []
  },

  zones: {
    support: [],
    resistance: [],
    supply: [],
    demand: [],
    fvg: [],
    orderBlocks: [],
    breakerBlocks: []
  },

  breakout: {
    status: "None|Bullish|Bearish|False Breakout|Waiting",
    retest: false
  },

  confirmations: [],
  invalidation: "",
  explanation: "",
  noTradeReasons: [],

  annotations: [
    {
      type: "line|box|label",
      label: "",
      x1: 0,
      y1: 0,
      x2: 0,
      y2: 0,
      color: "green|red|blue|yellow"
    }
  ]
};

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    aiConfigured: Boolean(process.env.GEMINI_API_KEY),
    liveDataConfigured: Boolean(process.env.TWELVE_DATA_API_KEY)
  });
});

// Main chart analysis
app.post("/api/analyze", upload.single("chart"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: "Chart image is required."
      });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(503).json({
        error: "GEMINI_API_KEY is not configured.",
        demo: true,
        message: "Add GEMINI_API_KEY in environment variables."
      });
    }

    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY
    });

    const asset = req.body.asset || "XAUUSD";
    const timeframe = req.body.timeframe || "15M";
    const risk = Number(req.body.risk || 2);
    const minPips = Number(req.body.minPips || 10);

    const base64Image = req.file.buffer.toString("base64");

    const userPrompt = `
Asset selected: ${asset}

Primary timeframe: ${timeframe}

Allowed risk: $${risk}

Minimum target requirement if scalping:
${minPips} pips

Return an object matching this structure:

${JSON.stringify(schemaHint, null, 2)}

Important rules:

- For XAUUSD 1M scalping, explicitly check whether a valid ${minPips}-pip setup exists.

- If there is no valid setup, return WAIT.

- Put "NO VALID ${minPips}-PIP SETUP" inside noTradeReasons.

- Do not fabricate position size.

- Do not invent prices.

- Targets must be structure-aware.

- Stop loss must be based on visible structure.

- If exact price is unreadable, use null.

- If evidence is weak, return WAIT.

- The selected asset is ${asset}.

- The selected timeframe is ${timeframe}.

Return JSON only.
`;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",

      contents: [
        {
          inlineData: {
            mimeType: req.file.mimetype,
            data: base64Image
          }
        },
        {
          text: userPrompt
        }
      ],

      config: {
        systemInstruction: SYSTEM_PROMPT,
        responseMimeType: "application/json",
        temperature: 0.1
      }
    });

    const content = response?.text;

    if (!content) {
      throw new Error("Gemini returned an empty response.");
    }

    const parsed = JSON.parse(content);

    parsed.meta = {
      analyzedAt: new Date().toISOString(),
      liveDataUsed: false,
      risk
    };

    return res.json(parsed);

  } catch (err) {
    console.error("ANALYSIS ERROR:", err);

    return res.status(500).json({
      error: err?.message || "Analysis failed."
    });
  }
});

// Live quote from Twelve Data
app.get("/api/quote", async (req, res) => {
  const symbol = req.query.symbol || "XAU/USD";

  if (!process.env.TWELVE_DATA_API_KEY) {
    return res.status(503).json({
      error: "TWELVE_DATA_API_KEY is not configured."
    });
  }

  try {
    const url = new URL(
      "https://api.twelvedata.com/quote"
    );

    url.searchParams.set("symbol", symbol);
    url.searchParams.set(
      "apikey",
      process.env.TWELVE_DATA_API_KEY
    );

    const response = await fetch(url);
    const data = await response.json();

    return res.json(data);

  } catch (err) {
    return res.status(500).json({
      error: err?.message || "Quote request failed."
    });
  }
});

// Frontend
app.get("/", (req, res) => {
  res.sendFile(
    path.join(
      process.cwd(),
      "public",
      "index.html"
    )
  );
});

// Start server
app.listen(port, "0.0.0.0", () => {
  console.log(`MUBEE AI running on port ${port}`);
});
