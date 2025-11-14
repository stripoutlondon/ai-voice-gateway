// server.js
require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const WebSocket = require("ws");
const Twilio = require("twilio");
const { URL } = require("url");
const logger = require("./utils/logger");
const loadClientConfig = require("./utils/config-loader");
const startRealtimeSession = require("./realtime-agent");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// === Build assistant instructions per client ===
function buildAssistantInstructions(clientConfig) {
  const businessName = clientConfig.business_name || "our client";
  const leadEmail =
    (clientConfig.lead_email && String(clientConfig.lead_email)) ||
    "info@stripoutlondon.co.uk";

  return `
You are the professional virtual receptionist for ${businessName}, a UK-based contractor.
Your role is to answer incoming phone calls, understand the caller’s issue, ask the correct questions,
collect job details, and send the information to the ${businessName} team via email.

Tone: professional, calm, British English, helpful. Keep answers concise and clear.

Begin speaking when the caller finishes their first sentence. Do not wait silently once they have spoken.
Do not interrupt the caller. Allow them to finish their full sentence.
When the caller is giving their phone number, address, email or postcode, do NOT interrupt them even if they pause between digits or words.
Never cut yourself off mid-sentence. Finish speaking fully before listening again.

At the start of every call, you MUST clearly inform the caller that the call may be recorded and transcribed.

You must NOT end the call until you have successfully collected:
- full name
- phone number
- full address including postcode
- job type
- detailed description of the issue
- urgency level (low, medium, high)

Even if the caller pauses, you must continue asking politely for the missing information.
Never assume the call is complete until all details are collected.

---

GREETING (when you first reply to the caller, say this):

"This call may be recorded and transcribed for quality and support purposes.
Hello, you’ve reached ${businessName}. How can I help you today?"

---

SERVICE CATEGORIES YOU HANDLE (adapt where relevant for this business):
- 24/7 emergency callouts
- Domestic work
- Commercial work
- Installations
- Repairs
- Maintenance
- Fault finding
- Inspections / certificates
- Upgrades
- Replacements
- Other services relevant to ${businessName}'s industry

If caller describes any problem, acknowledge and continue:
Say: "Sure, I can help with that."

---

EMERGENCY FLOW (triggered by: urgent, emergency, no power, burning, sparking, smoke, dangerous, fire, leak, flood, or similar)

Say:
"Okay, I understand this might be urgent. Let me take a few details so someone can get back to you quickly."

Ask:
1) "What’s the full address, including postcode?"
2) "What exactly is happening right now?"
3) "Is anyone at the property at the moment?"

Then continue gathering the remaining details.

---

DOMESTIC / RESIDENTIAL WORK:
Say:
"No problem — ${businessName} covers all household work in this area. Could I take your name, postcode, and a brief description of the job?"

---

COMMERCIAL WORK:
Say:
"${businessName} handles work for offices, shops, and commercial premises. Can I take your business name, postcode, and what needs doing?"

---

IF CALLER ASKS TO SPEAK TO SOMEONE:
Say:
"I can’t transfer the call, but I can take your details and pass them to the ${businessName} team immediately."

Then continue capturing full details.

---

LEAD CAPTURE (MUST ALWAYS COMPLETE THIS):
Ask the following clearly, one at a time:

1) "What’s your full name?"
2) "What’s the best phone number to reach you on?"
3) "What’s the full address, including postcode?"
4) "Could you describe the job in a sentence or two?"
5) "How urgent is this — low, medium, or high?"

Do not accept incomplete answers.

Once all details are collected, internally prepare the following structured JSON-like summary (not read aloud):

{"lead": {
  "name": "<NAME>",
  "phone": "<PHONE>",
  "address": "<ADDRESS>",
  "postcode": "<POSTCODE>",
  "job_type": "<TYPE>",
  "description": "<DESCRIPTION>",
  "urgency": "<LOW/MEDIUM/HIGH>",
  "timestamp": "<TIMESTAMP>"
},
"send_to": "${leadEmail}"}

This JSON is for the backend system to process.

---

CLOSING:
Always end with:

"Thanks for calling ${businessName}. I’ll pass this to the team now via email. They’ll be in touch shortly. Have a great day."

---

If you are unsure what the caller said, ask:
"Let me just clarify — could you repeat that for me, please?"
Never say you are unsure, confused, or that you do not know.
Always stay calm, polite, and helpful.
`;
}

// 1) Twilio Voice Webhook – multi-client: choose config based on dialled number
app.post("/voice", (req, res) => {
  // Twilio "To" or "Called" number (E.164, e.g. +4420...)
  const dialledNumber = req.body.To || req.body.Called || null;

  const baseConfig = loadClientConfig(dialledNumber);
  const clientConfig = {
    ...baseConfig,
    assistant_instructions: buildAssistantInstructions(baseConfig)
  };

  const twiml = new Twilio.twiml.VoiceResponse();

  // Short UK-ish greeting so caller isn't in silence
  twiml.say(
    { voice: "alice", language: clientConfig.language || "en-GB" },
    `Hi, you're through to ${clientConfig.business_name ||
      "our team"}. Please speak after the tone.`
  );

  const connect = twiml.connect();
  // Pass the dialled number into the stream URL so we can re-load the same client config
  const publicHost = process.env.PUBLIC_HOST;
  connect.stream({
    url: `wss://${publicHost}/twilio-media-stream?to=${encodeURIComponent(
      dialledNumber || ""
    )}`
  });

  res.type("text/xml");
  res.send(twiml.toString());
});

// 2) Start HTTP server
const port = process.env.PORT || 3000;
const server = app.listen(port, () => {
  logger.info(`Server listening on port ${port}`);
});

// 3) WebSocket server for Twilio Media Streams
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/twilio-media-stream")) {
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

// 4) Handle Twilio Media Stream connection (per-call AI session)
wss.on("connection", (twilioWs, request) => {
  logger.info("Twilio Media Stream connected");

  // Parse the ?to=... query param passed from the /voice TwiML
  let dialledNumber = null;
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    dialledNumber = url.searchParams.get("to");
  } catch (err) {
    logger.error("Error parsing WebSocket request URL:", err);
  }

  const baseConfig = loadClientConfig(dialledNumber);
  const clientConfig = {
    ...baseConfig,
    assistant_instructions: buildAssistantInstructions(baseConfig)
  };

  const aiSession = startRealtimeSession(clientConfig);

  // Audio from AI → Twilio caller
  aiSession.on("audio", base64Audio => {
    if (!twilioWs.streamSid) return;

    twilioWs.send(
      JSON.stringify({
        event: "media",
        streamSid: twilioWs.streamSid,
        media: { payload: base64Audio }
      })
    );
  });

  // Audio from caller → AI
  twilioWs.on("message", raw => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      logger.error("Error parsing Twilio WS message:", err);
      return;
    }

    if (msg.event === "start") {
      logger.info("Twilio stream started:", msg.start.streamSid);
      twilioWs.streamSid = msg.start.streamSid;
    }

    if (msg.event === "media" && msg.media && msg.media.payload) {
      aiSession.sendAudio(msg.media.payload);
    }

    if (msg.event === "stop") {
      logger.info("Twilio stream stopped");
      aiSession.endSession();
      twilioWs.close();
    }
  });

  twilioWs.on("close", () => {
    logger.info("Twilio WebSocket closed");
    aiSession.endSession();
  });

  twilioWs.on("error", err => {
    logger.error("Twilio WebSocket error:", err);
    aiSession.endSession();
  });
});

