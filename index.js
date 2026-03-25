const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { MongoClient } = require('mongodb');
const fs = require('fs');
const https = require('https');
const http = require('http');
const pino = require('pino');

// ===== ENV =====
const GROQ_KEY = process.env.GROQ_KEY;
const MONGODB_URI = process.env.MONGODB_URI;
const PORT = process.env.PORT || 3000;
const MY_NUMBER = process.env.MY_NUMBER || '';

// ===== FOLDERS =====
['saved/deleted','saved/edited','saved/statuses','saved/voice-notes','saved/media','saved/view-once','saved/spy','auth'].forEach(function(f){
  fs.mkdirSync(f, { recursive: true });
});

// ===== STATE =====
const memory = {};
const store = {};
const spamTracker = {};
let sock;
let lastQR = '';
let db, sessionsCol;

const botState = {
  spyMode: false,
  dndMode: false,
  dndQueue: [],
  secretMode: true,
  vipContacts: {},
  personalities: {},
  stats: { messages: 0, replies: 0, statusesSaved: 0, deletedCaught: 0 }
};

const personalityPrompts = {
  savage: 'You are savage, brutal and have zero filter. Roast them, clap back hard.',
  romantic: 'You are smooth, warm and deeply romantic. Speak with affection.',
  professional: 'You are formal, precise and professional. No slang.',
  funny: 'You are a comedian. Make every reply hilarious.',
  motivator: 'You are an intense motivational coach. Hype them up hard.',
  default: 'You are a savage witty intelligent human. Match the energy of whoever texts you.'
};

// ===== MONGODB =====
async function connectDB(){
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db('wisebot');
    sessionsCol = db.collection('sessions');
    console.log('MongoDB connected!');
  } catch(e){ console.log('MongoDB error: ' + e.message); }
}

async function saveSessionToDB(){
  if (!sessionsCol) return;
  try {
    if (!fs.existsSync('auth')) return;
    const files = fs.readdirSync('auth');
    for (const file of files){
      const data = fs.readFileSync('auth/' + file, 'utf8');
      await sessionsCol.updateOne({ _id: 'file_' + file }, { $set: { data: data } }, { upsert: true });
    }
    console.log('Session saved to MongoDB!');
  } catch(e){ console.log('Session save error: ' + e.message); }
}

async function loadSessionFromDB(){
  if (!sessionsCol) return false;
  try {
    const docs = await sessionsCol.find({ _id: { $regex: '^file_' } }).toArray();
    if (!docs || docs.length === 0) return false;
    if (!fs.existsSync('auth')) fs.mkdirSync('auth', { recursive: true });
    for (const doc of docs){
      fs.writeFileSync('auth/' + doc._id.replace('file_', ''), doc.data);
    }
    console.log('Session restored from MongoDB!');
    return true;
  } catch(e){ return false; }
}

// ===== UTILS =====
function getTime(){ return new Date().toLocaleString('en-NG', { timeZone: 'Africa/Lagos' }); }
function sanitize(str){ return str.replace(/[^a-z0-9]/gi, ''); }

function detectMood(text){
  const t = text.toLowerCase();
  if (/lol|haha|funny|joke|laugh/.test(t)) return 'funny';
  if (/angry|mad|stupid|idiot|wtf|rubbish/.test(t)) return 'savage';
  if (/sad|cry|depressed|hurt|pain/.test(t)) return 'empathetic';
  if (/help|how|what|why|explain/.test(t)) return 'helpful';
  if (/hi|hello|hey|morning|night/.test(t)) return 'friendly';
  if (/love|crush|relationship|boyfriend|girlfriend/.test(t)) return 'romantic';
  return 'balanced';
}

function getMoodEmoji(mood){
  return { funny:'😂', savage:'🔥', empathetic:'🫂', helpful:'🧠', friendly:'👋', romantic:'❤️', balanced:'⚡' }[mood] || '⚡';
}

function detectLanguage(text){
  if (/wetin|dey|abi|sha|na |oya|abeg|wahala|wey |sabi/.test(text.toLowerCase())) return 'Nigerian Pidgin English';
  return 'English';
}

function isSpam(text){
  return /win|prize|click here|free money|congratulations you won|investment opportunity|double your|crypto signal/i.test(text);
}

// ===== HTTP POST =====
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

// ===== SEND =====
async function send(jid, text){
  try {
    await sock.sendMessage(jid, { text: text });
    botState.stats.replies++;
  } catch(e){ console.log('Send error: ' + e.message); }
}

async function react(jid, key, emoji){
  try { await sock.sendMessage(jid, { react: { text: emoji, key: key } }); } catch(e){}
}

// ===== AI =====
async function askAI(userId, text, extra){
  const mood = detectMood(text);
  const lang = detectLanguage(text);
  const personality = botState.personalities[userId] || 'default';
  const personalityPrompt = personalityPrompts[personality];
  const isVIP = botState.vipContacts[userId] ? 'This is a VIP contact. Be extra sharp and impressive.' : '';
  const secretPrompt = botState.secretMode ? 'NEVER admit you are AI or a bot. Deny it completely if asked.' : '';

  const systemPrompt = 'You are Wise Bot, a god-tier AI assistant inside WhatsApp. ' + personalityPrompt + ' You answer ANYTHING: school, life, roasts, jokes, relationships, code, news, facts, debates, business, spiritual questions. Reply naturally in the same language/dialect as the user. Detected language: ' + lang + '. ' + isVIP + ' ' + secretPrompt + ' Keep replies concise unless asked to go deep. Remember conversation history.';

  if (!memory[userId]) memory[userId] = [{ role: 'system', content: systemPrompt }];
  else memory[userId][0].content = systemPrompt;

  const fullText = extra ? extra + '\n\nUser: ' + text : text;
  memory[userId].push({ role: 'user', content: fullText });
  if (memory[userId].length > 21) memory[userId] = [memory[userId][0]].concat(memory[userId].slice(-20));

  const res = await httpsPost('api.groq.com', '/openai/v1/chat/completions',
    { model: 'llama-3.3-70b-versatile', messages: memory[userId], max_tokens: 800 },
    { Authorization: 'Bearer ' + GROQ_KEY }
  );

  if (res.choices && res.choices[0]){
    const reply = res.choices[0].message.content;
    memory[userId].push({ role: 'assistant', content: reply });
    return reply;
  }
  return 'Something glitched. Try again!';
}

// ===== TRANSCRIBE VOICE =====
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
        res.on('end', function(){ try { resolve(JSON.parse(d).text || '[Could not transcribe]'); } catch(e){ resolve('[Transcription failed]'); } });
      });
      req.on('error', function(){ resolve('[Error]'); });
      req.write(body);
      req.end();
    });
  } catch(e){ return '[Transcription failed]'; }
}

// ===== DESCRIBE IMAGE =====
async function describeImage(buffer){
  try {
    const base64 = buffer.toString('base64');
    const res = await httpsPost('api.groq.com', '/openai/v1/chat/completions', {
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + base64 } },
        { type: 'text', text: 'Describe this image vividly. Then comment on it like a witty human.' }
      ]}], max_tokens: 500
    }, { Authorization: 'Bearer ' + GROQ_KEY });
    if (res.choices && res.choices[0]) return res.choices[0].message.content;
    return '[Image analysis failed]';
  } catch(e){ return '[Image analysis failed]'; }
}

// ===== PARSE TIME =====
function parseTime(str){
  const m = str.match(/(\d+)\s*(min|hour|hr|day|sec)/i);
  if (!m) return null;
  const val = parseInt(m[1]);
  const mult = { sec:1000, min:60000, hour:3600000, hr:3600000, day:86400000 };
  return Date.now() + val * (mult[m[2].toLowerCase()] || 60000);
}

// ===== DAILY BRIEFING =====
async function sendDailyBriefing(myJid){
  const brief = await askAI('briefing_' + Date.now(), 'Give me a powerful daily briefing. Include: 1) Top world news 2) Motivational quote 3) Productivity tip 4) Lagos Nigeria weather tip 5) Fun fact. Be energetic and sharp! Speak Pidgin English.');
  await send(myJid, 'GOOD MORNING! Your Daily Briefing:\n\n' + brief);
}

// ===== COMMANDS =====
async function handleCommand(jid, text, key, myJid){
  const cmd = text.trim().toLowerCase();
  const parts = text.trim().split(' ');
  const lparts = cmd.split(' ');

  await react(jid, key, '⚡');

  if (cmd === '!help'){
    return await send(jid, 'WISE BOT - GOD TIER\n\nSAVED DATA:\n!deleted\n!edited\n!statuses\n!voicenotes\n\nFUN:\n!joke\n!roast [name]\n!advice\n!summarize\n\nUTILITY:\n!translate [lang] [text]\n!search [query]\n!crypto [coin]\n!weather [city]\n!remind [time] [msg]\n!schedule [time] [number] [msg]\n\nGOD TIER:\n!spy on/off\n!dnd on/off\n!vip [number]\n!personality [number] [type]\n!stats\n!brief\n!block [number]\n!secret on/off\n!clear\n\nPersonalities: savage, romantic, professional, funny, motivator');
  }

  if (cmd === '!deleted'){
    const files = fs.readdirSync('saved/deleted');
    if (!files.length) return await send(jid, 'No deleted messages yet.');
    await send(jid, 'Last deleted messages:');
    for (const f of files.slice(-5)) await send(jid, fs.readFileSync('saved/deleted/' + f, 'utf8'));
    return;
  }

  if (cmd === '!edited'){
    const files = fs.readdirSync('saved/edited');
    if (!files.length) return await send(jid, 'No edited messages yet.');
    await send(jid, 'Last edited messages:');
    for (const f of files.slice(-5)) await send(jid, fs.readFileSync('saved/edited/' + f, 'utf8'));
    return;
  }

  if (cmd === '!statuses'){
    const files = fs.readdirSync('saved/statuses');
    if (!files.length) return await send(jid, 'No statuses saved yet.');
    await send(jid, 'Last ' + Math.min(files.length, 5) + ' statuses:');
    for (const f of files.slice(-5)) await send(jid, fs.readFileSync('saved/statuses/' + f, 'utf8'));
    return;
  }

  if (cmd === '!voicenotes'){
    const files = fs.readdirSync('saved/voice-notes');
    if (!files.length) return await send(jid, 'No voice notes yet.');
    await send(jid, 'Last transcriptions:');
    for (const f of files.slice(-3)) await send(jid, fs.readFileSync('saved/voice-notes/' + f, 'utf8'));
    return;
  }

  if (cmd === '!joke') return await send(jid, await askAI(jid + '_cmd', 'Tell a very funny original joke. Be hilarious.'));
  
  if (lparts[0] === '!roast'){
    const target = parts.slice(1).join(' ') || 'yourself';
    return await send(jid, await askAI(jid + '_cmd', 'Give a savage roast about "' + target + '". Be brutal but funny.'));
  }

  if (cmd === '!advice') return await send(jid, await askAI(jid + '_cmd', 'Give one powerful deep life advice. Be real and motivating.'));

  if (cmd === '!summarize'){
    const hist = memory[jid];
    if (!hist || hist.length < 3) return await send(jid, 'Not enough conversation yet.');
    return await send(jid, 'Summary:\n' + await askAI(jid + '_cmd', 'Summarize briefly:\n' + hist.slice(1).map(function(m){ return m.role + ': ' + m.content; }).join('\n')));
  }

  if (lparts[0] === '!translate'){
    const lang = parts[1] || 'English';
    const txt = parts.slice(2).join(' ');
    if (!txt) return await send(jid, 'Usage: !translate [lang] [text]');
    return await send(jid, lang + ': ' + await askAI(jid + '_cmd', 'Translate to ' + lang + ' (reply ONLY with translation): "' + txt + '"'));
  }

  if (lparts[0] === '!search'){
    const q = parts.slice(1).join(' ');
    if (!q) return await send(jid, 'Usage: !search [query]');
    return await send(jid, await askAI(jid + '_cmd', 'Give accurate info about: "' + q + '". Be thorough.'));
  }

  if (lparts[0] === '!weather'){
    const city = parts.slice(1).join(' ') || 'Lagos';
    return await send(jid, city + ' Weather:\n' + await askAI(jid + '_cmd', 'Weather summary for ' + city + '. Include temp, conditions, tip.'));
  }

  if (lparts[0] === '!crypto'){
    const coin = parts[1] || 'bitcoin';
    return await send(jid, coin.toUpperCase() + ':\n' + await askAI(jid + '_cmd', 'Latest price and info for ' + coin + ' crypto.'));
  }

  if (lparts[0] === '!remind'){
    const t = parts[1]; const rmsg = parts.slice(2).join(' ');
    if (!t || !rmsg) return await send(jid, 'Usage: !remind [time] [msg]\nExample: !remind 30min Call Dorcas');
    const trigger = parseTime(t);
    if (!trigger) return await send(jid, 'Format: 30min, 2hour, 1day');
    setTimeout(async function(){ await send(jid, 'REMINDER!\n' + rmsg); }, trigger - Date.now());
    return await send(jid, 'Reminder set for ' + t + ': "' + rmsg + '"');
  }

  if (lparts[0] === '!schedule'){
    const t = parts[1]; const num = parts[2]; const smsg = parts.slice(3).join(' ');
    if (!t || !num || !smsg) return await send(jid, 'Usage: !schedule [time] [number] [msg]');
    const trigger = parseTime(t);
    if (!trigger) return await send(jid, 'Format: 30min, 2hour, 1day');
    setTimeout(async function(){ await send(num.replace('+','') + '@s.whatsapp.net', smsg); }, trigger - Date.now());
    return await send(jid, 'Scheduled to ' + num + ' in ' + t + ': "' + smsg + '"');
  }

  if (lparts[0] === '!spy'){
    botState.spyMode = parts[1] !== 'off';
    return await send(jid, 'Spy mode: ' + (botState.spyMode ? 'ON' : 'OFF'));
  }

  if (lparts[0] === '!dnd'){
    botState.dndMode = parts[1] !== 'off';
    if (!botState.dndMode && botState.dndQueue.length){
      await send(jid, 'DND OFF. Missed ' + botState.dndQueue.length + ' messages:');
      for (const m of botState.dndQueue) await send(jid, 'From ' + m.from + ' at ' + m.time + ':\n' + m.text);
      botState.dndQueue = [];
    }
    return await send(jid, 'DND: ' + (botState.dndMode ? 'ON' : 'OFF'));
  }

  if (lparts[0] === '!vip'){
    const vnum = parts[1];
    if (!vnum) return await send(jid, 'Usage: !vip [number]');
    botState.vipContacts[vnum.replace('+','') + '@s.whatsapp.net'] = true;
    return await send(jid, vnum + ' is now VIP!');
  }

  if (lparts[0] === '!personality'){
    const pnum = parts[1]; const ptype = parts[2];
    if (!pnum || !ptype || !personalityPrompts[ptype]) return await send(jid, 'Usage: !personality [number] [type]\nTypes: savage, romantic, professional, funny, motivator');
    botState.personalities[pnum.replace('+','') + '@s.whatsapp.net'] = ptype;
    return await send(jid, pnum + ' personality set to: ' + ptype);
  }

  if (lparts[0] === '!block'){
    const bnum = parts[1];
    if (!bnum) return await send(jid, 'Usage: !block [number]');
    spamTracker[bnum.replace('+','') + '@s.whatsapp.net'] = 999;
    return await send(jid, bnum + ' blocked!');
  }

  if (lparts[0] === '!secret'){
    botState.secretMode = parts[1] !== 'off';
    return await send(jid, 'Secret mode: ' + (botState.secretMode ? 'ON' : 'OFF'));
  }

  if (cmd === '!stats'){
    const top = Object.entries(memory).filter(function(e){ return e[0].includes('@s.whatsapp.net'); }).slice(0,3);
    return await send(jid, 'BOT STATS:\nMessages: ' + botState.stats.messages + '\nReplies: ' + botState.stats.replies + '\nStatuses saved: ' + botState.stats.statusesSaved + '\nDeleted caught: ' + botState.stats.deletedCaught);
  }

  if (cmd === '!brief'){
    await send(jid, 'Generating briefing...');
    return await sendDailyBriefing(jid);
  }

  if (cmd === '!clear'){
    memory[jid] = null;
    return await send(jid, 'Memory cleared!');
  }

  // Default — AI handles unknown commands
  const reply = await askAI(jid, text);
  await send(jid, reply);
}

// ===== MAIN BOT =====
async function start(){
  await connectDB();
  await loadSessionFromDB();

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
    await saveSessionToDB();
  });

  sock.ev.on('connection.update', async function(update){
    if (update.qr){
      lastQR = update.qr;
      console.log('QR ready! Visit /qr');
    }
    if (update.connection === 'open'){
      console.log('WISE BOT GOD TIER IS LIVE!');
      const myJid = sock.user && sock.user.id;
      if (myJid){
        await send(myJid, 'WISE BOT GOD TIER ONLINE!\n\nAI: ON | Spy: OFF | DND: OFF | Secret: ON\n\nType !help for commands.');
        // Daily briefing at 7AM
        setInterval(async function(){
          const h = new Date().toLocaleString('en-NG', { timeZone:'Africa/Lagos', hour:'2-digit', hour12:false });
          if (h === '07') await sendDailyBriefing(myJid);
        }, 3600000);
      }
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

        const content = msg.message;
        if (!content) continue;

        const msgType = Object.keys(content)[0];
        const text = content.conversation || (content.extendedTextMessage && content.extendedTextMessage.text) || (content.imageMessage && content.imageMessage.caption) || (content.videoMessage && content.videoMessage.caption) || '';

        botState.stats.messages++;
        if (text) store[msgId] = { jid: jid, text: text, time: getTime() };

        // ===== STATUSES =====
        if (isStatus){
          const realTypes = ['imageMessage','videoMessage','conversation','extendedTextMessage'];
          if (!realTypes.includes(msgType)) continue;

          const senderNum = (msg.key.participant || jid).split('@')[0];
          let contactName = senderNum;
          try {
            const contacts = await sock.fetchStatus(msg.key.participant || jid);
            if (contacts && contacts.status) contactName = contacts.status;
          } catch(e){}

          // Save status log
          fs.writeFileSync('saved/statuses/' + Date.now() + '.txt', 'From: ' + senderNum + '\nName: ' + contactName + '\nTime: ' + getTime() + '\nType: ' + msgType + '\nText: ' + (text || '[media]'));
          botState.stats.statusesSaved++;

          // Forward actual media to my DM
          if (msgType === 'imageMessage'){
            try {
              const buffer = await sock.downloadMediaMessage(msg);
              if (buffer) await sock.sendMessage(myJid, { image: buffer, caption: contactName + ' posted a status' + (text ? ': ' + text : '') });
            } catch(e){ await send(myJid, contactName + ' posted an image status' + (text ? ': ' + text : '')); }
          } else if (msgType === 'videoMessage'){
            try {
              const buffer = await sock.downloadMediaMessage(msg);
              if (buffer) await sock.sendMessage(myJid, { video: buffer, caption: contactName + ' posted a status' + (text ? ': ' + text : '') });
            } catch(e){ await send(myJid, contactName + ' posted a video status' + (text ? ': ' + text : '')); }
          } else if (text){
            await send(myJid, contactName + ' posted a status:\n\n' + text);
          }
          continue;
        }

        // ===== SPY MODE =====
        if (botState.spyMode && !isMe && !isStatus){
          fs.writeFileSync('saved/spy/' + Date.now() + '_' + sanitize(jid) + '.txt', 'FROM: ' + senderJid + '\nCHAT: ' + jid + '\nTIME: ' + getTime() + '\nTYPE: ' + msgType + '\nTEXT: ' + (text || '[media]'));
        }

        // ===== SPAM CHECK =====
        if (!isMe && text && isSpam(text)){
          await send(myJid, 'SPAM from ' + senderJid + ':\n' + text);
          continue;
        }

        // ===== DND MODE =====
        if (!isMe && botState.dndMode && text){
          botState.dndQueue.push({ from: senderJid, text: text, time: getTime() });
          continue;
        }

        // ===== GROUPS =====
        if (isGroup){
          const mentioned = (content.extendedTextMessage && content.extendedTextMessage.contextInfo && content.extendedTextMessage.contextInfo.mentionedJid) || [];
          const tagged = mentioned.some(function(j){ return j.includes(myJidClean); }) || text.includes('@' + myJidClean);
          if (!tagged) continue;
          const clean = text.replace(/@\d+/g, '').trim();
          await react(jid, msg.key, getMoodEmoji(detectMood(clean)));
          await send(jid, await askAI(senderJid, clean, '[Group message]'));
          continue;
        }

        // ===== MY COMMANDS =====
        if (isMe && text && text.startsWith('!')){
          await handleCommand(jid, text, msg.key, myJid);
          continue;
        }

        // ===== AI REPLY TO MYSELF =====
        if (isMe && text && !text.startsWith('!')){
          await send(jid, await askAI(jid, text));
          continue;
        }

        // ===== VOICE NOTES =====
        if (msgType === 'audioMessage' || msgType === 'pttMessage'){
          try {
            const buffer = await sock.downloadMediaMessage(msg);
            if (buffer){
              if (!isMe) await send(jid, 'Transcribing...');
              const transcript = await transcribeVoice(buffer);
              fs.writeFileSync('saved/voice-notes/' + Date.now() + '_' + sanitize(jid) + '.txt', 'From: ' + jid + '\nTime: ' + getTime() + '\nTranscript: ' + transcript);
              if (!isMe){
                await react(jid, msg.key, '🎤');
                const reply = await askAI(senderJid, transcript, '[Voice note: "' + transcript + '"]');
                await send(jid, 'I heard: "' + transcript + '"\n\n' + reply);
              } else {
                await send(jid, 'Transcription: "' + transcript + '"');
              }
            }
          } catch(e){ console.log('Voice error: ' + e.message); }
          continue;
        }

        // ===== IMAGES =====
        if (msgType === 'imageMessage'){
          try {
            const buffer = await sock.downloadMediaMessage(msg);
            if (buffer){
              fs.writeFileSync('saved/media/' + Date.now() + '_' + sanitize(jid) + '.bin', buffer);
              if (!isMe) await send(jid, 'Analyzing...');
              const desc = await describeImage(buffer);
              if (!isMe){
                await react(jid, msg.key, '👁️');
                const reply = await askAI(senderJid, text || 'React to this', '[Image: "' + desc + '"]');
                await send(jid, 'Image Analysis:\n' + desc + '\n\n' + reply);
              } else {
                await send(jid, 'Image Analysis:\n' + desc);
              }
            }
          } catch(e){ console.log('Image error: ' + e.message); }
          continue;
        }

        // ===== VIDEOS =====
        if (msgType === 'videoMessage'){
          try {
            const buffer = await sock.downloadMediaMessage(msg);
            if (buffer) fs.writeFileSync('saved/media/' + Date.now() + '_vid_' + sanitize(jid) + '.bin', buffer);
          } catch(e){}
          if (!isMe){
            await react(jid, msg.key, '🎥');
            if (text) await send(jid, await askAI(senderJid, text, '[Video sent]'));
            else await send(jid, 'Video saved!');
          }
          continue;
        }

        // ===== STICKERS =====
        if (msgType === 'stickerMessage'){
          if (!isMe){
            const reactions = ['That sticker sent me lol', 'Lmaoo', 'I felt that', 'Accurate af', 'You funny for this', 'Bro sent a whole vibe'];
            await react(jid, msg.key, '😂');
            await send(jid, reactions[Math.floor(Math.random() * reactions.length)]);
          }
          continue;
        }

        // ===== VIEW ONCE =====
        if (msgType === 'viewOnceMessage' || msgType === 'viewOnceMessageV2'){
          const inner = (content.viewOnceMessage && content.viewOnceMessage.message) || (content.viewOnceMessageV2 && content.viewOnceMessageV2.message);
          if (inner){
            const itype = Object.keys(inner)[0];
            fs.writeFileSync('saved/view-once/' + Date.now() + '.txt', 'From: ' + jid + '\nTime: ' + getTime() + '\nType: ' + itype);
            if (!isMe) await send(myJid, 'View once saved from ' + jid + '! Type: ' + itype);
          }
          continue;
        }

        // ===== DOCUMENTS =====
        if (msgType === 'documentMessage'){
          if (!isMe) await send(jid, 'Document received!');
          continue;
        }

        // ===== AI TEXT REPLIES =====
        if (!isMe && text){
          try {
            const mood = detectMood(text);
            await react(jid, msg.key, getMoodEmoji(mood));
            const reply = await askAI(senderJid, text);
            await send(jid, reply);
            botState.stats.replies++;
          } catch(e){
            console.log('AI error: ' + e.message);
            await send(jid, 'Give me a sec. Try again!');
          }
        }

      } catch(e){ console.log('Message error: ' + e.message); }
    }
  });

  // ===== DELETED MESSAGES =====
  sock.ev.on('messages.delete', async function(item){
    if ('keys' in item){
      for (const key of item.keys){
        const s = store[key.id];
        if (s && s.text){
          fs.writeFileSync('saved/deleted/' + key.id + '.txt', 'DELETED\nFrom: ' + s.jid + '\nTime: ' + s.time + '\nMessage: ' + s.text);
          botState.stats.deletedCaught++;
        }
      }
    }
  });

  // ===== EDITED MESSAGES =====
  sock.ev.on('messages.update', async function(updates){
    for (const update of updates){
      if (update.update && update.update.message){
        const s = store[update.key.id];
        const newText = (update.update.message.conversation) || (update.update.message.extendedTextMessage && update.update.message.extendedTextMessage.text) || '';
        if (s && s.text && newText && s.text !== newText){
          fs.writeFileSync('saved/edited/' + update.key.id + '.txt', 'EDITED\nFrom: ' + s.jid + '\nTime: ' + getTime() + '\nOriginal: ' + s.text + '\nNew: ' + newText);
          store[update.key.id].text = newText;
        }
      }
    }
  });
}

// ===== HTTP SERVER =====
http.createServer(function(req, res){
  if (req.url === '/qr'){
    res.writeHead(200, { 'Content-Type': 'text/html' });
    if (lastQR){
      res.end('<html><head><meta http-equiv="refresh" content="5"></head><body style="background:#000;color:#0f0;font-family:monospace;padding:20px;text-align:center"><h2>Scan with WhatsApp</h2><img src="https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=' + encodeURIComponent(lastQR) + '" style="border:5px solid #0f0"/><p>Auto-refreshes every 5s</p></body></html>');
    } else {
      res.end('<html><head><meta http-equiv="refresh" content="3"></head><body style="background:#000;color:#0f0;padding:20px"><h2>Waiting for QR... Auto-refreshing</h2></body></html>');
    }
    return;
  }
  if (req.url === '/reset'){
    if (sessionsCol){
      sessionsCol.deleteMany({ _id: { $regex: '^file_' } }).then(function(){
        try { fs.rmSync('auth', { recursive: true, force: true }); } catch(e){}
        res.writeHead(200);
        res.end('Session cleared! Restarting...');
        setTimeout(function(){ process.exit(0); }, 1000);
      });
    } else {
      res.writeHead(200);
      res.end('No session to clear');
    }
    return;
  }
  if (req.url === '/stats'){
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(botState.stats));
    return;
  }
  res.writeHead(200);
  res.end('WISE BOT GOD TIER IS ALIVE!');
}).listen(PORT, function(){ console.log('Server on port ' + PORT); });

// ===== KEEP ALIVE =====
setInterval(function(){
  https.get('https://whatsapp-bot-611z.onrender.com', function(res){
    console.log('Keep alive! Status: ' + res.statusCode);
  }).on('error', function(){});
}, 600000);

// ===== START =====
start().catch(console.error);
