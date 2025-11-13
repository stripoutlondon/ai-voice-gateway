// utils/logger.js
module.exports = {
  info: (...msg) => console.log("[INFO]", ...msg),
  warn: (...msg) => console.log("[WARN]", ...msg),
  error: (...msg) => console.error("[ERROR]", ...msg)
};