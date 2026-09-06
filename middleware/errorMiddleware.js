const multer = require('multer');
const logger = require('../utils/logger');

function errorMiddleware(err, req, res, next) {
  logger.error('Error occurred in request:', {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method
  });

  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        success: false,
        error: 'File size limit exceeded. Max size allowed is 20MB.'
      });
    }
    return res.status(400).json({
      success: false,
      error: `Upload error: ${err.message}`
    });
  }

  const statusCode = err.status || 500;
  res.status(statusCode).json({
    success: false,
    error: err.message || 'Internal Server Error'
  });
}

module.exports = errorMiddleware;
