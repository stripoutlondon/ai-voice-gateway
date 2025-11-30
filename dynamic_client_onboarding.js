/*
 * Dynamic Client Onboarding
 *
 * This module provides a helper for onboarding new clients into the AI voice
 * receptionist service.  When a new customer signs up, call `onboardClient`
 * with their details.  The function will:
 *   1. Search Twilio for an available UK phone number matching a London area
 *      code (default 020 for central London) or any pattern you choose.
 *   2. Purchase the number and set its voice/webhook URLs to point at your
 *      hosted `PUBLIC_HOST` endpoints for voice (and SMS if needed).
 *   3. Merge the new phone number into the client’s configuration object.
 *   4. Write the completed configuration to a JSON file under the `clients/`
 *      directory.  The filename is derived from the business name to keep
 *      things organised.
 *
 * Note: This script uses the Twilio Node library.  Make sure you install it
 * (npm install twilio) and that your environment has the following
 * variables defined:
 *   TWILIO_ACCOUNT_SID – your master account SID
 *   TWILIO_AUTH_TOKEN  – your auth token
 *   PUBLIC_HOST        – the publicly accessible base hostname of your
 *                        server (for example ai-voice-gateway.onrender.com)
 *
 * Running this script requires Node.js 14+.
 */

const fs = require('fs');
const path = require('path');

/**
 * Provisions a new Twilio number and persists the completed client config.
 *
 * @param {Object} clientConfig
 *   The partial configuration for the new client.  Should include
 *     - business_name (String)
 *     - industry (String)
 *     - service_area (String)
 *     - tone (String)
 *     - lead_email (String)
 *     - emergency_enabled (Boolean)
 *     - emergency_keywords (Array<String>)
 *     - services (Array<String>)
 *     - any other custom flags used by your core logic
 *
 * @param {Object} options
 *   Optional parameters:
 *     - pattern (String) – partial phone number to search for (defaults to
 *                          '020' to find London numbers).  If blank, Twilio
 *                          will return any available number.
 *     - country (String) – two-letter country code (defaults to 'GB').
 * @returns {Promise<Object>} The updated client config with `phone_number` set.
 */
async function onboardClient(clientConfig, options = {}) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const publicHost = process.env.PUBLIC_HOST;

  if (!accountSid || !authToken) {
    throw new Error('Twilio credentials are not set in environment variables');
  }
  if (!publicHost) {
    throw new Error('PUBLIC_HOST must be defined in environment variables');
  }

  const pattern = options.pattern || '020';
  const country = options.country || 'GB';

  // Dynamically import twilio so this file can be included without the
  // dependency during static analysis/testing.  At runtime Node will load
  // twilio from node_modules.
  const twilio = require('twilio');
  const twilioClient = twilio(accountSid, authToken);

  // 1. Search for an available number matching the pattern
  const searchResults = await twilioClient
    .availablePhoneNumbers(country)
    .local.list({
      contains: pattern,
      limit: 1,
    });

  if (!searchResults || searchResults.length === 0) {
    throw new Error(`No phone numbers available matching pattern: ${pattern}`);
  }
  const candidate = searchResults[0].phoneNumber;

  // 2. Purchase (provision) the number and set the voice webhook
const purchased = await twilioClient.incomingPhoneNumbers.create({
  phoneNumber: candidate,
  addressSid: process.env.TWILIO_ADDRESS_SID,
  bundleSid: process.env.TWILIO_BUNDLE_SID,
  voiceUrl: `https://${publicHost}/voice`,
  smsUrl: `https://${publicHost}/sms`,
});


  // 3. Add the phone number to the client config
  const updatedConfig = {
    ...clientConfig,
    phone_number: purchased.phoneNumber,
  };

  // 4. Persist the config to clients folder
  const slug = clientConfig.business_name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const clientsDir = path.join(__dirname, 'clients');
  if (!fs.existsSync(clientsDir)) {
    fs.mkdirSync(clientsDir, { recursive: true });
  }
  const filePath = path.join(clientsDir, `${slug}.json`);
  fs.writeFileSync(filePath, JSON.stringify(updatedConfig, null, 2));

  console.log(`Client onboarded: ${updatedConfig.business_name}`);
  console.log(`Assigned phone number: ${updatedConfig.phone_number}`);
  console.log(`Saved configuration to: ${filePath}`);

  return updatedConfig;
}

module.exports = { onboardClient };