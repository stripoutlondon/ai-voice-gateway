// utils/config-loader.js
const path = require("path");
const fs = require("fs");
const logger = require("./logger");

module.exports = function loadClientConfig() {
  try {
    const filePath = path.join(__dirname, "..", "clients", "default.json");
    const raw = fs.readFileSync(filePath, "utf8");
    const cfg = JSON.parse(raw);
    return cfg;
  } catch (err) {
    logger.error("Failed to load client config, using fallback:", err);
    return {
      business_name: "Our Business",
      language: "en-GB"
    };
  }
};