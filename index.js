const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeInMemoryStore, jidDecode } = require('@whiskeysockets/baileys');
const { MongoClient } = require('mongodb');
const pino = require('pino');
const fs = require('fs');
const https = require('https');
const http = require('http');
const cron = require('node-cron');

// ─── ENV ───
const GROQ_KEY = process.env.GROQ_KEY;
const MONGODB_URI = process.env.MONGODB_URI;
const PORT = process.env.PORT || 3000;
const MY_NUMBER = process.env.MY_NUMBER || '';

// ─── FOLDERS ───
const folders = ['saved/deleted', 'saved/edited', 'saved/voice-notes', 'saved/statuses', 'saved/media', 'saved/view-once', 'auth'];
folders.forEach(f => fs.mkdirSync(f, { recursive: true }));

// ─── STATE ───
const store = {};
const memory = {};
const reminders = {};
let db, sessionsCol, dataCol;
let sock;

// ─── MONGODB ───
async function connectDB() {
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db('wisebot');
    sessionsCol = db.collection('sessions');
    dataCol = db.collection('data');
    console.log('✅ MongoDB connected!');
  } catch(e) {
    console.log('MongoDB error:', e.message);
  }
}

// ─── MONGO AUTH STATE ───
async function useMongoAuthState() {
  const readData = async (key) => {
    try {
      const doc = await sessionsCol.findOne({ _id: key });
      return doc ? JSON.parse(doc.data) : null;
    } catch(e) { return null; }
  };
  const writeData = async (key, data) => {
    try {
      await sessionsCol.updateOne({ _id: key }, { $set: { data: JSON.stringify(data) } }, { upsert: true });
    } catch(e) { console.log('Write session error:', e.message); }
  };
  const removeData = async (key) => {
    try { await sessionsCol.deleteOne({ _id: key }); } catch(e) {}
  };

  const creds = await readData('creds') || { noiseKey: null, signedIdentityKey: null, signedPreKey: null, registrationId: null, advSecretKey: null, nextPreKeyId: null, firstUnuploadedPreKeyId: null, serverHasPreKeys: null, account: null, me: null, signalIdentities: [], lastAccountSyncTimestamp: null, myAppStateKeyId: null };

  return {
    state: { creds, keys: {
      get: async (type, ids) => {
        const data = {};
        for (const id of ids) {
          const val = await readData(`${type}-${id}`);
          if (val) data[id] = val;
        }
        return data;
      },
      set: async (data) => {
        for (const category in data) {
          for (const id in data[category]) {
            const val = data[category][id];
            if (val) await writeData(`${category}-${id}`, val);
            else await removeData(`${category}-${id}`);
          }
        }
      }
    }},
    saveCreds: async () => { await writeData('creds', creds); }
  };
}

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
    req.on('error', () => resolve({}));
    req.write(data);
    req.end();
  });
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

// ─── SEND MESSAGE ───
async function send(jid, text) {
  try {
    await sock.sendMessage(jid, { text });
    console.log('Sent to:', jid);
  } catch(e) { console.log('Send error:', e.message); }
}

// ─── REACT TO MESSAGE ───
async function react(jid, msgKey, emoji) {
  try {
    await sock.sendMessage(jid, { react: { text: emoji, key: msgKey } });
  } catch(e) {}
}

// ─── MOOD DETECTION ───
function detectMood(text) {
  const t = text.toLowerCase();
  if (/lol|haha|😂|😆|funny|joke|laugh/.test(t)) return 'funny';
  if (/angry|mad|stupid|idiot|useless|nonsense|wtf|fuck|rubbish|dumb/.test(t)) return 'savage';
  if (/sad|cry|depressed|lonely|miss|hurt|pain|broken|upset/.test(t)) return 'empathetic';
  if (/help|how|what|why|when|explain|meaning|define|tell me/.test(t)) return 'helpful';
  if (/hi|hello|hey|sup|wassup|morning|night|afternoon|good day/.test(t)) return 'friendly';
  if (/love|crush|relationship|date|boyfriend|girlfriend|marry|feelings/.test(t)) return 'romantic';
  if (/money|hustle|business|invest|income|profit|work/.test(t)) return 'strategic';
  return 'balanced';
}

function getMoodPrompt(mood) {
  const prompts = {
    funny: 'The user is in a fun/jokey mood. Be hilarious, witty and playful. Match their energy.',
    savage: 'The user is being aggressive. Be savage, brutally honest and sharp. No filter.',
    empathetic: 'The user seems emotional or hurt. Be warm, caring, deeply supportive.',
    helpful: 'The user needs info or help. Be clear, precise and thorough like an expert.',
    friendly: 'The user is just vibing. Be warm, casual and fun like a close friend.',
    romantic: 'The user is talking love/relationships. Be a smooth, wise advisor.',
    strategic: 'The user is talking business/money. Be sharp, strategic and motivating.',
    balanced: 'Be your default self — savage, witty, intelligent and real.',
  };
  return prompts[mood] || prompts.balanced;
}

// ─── ASK AI ───
async function askAI(userId, text, extraContext) {
  const mood = detectMood(text);
  const moodPrompt = getMoodPrompt(mood);
  const systemPrompt = `You are Wise Bot, a full blown AI assistant living inside WhatsApp. You are savage, witty, intelligent, funny, empathetic — whatever the moment demands. You answer ANYTHING: school work, life advice, roasts, jokes, relationship advice, coding, news, facts, stories, debates, business ideas, spiritual questions, street talk. You speak naturally like a real human. You remember the conversation. Keep replies concise unless asked to go deep. Never admit you are AI unless directly asked. ${moodPrompt}`;

  if (!memory[userId]) memory[userId] = [{ role: 'system', content: systemPrompt }];
  else memory[userId][0].content = systemPrompt;

  const fullText = extraContext ? `${extraContext}\n\nUser said: ${text}` : text;
  memory[userId].push({ role: 'user', content: fullText });
  if (memory[userId].length > 21) memory[userId] = [memory[userId][0], ...memory[userId].slice(-20)];

  const res = await httpsPost(
    'api.groq.com', '/openai/v1/chat/completions',
    { model: 'llama-3.3-70b-versatile', messages: memory[userId], max_tokens: 700 },
    { Authorization: `Bearer ${GROQ_KEY}` }
  );

  if (res.choices?.[0]) {
    const reply = res.choices[0].message.content;
    memory[userId].push({ role: 'assistant', content: reply });
    return reply;
  }
  if (res.error) return `AI Error: ${res.error.message}`;
  return 'Something glitched. Try again!';
}

// ─── TRANSCRIBE VOICE ───
async function transcribeVoice(audioBuffer) {
  try {
    const boundary = '----WiseBotBoundary' + Date.now();
    const formStart = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-large-v3\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.ogg"\r\nContent-Type: audio/ogg\r\n\r\n`);
    const formEnd = Buffer.from(`\r\n--${boundary}--\r\n`);
    const fullBody = Buffer.concat([formStart, audioBuffer, formEnd]);

    return new Promise((resolve) => {
      const req = https.request({
        hostname: 'api.groq.com', path: '/openai/v1/audio/transcriptions', method: 'POST',
        headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': fullBody.length }
      }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d).text || '[Could not transcribe]'); } catch(e) { resolve('[Transcription failed]'); } });
      });
      req.on('error', () => resolve('[Transcription error]'));
      req.write(fullBody);
      req.end();
    });
  } catch(e) { return '[Voice transcription failed]'; }
}

// ─── DESCRIBE IMAGE ───
async function describeImage(imageBuffer) {
  try {
    const base64 = imageBuffer.toString('base64');
    const res = await httpsPost('api.groq.com', '/openai/v1/chat/completions', {
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
        { type: 'text', text: 'Describe this image in vivid detail. Then comment on it like a witty, sharp human would.' }
      ]}],
      max_tokens: 500
    }, { Authorization: `Bearer ${GROQ_KEY}` });
    if (res.choices?.[0]) return res.choices[0].message.content;
    return '[Image analysis failed]';
  } catch(e) { return '[Image analysis failed]'; }
}

// ─── PARSE REMINDER TIME ───
function parseReminderTime(timeStr) {
  const now = Date.now();
  const match = timeStr.match(/(\d+)\s*(min|hour|hr|day|sec)/i);
  if (!match) return null;
  const val = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers = { sec: 1000, min: 60000, hour: 3600000, hr: 3600000, day: 86400000 };
  return now + (val * (multipliers[unit] || 60000));
}

// ─── PROCESS COMMANDS ───
async function handleCommand(jid, text, msgKey) {
  const cmd = text.trim().toLowerCase();
  const args = text.trim().split(' ');
  const argsLower = cmd.split(' ');

  await react(jid, msgKey, '⚡');

  if (cmd === '!help') {
    return await send(jid, `🤖 *Wise Bot Commands:*\n\n📦 *Saved Data:*\n🗑️ !deleted — last deleted msgs\n✏️ !edited — last edited msgs\n🎤 !voicenotes — transcriptions\n📊 !statuses — saved statuses\n\n🎭 *Fun:*\n😂 !joke\n🔥 !roast [name]\n💡 !advice\n📝 !summarize\n\n🌍 *Utility:*\n🌐 !translate [lang] [text]\n🔍 !search [query]\n💰 !crypto [coin]\n🌤️ !weather [city]\n⏰ !remind [time] [message]\n📢 !broadcast [message]\n\n🧠 *AI:*\n🧹 !clear — reset memory\n\n💬 Chat normally for AI reply!\n👥 Tag me in groups to reply`);
  }

  if (cmd === '!deleted') {
    const files = fs.readdirSync('saved/deleted');
    if (!files.length) return await send(jid, '🗑️ No deleted messages saved yet.');
    await send(jid, `🗑️ *Last ${Math.min(files.length, 5)} deleted messages:*`);
    for (const f of files.slice(-5)) await send(jid, fs.readFileSync(`saved/deleted/${f}`, 'utf8'));
    return;
  }

  if (cmd === '!edited') {
    const files = fs.readdirSync('saved/edited');
    if (!files.length) return await send(jid, '✏️ No edited messages yet.');
    await send(jid, `✏️ *Last ${Math.min(files.length, 5)} edited messages:*`);
    for (const f of files.slice(-5)) await send(jid, fs.readFileSync(`saved/edited/${f}`, 'utf8'));
    return;
  }

  if (cmd === '!statuses') {
    const files = fs.readdirSync('saved/statuses');
    if (!files.length) return await send(jid, '📊 No statuses saved yet.');
    await send(jid, `📊 *Last ${Math.min(files.length, 5)} statuses:*`);
    for (const f of files.slice(-5)) await send(jid, fs.readFileSync(`saved/statuses/${f}`, 'utf8'));
    return;
  }

  if (cmd === '!voicenotes') {
    const files = fs.readdirSync('saved/voice-notes');
    if (!files.length) return await send(jid, '🎤 No voice notes yet.');
    await send(jid, `🎤 *Last ${Math.min(files.length, 3)} transcriptions:*`);
    for (const f of files.slice(-3)) await send(jid, fs.readFileSync(`saved/voice-notes/${f}`, 'utf8'));
    return;
  }

  if (cmd === '!joke') {
    const joke = await askAI(jid + '_cmd', 'Tell me a very funny, original joke. Make it hilarious and unexpected.');
    return await send(jid, `😂 ${joke}`);
  }

  if (argsLower[0] === '!roast') {
    const target = args.slice(1).join(' ') || 'yourself';
    const roast = await askAI(jid + '_cmd', `Give a savage, creative roast about someone named "${target}". Be brutal but funny.`);
    return await send(jid, `🔥 ${roast}`);
  }

  if (cmd === '!advice') {
    const advice = await askAI(jid + '_cmd', 'Give me one powerful, deep piece of life advice. Be real, raw and motivating.');
    return await send(jid, `💡 ${advice}`);
  }

  if (cmd === '!summarize') {
    const hist = memory[jid];
    if (!hist || hist.length < 3) return await send(jid, '🧠 Not enough conversation to summarize yet.');
    const summary = await askAI(jid + '_cmd', `Summarize this conversation briefly:\n${hist.slice(1).map(m => `${m.role}: ${m.content}`).join('\n')}`);
    return await send(jid, `📝 *Summary:*\n${summary}`);
  }

  if (argsLower[0] === '!translate') {
    const lang = args[1] || 'English';
    const textToTranslate = args.slice(2).join(' ');
    if (!textToTranslate) return await send(jid, '❌ Usage: !translate [language] [text]');
    const translated = await askAI(jid + '_cmd', `Translate this to ${lang}: "${textToTranslate}". Reply with ONLY the translation, nothing else.`);
    return await send(jid, `🌍 *${lang}:* ${translated}`);
  }

  if (argsLower[0] === '!search') {
    const query = args.slice(1).join(' ');
    if (!query) return await send(jid, '❌ Usage: !search [query]');
    const result = await askAI(jid + '_cmd', `Search and give me accurate, up-to-date information about: "${query}". Be concise and factual.`);
    return await send(jid, `🔍 *${query}:*\n${result}`);
  }

  if (argsLower[0] === '!weather') {
    const city = args.slice(1).join(' ');
    if (!city) return await send(jid, '❌ Usage: !weather [city]');
    const weather = await askAI(jid + '_cmd', `Give me a realistic weather summary for ${city} right now. Include temperature, conditions, and a tip.`);
    return await send(jid, `🌤️ *${city} Weather:*\n${weather}`);
  }

  if (argsLower[0] === '!crypto') {
    const coin = args[1] || 'bitcoin';
    const price = await askAI(jid + '_cmd', `Give me the latest price and market info for ${coin} cryptocurrency. Be concise.`);
    return await send(jid, `💰 *${coin.toUpperCase()}:*\n${price}`);
  }

  if (argsLower[0] === '!remind') {
    const timeStr = args[1];
    const reminderMsg = args.slice(2).join(' ');
    if (!timeStr || !reminderMsg) return await send(jid, '❌ Usage: !remind [time] [message]\nExample: !remind 30min Call Dorcas');
    const triggerTime = parseReminderTime(timeStr);
    if (!triggerTime) return await send(jid, '❌ Time format: 30min, 2hour, 1day');
    const delay = triggerTime - Date.now();
    setTimeout(async () => {
      await send(jid, `⏰ *Reminder!*\n${reminderMsg}`);
    }, delay);
    return await send(jid, `⏰ Reminder set! I'll ping you in ${timeStr} about: "${reminderMsg}"`);
  }

  if (argsLower[0] === '!broadcast') {
    const msg = args.slice(1).join(' ');
    if (!msg) return await send(jid, '❌ Usage: !broadcast [message]');
    return await send(jid, `📢 Broadcast feature coming soon! For now use WhatsApp broadcast lists directly.`);
  }

  if (cmd === '!clear') {
    memory[jid] = null;
    return await send(jid, '🧹 AI memory cleared!');
  }

  // Unknown command — let AI handle it
  const aiReply = await askAI(jid, text);
  await send(jid, aiReply);
}

// ─── MAIN BOT ───
async function startBot() {
  await connectDB();

  let authState, saveCreds;

  if (MONGODB_URI && sessionsCol) {
    const mongoAuth = await useMongoAuthState();
    authState = mongoAuth.state;
    saveCreds = mongoAuth.saveCreds;
  } else {
    const { state, saveCreds: save } = await useMultiFileAuthState('auth');
    authState = state;
    saveCreds = save;
  }

  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: authState,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: true,
    browser: ['Wise Bot', 'Chrome', '1.0.0'],
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('📱 SCAN THIS QR CODE IN WHATSAPP LINKED DEVICES:');
      console.log(qr);
    }
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed. Reconnecting:', shouldReconnect);
      if (shouldReconnect) setTimeout(startBot, 5000);
    }
    if (connection === 'open') {
      console.log('✅ Wise Bot is LIVE on WhatsApp! 🔥');
      const myJid = sock.user?.id;
      if (myJid) await send(myJid, '🤖 *Wise Bot is online and ready!* 🔥\n\nType !help to see all commands.');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        const jid = msg.key.remoteJid;
        const isMe = msg.key.fromMe;
        const isGroup = jid?.endsWith('@g.us');
        const isStatus = jid === 'status@broadcast';
        const msgId = msg.key.id;
        const myJid = sock.user?.id?.split(':')[0] + '@s.whatsapp.net';

        const content = msg.message;
        if (!content) continue;

        const text = content.conversation || content.extendedTextMessage?.text || content.imageMessage?.caption || content.videoMessage?.caption || '';
        const msgType = Object.keys(content)[0];

        console.log(`MSG - jid: ${jid} | isMe: ${isMe} | type: ${msgType} | text: ${text.substring(0, 50)}`);

        // Store for deleted/edited tracking
        if (text) store[msgId] = { jid, text, time: getTime() };

        // ─── STATUSES ───
        if (isStatus) {
          const statusLog = `From: ${msg.key.participant || jid}\nTime: ${getTime()}\nType: ${msgType}\nText: ${text || '[media]'}`;
          fs.writeFileSync(`saved/statuses/${Date.now()}.txt`, statusLog);
          console.log('Status saved!');
          if (myJid) await send(myJid, `📊 *New Status Saved!*\n\n${statusLog}`);
          continue;
        }

        // ─── GROUP MESSAGES — only reply when tagged ───
        if (isGroup) {
          const mentionedJids = content.extendedTextMessage?.contextInfo?.mentionedJid || [];
          const myJidClean = sock.user?.id?.split(':')[0];
          const isMentioned = mentionedJids.some(j => j.includes(myJidClean)) || text.includes(`@${myJidClean}`);
          if (!isMentioned) continue;
          // Strip mention from text
          const cleanText = text.replace(/@\d+/g, '').trim();
          const reply = await askAI(jid, cleanText);
          await send(jid, reply);
          continue;
        }

        // ─── MY COMMANDS ───
        if (isMe && text.startsWith('!')) {
          await handleCommand(jid, text, msg.key);
          continue;
        }

        // ─── VOICE NOTES ───
        if (msgType === 'audioMessage' || msgType === 'pttMessage') {
          const buffer = await sock.downloadMediaMessage(msg);
          if (buffer) {
            await send(jid, '🎤 Transcribing voice note...');
            const transcript = await transcribeVoice(buffer);
            fs.writeFileSync(`saved/voice-notes/${Date.now()}_${jid.replace(/[^a-z0-9]/gi,'')}.txt`,
              `From: ${jid}\nTime: ${getTime()}\nTranscript: ${transcript}`
            );
            if (!isMe) {
              const aiReply = await askAI(jid, transcript, `[Voice note transcription: "${transcript}"]`);
              await send(jid, `🎤 *I heard:* "${transcript}"\n\n${aiReply}`);
            } else {
              await send(jid, `🎤 *Transcription:* "${transcript}"`);
            }
          }
          continue;
        }

        // ─── IMAGES ───
        if (msgType === 'imageMessage') {
          const buffer = await sock.downloadMediaMessage(msg);
          fs.writeFileSync('saved/media/' + Date.now() + '_' + jid.replace(/[^a-z0-9]/gi,'') + '_img.bin', buffer);
