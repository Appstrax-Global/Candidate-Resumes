const { Pool } = require('pg');
const config = require('./config');
const logger = require('../utils/logger');

let pool = null;

if (config.databaseUrl) {
  // If the placeholder hasn't been replaced yet, warn but construct the pool
  const hasPlaceholder = config.databaseUrl.includes('[YOUR-PASSWORD]');
  if (hasPlaceholder) {
    logger.warn('DATABASE_URL contains the default "[YOUR-PASSWORD]" placeholder. Please replace it in the .env file with your actual password.');
  }

  pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: {
      rejectUnauthorized: false // Required for Supabase in many environments
    }
  });

  // Test the pool connection and verify/initialize the schema
  const initDb = async () => {
    try {
      const client = await pool.connect();
      logger.info('Successfully connected to Supabase PostgreSQL database.');
      
      const createTableQuery = `
        CREATE TABLE IF NOT EXISTS extractions (
          id SERIAL PRIMARY KEY,
          candidate_id VARCHAR(50),
          filename VARCHAR(255) NOT NULL,
          pages INTEGER,
          characters INTEGER,
          text TEXT,
          status VARCHAR(50),
          webhook_status VARCHAR(50),
          error_message TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `;
      
      await client.query(createTableQuery);
      
      // Ensure candidate_id and email columns exist if table was created previously without them
      const alterTableQuery = `
        ALTER TABLE extractions ADD COLUMN IF NOT EXISTS candidate_id VARCHAR(50);
        ALTER TABLE extractions ADD COLUMN IF NOT EXISTS email VARCHAR(255);
      `;
      await client.query(alterTableQuery);
      
      logger.info('Database extractions table initialized.');
      client.release();
    } catch (err) {
      logger.error('Failed to initialize Supabase database:', { error: err.message });
    }
  };

  initDb();
} else {
  logger.warn('DATABASE_URL environment variable is missing. Database persistence is disabled.');
}

module.exports = {
  query: (text, params) => {
    if (!pool) {
      logger.warn('Query attempted but database pool is not initialized.');
      return null;
    }
    return pool.query(text, params);
  },
  pool
};
