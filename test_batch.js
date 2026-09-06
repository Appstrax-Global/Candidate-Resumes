const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

async function runTest() {
  const testDir = path.join(__dirname, 'test_files');
  if (!fs.existsSync(testDir)) {
    console.error('test_files directory not found. Please create it and add test documents.');
    return;
  }

  const files = fs.readdirSync(testDir).filter(f => !f.startsWith('.'));
  if (files.length === 0) {
    console.error('No files found in test_files directory.');
    return;
  }

  const form = new FormData();
  for (const file of files) {
    form.append('documents', fs.createReadStream(path.join(testDir, file)));
  }

  console.log(`Sending ${files.length} files to /api/upload...`);

  try {
    const response = await axios.post('http://localhost:3000/api/upload', form, {
      headers: {
        ...form.getHeaders()
      },
      // Do not throw on 207 or 400
      validateStatus: (status) => status < 500 
    });

    const results = response.data.results || [];
    
    // Format for console.table
    const tableData = results.map(r => ({
      Filename: r.filename,
      Type: r.fileType,
      Method: r.extractionMethod,
      Success: r.success ? 'Yes' : 'No',
      Error: r.error || '-'
    }));

    console.table(tableData);
    
    const successCount = results.filter(r => r.success).length;
    console.log(`\nBatch complete! ${successCount}/${results.length} succeeded.`);
    
  } catch (e) {
    console.error('Request failed:', e.message);
  }
}

runTest();
