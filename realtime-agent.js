// realtime-agent.js
const WebSocket = require("ws");
const logger = require("./utils/logger");

function startRealtimeSession(clientConfig) {
  const model = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview";

  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
    model
  )}`;

  const ws = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  const session = {
    ws,
    _listeners: {},
    _isOpen: false,
    _pendingAudio: [],
    _responseInProgress: false, // avoid spamming response.create

    on(event, cb) {
      this._listeners[event] = this._listeners[event] || [];
      this._listeners[event].push(cb);
    },

    emit(event, data) {
      (this._listeners[event] || []).forEach((cb) => {
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

      // Append caller audio
      ws.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: base64Audio,
        })
      );

      // Ask the model to respond, but only if we aren't already waiting
      if (!this._responseInProgress) {
        ws.send(
          JSON.stringify({
            type: "response.create",
            response: {
              // instructions/tools are already set in session.update
            },
          })
        );
        this._responseInProgress = true;
      }
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
    },
  };

  ws.on("open", () => {
    logger.info("Connected to OpenAI Realtime");
    session._isOpen = true;

    const instructions =
      clientConfig.assistant_instructions ||
      `
You are a friendly, professional telephone receptionist for ${
        clientConfig.business_name || "our client"
      }.
You are talking to a caller on the phone.
Have a natural conversation. Use short, clear answers.
Ask follow-up questions when needed.
Speak British English. Do not say you are an AI unless asked.
`;

    const sessionUpdate = {
      type: "session.update",
      session: {
        instructions,
        voice: clientConfig.voice || "alloy",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        modalities: ["audio", "text"],
        turn_detection: {
          type: "server_vad",
          silence_duration_ms: 2000,
          prefix_padding_ms: 400,
        },

        // 🚀 enable tools
        tools: [
          {
            type: "function",
            name: "capture_lead",
            description:
              "Capture a fully qualified service lead from the caller.",
            parameters: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  description: "Caller full name",
                },
                phone: {
                  type: "string",
                  description: "Best contact phone number",
                },
                email: {
                  type: "string",
                  description: "Email address if provided",
                },
                address: {
                  type: "string",
                  description: "Full address including street, town, etc.",
                },
                postcode: {
                  type: "string",
                  description: "UK postcode",
                },
                job_type: {
                  type: "string",
                  description:
                    "Short job type/category, e.g. 'consumer unit upgrade'",
                },
                description: {
                  type: "string",
                  description:
                    "Detailed description of the issue or work requested",
                },
                urgency: {
                  type: "string",
                  enum: ["low", "medium", "high"],
                  description:
                    "How urgent the job is from the caller’s perspective",
                },
                company: {
                  type: "string",
                  description: "Company name for commercial callers",
                },
                how_found: {
                  type: "string",
                  description:
                    "How the caller found the business (Google, referral, etc.)",
                },
              },
              required: ["name", "phone", "address", "postcode", "description"],
            },
          },
        ],
        tool_choice: "auto", // <- explicitly allow tool use
      },
    };

    ws.send(JSON.stringify(sessionUpdate));

    // Flush any buffered audio now that the WS is open
    if (session._pendingAudio.length > 0) {
      logger.info(
        `Flushing ${session._pendingAudio.length} buffered audio chunks`
      );
      session._pendingAudio.forEach((audio) => {
        ws.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio,
          })
        );
      });
      session._pendingAudio = [];
    }
  });

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (err) {
      logger.error("Failed to parse Realtime message:", err);
      return;
    }

    // TEMP DEBUG: see what kinds of responses we're getting
    if (msg.type && msg.type.startsWith("response.")) {
      logger.info(
        "[Realtime] Event:",
        msg.type,
        JSON.stringify(msg).slice(0, 500) // keep log sane
      );
    }

    // Reset flag when a response finishes or errors
    if (msg.type === "response.completed" || msg.type === "response.error") {
      session._responseInProgress = false;
    }

    // Log any error messages from OpenAI so we can debug config issues
    if (msg.type === "error" || msg.type === "response.error") {
      logger.error("OpenAI Realtime error message:", msg);
    }

    // 🎧 Audio from model back to caller
    if (msg.type === "response.output_audio.delta" && msg.audio) {
      session.emit("audio", msg.audio); // base64 g711_ulaw
    }

    // Older / alternative shape: "response.audio.delta" with "delta"
    if (msg.type === "response.audio.delta" && msg.delta) {
      session.emit("audio", msg.delta); // base64 g711_ulaw
    }

    // 🧠 Tool / function calls (lead capture)
    if (
      msg.type === "response.output_item.added" &&
      msg.item &&
      msg.item.type === "function_call"
    ) {
      const fc = msg.item;

      if (fc.name === "capture_lead" && fc.arguments) {
        try {
          const lead = JSON.parse(fc.arguments);
          logger.info("[AI] capture_lead tool called:", lead);
          session.emit("lead", lead);
        } catch (err) {
          logger.error(
            "Failed to parse capture_lead arguments:",
            err,
            fc.arguments
          );
        }
      }
    }
  });

  ws.on("close", () => {
    logger.info("OpenAI Realtime connection closed");
    session._isOpen = false;
  });

  ws.on("error", (err) => {
    logger.error("OpenAI Realtime error:", err);
  });

  return session;
}

module.exports = startRealtimeSession;


