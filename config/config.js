require('dotenv').config();

module.exports = {
  port: process.env.PORT || 3000,
  n8nWebhook: process.env.N8N_WEBHOOK || 'https://n8n-lnip.srv1936400.hstgr.cloud/webhook/e601a6d1-9dbf-4b9d-b2bb-69c6dec0bd45',
  maxFileSizeMb: parseInt(process.env.MAX_FILE_SIZE_MB || '20', 10),
  uploadDir: 'uploads',
  logDir: 'logs',
  databaseUrl: process.env.DATABASE_URL
};
