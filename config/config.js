require('dotenv').config();

module.exports = {
  port: process.env.PORT || 3000,
  n8nWebhook: process.env.N8N_WEBHOOK || 'http://localhost:5678/webhook/document',
  maxFileSizeMb: parseInt(process.env.MAX_FILE_SIZE_MB || '20', 10),
  uploadDir: 'uploads',
  logDir: 'logs',
  databaseUrl: process.env.DATABASE_URL
};
