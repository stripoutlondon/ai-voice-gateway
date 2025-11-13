// realtime-agent.js
const WebSocket = require("ws");
const logger = require("./utils/logger");

function startRealtimeSession(clientConfig) {
  const model = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview";

  const url = `wss://api.openai.com/v1/realtime?model=${model}`;
  const ws = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1"
    }
  });

  const session = {
    ws,
    _listeners: {},

    on(event, cb) {
      this._listeners[event] = this._listeners[event] || [];
      this._listeners[event].push(cb);
    },

    emit(event, data) {
      (this._listeners[event] || []).forEach(cb => {
        try {
          cb(data);
        } catch (err) {
          logger.error("Listener error:", err);
        }
      });
    },

    sendAudio(base64Audio) {
      // Twilio sends base64 g711_ulaw audio; send straight as input_audio_buffer.append
      ws.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: base64Audio
        })
      );
    },

    endSession() {
      try {
        ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      } catch (e) {
        // ignore
      }
      ws.close();
    }
  };

  ws.on("open", () => {
    logger.info("Connected to OpenAI Realtime");

    const instructions = `
You are a friendly, professional telephone receptionist for ${clientConfig.business_name}.
You are talking to a caller on the phone.
Have a natural conversation. Use short answers. Ask clarifying questions.
Speak British English. Do not mention that you are an AI unless asked.
`;

    const sessionUpdate = {
      type: "session.update",
      session: {
        instructions,
        voice: "alloy",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        modalities: ["audio", "text"],
        turn_detection: {
          type: "server_vad"
        }
      }
    };

    ws.send(JSON.stringify(sessionUpdate));
  });

  ws.on("message", data => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (err) {
      logger.error("Failed to parse Realtime message:", err);
      return;
    }

    // Audio from model back to caller
    if (msg.type === "response.audio.delta" && msg.delta) {
      session.emit("audio", msg.delta); // base64 g711_ulaw
    }
  });

  ws.on("close", () => {
    logger.info("OpenAI Realtime connection closed");
  });

  ws.on("error", err => {
    logger.error("OpenAI Realtime error:", err);
  });

  return session;
}

module.exports = startRealtimeSession;
