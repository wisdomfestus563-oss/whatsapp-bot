const express = require('express');
const app = express();

app.get('/', (req, res) => {
    res.send('WISE BOT IS ALIVE 😈');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));// WISE BOT - GOD MODE (ALL-IN-ONE)

const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { MongoClient } = require('mongodb');
const fs = require('fs');
const https = require('https');
const pino = require('pino');

// ===== ENV =====
const GROQ_KEY = process.env.GROQ_KEY;
const MONGODB_URI = process.env.MONGODB_URI;
const MY_NUMBER = "2348153024304@s.whatsapp.net";

// ===== FOLDERS =====
['auth','saved/deleted','saved/edited','saved/voice','saved/status','saved/media','saved/viewonce']
.forEach(f => fs.mkdirSync(f, { recursive: true }));

// ===== DB =====
let db;
async function connectDB(){
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db("wisebot");
    console.log("DB Connected");
}
connectDB();

// ===== AI CALL =====
function askAI(prompt){
    return new Promise((resolve)=>{
        const data = JSON.stringify({
            model: "llama-3.3-70b-versatile",
            messages: [{ role:"user", content: prompt }]
        });

        const req = https.request({
            hostname:"api.groq.com",
            path:"/openai/v1/chat/completions",
            method:"POST",
            headers:{
                "Authorization":"Bearer "+GROQ_KEY,
                "Content-Type":"application/json",
                "Content-Length":data.length
            }
        },res=>{
            let d="";
            res.on("data",c=>d+=c);
            res.on("end",()=>{
                try{
                    const j = JSON.parse(d);
                    resolve(j.choices[0].message.content);
                }catch{
                    resolve("AI error");
                }
            });
        });

        req.on("error",()=>resolve("AI failed"));
        req.write(data);
        req.end();
    });
}

// ===== BOT =====
async function start(){
    const { state, saveCreds } = await useMultiFileAuthState('auth');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: "silent" })
    });

    sock.ev.on('creds.update', saveCreds);

    // ===== MESSAGE HANDLER =====
    sock.ev.on('messages.upsert', async ({ messages })=>{
        const msg = messages[0];
        if (!msg.message) return;

        const jid = msg.key.remoteJid;
        const isGroup = jid.endsWith("@g.us");

        let text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];

        // ===== GROUP RULE (FIXED PROPERLY) =====
        if (isGroup && !mentioned.includes(MY_NUMBER)) return;

        // ===== SAVE MEDIA =====
        fs.writeFileSync("saved/media/"+Date.now()+".txt", text);

        // ===== DELAY =====
        await new Promise(r=>setTimeout(r, Math.random()*3000+1000));

        // ===== AI =====
        let reply = await askAI("Reply like a smart savage human: "+text);

        // ===== SEND =====
        await sock.sendMessage(jid,{ text: reply });

    });

    // ===== DELETE CATCH =====
    sock.ev.on('messages.update', async (updates)=>{
        for(const u of updates){
            if(u.update.message === null){
                fs.writeFileSync("saved/deleted/"+Date.now()+".txt", JSON.stringify(u));
            }
        }
    });

    // ===== CONNECTION =====
    sock.ev.on('connection.update', ({ connection, lastDisconnect })=>{
        if(connection === "close"){
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if(shouldReconnect) start();
        } else if(connection === "open"){
            console.log("🔥 GOD BOT LIVE");
        }
    });
}

start();
