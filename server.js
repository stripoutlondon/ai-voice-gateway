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

// 1) Twilio Voice Webhook – returns TwiML with <Connect><Stream>
app.post("/voice", (req, res) => {
  const clientConfig = loadClientConfig();

  const twiml = new Twilio.twiml.VoiceResponse();

  twiml.say(
    { voice: "alice", language: clientConfig.language || "en-GB" },
    `Hi, you're through to ${clientConfig.business_name}. Please speak after the tone.`
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

  const clientConfig = loadClientConfig();
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
