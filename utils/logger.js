const fs = require('fs');
const path = require('path');
const config = require('../config/config');

const logDir = path.resolve(__dirname, '..', config.logDir);

if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const logFilePath = path.join(logDir, 'app.log');

function formatMessage(level, message, meta = '') {
  const timestamp = new Date().toISOString();
  const metaString = meta ? ` ${JSON.stringify(meta)}` : '';
  return `[${timestamp}] [${level.toUpperCase()}] ${message}${metaString}`;
}

function writeToFile(line) {
  fs.appendFile(logFilePath, line + '\n', (err) => {
    if (err) {
      console.error('Failed to write to log file:', err);
    }
  });
}

const logger = {
  info: (message, meta) => {
    const formatted = formatMessage('info', message, meta);
    console.log(formatted);
    writeToFile(formatted);
  },
  error: (message, meta) => {
    const formatted = formatMessage('error', message, meta);
    console.error(formatted);
    writeToFile(formatted);
  },
  warn: (message, meta) => {
    const formatted = formatMessage('warn', message, meta);
    console.warn(formatted);
    writeToFile(formatted);
  },
  debug: (message, meta) => {
    const formatted = formatMessage('debug', message, meta);
    console.debug(formatted);
    writeToFile(formatted);
  }
};

module.exports = logger;
