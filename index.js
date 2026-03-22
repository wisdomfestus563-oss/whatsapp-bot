const http = require('http');
const https = require('https');
const fs = require('fs');

const TOKEN = 'y0VAuGb2U7eb3LQs5ps2tNd7t0cMoHZa';
const GROQ_KEY = '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';
const PORT = process.env.PORT || 3000;

const folders = ['saved/deleted', 'saved/edited', 'saved/voice-notes', 'saved/statuses', 'saved/view-once'];
folders.forEach(f => fs.mkdirSync(f, { recursive: true }));

const store = {};
const memory = {};

function getTime() {
  return new Date().toLocaleString('en-NG', { timeZone: 'Africa/Lagos' });
}

function httpsPost(host, path, body, headers) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: host, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({}); } });
    });
    req.on('error', (e) => { console.log('HTTPS error:', e.message); resolve({}); });
    req.write(data);
    req.end();
  });
}

async function send(to, text) {
  console.log('Sending to:', to, '| Message:', text.substring(0, 50));
  const result = await httpsPost('gate.whapi.cloud', '/messages/text', 
    { to, body: text }, 
    { Authorization: `Bearer ${TOKEN}` }
  );
  console.log('Send result:', JSON.stringify(result).substring(0, 100));
}

async function askAI(userId, text) {
  if (!memory[userId]) {
    memory[userId] = [{
      role: 'system',
      content: `You are a savage, witty, intelligent AI assistant living inside WhatsApp. 
      You answer any question, explain things clearly, chat like a human, tell jokes, 
      roast people, write stories, help with school work, give advice, and more. 
      You remember the conversation history. Keep replies concise unless asked to explain deeply.
      Never say you are an AI unless directly asked.`
    }];
  }
  memory[userId].push({ role: 'user', content: text });
  if (memory[userId].length > 21) memory[userId] = [memory[userId][0], ...memory[userId].slice(-20)];
  
  console.log('Calling Groq AI...');
  const res = await httpsPost(
    'api.groq.com', 
    '/openai/v1/chat/completions',
    { model: 'llama-3.3-70b-versatile', messages: memory[userId], max_tokens: 500 },
    { Authorization: `Bearer ${GROQ_KEY}` }
  );
  
  console.log('Groq response:', JSON.stringify(res).substring(0, 200));
  
  if (res.choices && res.choices[0]) {
    const reply = res.choices[0].message.content;
    memory[userId].push({ role: 'assistant', content: reply });
    return reply;
  }
  
  if (res.error) {
    console.log('Groq error:', res.error.message);
    return `Error: ${res.error.message}`;
  }
  
  return 'Something went wrong with the AI.';
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  
  if (req.method === 'GET') { 
    res.end('WhatsApp Bot is alive! 🤖'); 
    return; 
  }

  let body = '';
  req.on('data', c => body += c);
  req.on('end', async () => {
    res.end('ok');
    
    if (!body || body.trim() === '') return;
    
    try {
      const data = JSON.parse(body);
      console.log('Webhook received. Keys:', Object.keys(data));
      
      const msgs = data.messages || [];
      console.log('Messages count:', msgs.length);

      for (const msg of msgs) {
        const from = msg.chat_id || '';
        const isMe = msg.from_me;
        const id = msg.id || '';
        const text = msg.text?.body || '';
        const type = msg.type || '';

        console.log(`MSG - from: ${from} | isMe: ${isMe} | type: ${type} | text: ${text.substring(0, 50)}`);

        if (text) store[id] = { from, text, time: getTime() };

        // Save statuses
        if (from === 'status@broadcast') {
          fs.writeFileSync(`saved/statuses/${Date.now()}_${from.replace(/[^a-z0-9]/gi,'')}.txt`,
            `From: ${from}\nTime: ${getTime()}\nType: ${type}\nText: ${text || '[media]'}`
          );
          console.log('Status saved!');
        }

        // My commands only
        if (isMe && text.startsWith('!')) {
          const cmd = text.trim().toLowerCase();
          console.log('Command received:', cmd);

          if (cmd === '!help') {
            await send(from, `🤖 *Bot Commands:*\n\n🗑️ !deleted\n✏️ !edited\n🎤 !voicenotes\n📊 !statuses\n👁️ !viewonce\n🧹 !clear`);
            continue;
          }
          if (cmd === '!deleted') {
            const files = fs.readdirSync('saved/deleted');
            if (!files.length) { await send(from, '🗑️ No deleted messages saved yet.'); continue; }
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
            if (!files.length) { await send(from, '📊 No statuses saved yet.'); continue; }
            for (const f of files.slice(-5)) await send(from, fs.readFileSync(`saved/statuses/${f}`, 'utf8'));
            continue;
          }
          if (cmd === '!voicenotes') {
            const files = fs.readdirSync('saved/voice-notes');
            if (!files.length) { await send(from, '🎤 No voice notes yet.'); continue; }
            for (const f of files.slice(-3)) await send(from, `🎤 ${fs.readFileSync(`saved/voice-notes/${f}`, 'utf8')}`);
            continue;
          }
          if (cmd === '!clear') {
            memory[from] = null;
            await send(from, '🧹 AI memory cleared!');
            continue;
          }
          continue;
        }

        // AI replies to everyone else
        if (!isMe && text) {
          try {
            const reply = await askAI(from, text);
            await send(from, reply);
          } catch(e) { 
            console.log('AI error:', e.message);
            await send(from, 'Give me a second, something glitched. Try again!');
          }
        }
      }

      // Catch deleted messages
      const events = data.events || [];
      console.log('Events count:', events.length);
      
      for (const ev of events) {
        console.log('Event type:', ev.type);
        
        if (ev.type === 'message.revoked' || ev.type === 'revoke') {
          const msgId = ev.message_id || ev.id;
          const s = store[msgId];
          if (s?.text) {
            fs.writeFileSync(`saved/deleted/${msgId}.txt`,
              `🗑️ Deleted Message\nFrom: ${s.from}\nTime: ${s.time}\nMessage: ${s.text}`
            );
            console.log('Deleted message saved!');
          }
        }
        
        if (ev.type === 'message.edited' || ev.type === 'edited') {
          const msgId = ev.message_id || ev.id;
          const s = store[msgId];
          const newText = ev.text?.body || ev.body || '';
          if (s?.text && newText) {
            fs.writeFileSync(`saved/edited/${msgId}.txt`,
              `✏️ Edited Message\nFrom: ${s.from}\nTime: ${getTime()}\nOriginal: ${s.text}\nEdited to: ${newText}`
            );
            console.log('Edited message saved!');
          }
        }
      }

    } catch(e) { 
      console.log('Webhook error:', e.message);
      console.log('Body was:', body.substring(0, 200));
    }
  });
});

server.listen(PORT, () => console.log(`✅ Bot running on port ${PORT}`));
