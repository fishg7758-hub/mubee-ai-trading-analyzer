import express from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";
import OpenAI from "openai";
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
You are MUBEE AI, a rule-based trading chart analyst.

Analyze the uploaded trading screenshot conservatively.

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
- Bullish/Bearish FVG
- Order Block
- Breaker Block
- Breakout
- Retest
- False breakout

For an entry, require multiple confirmations and acceptable structure-based risk/reward.

The screenshot may be incomplete.
If price, timeframe or candles are unclear, lower confidence or return WAIT.

Never invent exact prices that are not visible.
If exact values cannot be read, use null.

Confidence must reflect evidence quality, not optimism.
Use 0-100.

For chart annotations:
x and y are normalized percentages from the uploaded image:
x=0 left
x=100 right
y=0 top
y=100 bottom

Return JSON only.
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
aiConfigured: Boolean(process.env.OPENAI_API_KEY),
liveDataConfigured: Boolean(process.env.TWELVEDATA_API_KEY)
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

if (!process.env.OPENAI_API_KEY) {
  return res.status(503).json({
    error: "OPENAI_API_KEY is not configured.",
    demo: true,
    message: "Add OPENAI_API_KEY in environment variables."
  });
}

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const asset = req.body.asset || "XAUUSD";
const timeframe = req.body.timeframe || "15M";
const risk = Number(req.body.risk || 2);
const minPips = Number(req.body.minPips || 10);

const dataUrl =
  `data:${req.file.mimetype};base64,` +
  req.file.buffer.toString("base64");

const userPrompt = `

Asset selected: ${asset}

Primary timeframe: ${timeframe}

Allowed risk: $${risk}

1-minute minimum target requirement if scalping:
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

- If evidence is weak, return WAIT.
  `;
  
  const response = await client.chat.completions.create({
  model: process.env.OPENAI_MODEL || "gpt-4o",
  temperature: 0.1,
  response_format: {
  type: "json_object"
  },
  messages: [
  {
  role: "system",
  content: SYSTEM_PROMPT
  },
  {
  role: "user",
  content: [
  {
  type: "text",
  text: userPrompt
  },
  {
  type: "image_url",
  image_url: {
  url: dataUrl,
  detail: "high"
  }
  }
  ]
  }
  ]
  });
  
  const content = response?.choices?.[0]?.message?.content;
  
  if (!content) {
  throw new Error("OpenAI returned an empty response.");
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

// Live quote
app.get("/api/quote", async (req, res) => {
const symbol = req.query.symbol || "XAU/USD";

if (!process.env.TWELVEDATA_API_KEY) {
return res.status(503).json({
error: "TWELVEDATA_API_KEY is not configured."
});
}

try {
const url = new URL(
"https://api.twelvedata.com/quote"
);

url.searchParams.set("symbol", symbol);
url.searchParams.set(
  "apikey",
  process.env.TWELVEDATA_API_KEY
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
);
});
  
