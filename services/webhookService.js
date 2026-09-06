const axios = require('axios');
const config = require('../config/config');
const logger = require('../utils/logger');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sends payload to n8n webhook with up to 3 retries on failure
 * @param {object} payload - The data to send to the webhook
 * @returns {Promise<boolean>} - Success or failure of the delivery
 */
async function sendWebhook(payload) {
  const maxRetries = 3;
  let attempt = 0;
  let delay = 1000; // start with 1 second delay

  while (attempt < maxRetries) {
    attempt++;
    try {
      logger.info(`Sending payload to webhook: ${config.n8nWebhook} (Attempt ${attempt}/${maxRetries})`);
      const response = await axios.post(config.n8nWebhook, payload, {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 10000 // 10s timeout
      });

      logger.info(`Webhook successfully delivered on attempt ${attempt}. Status: ${response.status}`);
      return true;
    } catch (error) {
      logger.error(`Webhook delivery failed on attempt ${attempt}: ${error.message}`);
      if (attempt < maxRetries) {
        logger.info(`Retrying in ${delay}ms...`);
        await sleep(delay);
        delay *= 2; // exponential backoff
      }
    }
  }

  logger.error(`All webhook delivery attempts failed.`);
  return false;
}

module.exports = {
  sendWebhook
};
