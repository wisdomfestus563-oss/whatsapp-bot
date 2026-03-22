const http = require('http');
const https = require('https');
const fs = require('fs');

const TOKEN = 'y0VAuGb2U7eb3LQs5ps2tNd7t0cMoHZa';
const GROQ_KEY = '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';
const MY_NUMBER = '2348153024304@s.whatsapp.net';

const folders = ['saved/deleted', 'saved/edited', 'saved/voice-notes', 'saved/statuses', 'saved/view-once'];
folders.forEach(f => fs.mkdirSync(f, { recursive: true }));

const store = {};
const memory = {};

function getTime() {
  return new Date().toLocaleString('en-NG', { timeZone: 'Africa/Lagos' });
}

function post(host, path, body, headers) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = https.request({ hostname: host, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({}); } });
    });
    req.on('error', () => resolve({}));
    req.write(data);
    req.end();
  });
}

async function send(to, text) {
  await post('gate.whapi.cloud', '/messages/text', { to, body: text }, { Authorization: `Bearer ${TOKEN}` });
}

async function askAI(userId, text) {
  if (!memory[userId]) memory[userId] = [{ role: 'system', content: 'You are a witty, intelligent WhatsApp AI. Answer anything, chat like a human, keep replies concise.' }];
  memory[userId].push({ role: 'user', content: text });
  if (memory[userId].length > 21) memory[userId] = [memory[userId][0], ...memory[userId].slice(-20)];
  const res = await post('api.groq.com', '/openai/v1/chat/completions', { model: 'llama3-8b-8192', messages: memory[userId] }, { Authorization: `Bearer ${GROQ_KEY}` });
  const reply = res?.choices?.[0]?.message?.content || 'I had a brain glitch, try again.';
  memory[userId].push({ role: 'assistant', content: reply });
  return reply;
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });

  if (req.method === 'GET') { res.end('Bot is alive!'); return; }

  let body = '';
  req.on('data', c => body += c);
  req.on('end', async () => {
    res.end('ok');
    try {
      const data = JSON.parse(body);
      const msgs = data.messages || [];

      for (const msg of msgs) {
        const from = msg.chat_id || '';
        const isMe = msg.from_me;
        const id = msg.id || '';
        const text = msg.text?.body || '';
        const type = msg.type || '';

        if (text) store[id] = { from, text, time: getTime() };

        if (from === 'status@broadcast') {
          fs.writeFileSync(`saved/statuses/${Date.now()}.txt`, `From: ${from}\nTime: ${getTime()}\n${text || '[media]'}`);
        }

        if (isMe && text.startsWith('!')) {
          const cmd = text.trim().toLowerCase();
          if (cmd === '!help') { await send(from, '🤖 Commands:\n\n!deleted\n!edited\n!voicenotes\n!statuses\n!viewonce'); continue; }
          if (cmd === '!deleted') {
            const files = fs.readdirSync('saved/deleted');
            if (!files.length) { await send(from, '🗑️ No deleted messages yet.'); continue; }
            for (const f of files.slice(-5)) await send(from, fs.readFileSync(`saved/deleted/${f}`, 'utf8'));
            continue;
          }
          if (cmd === '!edited') {
            const files = fs.readdirSync('saved/edited');
            if (!files.length) { await send(from, '✏️ No edited messages yet.'); continue; }
            for (const f of files.slice(-5)) await send(from, fs.readFileSync(`saved/edited/${f}`, 'utf8'));
            continue;
          }
          if (cmd === '!statuses') {
            const files = fs.readdirSync('saved/statuses');
            if (!files.length) { await send(from, '📊 No statuses yet.'); continue; }
            for (const f of files.slice(-5)) await send(from, fs.readFileSync(`saved/statuses/${f}`, 'utf8'));
            continue;
          }
          if (cmd === '!voicenotes') { await send(from, '🎤 Voice note retrieval coming soon.'); continue; }
          if (cmd === '!viewonce') { await send(from, '👁️ View-once retrieval coming soon.'); continue; }
          continue;
        }

        if (!isMe && text) {
          try { const reply = await askAI(from, text); await send(from, reply); } catch(e) { console.log('AI error:', e.message); }
        }
      }

      for (const ev of (data.events || [])) {
        if (ev.type === 'message.revoked') {
          const s = store[ev.message_id];
          if (s?.text) fs.writeFileSync(`saved/deleted/${ev.message_id}.txt`, `🗑️ Deleted\nFrom: ${s.from}\nTime: ${s.time}\nMessage: ${s.text}`);
        }
        if (ev.type === 'message.edited') {
          const s = store[ev.message_id];
          const newText = ev.text?.body || '';
          if (s?.text && newText) fs.writeFileSync(`saved/edited/${ev.message_id}.txt`, `✏️ Edited\nFrom: ${s.from}\nTime: ${getTime()}\nOriginal: ${s.text}\nEdited: ${newText}`);
        }
      }
    } catch(e) { console.log('Error:', e.message); }
  });
});

server.listen(3002, () => console.log('✅ Bot running on port 3002'));
