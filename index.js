const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { MongoClient } = require('mongodb');
const fs = require('fs');
const https = require('https');
const http = require('http');
const pino = require('pino');

const GROQ_KEY = process.env.GROQ_KEY;
const MONGODB_URI = process.env.MONGODB_URI;
const PORT = process.env.PORT || 3000;

['saved/deleted','saved/edited','saved/statuses','saved/voice-notes','saved/media','auth'].forEach(function(f){
  fs.mkdirSync(f, { recursive: true });
});

const memory = {};
const store = {};
let sock, lastQR = '', db, sessionsCol;

async function connectDB(){
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db('wisebot');
    sessionsCol = db.collection('sessions');
    console.log('MongoDB connected!');
  } catch(e){ console.log('DB error: ' + e.message); }
}

async function saveSession(){
  if (!sessionsCol || !fs.existsSync('auth')) return;
  try {
    for (const file of fs.readdirSync('auth')){
      await sessionsCol.updateOne(
        { _id: 'file_' + file },
        { $set: { data: fs.readFileSync('auth/' + file, 'utf8') } },
        { upsert: true }
      );
    }
  } catch(e){}
}

async function loadSession(){
  if (!sessionsCol) return;
  try {
    const docs = await sessionsCol.find({ _id: { $regex: '^file_' } }).toArray();
    if (!docs.length) return;
    if (!fs.existsSync('auth')) fs.mkdirSync('auth');
    for (const doc of docs){
      fs.writeFileSync('auth/' + doc._id.replace('file_', ''), doc.data);
    }
    console.log('Session loaded!');
  } catch(e){}
}

function getTime(){ return new Date().toLocaleString('en-NG', { timeZone: 'Africa/Lagos' }); }

function httpsPost(host, path, body, headers){
  return new Promise(function(resolve){
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: host, path: path, method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers)
    }, function(res){
      let d = '';
      res.on('data', function(c){ d += c; });
      res.on('end', function(){ try { resolve(JSON.parse(d)); } catch(e){ resolve({}); } });
    });
    req.on('error', function(){ resolve({}); });
    req.write(data);
    req.end();
  });
}

async function send(jid, text){
  try { await sock.sendMessage(jid, { text: String(text) }); }
  catch(e){ console.log('Send error: ' + e.message); }
}

async function askAI(userId, text){
  if (!memory[userId]) memory[userId] = [{
    role: 'system',
    content: 'You are Wise Bot, a savage witty intelligent AI inside WhatsApp. You answer anything, match the energy of whoever texts you, speak naturally like a human. Never admit you are AI unless directly asked. Be concise unless asked to go deep.'
  }];

  memory[userId].push({ role: 'user', content: text });
  if (memory[userId].length > 21) memory[userId] = [memory[userId][0]].concat(memory[userId].slice(-20));

  const res = await httpsPost('api.groq.com', '/openai/v1/chat/completions',
    { model: 'llama-3.3-70b-versatile', messages: memory[userId], max_tokens: 700 },
    { Authorization: 'Bearer ' + GROQ_KEY }
  );

  if (res.choices && res.choices[0]){
    const reply = res.choices[0].message.content;
    memory[userId].push({ role: 'assistant', content: reply });
    return reply;
  }
  return 'Something glitched. Try again!';
}

async function transcribeVoice(buffer){
  try {
    const boundary = '----WiseBot' + Date.now();
    const start = Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-large-v3\r\n--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="audio.ogg"\r\nContent-Type: audio/ogg\r\n\r\n');
    const end = Buffer.from('\r\n--' + boundary + '--\r\n');
    const body = Buffer.concat([start, buffer, end]);
    return new Promise(function(resolve){
      const req = https.request({
        hostname: 'api.groq.com', path: '/openai/v1/audio/transcriptions', method: 'POST',
        headers: { 'Authorization': 'Bearer ' + GROQ_KEY, 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length }
      }, function(res){
        let d = '';
        res.on('data', function(c){ d += c; });
        res.on('end', function(){ try { resolve(JSON.parse(d).text || '[Could not transcribe]'); } catch(e){ resolve('[Failed]'); } });
      });
      req.on('error', function(){ resolve('[Error]'); });
      req.write(body);
      req.end();
    });
  } catch(e){ return '[Failed]'; }
}

async function start(){
  await connectDB();
  await loadSession();

  const { state, saveCreds } = await useMultiFileAuthState('auth');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version: version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Wise Bot', 'Chrome', '1.0.0'],
    syncFullHistory: false
  });

  sock.ev.on('creds.update', async function(){
    await saveCreds();
    await saveSession();
  });

  sock.ev.on('connection.update', async function(update){
    if (update.qr){
      lastQR = update.qr;
      console.log('QR ready! Visit /qr to scan');
    }
    if (update.connection === 'open'){
      console.log('WISE BOT IS LIVE!');
      const myJid = sock.user && sock.user.id;
      if (myJid) await send(myJid, 'Wise Bot is online! Type !help for commands.');
    }
    if (update.connection === 'close'){
      const code = update.lastDisconnect && update.lastDisconnect.error && update.lastDisconnect.error.output && update.lastDisconnect.error.output.statusCode;
      if (code !== DisconnectReason.loggedOut){
        console.log('Reconnecting...');
        setTimeout(start, 5000);
      }
    }
  });

  sock.ev.on('messages.upsert', async function(upsert){
    if (upsert.type !== 'notify') return;

    for (const msg of upsert.messages){
      try {
        const jid = msg.key.remoteJid;
        const isMe = msg.key.fromMe;
        const isGroup = jid && jid.endsWith('@g.us');
        const isStatus = jid === 'status@broadcast';
        const msgId = msg.key.id;
        const myJidClean = sock.user && sock.user.id && sock.user.id.split(':')[0];
        const myJid = myJidClean + '@s.whatsapp.net';
        const senderJid = isGroup ? (msg.key.participant || jid) : jid;
        const senderName = msg.pushName || senderJid.split('@')[0];

        const content = msg.message;
        if (!content) continue;

        const msgType = Object.keys(content)[0];
        const text = content.conversation ||
          (content.extendedTextMessage && content.extendedTextMessage.text) ||
          (content.imageMessage && content.imageMessage.caption) ||
          (content.videoMessage && content.videoMessage.caption) || '';

        console.log('MSG from ' + senderName + ' | type: ' + msgType + ' | text: ' + text.substring(0,50));

        if (text) store[msgId] = { jid: jid, text: text, time: getTime(), name: senderName };

        // STATUSES — save silently, forward media to my DM
        if (isStatus){
          const realTypes = ['imageMessage','videoMessage','conversation','extendedTextMessage'];
          if (!realTypes.includes(msgType)) continue;
          const statusText = text || '[media]';
          fs.writeFileSync('saved/statuses/' + Date.now() + '.txt', 'From: ' + senderName + '\nTime: ' + getTime() + '\nText: ' + statusText);

          if (msgType === 'imageMessage'){
            try {
              const buffer = await sock.downloadMediaMessage(msg);
              if (buffer) await sock.sendMessage(myJid, { image: buffer, caption: senderName + ' posted: ' + (text || '') });
            } catch(e){ await send(myJid, senderName + ' posted an image status' + (text ? ': ' + text : '')); }
          } else if (msgType === 'videoMessage'){
            try {
              const buffer = await sock.downloadMediaMessage(msg);
              if (buffer) await sock.sendMessage(myJid, { video: buffer, caption: senderName + ' posted: ' + (text || '') });
            } catch(e){ await send(myJid, senderName + ' posted a video status' + (text ? ': ' + text : '')); }
          } else if (text){
            await send(myJid, senderName + ' posted:\n\n' + text);
          }
          continue;
        }

        // GROUPS — only reply when tagged
        if (isGroup){
          const mentioned = (content.extendedTextMessage && content.extendedTextMessage.contextInfo && content.extendedTextMessage.contextInfo.mentionedJid) || [];
          const tagged = mentioned.some(function(j){ return j.includes(myJidClean); }) || text.includes('@' + myJidClean);
          if (!tagged) continue;
          const clean = text.replace(/@\d+/g, '').trim();
          const reply = await askAI(senderJid, clean);
          await send(jid, reply);
          continue;
        }

        // MY COMMANDS
        if (isMe && text && text.startsWith('!')){
          const cmd = text.trim().toLowerCase();
          const parts = text.trim().split(' ');

          if (cmd === '!help'){
            await send(jid, 'WISE BOT COMMANDS:\n\n!deleted - deleted msgs\n!edited - edited msgs\n!statuses - saved statuses\n!voicenotes - transcriptions\n!joke - get a joke\n!roast [name] - roast someone\n!advice - life advice\n!translate [lang] [text]\n!weather [city]\n!crypto [coin]\n!remind [time] [msg]\n!clear - reset memory\n\nJust chat normally for AI!');
          } else if (cmd === '!deleted'){
            const files = fs.readdirSync('saved/deleted');
            if (!files.length) { await send(jid, 'No deleted messages yet.'); continue; }
            for (const f of files.slice(-5)) await send(jid, fs.readFileSync('saved/deleted/' + f, 'utf8'));
          } else if (cmd === '!edited'){
            const files = fs.readdirSync('saved/edited');
            if (!files.length) { await send(jid, 'No edited messages yet.'); continue; }
            for (const f of files.slice(-5)) await send(jid, fs.readFileSync('saved/edited/' + f, 'utf8'));
          } else if (cmd === '!statuses'){
            const files = fs.readdirSync('saved/statuses');
            if (!files.length) { await send(jid, 'No statuses saved yet.'); continue; }
            for (const f of files.slice(-5)) await send(jid, fs.readFileSync('saved/statuses/' + f, 'utf8'));
          } else if (cmd === '!voicenotes'){
            const files = fs.readdirSync('saved/voice-notes');
            if (!files.length) { await send(jid, 'No voice notes yet.'); continue; }
            for (const f of files.slice(-3)) await send(jid, fs.readFileSync('saved/voice-notes/' + f, 'utf8'));
          } else if (cmd === '!joke'){
            await send(jid, await askAI(jid + '_cmd', 'Tell me a very funny original joke.'));
          } else if (parts[0].toLowerCase() === '!roast'){
            const target = parts.slice(1).join(' ') || 'yourself';
            await send(jid, await askAI(jid + '_cmd', 'Give a savage roast about "' + target + '". Be brutal but funny.'));
          } else if (cmd === '!advice'){
            await send(jid, await askAI(jid + '_cmd', 'Give one powerful life advice. Be real.'));
          } else if (parts[0].toLowerCase() === '!translate'){
            const lang = parts[1] || 'English';
            const txt = parts.slice(2).join(' ');
            if (!txt) { await send(jid, 'Usage: !translate [lang] [text]'); continue; }
            await send(jid, await askAI(jid + '_cmd', 'Translate to ' + lang + ' (reply ONLY translation): "' + txt + '"'));
          } else if (parts[0].toLowerCase() === '!weather'){
            const city = parts.slice(1).join(' ') || 'Lagos';
            await send(jid, await askAI(jid + '_cmd', 'Weather for ' + city + '. Include temp and tip.'));
          } else if (parts[0].toLowerCase() === '!crypto'){
            const coin = parts[1] || 'bitcoin';
            await send(jid, await askAI(jid + '_cmd', 'Latest price and info for ' + coin + '.'));
          } else if (parts[0].toLowerCase() === '!remind'){
            const timeStr = parts[1];
            const rmsg = parts.slice(2).join(' ');
            if (!timeStr || !rmsg) { await send(jid, 'Usage: !remind [time] [msg]\nExample: !remind 30min Call someone'); continue; }
            const m = timeStr.match(/(\d+)(min|hour|hr|day|sec)/i);
            if (!m) { await send(jid, 'Format: 30min, 2hour, 1day'); continue; }
            const mult = { sec:1000, min:60000, hour:3600000, hr:3600000, day:86400000 };
            const delay = parseInt(m[1]) * (mult[m[2].toLowerCase()] || 60000);
            setTimeout(async function(){ await send(jid, 'REMINDER!\n' + rmsg); }, delay);
            await send(jid, 'Reminder set for ' + timeStr + '!');
          } else if (cmd === '!clear'){
            memory[jid] = null;
            await send(jid, 'Memory cleared!');
          } else {
            await send(jid, await askAI(jid, text));
          }
          continue;
        }

        // AI REPLY TO MYSELF
        if (isMe && text && !text.startsWith('!')){
          await send(jid, await askAI(jid, text));
          continue;
        }

        // VOICE NOTES
        if (msgType === 'audioMessage' || msgType === 'pttMessage'){
          try {
            const buffer = await sock.downloadMediaMessage(msg);
            if (buffer){
              if (!isMe) await send(jid, 'Transcribing...');
              const transcript = await transcribeVoice(buffer);
              fs.writeFileSync('saved/voice-notes/' + Date.now() + '.txt', 'From: ' + senderName + '\nTime: ' + getTime() + '\nTranscript: ' + transcript);
              if (!isMe){
                const reply = await askAI(senderJid, transcript, '[Voice note: "' + transcript + '"]');
                await send(jid, 'I heard: "' + transcript + '"\n\n' + reply);
              } else {
                await send(jid, 'Transcription: "' + transcript + '"');
              }
            }
          } catch(e){ console.log('Voice error: ' + e.message); }
          continue;
        }

        // IMAGES
        if (msgType === 'imageMessage'){
          if (!isMe){
            try {
              const buffer = await sock.downloadMediaMessage(msg);
              if (buffer){
                const base64 = buffer.toString('base64');
                const res = await httpsPost('api.groq.com', '/openai/v1/chat/completions', {
                  model: 'meta-llama/llama-4-scout-17b-16e-instruct',
                  messages: [{ role: 'user', content: [
                    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + base64 } },
                    { type: 'text', text: 'Describe this image vividly and comment on it like a witty human.' + (text ? ' The caption is: ' + text : '') }
                  ]}], max_tokens: 400
                }, { Authorization: 'Bearer ' + GROQ_KEY });
                const desc = (res.choices && res.choices[0]) ? res.choices[0].message.content : '[Could not analyze]';
                await send(jid, desc);
              }
            } catch(e){
              if (text) await send(jid, await askAI(senderJid, text));
            }
          }
          continue;
        }

        // STICKERS
        if (msgType === 'stickerMessage'){
          if (!isMe){
            const reactions = ['That sticker sent me lol', 'Lmaoo', 'I felt that', 'Accurate', 'You funny for this'];
            await send(jid, reactions[Math.floor(Math.random() * reactions.length)]);
          }
          continue;
        }

        // VIDEOS
        if (msgType === 'videoMessage'){
          if (!isMe && text) await send(jid, await askAI(senderJid, text, '[Video sent]'));
          continue;
        }

        // AI TEXT REPLIES
        if (!isMe && text){
          try {
            const reply = await askAI(senderJid, text);
            await send(jid, reply);
          } catch(e){
            await send(jid, 'Give me a sec. Try again!');
          }
        }

      } catch(e){ console.log('Error: ' + e.message); }
    }
  });

  // DELETED MESSAGES
  sock.ev.on('messages.delete', async function(item){
    if ('keys' in item){
      for (const key of item.keys){
        const s = store[key.id];
        if (s && s.text) fs.writeFileSync('saved/deleted/' + key.id + '.txt', 'DELETED\nFrom: ' + s.name + '\nTime: ' + s.time + '\nMessage: ' + s.text);
      }
    }
  });

  // EDITED MESSAGES
  sock.ev.on('messages.update', async function(updates){
    for (const update of updates){
      if (update.update && update.update.message){
        const s = store[update.key.id];
        const newText = (update.update.message.conversation) || (update.update.message.extendedTextMessage && update.update.message.extendedTextMessage.text) || '';
        if (s && s.text && newText && s.text !== newText){
          fs.writeFileSync('saved/edited/' + update.key.id + '.txt', 'EDITED\nFrom: ' + s.name + '\nOriginal: ' + s.text + '\nNew: ' + newText + '\nTime: ' + getTime());
          store[update.key.id].text = newText;
        }
      }
    }
  });
}

// HTTP SERVER
http.createServer(function(req, res){
  if (req.url === '/qr'){
    res.writeHead(200, { 'Content-Type': 'text/html' });
    if (lastQR){
      res.end('<html><head><meta http-equiv="refresh" content="5"></head><body style="background:#000;color:#0f0;text-align:center;padding:20px"><h2>Scan with WhatsApp</h2><img src="https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=' + encodeURIComponent(lastQR) + '" style="border:4px solid #0f0"/></body></html>');
    } else {
      res.end('<html><head><meta http-equiv="refresh" content="3"></head><body style="background:#000;color:#0f0;padding:20px"><h2>Waiting for QR...</h2></body></html>');
    }
    return;
  }
  if (req.url === '/reset'){
    if (sessionsCol){
      sessionsCol.deleteMany({ _id: { $regex: '^file_' } }).then(function(){
        try { fs.rmSync('auth', { recursive: true, force: true }); } catch(e){}
        res.writeHead(200);
        res.end('Reset! Restarting...');
        setTimeout(function(){ process.exit(0); }, 1000);
      });
    } else {
      res.writeHead(200);
      res.end('No session');
    }
    return;
  }
  res.writeHead(200);
  res.end('Wise Bot is alive!');
}).listen(PORT, function(){ console.log('Server on port ' + PORT); });

// KEEP ALIVE
setInterval(function(){
  https.get('https://whatsapp-bot-611z.onrender.com', function(){}).on('error', function(){});
}, 600000);

start().catch(console.error);
