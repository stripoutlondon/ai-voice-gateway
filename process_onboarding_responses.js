/*
 * Batch processor for client onboarding responses.
 *
 * This script reads a spreadsheet of onboarding responses and
 * automatically provisions a new Twilio phone number for each
 * unprocessed client.  For each row in the sheet (excluding
 * the header), it builds a client configuration object and
 * calls the onboardClient helper from dynamic_client_onboarding.js.
 *
 * Usage:
 *   node process_onboarding_responses.js <path_to_responses_file>
 *
 * The responses file should be an XLSX spreadsheet downloaded from
 * Google Forms (or the Google Drive API).  The first row must
 * contain the following column headers:
 *   Timestamp, Business Name, Industry, Service Area, Tone,
 *   Email Address, Services Offered, Emergency Keywords, Emergency Enable
 *
 * The script requires the following environment variables to be set:
 *   TWILIO_ACCOUNT_SID  – your Twilio Account SID
 *   TWILIO_AUTH_TOKEN   – your Twilio Auth Token
 *   PUBLIC_HOST         – the base URL of your deployed server
 *
 * It also depends on the 'xlsx' library to parse Excel files
 * and the 'dotenv' library to load environment variables.  Install
 * dependencies by running:
 *   npm install twilio dotenv xlsx
 *
 * Note: This script will not modify the spreadsheet.  It simply
 * writes client configuration files into the `clients` directory.
 */

const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
require('dotenv').config();

const { onboardClient } = require('./dynamic_client_onboarding');

async function processSheet(filePath) {
  // Ensure the file exists
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  // Read the Excel file
  const workbook = xlsx.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  const rows = xlsx.utils.sheet_to_json(worksheet, { defval: '' });

  // Check if there are any responses
  if (rows.length === 0) {
    console.log('No responses found in the spreadsheet.');
    return;
  }

  console.log(`Processing ${rows.length} response(s)...`);

  // Directory to store processed client configs
  const clientsDir = path.join(__dirname, 'clients');
  if (!fs.existsSync(clientsDir)) {
    fs.mkdirSync(clientsDir, { recursive: true });
  }

  for (const row of rows) {
    const businessName = row['Business Name']?.toString().trim();
    if (!businessName) {
      console.warn('Skipping row with missing business name:', row);
      continue;
    }

    // Create a slug from the business name
    const slug = businessName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    const clientFile = path.join(clientsDir, `${slug}.json`);

    // Skip if config already exists
    if (fs.existsSync(clientFile)) {
      console.log(`Config for ${businessName} already exists. Skipping.`);
      continue;
    }

    // Parse boolean for emergency enabled
    const emergencyEnabled = String(row['Emergency Enable']).toLowerCase() === 'yes';

    // Parse comma-separated lists for services and keywords
    const services = row['Services Offered']
      ? row['Services Offered'].split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    const keywords = row['Emergency Keywords']
      ? row['Emergency Keywords'].split(',').map((k) => k.trim()).filter(Boolean)
      : [];

    const clientConfig = {
      business_name: businessName,
      industry: row['Industry']?.toString().trim() || '',
      service_area: row['Service Area']?.toString().trim() || '',
      tone: row['Tone']?.toString().trim().toLowerCase() || 'professional',
      lead_email: row['Email Address']?.toString().trim() || '',
      emergency_enabled: emergencyEnabled,
      emergency_keywords: keywords,
      services: services,
    };

    try {
      const updatedConfig = await onboardClient(clientConfig, {
        pattern: '020', // search for London numbers by default
        country: 'GB',
      });
      console.log(`Successfully onboarded ${businessName}`);
      console.log(`Assigned number: ${updatedConfig.phone_number}`);
    } catch (err) {
      console.error(`Failed to onboard ${businessName}:`, err.message);
    }
  }
}

// Entry point: read the file path from the command line
if (require.main === module) {
  const fileArg = process.argv[2];
  if (!fileArg) {
    console.error('Usage: node process_onboarding_responses.js <path_to_responses_excel>');
    process.exit(1);
  }
  processSheet(fileArg).catch((err) => {
    console.error('Error processing responses:', err);
    process.exit(1);
  });
}