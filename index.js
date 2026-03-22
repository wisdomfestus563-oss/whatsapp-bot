const http = require('http');
const https = require('https');
const fs = require('fs');

const GROQ_KEY = process.env.GROQ_KEY;
const ULTRAMSG_TOKEN = process.env.ULTRAMSG_TOKEN;
const ULTRAMSG_INSTANCE_ID = process.env.ULTRAMSG_INSTANCE_ID;
const PORT = process.env.PORT || 3000;

const folders = ['saved/deleted', 'saved/edited', 'saved/voice-notes', 'saved/statuses', 'saved/view-once', 'saved/media'];
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

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

// Send text message via UltraMsg
async function send(to, text) {
  console.log('Sending to:', to, '| Message:', text.substring(0, 50));
  const result = await httpsPost(
    'api.ultramsg.com',
    `/${ULTRAMSG_INSTANCE_ID}/messages/chat`,
    { token: ULTRAMSG_TOKEN, to, body: text },
    {}
  );
  console.log('Send result:', JSON.stringify(result).substring(0, 100));
}

// Forward media (image/video/audio/sticker/gif) via UltraMsg
async function forwardMedia(to, mediaUrl, caption = '', type = 'image') {
  const endpoints = {
    image: 'messages/image',
    video: 'messages/video',
    audio: 'messages/audio',
    voice: 'messages/audio',
    sticker: 'messages/sticker',
    document: 'messages/document',
  };
  const endpoint = endpoints[type] || 'messages/image';
  const body = { token: ULTRAMSG_TOKEN, to, [type === 'document' ? 'document' : type === 'sticker' ? 'sticker' : type === 'audio' || type === 'voice' ? 'audio' : type === 'video' ? 'video' : 'image']: mediaUrl, caption };
  await httpsPost('api.ultramsg.com', `/${ULTRAMSG_INSTANCE_ID}/${endpoint}`, body, {});
}

// Detect mood from message text
function detectMood(text) {
  const t = text.toLowerCase();
  if (/lol|haha|\ud83d\ude02|\ud83d\ude06|funny|joke|laugh/.test(t)) return 'funny';
  if (/angry|mad|stupid|idiot|useless|nonsense|wtf|fuck|rubbish/.test(t)) return 'savage';
  if (/sad|cry|depressed|lonely|miss|hurt|pain|broken/.test(t)) return 'empathetic';
  if (/help|how|what|why|when|explain|meaning|define/.test(t)) return 'helpful';
  if (/hi|hello|hey|sup|wassup|morning|night|afternoon/.test(t)) return 'friendly';
  if (/love|crush|relationship|date|boyfriend|girlfriend|marry/.test(t)) return 'romantic-advice';
  return 'balanced';
}

function getMoodPrompt(mood) {
  const prompts = {
    funny: 'You are hilarious and playful. Match their joke energy, be witty and entertaining.',
    savage: 'You are savage and brutally honest. Roast them back if needed. No filter but still smart.',
    empathetic: 'You are warm, caring and deeply empathetic. Comfort them, validate their feelings.',
    helpful: 'You are sharp, clear and highly informative. Answer precisely and thoroughly.',
    friendly: 'You are warm, casual and friendly like a close friend. Keep it light and fun.',
    'romantic-advice': 'You are a smooth, wise relationship advisor. Give real, honest romantic advice.',
    balanced: 'You are a savage, witty, intelligent assistant. Be real, sharp and helpful.',
  };
  return prompts[mood] || prompts.balanced;
}

// Ask Groq AI with mood awareness
async function askAI(userId, text, extraContext = '') {
  const mood = detectMood(text);
  const moodPrompt = getMoodPrompt(mood);

  if (!memory[userId]) {
    memory[userId] = [{
      role: 'system',
      content: `You are a full blown AI assistant living inside WhatsApp. You are savage, witty, intelligent, funny, empathetic \u2014 whatever the moment needs. You answer anything: school work, life advice, roasts, jokes, relationship advice, code, news, facts, stories. You remember conversation history. Keep replies concise unless asked to go deep. Never say you are an AI unless directly asked. ${moodPrompt}`
    }];
  } else {
    // Update system mood dynamically
    memory[userId][0].content = `You are a full blown AI assistant living inside WhatsApp. You are savage, witty, intelligent, funny, empathetic \u2014 whatever the moment needs. You answer anything: school work, life advice, roasts, jokes, relationship advice, code, news, facts, stories. You remember conversation history. Keep replies concise unless asked to go deep. Never say you are an AI unless directly asked. ${moodPrompt}`;
  }

  const fullText = extraContext ? `${extraContext}\n\nUser said: ${text}` : text;
  memory[userId].push({ role: 'user', content: fullText });
  if (memory[userId].length > 21) memory[userId] = [memory[userId][0], ...memory[userId].slice(-20)];

  console.log('Calling Groq AI with mood:', mood);
  const res = await httpsPost(
    'api.groq.com',
    '/openai/v1/chat/completions',
    { model: 'llama-3.3-70b-versatile', messages: memory[userId], max_tokens: 600 },
    { Authorization: `Bearer ${GROQ_KEY}` }
  );

  if (res.choices && res.choices[0]) {
    const reply = res.choices[0].message.content;
    memory[userId].push({ role: 'assistant', content: reply });
    return reply;
  }
  if (res.error) return `Error: ${res.error.message}`;
  return 'Something went wrong with the AI.';
}

// Transcribe voice note using Groq Whisper
async function transcribeVoice(audioUrl) {
  try {
    // Download audio buffer
    const audioBuffer = await httpsGet(audioUrl);
    const base64Audio = audioBuffer.toString('base64');

    // Groq Whisper via REST
    const boundary = '----FormBoundary' + Date.now();
    const audioData = Buffer.from(base64Audio, 'base64');

    const formParts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-large-v3`,
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.ogg"\r\nContent-Type: audio/ogg\r\n\r\n`,
    ];

    const formEnd = `\r\n--${boundary}--\r\n`;
    const formStart = Buffer.from(formParts.join('\r\n'));
    const formEndBuf = Buffer.from(formEnd);
    const fullBody = Buffer.concat([formStart, audioData, formEndBuf]);

    return new Promise((resolve) => {
      const req = https.request({
        hostname: 'api.groq.com',
        path: '/openai/v1/audio/transcriptions',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GROQ_KEY}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': fullBody.length,
        }
      }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(d);
            resolve(parsed.text || '[Could not transcribe]');
          } catch(e) { resolve('[Transcription failed]'); }
        });
      });
      req.on('error', () => resolve('[Transcription error]'));
      req.write(fullBody);
      req.end();
    });
  } catch(e) {
    console.log('Voice transcription error:', e.message);
    return '[Voice note received but could not be transcribed]';
  }
}

// Describe image using Groq vision
async function describeImage(imageUrl) {
  try {
    const res = await httpsPost(
      'api.groq.com',
      '/openai/v1/chat/completions',
      {
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: imageUrl } },
            { type: 'text', text: 'Describe this image in detail. Be vivid, sharp and insightful. Also comment on it like a witty human would.' }
          ]
        }],
        max_tokens: 400
      },
      { Authorization: `Bearer ${GROQ_KEY}` }
    );
    if (res.choices && res.choices[0]) return res.choices[0].message.content;
    return '[Image received but could not be analyzed]';
  } catch(e) {
    console.log('Image description error:', e.message);
    return '[Image analysis failed]';
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });

  if (req.method === 'GET') {
    res.end('WhatsApp Bot is alive! \ud83e\udd16');
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

      const msg = data.data || {};
      const msgs = msg.id ? [msg] : (data.messages || []);
      console.log('Messages count:', msgs.length);

      for (const msg of msgs) {
        const from = msg.from || msg.chat_id || '';
        const isMe = msg.fromMe === true || msg.from_me === true;
        const id = msg.id || '';
        const text = msg.body || msg.text?.body || '';
        const type = msg.type || '';
        const mediaUrl = msg.media || msg.image?.url || msg.video?.url || msg.audio?.url || msg.document?.url || '';
        const caption = msg.caption || '';

        console.log(`MSG - from: ${from} | isMe: ${isMe} | type: ${type} | text: ${text.substring(0, 50)}`);

        if (text) store[id] = { from, text, time: getTime() };

        // \u2500\u2500\u2500 SAVE & FORWARD STATUSES \u2500\u2500\u2500
        if (from === 'status@broadcast') {
          const statusLog = `From: ${from}\nTime: ${getTime()}\nType: ${type}\nText: ${text || '[media]'}\nMedia: ${mediaUrl || 'none'}`;
          fs.writeFileSync(`saved/statuses/${Date.now()}.txt`, statusLog);
          console.log('Status saved!');

          // Forward to your own DM
          if (text) await send(from.replace('status@broadcast', '') || 'me', `\ud83d\udcca *New Status Saved!*\n\n${statusLog}`);
          if (mediaUrl) {
            await send('me', `\ud83d\udcca *Status from ${from}*\n${text || ''}`);
            await forwardMedia('me', mediaUrl, text || 'Status', type === 'video' ? 'video' : type === 'audio' ? 'audio' : 'image');
          }
          continue;
        }

        // \u2500\u2500\u2500 MY COMMANDS \u2500\u2500\u2500
        if (isMe && text.startsWith('!')) {
          const cmd = text.trim().toLowerCase();
          const args = cmd.split(' ');
          console.log('Command received:', cmd);

          if (cmd === '!help') {
            await send(from, `\ud83e\udd16 *Wise Bot Commands:*\n\n\ud83d\udce6 *Saved Data:*\n\ud83d\uddd1\ufe0f !deleted\n\u270f\ufe0f !edited\n\ud83c\udfa4 !voicenotes\n\ud83d\udcca !statuses\n\ud83d\udc41\ufe0f !viewonce\n\n\ud83c\udfad *Fun:*\n\ud83d\ude02 !joke\n\ud83d\udd25 !roast [name]\n\ud83d\udca1 !advice\n\n\ud83e\udde0 *AI:*\n\ud83e\uddf9 !clear \u2014 clear AI memory\n\n\ud83d\udcac Just chat normally for AI reply!`);
            continue;
          }
          if (cmd === '!deleted') {
            const files = fs.readdirSync('saved/deleted');
            if (!files.length) { await send(from, '\ud83d\uddd1\ufe0f No deleted messages saved yet.'); continue; }
            await send(from, `\ud83d\uddd1\ufe0f Last ${Math.min(files.length, 5)} deleted messages:`);
            for (const f of files.slice(-5)) await send(from, fs.readFileSync(`saved/deleted/${f}`, 'utf8'));
            continue;
          }
          if (cmd === '!edited') {
            const files = fs.readdirSync('saved/edited');
            if (!files.length) { await send(from, '\u270f\ufe0f No edited messages yet.'); continue; }
            await send(from, `\u270f\ufe0f Last ${Math.min(files.length, 5)} edited messages:`);
            for (const f of files.slice(-5)) await send(from, fs.readFileSync(`saved/edited/${f}`, 'utf8'));
            continue;
          }
          if (cmd === '!statuses') {
            const files = fs.readdirSync('saved/statuses');
            if (!files.length) { await send(from, '\ud83d\udcca No statuses saved yet.'); continue; }
            await send(from, `\ud83d\udcca Last ${Math.min(files.length, 5)} statuses:`);
            for (const f of files.slice(-5)) await send(from, fs.readFileSync(`saved/statuses/${f}`, 'utf8'));
            continue;
          }
          if (cmd === '!voicenotes') {
            const files = fs.readdirSync('saved/voice-notes');
            if (!files.length) { await send(from, '\ud83c\udfa4 No voice notes yet.'); continue; }
            await send(from, `\ud83c\udfa4 Last ${Math.min(files.length, 3)} voice note transcriptions:`);
            for (const f of files.slice(-3)) await send(from, `\ud83c\udfa4 ${fs.readFileSync(`saved/voice-notes/${f}`, 'utf8')}`);
            continue;
          }
          if (cmd === '!joke') {
            const joke = await askAI(from + '_cmd', 'Tell me a very funny joke. Make it original and hilarious.');
            await send(from, `\ud83d\ude02 ${joke}`);
            continue;
          }
          if (args
