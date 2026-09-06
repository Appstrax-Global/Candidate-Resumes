const fs = require('fs');

/**
 * Detects the file type using magic numbers (file signature headers)
 * @param {string} filePath - Absolute path to the file
 * @returns {Promise<{ext: string, mime: string} | null>} - The detected file type or null if unsupported
 */
async function detectFileType(filePath) {
  return new Promise((resolve) => {
    const buffer = Buffer.alloc(4);
    fs.open(filePath, 'r', (err, fd) => {
      if (err) {
        return resolve(null);
      }

      fs.read(fd, buffer, 0, 4, 0, (readErr, bytesRead) => {
        fs.close(fd, () => {});
        if (readErr || bytesRead < 4) {
          return resolve(null);
        }

        // PDF Signature: 25 50 44 46 (%PDF)
        if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
          return resolve({ ext: 'pdf', mime: 'application/pdf' });
        }

        // ZIP/Office Open XML Signature: 50 4b 03 04 (PK..)
        if (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) {
          return resolve({ ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
        }

        // Legacy binary .doc (OLE CFB) Signature: D0 CF 11 E0
        if (buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0) {
          return resolve({ ext: 'doc', mime: 'application/msword' });
        }

        // Return null if signature does not match PDF, DOCX, or DOC
        return resolve(null);
      });
    });
  });
}

module.exports = {
  detectFileType
};
