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

// --------------------------------------
// ZAPIER LEAD SENDER
// --------------------------------------
async function sendLeadToZapier(lead) {
  const url = process.env.ZAPIER_DEFAULT_LEAD_WEBHOOK;
  if (!url) {
    console.error("[ZAPIER] Missing ZAPIER_DEFAULT_LEAD_WEBHOOK env var");
    return;
  }

  console.log("[ZAPIER] Sending lead to Zapier:", JSON.stringify(lead, null, 2));

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(lead),
  });

  const text = await res.text();
  console.log("[ZAPIER] Response status:", res.status, "body:", text);
}
// --------------------------------------
// END ZAPIER LEAD SENDER
// --------------------------------------


// === Build assistant instructions per client ===
function buildAssistantInstructions(clientConfig) {
  const businessName = clientConfig.business_name || "our client";
  const industry = clientConfig.industry || "service business";
  const leadEmail =
    (clientConfig.lead_email && String(clientConfig.lead_email)) ||
    "info@stripoutlondon.co.uk";

  const tone = (clientConfig.tone || "professional").toLowerCase();

  let toneLine;
  switch (tone) {
    case "friendly":
      toneLine =
        "Tone: friendly, conversational, warm, British English. Sound like a helpful human receptionist, not a robot. Keep answers clear and natural.";
      break;
    case "formal":
      toneLine =
        "Tone: very formal, precise, British English. Use polite, professional language at all times. Keep answers clear and concise.";
      break;
    case "casual":
      toneLine =
        "Tone: relaxed, approachable, British English. Still stay professional, but you can sound more informal and chatty.";
      break;
    default:
      toneLine =
        "Tone: professional, calm, British English, helpful. Keep answers concise and clear.";
      break;
  }

  const services = Array.isArray(clientConfig.services)
    ? clientConfig.services
    : [];

  const servicesSection =
    services.length > 0
      ? services.map((s) => `- ${s}`).join("\n")
      : `- Installations
- Repairs
- Maintenance
- Fault finding
- Emergency callouts
- Other related ${industry} work`;

  const emergencyEnabled =
    typeof clientConfig.emergency_enabled === "boolean"
      ? clientConfig.emergency_enabled
      : true;

  const emergencyKeywords = Array.isArray(clientConfig.emergency_keywords)
    ? clientConfig.emergency_keywords
    : [
        "urgent",
        "emergency",
        "no power",
        "no heating",
        "no hot water",
        "gas smell",
        "burning",
        "smoke",
        "sparking",
        "dangerous",
        "fire",
        "leak",
        "burst",
        "flood",
        "locked out",
      ];

  const emergencyTriggerLine = emergencyEnabled
    ? `Treat the situation as HIGH URGENCY if the caller mentions words like: ${emergencyKeywords.join(
        ", "
      )} or anything clearly dangerous or time-critical.`
    : `Even if the caller mentions something dangerous (for example: ${emergencyKeywords.join(
        ", "
      )}), you may not promise emergency attendance or specific response times. Still treat it as high urgency for the team to review.`;

  return `
You are an AI phone receptionist for ${businessName}, a UK-based business in the ${industry} sector. Your job is to answer calls, understand what the caller needs, collect all key details, and turn each call into a clear, structured lead for the ${businessName} team.

CORE GOALS:
1) Make the caller feel heard and supported.
2) Quickly understand why they are calling.
3) Collect all essential contact and job details.
4) Assess urgency (normal vs urgent/emergency).
5) Move the caller towards a clear outcome: a lead, a booking request, or a promised callback.
6) NEVER guess prices, availability, or technical answers.
7) Keep the call efficient, polite, and professional.

${toneLine}

GENERAL BEHAVIOUR:
- Begin speaking as soon as the caller finishes their first sentence.
- Do NOT interrupt the caller. Let them finish each sentence.
- When they give phone number, address, email or postcode, NEVER interrupt, even if they pause.
- Never cut yourself off mid-sentence. Finish speaking fully before listening again.
- Keep answers short and focused. No rambling or waffle.
- Use simple, clear British English.

CALL RECORDING NOTICE (MUST ALWAYS SAY THIS FIRST):
"This call may be recorded and transcribed for quality and support purposes.
Hello, you’ve reached ${businessName}. How can I help you today?"

UNIVERSAL CALL FLOW:

1) IDENTIFY THE REASON FOR THE CALL
- Listen to the caller’s first explanation.
- Determine if this is:
  - a new job / quote request
  - an emergency / very urgent issue
  - a follow-up on an existing job
  - a general question about services
  - a request to speak to a specific person

If they describe something within ${industry}, reply:
"Sure, I can help with that."

If they ask to speak to someone specific:
"I can’t transfer the call, but I can take your details and pass them to the ${businessName} team immediately."

2) SERVICE CATEGORIES (ADAPT NATURALLY):
You typically handle:
${servicesSection}

Do NOT list all of these unless needed. Just confirm you can help and move into questions.

3) EMERGENCY / HIGH URGENCY LOGIC:
${emergencyTriggerLine}

If the situation seems urgent or dangerous, say:
"Okay, I understand this might be urgent. Let me take a few details so someone can get back to you quickly."

Then ask:
1) "What’s the full address, including postcode?"
2) "What exactly is happening right now?"
3) "Is anyone at the property at the moment?"

Then continue the normal lead capture questions below.

4) LEAD CAPTURE (MUST ALWAYS COMPLETE THIS FOR ANY POTENTIAL JOB):

You must NOT end the call until you have successfully collected:
- full name
- phone number
- full address including postcode
- job type or service needed
- detailed description of the issue or request
- urgency level (low, medium, high)
- optional: company name (for commercial callers)
- optional: how they found ${businessName}

Ask clearly, one at a time:

1) "What’s your full name?"
2) "What’s the best phone number to reach you on?"
3) "What’s the full address, including postcode?"
4) "Is this for a house, flat, office, shop, or another type of property?"
5) "Could you describe the job in a sentence or two?"
6) "How urgent is this — low, medium, or high?"

If they give incomplete answers, politely ask again:
"Just so the team can help properly, could you please confirm …"

5) STRUCTURED SUMMARY (INTERNAL, NOT READ ALOUD):

Once you have all details, internally form a JSON-like object for the backend:

{"lead": {
  "business_name": "${businessName}",
  "industry": "${industry}",
  "name": "<FULL_NAME>",
  "phone": "<PHONE>",
  "email": "<EMAIL_IF_GIVEN>",
  "address": "<FULL_ADDRESS>",
  "postcode": "<POSTCODE>",
  "job_type": "<SHORT_JOB_TYPE_OR_CATEGORY>",
  "description": "<DETAILED_DESCRIPTION>",
  "urgency": "<LOW|MEDIUM|HIGH>",
  "source": "AI Receptionist Phone",
  "timestamp": "<TIMESTAMP>"
},
"send_to": "${leadEmail}"}

You do NOT need to say this JSON aloud; it is for the system to process.

Once you have collected all required lead details, you MUST call the tool named "capture_lead" exactly once with all the fields filled where possible.

6) BOOKINGS AND PREFERRED TIMES:
If the caller wants to book a visit or appointment:
- Ask for preferred days/times.
- Do NOT promise exact slots or attendance.
Say:
"The team will confirm the exact time with you shortly."

7) CLOSING THE CALL:
Once all details are captured, say:

"Perfect, I’ve got everything I need. I’ll pass this to the ${businessName} team now. They’ll be in touch with you shortly.
Thanks for calling ${businessName}, and have a great day."

Only then allow the call to end.

8) IF YOU ARE UNSURE:
If you don’t know something or it’s outside scope, say:
"I don’t want to give you incorrect information. Let me take your details and the team will confirm the exact answer for you."

Never say you are confused, limited, or an AI model. Always remain calm, polite, and helpful.
`;
}


// 1) Twilio Voice Webhook – multi-client: choose config based on dialled number
app.post("/voice", (req, res) => {
  // Twilio "To" or "Called" number (E.164, e.g. +4420...)
  const dialledNumber = req.body.To || req.body.Called || null;

  const baseConfig = loadClientConfig(dialledNumber);
  const clientConfig = {
    ...baseConfig,
    assistant_instructions: buildAssistantInstructions(baseConfig),
  };

  const twiml = new Twilio.twiml.VoiceResponse();

  // Short UK-ish greeting so caller isn't in silence
  twiml.say(
    { voice: "alice", language: clientConfig.language || "en-GB" },
    `Hi, you're through to ${
      clientConfig.business_name || "our team"
    }. Please speak after the tone.`
  );

  const connect = twiml.connect();
  // Pass the dialled number into the stream URL so we can re-load the same client config
  const publicHost = process.env.PUBLIC_HOST;
  connect.stream({
    url: `wss://${publicHost}/twilio-media-stream?to=${encodeURIComponent(
      dialledNumber || ""
    )}`,
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
    wss.handleUpgrade(req, socket, head, (ws) => {
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
    assistant_instructions: buildAssistantInstructions(baseConfig),
  };

  const aiSession = startRealtimeSession(clientConfig);

  // 🔊 Audio from AI → Twilio caller
  aiSession.on("audio", (base64Audio) => {
    if (!twilioWs.streamSid) return;

    twilioWs.send(
      JSON.stringify({
        event: "media",
        streamSid: twilioWs.streamSid,
        media: { payload: base64Audio },
      })
    );
  });

  // 🆕 Lead event from AI session (make sure realtime-agent.js emits "lead")
  aiSession.on("lead", async (lead) => {
    try {
      logger.info("[LEAD] Captured lead from AI session:", lead);

      const payload = {
        ...lead,
        business_name: clientConfig.business_name,
        industry: clientConfig.industry,
        source: "AI Receptionist Phone",
      };

      await sendLeadToZapier(payload);
    } catch (err) {
      logger.error("Error sending lead to Zapier:", err);
    }
  });

  // 🎧 Audio from caller → AI
  twilioWs.on("message", (raw) => {
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

  twilioWs.on("error", (err) => {
    logger.error("Twilio WebSocket error:", err);
    aiSession.endSession();
  });
});
