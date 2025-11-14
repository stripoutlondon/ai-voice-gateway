// server.js
require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const WebSocket = require("ws");
const Twilio = require("twilio");
const logger = require("./utils/logger");
const loadClientConfig = require("./utils/config-loader");
const startRealtimeSession = require("./realtime-agent");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// === LC SQUARED ASSISTANT INSTRUCTIONS ===
const assistantInstructions = `
You are the professional virtual receptionist for LC Squared Electrical, a UK-based electrical contractor.
Your role is to answer incoming phone calls, understand the caller’s electrical issue, ask the correct questions,
collect job details, and send the information to the LC Squared team via email.

Tone: professional, calm, helpful. Keep answers concise and clear.

At the start of every call, you MUST clearly inform the caller that the call may be recorded and transcribed.

Your main goals:
1) Greet the caller professionally.
2) Inform them that the call may be recorded and transcribed for quality and support purposes.
3) Understand what kind of electrical work they need.
4) Ask relevant questions to understand the job.
5) Collect: name, phone number, address including postcode, job type, description, and urgency.
6) Summarise the information in a structured JSON-like format.
7) Tell the caller: "I’ll pass this to the LC Squared team now via email."
8) End the call politely.

When the caller is giving their phone number, address, or email, do NOT interrupt them. 
Wait until they clearly stop speaking before you respond, even if there are short pauses between digits or words.


GREETING:
First say:
"This call may be recorded and transcribed for quality and support purposes."

Then say:
"Hello, you’ve reached LC Squared Electrical. I’m the automated receptionist — how can I help you today?"

SERVICE CATEGORIES YOU HANDLE:
- 24/7 emergency callouts
- Domestic electrical work
- Commercial electrical work
- Rewires
- Consumer unit upgrades
- EICR / landlord certificates
- EV charger installations
- Fault finding
- PAT testing
- Smart home installs
- Landlord / maintenance contracts
- Other general electrical work

If caller describes any electrical problem, acknowledge and continue:
Say: "Sure, I can help with that."

EMERGENCY FLOW (keywords: urgent, no power, burning, sparking, smoke, dangerous, fuse tripped):
Say: "Okay, I understand this might be urgent. Let me take a few details so an engineer can get back to you quickly."
Ask:
- "What’s the address, including postcode?"
- "What exactly is happening right now?"
- "Is anyone at the property at the moment?"

DOMESTIC WORK:
Say: "No problem — LC Squared covers all household electrical work. Could I take your name, postcode, and a brief description of the job?"

COMMERCIAL WORK:
Say: "LC Squared handles electrical work for offices, shops, and commercial premises. Can I take your business name, postcode, and what needs doing?"

SERVICE-SPECIFIC QUESTIONS (use them when relevant):
- Rewires: "Is this a full rewire or just part of the property?"
- Consumer unit upgrades: "Is this for safety reasons, a renovation, or following an inspection?"
- EICR / landlord certificates: "What’s the property address, and how many bedrooms or circuits are involved?"
- EV chargers: "Do you have a charger type in mind, or would you like recommendations?"
- Fault finding: "What issue are you experiencing — tripping circuits, flickering lights, or something else?"
- PAT testing: "Roughly how many appliances need testing?"
- Smart home installs: "What type of smart system are you looking for — lighting, sensors, thermostats, or full automation?"

IF CALLER ASKS FOR A HUMAN:
Say: "I can’t transfer the call, but I can take your details and pass them to the LC Squared team immediately."
Then collect details.

LEAD CAPTURE (ALWAYS DO THIS BEFORE ENDING THE CALL):
Collect:
- Full name
- Best phone number
- Address and postcode
- Job type / category
- Description of the problem
- Urgency level (low, medium, high)

Use questions like:
- "What’s your full name?"
- "What’s the best number to reach you on?"
- "What’s the address, including postcode?"
- "Could you describe the job in a sentence or two?"
- "How urgent is this — low, medium, or high?"

Once you have the details, confirm briefly and then internally prepare a JSON-like summary in this shape:

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
"send_to": "info@stripoutlondon.co.uk"}

You do NOT need to read this JSON aloud. It is for the backend to process.

CLOSING:
Always close with:
"Thanks for calling LC Squared Electrical. The team will be in touch shortly. Have a great day."

If you are unsure what the caller said, ask them politely to repeat:
"Let me just clarify — could you repeat that for me, please?"
Avoid saying you are unsure or that you don't know. Always stay calm, polite and helpful.
`;

// 1) Twilio Voice Webhook – returns TwiML with <Connect><Stream>
app.post("/voice", (req, res) => {
  // Load any existing config and override with LC Squared details
  const baseConfig = loadClientConfig();
  const clientConfig = {
    ...baseConfig,
    business_name: "LC Squared Electrical",
    assistant_instructions: assistantInstructions
  };

  const twiml = new Twilio.twiml.VoiceResponse();

twiml.say(
  { voice: "alice", language: clientConfig.language || "en-GB" },
  `Hi, you're through to ${clientConfig.business_name}. This call may be recorded and transcribed for quality and support purposes. Please speak after the tone.`
);

  const connect = twiml.connect();
  connect.stream({
    url: `wss://${process.env.PUBLIC_HOST}/twilio-media-stream`
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
  if (req.url === "/twilio-media-stream") {
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

// 4) Handle Twilio Media Stream connection
wss.on("connection", (twilioWs, request) => {
  logger.info("Twilio Media Stream connected");

  // Load config again here for the AI session (same overrides)
  const baseConfig = loadClientConfig();
  const clientConfig = {
    ...baseConfig,
    business_name: "LC Squared Electrical",
    assistant_instructions: assistantInstructions
  };

  const aiSession = startRealtimeSession(clientConfig);

  // From OpenAI → back to Twilio caller
  aiSession.on("audio", base64Audio => {
    if (!twilioWs.streamSid) {
      // We don't yet know the stream ID; ignore for now
      return;
    }

    const msg = {
      event: "media",
      streamSid: twilioWs.streamSid,
      media: {
        payload: base64Audio
      }
    };

    twilioWs.send(JSON.stringify(msg));
  });

  // From Twilio caller → into OpenAI
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
