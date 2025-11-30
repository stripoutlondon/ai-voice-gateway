// utils/email.js
const nodemailer = require("nodemailer");
const logger = require("./logger");

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: Number(process.env.EMAIL_PORT || 587),
    secure: process.env.EMAIL_SECURE === "true",
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    }
  });

  return transporter;
}

/**
 * Sends a lead email to the client's configured email address.
 */
async function sendLeadEmail(to, lead, businessName) {
  try {
    const transporter = getTransporter();

    const subject = `New Lead for ${businessName}`;
    const messageText = `
A new enquiry has been received:

Name: ${lead.name}
Phone: ${lead.phone}
Address: ${lead.address}
Postcode: ${lead.postcode}
Job Type: ${lead.job_type}
Description: ${lead.description}
Urgency: ${lead.urgency}
Time: ${lead.timestamp}

----------------------------
JSON Payload:
${JSON.stringify(lead, null, 2)}
`;

    await transporter.sendMail({
      from: `"${businessName} AI Reception" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      text: messageText
    });

    logger.info(`Lead email sent to ${to}`);
  } catch (err) {
    logger.error("Error sending lead email:", err);
  }
}

module.exports = { sendLeadEmail };
