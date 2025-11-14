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
    _isOpen: false,
    _pendingAudio: [],

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
      // If the Realtime WS isn't open yet, buffer the audio
      if (!this._isOpen || ws.readyState !== WebSocket.OPEN) {
        this._pendingAudio.push(base64Audio);
        return;
      }

      ws.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: base64Audio
        })
      );
    },

    endSession() {
      try {
        if (this._isOpen && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        }
      } catch (e) {
        // ignore
      }
      ws.close();
    }
  };

  ws.on("open", () => {
    logger.info("Connected to OpenAI Realtime");
    session._isOpen = true;

    // Use the detailed assistant instructions from clientConfig if provided,
    // otherwise fall back to a simple generic prompt.
    const instructions =
      clientConfig.assistant_instructions ||
      `
You are a friendly, professional telephone receptionist for ${clientConfig.business_name || "our client"}.
You are talking to a caller on the phone.
Have a natural conversation. Use short, clear answers.
Ask follow-up questions when needed.
Speak British English. Do not say you are an AI unless asked.
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
  type: "server_vad",
  // Wait a bit longer before cutting the user off
  silence_duration_ms: 1200,   // 1.2 seconds of silence before ending your turn
  prefix_padding_ms: 300       // include a bit of audio before speech starts
}
      }
    };

    ws.send(JSON.stringify(sessionUpdate));

    // Flush any buffered audio now that the WS is open
    if (session._pendingAudio.length > 0) {
      logger.info(`Flushing ${session._pendingAudio.length} buffered audio chunks`);
      session._pendingAudio.forEach(audio => {
        ws.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio
          })
        );
      });
      session._pendingAudio = [];
    }
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
    session._isOpen = false;
  });

  ws.on("error", err => {
    logger.error("OpenAI Realtime error:", err);
  });

  return session;
}

module.exports = startRealtimeSession;
