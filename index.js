const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { MongoClient } = require('mongodb');
const pino = require('pino');
const fs = require('fs');
const https = require('https');
const http = require('http');

// ─── ENV ───
const GROQ_KEY = process.env.GROQ_KEY;
const MONGODB_URI = process.env.MONGODB_URI;
const MY_NUMBER = process.env.MY_NUMBER || '';
const PORT = process.env.PORT || 3000;

// ─── FOLDERS ───
const folders = ['saved/deleted', 'saved/edited', 'saved/voice-notes', 'saved/statuses', 'saved/media', 'saved/view-once', 'saved/spy', 'auth'];
folders.forEach(function(f) { fs.mkdirSync(f, { recursive: true }); });

// ─── STATE ───
const store = {};
const memory = {};
let db, sessionsCol;
let sock;

// ─── GOD TIER STATE ───
const state = {
  spyMode: false,
  dndMode: false,
  dndQueue: [],
  scheduledMessages: [],
  vipContacts: {},
  contactPersonalities: {},
  blockedSpammers: {},
  messageCount: {},
  readReceipts: {},
  briefingTime: '07:00',
  secretMode: true,
  stats: { totalMessages: 0, totalReplies: 0, statusesSaved: 0, deletedCaught: 0 }
};

// ─── PERSONALITIES ───
const personalities = {
  savage: 'You are savage, brutal, no filter. Roast, clap back, zero tolerance for nonsense.',
  romantic: 'You are smooth, charming and romantic. Speak with warmth and deep affection.',
  professional: 'You are formal, precise and highly professional. No slang.',
  funny: 'You are a comedian. Everything is a joke. Make them laugh every single reply.',
  motivator: 'You are an intense motivational coach. Hype them up, push them hard.',
  default: 'You are savage, witty, intelligent and real. Match the energy of whoever you talk to.'
};

// ─── VIP CONTACTS (add numbers here) ───
const defaultVIPs = {};

// ─── MONGODB ───
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

async function saveSessionToDB() {
  if (!sessionsCol) return;
  try {
    if (!fs.existsSync('auth')) return;
    const files = fs.readdirSync('auth');
    for (const file of files) {
      const key = 'file_' + file;
      const data = fs.readFileSync('auth/' + file, 'utf8');
      await sessionsCol.updateOne({ _id: key }, { $set: { data: data } }, { upsert: true });
    }
    console.log('Session backed up to MongoDB!');
  } catch(e) {
    console.log('Session backup error: ' + e.message);
  }
}

async function loadSessionFromDB() {
  if (!sessionsCol) return false;
  try {
    const docs = await sessionsCol.find({ _id: { $regex: '^file_' } }).toArray();
    if (!docs || docs.length === 0) return false;
    if (!fs.existsSync('auth')) fs.mkdirSync('auth', { recursive: true });
    for (const doc of docs) {
      const filename = doc._id.replace('file_', '');
      fs.writeFileSync('auth/' + filename, doc.data);
    }
    console.log('Session restored from MongoDB!');
    return true;
  } catch(e) {
    console.log('Session restore error: ' + e.message);
    return false;
  }
}

// ─── UTILS ───
function getTime() {
  return new Date().toLocaleString('en-NG', { timeZone: 'Africa/Lagos' });
}

function sanitize(str) {
  return str.replace(/[^a-z0-9]/gi, '');
}

function getHour() {
  return new Date().toLocaleString('en-NG', { timeZone: 'Africa/Lagos', hour: '2-digit', hour12: false });
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

// ─── SEND ───
async function send(jid, text) {
  try {
    await sock.sendMessage(jid, { text: text });
    state.stats.totalReplies++;
  } catch(e) { console.log('Send error: ' + e.message); }
}

// ─── REACT ───
async function react(jid, msgKey, emoji) {
  try {
    await sock.sendMessage(jid, { react: { text: emoji, key: msgKey } });
  } catch(e) {}
}

// ─── MOOD DETECTION ───
function detectMood(text) {
  const t = text.toLowerCase();
  if (/lol|haha|funny|joke|laugh|😂|😆/.test(t)) return 'funny';
  if (/angry|mad|stupid|idiot|useless|wtf|rubbish|😡|🤬/.test(t)) return 'savage';
  if (/sad|cry|depressed|lonely|hurt|pain|broken|😢|😭/.test(t)) return 'empathetic';
  if (/help|how|what|why|when|explain|define/.test(t)) return 'helpful';
  if (/hi|hello|hey|sup|wassup|morning|night|👋/.test(t)) return 'friendly';
  if (/love|crush|relationship|date|boyfriend|girlfriend|❤️|😍/.test(t)) return 'romantic';
  if (/money|hustle|business|invest|income|profit/.test(t)) return 'strategic';
  return 'balanced';
}

function getMoodEmoji(mood) {
  const emojis = { funny: '😂', savage: '🔥', empathetic: '🫂', helpful: '🧠', friendly: '👋', romantic: '❤️', strategic: '💰', balanced: '⚡' };
  return emojis[mood] || '⚡';
}

// ─── SPAM DETECTION ───
function isSpam(jid, text) {
  if (state.blockedSpammers[jid]) return true;
  const spamPatterns = /win|prize|click here|free money|congratulations you won|investment opportunity|double your|crypto signal|buy now|limited offer/i;
  return spamPatterns.test(text);
}

// ─── LANGUAGE DETECTION ───
function detectLanguage(text) {
  const pidginPatterns = /wetin|dey|abi|sha|na|oya|abeg|wahala|wahala|nah|wey|don|sabi/i;
  if (pidginPatterns.test(text)) return 'Nigerian Pidgin English';
  return 'English';
}

// ─── ASK AI ───
async function askAI(userId, text, extraContext, personalityOverride) {
  const mood = detectMood(text);
  const lang = detectLanguage(text);
  const personality = personalityOverride || state.contactPersonalities[userId] || 'default';
  const personalityPrompt = personalities[personality] || personalities.default;
  const isVIP = state.vipContacts[userId];

  const systemPrompt = 'You are Wise Bot, a god-tier AI assistant living inside WhatsApp. ' + personalityPrompt + ' You answer ANYTHING: school, life, roasts, jokes, relationships, code, news, facts, stories, debates, business, spiritual questions. You speak naturally like a real human, using the same language/dialect as the user. Current detected language: ' + lang + '. ' + (isVIP ? 'This is a VIP contact — be extra attentive and impressive.' : '') + (state.secretMode ? ' NEVER admit you are an AI or bot under any circumstances. Deny it completely.' : '') + ' Keep replies concise unless asked to go deep. Remember conversation history.';

  if (!memory[userId]) memory[userId] = [{ role: 'system', content: systemPrompt }];
  else memory[userId][0].content = systemPrompt;

  const fullText = extraContext ? extraContext + '\n\nUser said: ' + text : text;
  memory[userId].push({ role: 'user', content: fullText });
  if (memory[userId].length > 21) memory[userId] = [memory[userId][0]].concat(memory[userId].slice(-20));

  const res = await httpsPost(
    'api.groq.com', '/openai/v1/chat/completions',
    { model: 'llama-3.3-70b-versatile', messages: memory[userId], max_tokens: 800 },
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

// ─── TRANSCRIBE VOICE ───
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
        res.on('end', function() { try { resolve(JSON.parse(d).text || '[Could not transcribe]'); } catch(e) { resolve('[Transcription failed]'); } });
      });
      req.on('error', function() { resolve('[Transcription error]'); });
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
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + base64 } },
        { type: 'text', text: 'Describe this image in vivid detail. Then comment on it like a witty sharp human would.' }
      ]}],
      max_tokens: 500
    }, { Authorization: 'Bearer ' + GROQ_KEY });
    if (res.choices && res.choices[0]) return res.choices[0].message.content;
    return '[Image analysis failed]';
  } catch(e) { return '[Image analysis failed]'; }
}

// ─── PARSE TIME ───
function parseReminderTime(timeStr) {
  const match = timeStr.match(/(\d+)\s*(min|hour|hr|day|sec)/i);
  if (!match) return null;
  const val = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers = { sec: 1000, min: 60000, hour: 3600000, hr: 3600000, day: 86400000 };
  return Date.now() + (val * (multipliers[unit] || 60000));
}

// ─── DAILY BRIEFING ───
async function sendDailyBriefing(myJid) {
  try {
    const briefing = await askAI('briefing', 'Give me a powerful daily briefing for today. Include: 1) Top world news summary 2) Motivational quote 3) A productivity tip 4) Weather tip for Lagos Nigeria 5) A fun fact. Make it energetic and sharp!', null, 'motivator');
    await send(myJid, 'GOOD MORNING! Your Daily Briefing:\n\n' + briefing);
  } catch(e) {
    console.log('Briefing error: ' + e.message);
  }
}

// ─── COMMANDS ───
async function handleCommand(jid, text, msgKey, myJid) {
  const cmd = text.trim().toLowerCase();
  const args = text.trim().split(' ');
  const argsLower = cmd.split(' ');

  await react(jid, msgKey, '⚡');

  if (cmd === '!help') {
    return await send(jid, '*WISE BOT - GOD TIER COMMANDS*\n\n*SAVED DATA:*\n!deleted - deleted messages\n!edited - edited messages\n!voicenotes - transcriptions\n!statuses - saved statuses\n\n*AI & FUN:*\n!joke - funny joke\n!roast [name] - savage roast\n!advice - life advice\n!summarize - summarize convo\n!translate [lang] [text]\n!search [query]\n!crypto [coin]\n!weather [city]\n\n*GOD TIER:*\n!spy on/off - spy mode\n!dnd on/off - do not disturb\n!vip [number] - set VIP contact\n!personality [number] [type] - set personality\n!schedule [time] [number] [msg]\n!stats - bot statistics\n!brief - daily briefing now\n!block [number] - block spammer\n!secret on/off - secret mode\n!clear - reset AI memory\n!status [text] - AI reply to status\n\nPersonality types: savage, romantic, professional, funny, motivator');
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
    await send(jid, 'Last ' + Math.min(files.length, 5) + ' statuses:');
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
    const joke = await askAI(jid + '_cmd', 'Tell me a very funny original joke. Make it hilarious and unexpected.', null, 'funny');
    return await send(jid, joke);
  }

  if (argsLower[0] === '!roast') {
    const target = args.slice(1).join(' ') || 'yourself';
    const roast = await askAI(jid + '_cmd', 'Give a savage funny roast about someone named "' + target + '". Be brutal but creative.', null, 'savage');
    return await send(jid, roast);
  }

  if (cmd === '!advice') {
    const advice = await askAI(jid + '_cmd', 'Give one powerful deep piece of life advice. Be real, raw and motivating.', null, 'motivator');
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
    const result = await askAI(jid + '_cmd', 'Give accurate detailed information about: "' + query + '". Be thorough and factual.');
    return await send(jid, query + ':\n' + result);
  }

  if (argsLower[0] === '!weather') {
    const city = args.slice(1).join(' ') || 'Lagos';
    const weather = await askAI(jid + '_cmd', 'Give a realistic weather summary for ' + city + '. Include temperature range, conditions, humidity and a practical tip.');
    return await send(jid, city + ' Weather:\n' + weather);
  }

  if (argsLower[0] === '!crypto') {
    const coin = args[1] || 'bitcoin';
    const price = await askAI(jid + '_cmd', 'Give latest price, 24h change, market cap and outlook for ' + coin + ' cryptocurrency. Be concise.');
    return await send(jid, coin.toUpperCase() + ':\n' + price);
  }

  if (argsLower[0] === '!remind') {
    const timeStr = args[1];
    const reminderMsg = args.slice(2).join(' ');
    if (!timeStr || !reminderMsg) return await send(jid, 'Usage: !remind [time] [message]\nExample: !remind 30min Call Dorcas');
    const triggerTime = parseReminderTime(timeStr);
    if (!triggerTime) return await send(jid, 'Time format: 30min, 2hour, 1day');
    setTimeout(async function() { await send(jid, 'REMINDER!\n' + reminderMsg); }, triggerTime - Date.now());
    return await send(jid, 'Reminder set for ' + timeStr + ': "' + reminderMsg + '"');
  }

  if (argsLower[0] === '!schedule') {
    const timeStr = args[1];
    const number = args[2];
    const msg = args.slice(3).join(' ');
    if (!timeStr || !number || !msg) return await send(jid, 'Usage: !schedule [time] [number] [message]\nExample: !schedule 2hour 2348012345678 Happy birthday!');
    const triggerTime = parseReminderTime(timeStr);
    if (!triggerTime) return await send(jid, 'Time format: 30min, 2hour, 1day');
    const targetJid = number.replace('+', '') + '@s.whatsapp.net';
    setTimeout(async function() { await send(targetJid, msg); }, triggerTime - Date.now());
    return await send(jid, 'Scheduled! Will send to ' + number + ' in ' + timeStr + ': "' + msg + '"');
  }

  if (argsLower[0] === '!spy') {
    const mode = args[1] || 'on';
    state.spyMode = mode === 'on';
    return await send(jid, 'Spy mode: ' + (state.spyMode ? 'ON - All conversations being logged silently' : 'OFF'));
  }

  if (argsLower[0] === '!dnd') {
    const mode = args[1] || 'on';
    state.dndMode = mode === 'on';
    if (!state.dndMode && state.dndQueue.length > 0) {
      await send(jid, 'DND OFF. You missed ' + state.dndQueue.length + ' messages:');
      for (const m of state.dndQueue) await send(jid, 'From ' + m.from + ' at ' + m.time + ':\n' + m.text);
      state.dndQueue = [];
    }
    return await send(jid, 'Do Not Disturb: ' + (state.dndMode ? 'ON - Messages queued while you are busy' : 'OFF'));
  }

  if (argsLower[0] === '!vip') {
    const number = args[1];
    if (!number) return await send(jid, 'Usage: !vip [number]\nExample: !vip 2348012345678');
    const vipJid = number.replace('+', '') + '@s.whatsapp.net';
    state.vipContacts[vipJid] = true;
    return await send(jid, number + ' is now a VIP contact!');
  }

  if (argsLower[0] === '!personality') {
    const number = args[1];
    const type = args[2];
    if (!number || !type) return await send(jid, 'Usage: !personality [number] [type]\nTypes: savage, romantic, professional, funny, motivator\nExample: !personality 2348012345678 savage');
    if (!personalities[type]) return await send(jid, 'Invalid type. Choose: savage, romantic, professional, funny, motivator');
    const targetJid = number.replace('+', '') + '@s.whatsapp.net';
    state.contactPersonalities[targetJid] = type;
    return await send(jid, 'Personality for ' + number + ' set to: ' + type);
  }

  if (argsLower[0] === '!block') {
    const number = args[1];
    if (!number) return await send(jid, 'Usage: !block [number]');
    const blockJid = number.replace('+', '') + '@s.whatsapp.net';
    state.blockedSpammers[blockJid] = true;
    return await send(jid, number + ' has been blocked!');
  }

  if (argsLower[0] === '!secret') {
    const mode = args[1] || 'on';
    state.secretMode = mode === 'on';
    return await send(jid, 'Secret mode: ' + (state.secretMode ? 'ON - Bot denies being AI to everyone' : 'OFF'));
  }

  if (cmd === '!stats') {
    const topContacts = Object.entries(state.messageCount).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 3);
    return await send(jid, 'BOT STATISTICS:\n\nTotal messages: ' + state.stats.totalMessages + '\nTotal replies: ' + state.stats.totalReplies + '\nStatuses saved: ' + state.stats.statusesSaved + '\nDeleted caught: ' + state.stats.deletedCaught + '\n\nTop contacts:\n' + topContacts.map(function(c) { return c[0].split('@')[0] + ': ' + c[1] + ' msgs'; }).join('\n'));
  }

  if (cmd === '!brief') {
    await send(jid, 'Generating your briefing...');
    return await sendDailyBriefing(jid);
  }

  if (argsLower[0] === '!status') {
    const statusText = args.slice(1).join(' ');
    if (!statusText) return await send(jid, 'Usage: !status [text to reply to status]');
    const reply = await askAI(jid + '_cmd', 'Generate a witty, engaging reply to this WhatsApp status: "' + statusText + '"');
    return await send(jid, 'Status reply suggestion:\n' + reply);
  }

  if (cmd === '!clear') {
    memory[jid] = null;
    return await send(jid, 'AI memory cleared!');
  }

  // Unknown command — AI handles it
  const aiReply = await askAI(jid, text);
  await send(jid, aiReply);
}

// ─── MAIN BOT ───
async function startBot() {
  await connectDB();
  await loadSessionFromDB();

  let authState, saveCreds;
  try {
    const fileAuth = await useMultiFileAuthState('auth');
    authState = fileAuth.state;
    saveCreds = async function() {
      await fileAuth.saveCreds();
      await saveSessionToDB();
    };
  } catch(e) {
    console.log('Auth error: ' + e.message);
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
      console.log('QR code ready! Visit /qr to scan');
    }

    if (connection === 'close') {
      const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log('Connection closed. Reconnecting: ' + shouldReconnect);
      if (shouldReconnect) setTimeout(startBot, 5000);
    }

    if (connection === 'open') {
      console.log('Wise Bot GOD TIER is LIVE!');
      const myJid = sock.user && sock.user.id;
      if (myJid) {
        await send(myJid, 'WISE BOT GOD TIER IS ONLINE!\n\nAll systems active:\nAI Brain: ON\nSpy Mode: OFF\nDND Mode: OFF\nSecret Mode: ON\nMood Detection: ON\nLanguage Detection: ON\nSpam Shield: ON\n\nType !help to see all commands.');

        // Schedule daily briefing at 7AM
        setInterval(async function() {
          const hour = getHour();
          if (hour === '07') {
            await sendDailyBriefing(myJid);
          }
        }, 3600000);
      }
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
        const senderJid = (isGroup ? msg.key.participant : jid) || jid;

        const content = msg.message;
        if (!content) continue;

        const text = content.conversation || (content.extendedTextMessage && content.extendedTextMessage.text) || (content.imageMessage && content.imageMessage.caption) || (content.videoMessage && content.videoMessage.caption) || '';
        const msgType = Object.keys(content)[0];

        state.stats.totalMessages++;
        if (!state.messageCount[jid]) state.messageCount[jid] = 0;
        state.messageCount[jid]++;

        if (text) store[msgId] = { jid: jid, text: text, time: getTime() };

        // ─── SPY MODE ───
        if (state.spyMode && !isMe && !isStatus) {
          const spyLog = 'SPY LOG\nFrom: ' + senderJid + '\nChat: ' + jid + '\nTime: ' + getTime() + '\nType: ' + msgType + '\nText: ' + (text || '[media]');
          fs.writeFileSync('saved/spy/' + Date.now() + '_' + sanitize(jid) + '.txt', spyLog);
        }

        // ─── STATUSES ───
        if (isStatus) {
          // Only save real statuses — ignore protocol/system messages
          const realStatusTypes = ['imageMessage', 'videoMessage', 'conversation', 'extendedTextMessage'];
          if (!realStatusTypes.includes(msgType)) continue;

          const sender = msg.key.participant || jid;
          const statusLog = 'Status from: ' + sender + '\nTime: ' + getTime() + '\nText: ' + (text || '[media]');
          fs.writeFileSync('saved/statuses/' + Date.now() + '.txt', statusLog);
          state.stats.statusesSaved++;

          // Forward text notification
          await send(myJid, 'New Status from ' + sender.split('@')[0] + ':\n' + (text || '[media status]'));

          // Forward actual media
          if (msgType === 'imageMessage' || msgType === 'videoMessage') {
            try {
              const mediaBuffer = await sock.downloadMediaMessage(msg);
              if (mediaBuffer && msgType === 'imageMessage') {
                await sock.sendMessage(myJid, { image: mediaBuffer, caption: text || 'Status image from ' + sender.split('@')[0] });
              } else if (mediaBuffer && msgType === 'videoMessage') {
                await sock.sendMessage(myJid, { video: mediaBuffer, caption: text || 'Status video from ' + sender.split('@')[0] });
              }
            } catch(e) {
              console.log('Status media forward error: ' + e.message);
            }
          }
          continue;
        }

        // ─── SPAM CHECK ───
        if (!isMe && text && isSpam(jid, text)) {
          console.log('Spam detected from: ' + jid);
          await send(myJid, 'SPAM DETECTED from ' + jid + ':\n' + text);
          continue;
        }

        // ─── DND MODE ───
        if (!isMe && state.dndMode && text) {
          state.dndQueue.push({ from: jid, text: text, time: getTime() });
          continue;
        }

        // ─── READ RECEIPTS TRACKING ───
        if (isMe) {
          state.readReceipts[msgId] = { text: text, sent: getTime(), read: false };
        }

        // ─── GROUPS — only reply when tagged ───
        if (isGroup) {
          const mentionedJids = (content.extendedTextMessage && content.extendedTextMessage.contextInfo && content.extendedTextMessage.contextInfo.mentionedJid) || [];
          const isMentioned = mentionedJids.some(function(j) { return j.includes(myJidClean); }) || text.includes('@' + myJidClean);
          if (!isMentioned) continue;
          const cleanText = text.replace(/@\d+/g, '').trim();
          const mood = detectMood(cleanText);
          await react(jid, msg.key, getMoodEmoji(mood));
          const reply = await askAI(senderJid, cleanText, '[Group chat message]');
          await send(jid, reply);
          continue;
        }

        // ─── MY COMMANDS ───
        if (isMe && text && text.startsWith('!')) {
          await handleCommand(jid, text, msg.key, myJid);
          continue;
        }

        // ─── AI REPLY TO MYSELF ───
        if (isMe && text && !text.startsWith('!')) {
          const reply = await askAI(jid, text);
          await send(jid, reply);
          continue;
        }

        // ─── VOICE NOTES ───
        if (msgType === 'audioMessage' || msgType === 'pttMessage') {
          const buffer = await sock.downloadMediaMessage(msg);
          if (buffer) {
            await send(jid, 'Transcribing...');
            const transcript = await transcribeVoice(buffer);
            fs.writeFileSync('saved/voice-notes/' + Date.now() + '_' + sanitize(jid) + '.txt', 'From: ' + jid + '\nTime: ' + getTime() + '\nTranscript: ' + transcript);
            if (!isMe) {
              const mood = detectMood(transcript);
              await react(jid, msg.key, getMoodEmoji(mood));
              const aiReply = await askAI(senderJid, transcript, '[Voice note: "' + transcript + '"]');
              await send(jid, 'I heard: "' + transcript + '"\n\n' + aiReply);
            } else {
              await send(jid, 'Transcription: "' + transcript + '"');
            }
          }
          continue;
        }

        // ─── IMAGES ───
        if (msgType === 'imageMessage') {
          const buffer = await sock.downloadMediaMessage(msg);
          if (buffer) {
            fs.writeFileSync('saved/media/' + Date.now() + '_' + sanitize(jid) + '_img.bin', buffer);
            await send(jid, 'Analyzing...');
            const description = await describeImage(buffer);
            if (!isMe) {
              await react(jid, msg.key, '👁️');
              const aiReply = await askAI(senderJid, text || 'React to this image', '[Image: "' + description + '"]');
              await send(jid, 'Image Analysis:\n' + description + '\n\n' + aiReply);
            } else {
              await send(jid, 'Image Analysis:\n' + description);
            }
          }
          continue;
        }

        // ─── VIDEOS ───
        if (msgType === 'videoMessage') {
          const buffer = await sock.downloadMediaMessage(msg);
          if (buffer) fs.writeFileSync('saved/media/' + Date.now() + '_' + sanitize(jid) + '_vid.bin', buffer);
          if (!isMe) {
            await react(jid, msg.key, '🎥');
            if (text) {
              const aiReply = await askAI(senderJid, text, '[User sent a video]');
              await send(jid, aiReply);
            } else {
              await send(jid, 'Video saved!');
            }
          }
          continue;
        }

        // ─── STICKERS ───
        if (msgType === 'stickerMessage') {
          fs.writeFileSync('saved/media/' + Date.now() + '_sticker.txt', 'From: ' + jid + '\nTime: ' + getTime());
          if (!isMe) {
            const reactions = ['That sticker sent me lol', 'Lmaoo okay', 'I felt that', 'Accurate', 'You funny for this', 'Nah this one got me', 'Bro sent a whole vibe'];
            await react(jid, msg.key, '😂');
            await send(jid, reactions[Math.floor(Math.random() * reactions.length)]);
          }
          continue;
        }

        // ─── DOCUMENTS ───
        if (msgType === 'documentMessage') {
          await send(jid, 'Document received and saved!');
          continue;
        }

        // ─── VIEW ONCE ───
        if (msgType === 'viewOnceMessage' || msgType === 'viewOnceMessageV2') {
          const inner = (content.viewOnceMessage && content.viewOnceMessage.message) || (content.viewOnceMessageV2 && content.viewOnceMessageV2.message);
          if (inner) {
            const innerType = Object.keys(inner)[0];
            fs.writeFileSync('saved/view-once/' + Date.now() + '.txt', 'From: ' + jid + '\nTime: ' + getTime() + '\nType: ' + innerType);
            if (!isMe) await send(myJid, 'View once message saved from ' + jid + '! Type: ' + innerType);
          }
          continue;
        }

        // ─── AI TEXT REPLIES ───
        if (!isMe && text) {
          try {
            const mood = detectMood(text);
            await react(jid, msg.key, getMoodEmoji(mood));
            const reply = await askAI(senderJid, text);
            await send(jid, reply);
          } catch(e) {
            console.log('AI error: ' + e.message);
            await send(jid, 'Give me a second, something glitched. Try again!');
          }
          continue;
        }

      } catch(e) {
        console.log('Message error: ' + e.message);
      }
    }
  });

  // ─── READ RECEIPTS ───
  sock.ev.on('message-receipt.update', async function(updates) {
    for (const update of updates) {
      if (update.receipt && update.receipt.readTimestamp) {
        const msgId = update.key.id;
        if (state.readReceipts[msgId]) {
          state.readReceipts[msgId].read = true;
          state.readReceipts[msgId].readAt = getTime();
          console.log('Message read: ' + msgId + ' at ' + state.readReceipts[msgId].readAt);
        }
      }
    }
  });

  // ─── DELETED MESSAGES ───
  sock.ev.on('messages.delete', async function(item) {
    if ('keys' in item) {
      for (const key of item.keys) {
        const s = store[key.id];
        if (s && s.text) {
          fs.writeFileSync('saved/deleted/' + key.id + '.txt', 'DELETED MESSAGE\nFrom: ' + s.jid + '\nTime: ' + s.time + '\nMessage: ' + s.text);
          state.stats.deletedCaught++;
          console.log('Deleted message saved!');
        }
      }
    }
  });

  // ─── EDITED MESSAGES ───
  sock.ev.on('messages.update', async function(updates) {
    for (const update of updates) {
      if (update.update && update.update.message) {
        const s = store[update.key.id];
        const newText = (update.update.message.conversation) || (update.update.message.extendedTextMessage && update.update.message.extendedTextMessage.text) || '';
        if (s && s.text && newText && s.text !== newText) {
          fs.writeFileSync('saved/edited/' + update.key.id + '.txt', 'EDITED MESSAGE\nFrom: ' + s.jid + '\nTime: ' + getTime() + '\nOriginal: ' + s.text + '\nEdited to: ' + newText);
          console.log('Edited message saved!');
          store[update.key.id].text = newText;
        }
      }
    }
  });
}

// ─── QR SERVER ───
let lastQR = '';

http.createServer(function(req, res) {
  if (req.url === '/reset') {
    if (sessionsCol) {
      sessionsCol.deleteMany({ _id: { $regex: '^file_' } }).then(function() {
        try { fs.rmSync('auth', { recursive: true, force: true }); } catch(e) {}
        res.writeHead(200);
        res.end('Session cleared! Restarting...');
        setTimeout(function() { process.exit(0); }, 1000);
      });
    } else {
      res.writeHead(200);
      res.end('No session to clear');
    }
    return;
  }
  if (req.url === '/qr') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    if (lastQR) {
      res.end('<html><head><meta http-equiv="refresh" content="5"></head><body style="background:#000;color:#0f0;font-family:monospace;padding:20px;text-align:center"><h2>Scan with WhatsApp</h2><img src="https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=' + encodeURIComponent(lastQR) + '" style="border:5px solid #0f0"/><p>Auto-refreshes every 5 seconds</p></body></html>');
    } else {
      res.end('<html><head><meta http-equiv="refresh" content="3"></head><body style="background:#000;color:#0f0;font-family:monospace;padding:20px"><h2>Waiting for QR... Auto-refreshing</h2><p>Visit /reset if this takes too long</p></body></html>');
    }
    return;
  }
  if (req.url === '/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ stats: state.stats, spyMode: state.spyMode, dndMode: state.dndMode, secretMode: state.secretMode, messageCount: state.messageCount }, null, 2));
    return;
  }
  res.writeHead(200);
  res.end('Wise Bot GOD TIER is alive!');
}).listen(PORT, function() { console.log('Server running on port ' + PORT); });

// ─── KEEP ALIVE ───
setInterval(function() {
  https.get('https://whatsapp-bot-611z.onrender.com', function(res) {
    console.log('Keep alive ping! Status: ' + res.statusCode);
  }).on('error', function(e) {
    console.log('Ping error: ' + e.message);
  });
}, 600000);

startBot().catch(console.error);
