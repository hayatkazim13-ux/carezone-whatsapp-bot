const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleGenAI } = require('@google/genai');
require('dotenv').config();

const { fetchProducts } = require('./shopifySync');
const { logOrder } = require('./googleSheets');
const { sendEmailAlert } = require('./emailNotifier');

if (!process.env.GEMINI_API_KEY) {
    console.error("Error: GEMINI_API_KEY is missing from the .env file.");
    process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
// Clean the admin phone number to contain only numbers (strips '+' and spaces)
const adminPhoneRaw = process.env.ADMIN_PHONE_NUMBER || "";
const adminPhone = adminPhoneRaw.replace(/[^0-9]/g, '');

// Store conversation memory: { 'phoneNumber@c.us': [ { role: 'user'|'model', parts: [{ text }] } ] }
const chatMemory = {};

let liveProducts = [];

// Fetch products immediately on startup, and then every 1 hour
async function updateProductCache() {
    liveProducts = await fetchProducts();
}
updateProductCache();
setInterval(updateProductCache, 60 * 60 * 1000);

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { 
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process', // This helps significantly with memory
            '--disable-gpu'
        ] 
    },
    // Fix for the WhatsApp Web update error (i.getLastMsgKeyForAction is not a function)
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
    }
});

client.on('qr', async (qr) => {
    console.log('\n===========================================================');
    console.log('Scan the QR code below with your WhatsApp to log in the bot:');
    console.log('===========================================================\n');
    qrcode.generate(qr, { small: true });
    
    // Fallback: Generate a clickable web link with a perfect image!
    const qrLink = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
    console.log('\n🚨 IF THE SQUARE ABOVE IS BROKEN, CLICK THIS LINK TO OPEN A PERFECT PICTURE:');
    console.log(qrLink);
    console.log('===========================================================\n');
});

client.on('ready', () => {
    console.log('\n✅ Client is ready! The WhatsApp AI Assistant is online and listening.');
});

// FEATURE: Call Handling (Reject incoming calls and notify)
client.on('call', async (call) => {
    try {
        await call.reject();
        
        let callerName = "";
        try {
            const contact = await client.getContactById(call.from);
            if (contact && (contact.pushname || contact.name)) {
                callerName = (contact.pushname || contact.name);
            }
        } catch (err) { }
        
        const finalName = callerName ? ` ${callerName}` : "";

        // Send a polite message to the user calling
        await client.sendMessage(call.from, `Sorry${finalName}, I can't take calls right now. You can contact our CEO at ${adminPhone}. I’ve informed him; he’ll be in touch.`);
        
        // Notify admin
        if (adminPhone) {
            const formattedAdmin = adminPhone.includes('@c.us') ? adminPhone : `${adminPhone}@c.us`;
            await client.sendMessage(formattedAdmin, `Respected Sir,\n\n🚨 *Missed Call Alert!* 🚨\nCustomer${finalName} (${call.from}) just tried to call the bot.`);
        }
    } catch (e) {
        console.error("Error handling call rejection:", e);
    }
});

client.on('message', async msg => {
    if (msg.isStatus) return;
    if (msg.fromMe) return;

    try {
        const from = msg.from;
        
        // Initialize memory if empty
        if (!chatMemory[from]) {
            chatMemory[from] = [];
        }

        // We prepare the parts array for Gemini
        const userParts = [];

        // Determine the message text
        let promptText = "";
        
        if (msg.hasMedia) {
            const media = await msg.downloadMedia();
            if (media && media.mimetype.includes('audio')) {
                // FEATURE: Voice Note Processing
                userParts.push({
                    inlineData: {
                        mimeType: media.mimetype.split(';')[0],
                        data: media.data
                    }
                });
                promptText = "The user sent a voice note. Here is the audio. Please transcribe it, understand it (Urdu/Pashto/English), and respond conversationally.";
            } else if (media && media.mimetype.includes('image')) {
                userParts.push({
                    inlineData: {
                        mimeType: media.mimetype.split(';')[0],
                        data: media.data
                    }
                });
                promptText = msg.body ? `The user sent an image with caption: ${msg.body}` : "The user sent an image. What is this?";
            } else {
                promptText = "Unsupported media type sent. Acknowledge this politely without fulfilling it.";
            }
        } else {
            promptText = msg.body || "";
        }

        // If it's pure text or if we added a prompt
        if (promptText) {
            userParts.push({ text: promptText });
        }

        if (userParts.length === 0) {
            return; // Ignore empty or unsupported messages so Gemini doesn't crash
        }

        // Add user's new message to memory
        chatMemory[from].push({ role: 'user', parts: userParts });

        // Keep memory from getting infinitely large (keep last 15 interactions)
        if (chatMemory[from].length > 15) {
            chatMemory[from] = chatMemory[from].slice(-15);
        }

        // System instructions (System prompt)
        const systemInstruction = `
Role: Human-like AI Assistant for CareZone.pk (Peshawar).
Operational Environment: Extreme efficiency required. No robotic fillers. No lengthy explanations. Act like a busy but helpful human staff member. Use minimum words.

Core Instructions:
1. Greeting: If this is the start of a new conversation, immediately start with: "Nice to meet you! Thanks for choosing CareZone. Can I have your name?"
2. Language Mirroring: Strictly match the customer's language (English ↔ English, Urdu ↔ Urdu/Roman Urdu).
3. Inventory Management: Fetch from the LIVE product catalogue below. If the exact product is NOT found in the catalogue, you MUST say exactly: "[Product Name] is unavailable. I've alerted the owner to add it to our catalogue." AND append the trigger UNAVAILABLE_ITEM_TRIGGER|[Product Name] to the very end of your response.
4. Closing: ONLY use "Best wishes" and "Thanks" when the conversation is truly ending (like after an order is confirmed or they say goodbye). DO NOT repeat it on every single message.

Live Catalogue:
${JSON.stringify(liveProducts, null, 2)}

Order Processing:
If they want to order available items, keep it extremely brief. Ask them to confirm the exact [Product Name] and their full [Delivery Address]. 
CRITICAL INSTRUCTION: If the user provides their final delivery address and confirms their order, you MUST append this exact phrase to the VERY END of your response ONLY ONCE:
ORDER_PLACED_TRIGGER|[Product Name]|[Price]|[Customer Name]|[Delivery Address]
`;

        // Send chat history to Gemini
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: chatMemory[from],
            config: {
                systemInstruction: systemInstruction,
            }
        });

        let reply = response.text;
        
        // Add model's reply to memory
        chatMemory[from].push({ role: 'model', parts: [{ text: reply }] });

        // Check for the secret missing item trigger
        let unavailableTriggered = false;
        let missingItemName = "";

        if (reply.includes("UNAVAILABLE_ITEM_TRIGGER|")) {
            unavailableTriggered = true;
            const splitData = reply.split("UNAVAILABLE_ITEM_TRIGGER|");
            missingItemName = splitData[1].trim();
            reply = splitData[0].trim();
        }

        // Check for the secret order trigger
        let orderTriggered = false;
        let orderDetails = null;

        if (reply.includes("ORDER_PLACED_TRIGGER|")) {
            orderTriggered = true;
            const splitData = reply.split("ORDER_PLACED_TRIGGER|");
            const dataStr = splitData[1].trim(); 
            const parts = dataStr.split("|");
            
            orderDetails = {
                productName: parts[0] || "Unknown",
                price: parts[1] || "Unknown",
                ordererName: parts[2] || "Customer",
                address: parts[3] || "Unknown"
            };

            // Remove the trigger text from the reply before sending to user
            reply = splitData[0].trim();
        }
        
        // Reply back to the user
        await msg.reply(reply);

        // Notify admin about the missing inventory
        if (unavailableTriggered && adminPhone) {
            console.log(`⚠️ Missing Item Requested: ${missingItemName}. Notifying admin...`);
            const formattedAdminNumber = adminPhone.includes('@c.us') ? adminPhone : `${adminPhone}@c.us`;
            await client.sendMessage(formattedAdminNumber, `Respected Sir,\n\nA customer (${msg.from}) requested an item that isn't in our catalogue: *${missingItemName}*.\nThey were informed that you have been notified to add it.`);
        }

        // FEATURE: Google Sheets & Email Alert
        if (orderTriggered && orderDetails) {
            console.log("🛒 Order detected! Logging to sheets and notifying admin...");
            
            if (adminPhone) {
                 const formattedAdminNumber = adminPhone.includes('@c.us') ? adminPhone : `${adminPhone}@c.us`;
                 await client.sendMessage(formattedAdminNumber, `Respected Sir,\n\nA new order has been securely placed via the WhatsApp Assistant!\n\n*Product:* ${orderDetails.productName}\n*Price:* ${orderDetails.price}\n*Customer Name:* ${orderDetails.ordererName}\n*Delivery Address:* ${orderDetails.address}\n\n*Customer WhatsApp:* ${msg.from}`);
            }
            
            await logOrder(orderDetails);
            await sendEmailAlert(orderDetails);

            // Send final confirmation to the customer
            await client.sendMessage(msg.from, `✅ *Thank you!* Your order for *${orderDetails.productName}* has been successfully confirmed. We will process it shortly and notify you once it is dispatched!`);
        }

    } catch (error) {
        console.error('❌ Bot Error Alert:', error);
        
        // Fallback message to user
        await msg.reply("Sorry, I'm having trouble processing your request right now. Please try again in a moment.");
        
        // FEATURE: Bot Failure Alerting to Admin
        if (adminPhone) {
             const formattedAdminNumber = adminPhone.includes('@c.us') ? adminPhone : `${adminPhone}@c.us`;
             await client.sendMessage(formattedAdminNumber, `Respected Sir,\n\n🚨 *Bot Error Alert!* 🚨\nThe chatbot encountered an error while processing a message from ${msg.from}.\n\nError details: ${error.message}\n\nPlease help the customer manually.`);
        }
    }
});

client.initialize();

// Dummy web server to satisfy Railway/Cloud health checks
const http = require('http');
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('WhatsApp Assistant is safely running in the background!\n');
}).listen(port, () => {
    console.log(`\n🌐 Dummy web server active on port ${port} (satisfies Railway health checks)`);
});
