const fs = require('fs');
let code = fs.readFileSync('index.js', 'utf8');
code = code.replace(
  "let body = '';\n  req.on('data', c => body += c);\n  req.on('end', async () => {\n    res.end('ok');\n    try {\n      const data = JSON.parse(body);",
  "let body = '';\n  req.on('data', c => body += c);\n  req.on('end', async () => {\n    res.end('ok');\n    if (!body || body.trim() === '') return;\n    try {\n      const data = JSON.parse(body);"
);
fs.writeFileSync('index.js', code);
console.log('Fixed!');
