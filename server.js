const express = require('express');
const cors = require('cors');
const path = require('path');
const config = require('./config/config');
const apiRoutes = require('./routes/api');
const errorMiddleware = require('./middleware/errorMiddleware');
const logger = require('./utils/logger');

const app = express();

// Standard middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
app.use('/api', apiRoutes);

// Global Error Handler
app.use(errorMiddleware);

const { testPdfjsFallback } = require('./services/extractionService');

// Start server
app.listen(config.port, async () => {
  logger.info(`Server is running in production mode on http://localhost:${config.port}`);
  
  // Run pdfjs-dist fallback self-test on boot
  await testPdfjsFallback();
});
