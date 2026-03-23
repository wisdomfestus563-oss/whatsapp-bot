const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { MongoClient } = require('mongodb');
const pino = require('pino');
const fs = require('fs');
const https = require('https');
const http = require('http');

const GROQ_KEY = process.env.GROQ_KEY;
const MONGODB_URI = process.env.MONGODB_URI;
const PORT = process.env.PORT || 3000;

const folders = ['saved/deleted', 'saved/edited', 'saved/voice-notes', 'saved/statuses', 'saved/media', 'saved/view-once', 'auth'];
folders.forEach(function(f) { fs.mkdirSync(f, { recursive: true }); });

const store = {};
const memory = {};
let db, sessionsCol;
let sock;

async function connectDB() {
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db('wisebot');
    sessionsCol = db.collection('sessions');
    console.log('MongoDB connected!');
  } catch(e) {
    console.log('MongoDB error: ' + e.message);
  }
}

async function useMongoAuthState() {
  async function readData(key) {
    try {
      const doc = await sessionsCol.findOne({ _id: key });
      return doc ? JSON.parse(doc.data) : null;
    } catch(e) { return null; }
  }
  async function writeData(key, data) {
    try {
      await sessionsCol.updateOne({ _id: key }, { $set: { data: JSON.stringify(data) } }, { upsert: true });
    } catch(e) { console.log('Write error: ' + e.message); }
  }
  async function removeData(key) {
    try { await sessionsCol.deleteOne({ _id: key }); } catch(e) {}
  }

  const creds = await readData('creds') || {};

  return {
    state: {
      creds,
      keys: {
        get: async function(type, ids) {
          const data = {};
          for (const id of ids) {
            const val = await readData(type + '-' + id);
            if (val) data[id] = val;
          }
          return data;
        },
        set: async function(data) {
          for (const category in data) {
            for (const id in data[category]) {
              const val = data[category][id];
              if (val) await writeData(category + '-' + id, val);
              else await removeData(category + '-' + id);
            }
          }
        }
      }
    },
    saveCreds: async function() { await writeData('creds', creds); }
  };
}

function getTime() {
  return new Date().toLocaleString('en-NG', { timeZone: 'Africa/Lagos' });
}

function httpsPost(host, path, body, headers) {
  return new Promise(function(resolve) {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: host, path: path, method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers)
    }, function(res) {
      let d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() { try { resolve(JSON.parse(d)); } catch(e) { resolve({}); } });
    });
    req.on('error', function() { resolve({}); });
    req.write(data);
    req.end();
  });
}

function httpsGetBuffer(url) {
  return new Promise(function(resolve, reject) {
    https.get(url, function(res) {
      const chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() { resolve(Buffer.concat(chunks)); });
    }).on('error', reject);
  });
}

async function send(jid, text) {
  try {
    await sock.sendMessage(jid, { text: text });
  } catch(e) { console.log('Send error: ' + e.message); }
}

async function react(jid, msgKey, emoji) {
  try {
    await sock.sendMessage(jid, { react: { text: emoji, key: msgKey } });
  } catch(e) {}
}

function detectMood(text) {
  const t = text.toLowerCase();
  if (/lol|haha|funny|joke|laugh/.test(t)) return 'funny';
  if (/angry|mad|stupid|idiot|useless|wtf|rubbish/.test(t)) return 'savage';
  if (/sad|cry|depressed|lonely|hurt|pain|broken/.test(t)) return 'empathetic';
  if (/help|how|what|why|when|explain|define/.test(t)) return 'helpful';
  if (/hi|hello|hey|sup|wassup|morning|night/.test(t)) return 'friendly';
  if (/love|crush|relationship|date|boyfriend|girlfriend/.test(t)) return 'romantic';
  if (/money|hustle|business|invest|income/.test(t)) return 'strategic';
  return 'balanced';
}

function getMoodPrompt(mood) {
  const prompts = {
    funny: 'The user is in a fun mood. Be hilarious and witty.',
    savage: 'The user is being aggressive. Be savage and brutally honest.',
    empathetic: 'The user seems hurt. Be warm and caring.',
    helpful: 'The user needs info. Be clear and precise.',
    friendly: 'The user is vibing. Be casual and fun.',
    romantic: 'The user is talking love. Be a smooth advisor.',
    strategic: 'The user is talking business. Be sharp and strategic.',
    balanced: 'Be savage, witty, intelligent and real.'
  };
  return prompts[mood] || prompts.balanced;
}

async function askAI(userId, text, extraContext) {
  const mood = detectMood(text);
  const moodPrompt = getMoodPrompt(mood);
  const systemPrompt = 'You are Wise Bot, a full blown AI assistant living inside WhatsApp. You are savage, witty, intelligent, funny, empathetic — whatever the moment demands. You answer ANYTHING. You speak naturally like a real human. Keep replies concise unless asked to go deep. Never admit you are AI unless directly asked. ' + moodPrompt;

  if (!memory[userId]) memory[userId] = [{ role: 'system', content: systemPrompt }];
  else memory[userId][0].content = systemPrompt;

  const fullText = extraContext ? extraContext + '\n\nUser said: ' + text : text;
  memory[userId].push({ role: 'user', content: fullText });
  if (memory[userId].length > 21) memory[userId] = [memory[userId][0]].concat(memory[userId].slice(-20));

  const res = await httpsPost(
    'api.groq.com', '/openai/v1/chat/completions',
    { model: 'llama-3.3-70b-versatile', messages: memory[userId], max_tokens: 700 },
    { Authorization: 'Bearer ' + GROQ_KEY }
  );

  if (res.choices && res.choices[0]) {
    const reply = res.choices[0].message.content;
    memory[userId].push({ role: 'assistant', content: reply });
    return reply;
  }
  if (res.error) return 'AI Error: ' + res.error.message;
  return 'Something glitched. Try again!';
}

async function transcribeVoice(audioBuffer) {
  try {
    const boundary = '----WiseBotBoundary' + Date.now();
    const formStart = Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-large-v3\r\n--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="audio.ogg"\r\nContent-Type: audio/ogg\r\n\r\n');
    const formEnd = Buffer.from('\r\n--' + boundary + '--\r\n');
    const fullBody = Buffer.concat([formStart, audioBuffer, formEnd]);

    return new Promise(function(resolve) {
      const req = https.request({
        hostname: 'api.groq.com', path: '/openai/v1/audio/transcriptions', method: 'POST',
        headers: { 'Authorization': 'Bearer ' + GROQ_KEY, 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': fullBody.length }
      }, function(res) {
        let d = '';
        res.on('data', function(c) { d += c; });
        res.on('end', function() {
          try { resolve(JSON.parse(d).text || '[Could not transcribe]'); }
          catch(e) { resolve('[Transcription failed]'); }
        });
      });
      req.on('error', function() { resolve('[Transcription error]'); });
      req.write(fullBody);
      req.end();
    });
  } catch(e) { return '[Voice transcription failed]'; }
}

async function describeImage(imageBuffer) {
  try {
    const base64 = imageBuffer.toString('base64');
    const res = await httpsPost('api.groq.com', '/openai/v1/chat/completions', {
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + base64 } },
        { type: 'text', text: 'Describe this image in vivid detail. Then comment on it like a witty human would.' }
      ]}],
      max_tokens: 500
    }, { Authorization: 'Bearer ' + GROQ_KEY });
    if (res.choices && res.choices[0]) return res.choices[0].message.content;
    return '[Image analysis failed]';
  } catch(e) { return '[Image analysis failed]'; }
}

function parseReminderTime(timeStr) {
  const match = timeStr.match(/(\d+)\s*(min|hour|hr|day|sec)/i);
  if (!match) return null;
  const val = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers = { sec: 1000, min: 60000, hour: 3600000, hr: 3600000, day: 86400000 };
  return Date.now() + (val * (multipliers[unit] || 60000));
}

function sanitize(str) {
  return str.replace(/[^a-z0-9]/gi, '');
}

async function handleCommand(jid, text, msgKey) {
  const cmd = text.trim().toLowerCase();
  const args = text.trim().split(' ');
  const argsLower = cmd.split(' ');

  await react(jid, msgKey, '');

  if (cmd === '!help') {
    return await send(jid, '*Wise Bot Commands:*\n\n*Saved Data:*\n!deleted - last deleted msgs\n!edited - last edited msgs\n!voicenotes - transcriptions\n!statuses - saved statuses\n\n*Fun:*\n!joke\n!roast [name]\n!advice\n!summarize\n\n*Utility:*\n!translate [lang] [text]\n!search [query]\n!crypto [coin]\n!weather [city]\n!remind [time] [message]\n\n*AI:*\n!clear - reset memory\n\nJust chat normally for AI reply!\nTag me in groups to reply');
  }

  if (cmd === '!deleted') {
    const files = fs.readdirSync('saved/deleted');
    if (!files.length) return await send(jid, 'No deleted messages saved yet.');
    await send(jid, 'Last deleted messages:');
    for (const f of files.slice(-5)) await send(jid, fs.readFileSync('saved/deleted/' + f, 'utf8'));
    return;
  }

  if (cmd === '!edited') {
    const files = fs.readdirSync('saved/edited');
    if (!files.length) return await send(jid, 'No edited messages yet.');
    await send(jid, 'Last edited messages:');
    for (const f of files.slice(-5)) await send(jid, fs.readFileSync('saved/edited/' + f, 'utf8'));
    return;
  }

  if (cmd === '!statuses') {
    const files = fs.readdirSync('saved/statuses');
    if (!files.length) return await send(jid, 'No statuses saved yet.');
    await send(jid, 'Last statuses:');
    for (const f of files.slice(-5)) await send(jid, fs.readFileSync('saved/statuses/' + f, 'utf8'));
    return;
  }

  if (cmd === '!voicenotes') {
    const files = fs.readdirSync('saved/voice-notes');
    if (!files.length) return await send(jid, 'No voice notes yet.');
    await send(jid, 'Last voice note transcriptions:');
    for (const f of files.slice(-3)) await send(jid, fs.readFileSync('saved/voice-notes/' + f, 'utf8'));
    return;
  }

  if (cmd === '!joke') {
    const joke = await askAI(jid + '_cmd', 'Tell me a very funny original joke. Make it hilarious.');
    return await send(jid, joke);
  }

  if (argsLower[0] === '!roast') {
    const target = args.slice(1).join(' ') || 'yourself';
    const roast = await askAI(jid + '_cmd', 'Give a savage funny roast about someone named "' + target + '". Be brutal but fun.');
    return await send(jid, roast);
  }

  if (cmd === '!advice') {
    const advice = await askAI(jid + '_cmd', 'Give me one powerful deep piece of life advice. Be real and motivating.');
    return await send(jid, advice);
  }

  if (cmd === '!summarize') {
    const hist = memory[jid];
    if (!hist || hist.length < 3) return await send(jid, 'Not enough conversation to summarize yet.');
    const summary = await askAI(jid + '_cmd', 'Summarize this conversation briefly:\n' + hist.slice(1).map(function(m) { return m.role + ': ' + m.content; }).join('\n'));
    return await send(jid, 'Summary:\n' + summary);
  }

  if (argsLower[0] === '!translate') {
    const lang = args[1] || 'English';
    const textToTranslate = args.slice(2).join(' ');
    if (!textToTranslate) return await send(jid, 'Usage: !translate [language] [text]');
    const translated = await askAI(jid + '_cmd', 'Translate this to ' + lang + ': "' + textToTranslate + '". Reply with ONLY the translation.');
    return await send(jid, lang + ': ' + translated);
  }

  if (argsLower[0] === '!search') {
    const query = args.slice(1).join(' ');
    if (!query) return await send(jid, 'Usage: !search [query]');
    const result = await askAI(jid + '_cmd', 'Give accurate information about: "' + query + '". Be concise and factual.');
    return await send(jid, query + ':\n' + result);
  }

  if (argsLower[0] === '!weather') {
    const city = args.slice(1).join(' ');
    if (!city) return await send(jid, 'Usage: !weather [city]');
    const weather = await askAI(jid + '_cmd', 'Give a weather summary for ' + city + '. Include temperature, conditions and a tip.');
    return await send(jid, city + ' Weather:\n' + weather);
  }

  if (argsLower[0] === '!crypto') {
    const coin = args[1] || 'bitcoin';
    const price = await askAI(jid + '_cmd', 'Give latest price and market info for ' + coin + ' cryptocurrency.');
    return await send(jid, coin.toUpperCase() + ':\n' + price);
  }

  if (argsLower[0] === '!remind') {
    const timeStr = args[1];
    const reminderMsg = args.slice(2).join(' ');
    if (!timeStr || !reminderMsg) return await send(jid, 'Usage: !remind [time] [message]\nExample: !remind 30min Call Dorcas');
    const triggerTime = parseReminderTime(timeStr);
    if (!triggerTime) return await send(jid, 'Time format: 30min, 2hour, 1day');
    const delay = triggerTime - Date.now();
    setTimeout(async function() {
      await send(jid, 'Reminder!\n' + reminderMsg);
    }, delay);
    return await send(jid, 'Reminder set for ' + timeStr + ': "' + reminderMsg + '"');
  }

  if (cmd === '!clear') {
    memory[jid] = null;
    return await send(jid, 'AI memory cleared!');
  }

  const aiReply = await askAI(jid, text);
  await send(jid, aiReply);
}

async function startBot() {
  await connectDB();

  let authState, saveCreds;

  try {
    const fileAuth = await useMultiFileAuthState('auth');
    authState = fileAuth.state;
    saveCreds = fileAuth.saveCreds;
    console.log('Using file auth state');
  } catch(e) {
    console.log('File auth error: ' + e.message);
    return;
  }

  const versionInfo = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version: versionInfo.version,
    auth: authState,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Wise Bot', 'Chrome', '1.0.0'],
    syncFullHistory: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async function(update) {
    const connection = update.connection;
    const lastDisconnect = update.lastDisconnect;

    if (update.qr) {
      lastQR = update.qr;
      console.log('QR code ready! Visit https://whatsapp-bot-611z.onrender.com/qr to scan');
    }
    if (connection === 'close') {
      const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log('Connection closed. Reconnecting: ' + shouldReconnect);
      if (shouldReconnect) setTimeout(startBot, 5000);
    }
    if (connection === 'open') {
      console.log('Wise Bot is LIVE on WhatsApp!');
      const myJid = sock.user && sock.user.id;
      if (myJid) await send(myJid, 'Wise Bot is online and ready! Type !help to see all commands.');
    }
  });

  sock.ev.on('messages.upsert', async function(upsert) {
    if (upsert.type !== 'notify') return;

    for (const msg of upsert.messages) {
      try {
        const jid = msg.key.remoteJid;
        const isMe = msg.key.fromMe;
        const isGroup = jid && jid.endsWith('@g.us');
        const isStatus = jid === 'status@broadcast';
        const msgId = msg.key.id;
        const myJidClean = sock.user && sock.user.id && sock.user.id.split(':')[0];
        const myJid = myJidClean + '@s.whatsapp.net';

        const content = msg.message;
        if (!content) continue;

        const text = content.conversation || (content.extendedTextMessage && content.extendedTextMessage.text) || (content.imageMessage && content.imageMessage.caption) || (content.videoMessage && content.videoMessage.caption) || '';
        const msgType = Object.keys(content)[0];

        console.log('MSG - jid: ' + jid + ' | isMe: ' + isMe + ' | type: ' + msgType);

        if (text) store[msgId] = { jid: jid, text: text, time: getTime() };

        if (isStatus) {
          const statusLog = 'From: ' + jid + '\nTime: ' + getTime() + '\nType: ' + msgType + '\nText: ' + (text || '[media]');
          fs.writeFileSync('saved/statuses/' + Date.now() + '.txt', statusLog);
          if (myJid) await send(myJid, 'New Status Saved!\n\n' + statusLog);
          continue;
        }

        if (isGroup) {
          const mentionedJids = (content.extendedTextMessage && content.extendedTextMessage.contextInfo && content.extendedTextMessage.contextInfo.mentionedJid) || [];
          const isMentioned = mentionedJids.some(function(j) { return j.includes(myJidClean); }) || text.includes('@' + myJidClean);
          if (!isMentioned) continue;
          const cleanText = text.replace(/@\d+/g, '').trim();
          const reply = await askAI(jid, cleanText);
          await send(jid, reply);
          continue;
        }

        if (isMe && text && text.startsWith('!')) {
          await handleCommand(jid, text, msg.key);
          continue;
        }

        if (msgType === 'audioMessage' || msgType === 'pttMessage') {
          const buffer = await sock.downloadMediaMessage(msg);
          if (buffer) {
            await send(jid, 'Transcribing voice note...');
            const transcript = await transcribeVoice(buffer);
            fs.writeFileSync('saved/voice-notes/' + Date.now() + '_' + sanitize(jid) + '.txt', 'From: ' + jid + '\nTime: ' + getTime() + '\nTranscript: ' + transcript);
            if (!isMe) {
              const aiReply = await askAI(jid, transcript, '[Voice note transcription: "' + transcript + '"]');
              await send(jid, 'I heard: "' + transcript + '"\n\n' + aiReply);
            } else {
              await send(jid, 'Transcription: "' + transcript + '"');
            }
          }
          continue;
        }

        if (msgType === 'imageMessage') {
          const buffer = await sock.downloadMediaMessage(msg);
          if (buffer) {
            fs.writeFileSync('saved/media/' + Date.now() + '_' + sanitize(jid) + '_img.bin', buffer);
            await send(jid, 'Analyzing image...');
            const description = await describeImage(buffer);
            if (!isMe) {
              const aiReply = await askAI(jid, text || 'React to this', '[Image description: "' + description + '"]');
              await send(jid, 'Image Analysis:\n' + description + '\n\n' + aiReply);
            } else {
              await send(jid, 'Image Analysis:\n' + description);
            }
          }
          continue;
        }

        if (msgType === 'videoMessage') {
          const buffer = await sock.downloadMediaMessage(msg);
          if (buffer) fs.writeFileSync('saved/media/' + Date.now() + '_' + sanitize(jid) + '_vid.bin', buffer);
          await send(jid, 'Video saved!' + (text ? '\nCaption: "' + text + '"' : ''));
          if (!isMe && text) {
            const aiReply = await askAI(jid, text, '[User sent a video]');
            await send(jid, aiReply);
          }
          continue;
        }

        if (msgType === 'stickerMessage') {
          fs.writeFileSync('saved/media/' + Date.now() + '_sticker.txt', 'From: ' + jid + '\nTime: ' + getTime());
          if (!isMe) {
            const reactions = ['That sticker sent me lol', 'Lmaoo okay', 'I felt that', 'Accurate', 'You funny for this', 'Nah this one got me'];
            await send(jid, reactions[Math.floor(Math.random() * reactions.length)]);
          }
          continue;
        }

        if (msgType === 'documentMessage') {
          await send(jid, 'Document received and saved!');
          continue;
        }

        if (msgType === 'viewOnceMessage' || msgType === 'viewOnceMessageV2') {
          const inner = (content.viewOnceMessage && content.viewOnceMessage.message) || (content.viewOnceMessageV2 && content.viewOnceMessageV2.message);
          if (inner) {
            const innerType = Object.keys(inner)[0];
            fs.writeFileSync('saved/view-once/' + Date.now() + '.txt', 'From: ' + jid + '\nTime: ' + getTime() + '\nType: ' + innerType);
            if (!isMe) await send(jid, 'View once message saved! Type: ' + innerType);
          }
          continue;
        }

        if (!isMe && text) {
          try {
            const reply = await askAI(jid, text);
            await send(jid, reply);
          } catch(e) {
            console.log('AI error: ' + e.message);
            await send(jid, 'Give me a second, something glitched. Try again!');
          }
        }

      } catch(e) {
        console.log('Message error: ' + e.message);
      }
    }
  });

  sock.ev.on('messages.delete', async function(item) {
    if ('keys' in item) {
      for (const key of item.keys) {
        const s = store[key.id];
        if (s && s.text) {
          fs.writeFileSync('saved/deleted/' + key.id + '.txt', 'Deleted Message\nFrom: ' + s.jid + '\nTime: ' + s.time + '\nMessage: ' + s.text);
          console.log('Deleted message saved!');
        }
      }
    }
  });

  sock.ev.on('messages.update', async function(updates) {
    for (const update of updates) {
      if (update.update && update.update.message) {
        const s = store[update.key.id];
        const newText = (update.update.message.conversation) || (update.update.message.extendedTextMessage && update.update.message.extendedTextMessage.text) || '';
        if (s && s.text && newText && s.text !== newText) {
          fs.writeFileSync('saved/edited/' + update.key.id + '.txt', 'Edited Message\nFrom: ' + s.jid + '\nTime: ' + getTime() + '\nOriginal: ' + s.text + '\nEdited to: ' + newText);
          console.log('Edited message saved!');
          store[update.key.id].text = newText;
        }
      }
    }
  });
}

let lastQR = '';

http.createServer(function(req, res) {
  if (req.url === '/reset') {
    if (sessionsCol) {
      sessionsCol.deleteMany({}).then(function() {
        res.writeHead(200);
        res.end('Session cleared! Restarting bot...');
        setTimeout(function() { process.exit(0); }, 1000);
      });
    } else {
      res.writeHead(200);
      res.end('No session to clear');
    }
    return;
  }
  if (req.url === '/qr') {
    res.writeHead(200, {'Content-Type': 'text/html'});
    if (lastQR) {
      res.end('<html><head><meta http-equiv="refresh" content="3"></head><body style="background:#000;color:#0f0;font-family:monospace;padding:20px"><h2>Scan this QR code with WhatsApp</h2><img src="https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=' + encodeURIComponent(lastQR) + '" style="border:5px solid #0f0"/><p>Page auto-refreshes every 3 seconds</p></body></html>');
    } else {
      res.end('<html><head><meta http-equiv="refresh" content="3"></head><body style="background:#000;color:#0f0;font-family:monospace;padding:20px"><h2>Waiting for QR code... Auto-refreshing</h2><p>If this takes too long, visit /reset first</p></body></html>');
    }
  } else {
    res.writeHead(200);
    res.end('Wise Bot is alive!');
  }
}).listen(PORT, function() { console.log('Keep-alive server on port ' + PORT); });

startBot().catch(console.error);
