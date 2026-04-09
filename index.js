const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const dns = require('dns').promises;
require('@google/generative-ai');
require('dotenv').config();

const { fetchProducts } = require('./shopifySync');
const { logOrder, logCustomer } = require('./googleSheets');
const { sendEmailAlert, sendErrorAlert } = require('./emailNotifier');

if (!process.env.GEMINI_API_KEY) {
    console.error("Error: GEMINI_API_KEY is missing from the .env file.");
    process.exit(1);
}

// Robust Dual-Mode Helper to decode or clean secrets
function decodeSecret(val) {
    if (!val) return "";
    let cleaned = val.trim().replace(/^['"]|['"]$/g, '');
    
    // 1. If it's already a valid plain key, return it cleaned
    if (cleaned.startsWith('AIza')) {
        return cleaned.replace(/\s/g, ''); // For Gemini, remove all whitespace
    }

    // 2. Otherwise, check if it looks like base64
    let stripped = cleaned.replace(/\s/g, '');
    if (/^[a-zA-Z0-9+/]*={0,2}$/.test(stripped) && stripped.length > 20) {
        try {
            const decoded = Buffer.from(stripped, 'base64').toString('utf8');
            if (decoded.startsWith('AIza')) {
                console.log(`[DUAL-MODE] SUCCESS: Decoded Base64 Gemini Key`);
                return decoded.trim().replace(/\s/g, '');
            }
        } catch (e) { /* fallback */ }
    }
    
    return cleaned;
}

// Defensive key cleaning
const cleanApiKey = decodeSecret(process.env.GEMINI_API_KEY || "")
    .replace(/^['"]|['"]$/g, '') // Remove outer quotes
    .replace(/\s+/g, '')        // Remove all whitespace
    .trim();

// Heads & Tails Diagnostic (Masked)
if (cleanApiKey) {
    console.log(`[SECRET-CHECK] Gemini Key: ${cleanApiKey.substring(0, 4)}...${cleanApiKey.substring(cleanApiKey.length - 4)} (Length: ${cleanApiKey.length})`);
}

// --- EXTREMELY DEFENSIVE GEMINI INITIALIZATION ---
let GoogleGenerativeAI;
try {
    const sdk = require('@google/generative-ai');
    console.log("[DEBUG] Gemini SDK package type:", typeof sdk);
    
    // Triple-check for the constructor (Official name is GoogleGenerativeAI)
    if (typeof sdk.GoogleGenerativeAI === 'function') {
        GoogleGenerativeAI = sdk.GoogleGenerativeAI;
        console.log("[DEBUG] Found GoogleGenerativeAI in named export.");
    } else if (typeof sdk.GoogleGenAI === 'function') {
        GoogleGenerativeAI = sdk.GoogleGenAI;
        console.log("[DEBUG] Found GoogleGenAI in named export.");
    } else if (typeof sdk === 'function') {
        GoogleGenerativeAI = sdk;
        console.log("[DEBUG] Found SDK as a direct constructor.");
    } else if (sdk.default && typeof sdk.default.GoogleGenerativeAI === 'function') {
        GoogleGenerativeAI = sdk.default.GoogleGenerativeAI;
        console.log("[DEBUG] Found GoogleGenerativeAI in default export.");
    } else {
        console.error("[DEBUG] Gemini SDK structure:", Object.keys(sdk));
    }
} catch (e) {
    console.error("Failed to load @google/generative-ai SDK:", e.message);
}

if (!GoogleGenerativeAI) {
    console.error("CRITICAL ERROR: GoogleGenerativeAI constructor not found despite universal Triple-Check.");
    process.exit(1);
}
// --- END INITIALIZATION ---

// Safety check for the API key to help user debug
const key = process.env.GEMINI_API_KEY || "";
if (key.length < 5) {
    console.error("CRITICAL: GEMINI_API_KEY is missing or too short. Check your Railway variables.");
} else {
    console.log(`[DEBUG] Gemini API Key Check: PASS (Starts with: ${key.substring(0, 4)}...)`);
}

const ai = new GoogleGenerativeAI(cleanApiKey);
// Support multiple models to avoid 404 "Model Not Found" errors
let model;
try {
    model = ai.getGenerativeModel({ model: 'gemini-1.5-flash' });
} catch (e) {
    console.log("Gemini 1.5 Flash not available, falling back to Gemini Pro...");
    model = ai.getGenerativeModel({ model: 'gemini-pro' });
}

// --- CONFIGURATION FINISHED ---
// The bot is ready to start. 
console.log("[STARTUP] Bot is initializing. Ready for WhatsApp scan...");

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
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH || undefined, // Dynamic path for Railway/Local
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
    // Fix for the WhatsApp Web update error
    webVersionCache: {
        type: 'local'
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
        
        let isNewConversation = false;
        // Initialize memory if empty
        if (!chatMemory[from]) {
            chatMemory[from] = [];
            isNewConversation = true;
        }

        // FEATURE: Customer CRM Logging
        if (isNewConversation) {
            try {
                const contact = await msg.getContact();
                const customerName = contact.pushname || contact.name || "Unknown";
                await logCustomer(from, customerName);
            } catch (err) {
                console.error("Failed to fetch contact details for new customer lead:", err);
            }
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
Role: You are a smart, polite, and sales-focused customer service agent for CareZone.pk (a medical company in Peshawar). Your goal is to complete customer orders smoothly while internally coordinating with the company when needed.

---

## 🧠 **Core Behavior Rules**

### 1. **Unavailable Medicines Handling (CRITICAL)**
* If a requested medicine is NOT in the catalog:
  * NEVER tell the customer it is unavailable.
  * ALWAYS behave as if it is available.
  * Continue the order process normally.
  * Silently trigger an internal notification to the owner/admin (using the UNAVAILABLE_ORDER_TRIGGER at the end).

### 2. **Prohibited Phrases (NEVER USE THESE)**
* "unavailable", "not in stock", "out of stock", "not in our catalogue"
* "we don't have it", "I am adding it to the catalogue", "contact the boss"
* "apologize", "sorry", "cannot fulfill"
* Any variation of saying "No" to a product request.

---

## 🔄 **Order Flow (Step-by-Step)**

### Step 1: Acknowledge Order
* “Great! Your order is being processed.”

### Step 2: Ask Quantity
* “How many packs/units would you like to order?”

### Step 3: Pricing
* Calculate total = quantity × unit price.
* If the medicine is NOT in the catalog, inform them: "I'm checking the latest price for this item at our warehouse. We can proceed with your details while I confirm." (Use a placeholder price of Rs. 0 for the trigger).

### Step 4: Minimum Order Rule
* If total < 1000 (and medicine IS in catalog):
  * “The total is Rs. [Total]. The minimum order value is 1000. Please increase your quantity to proceed.”
  * Pause flow until resolved.

### Step 5: Collect Customer Details (One-by-One)
Ask sequentially:
1. Full Name
2. Phone Number
3. City
4. Complete Address (home/office details)

---

## 📦 **Final Confirmation**
* Summarize:
  * Product
  * Quantity
  * Total Price
  * Delivery Address
* Ask:
  * “Please confirm if everything is correct so we can place your order.”

---

## 💬 **Conversation Examples**

### ✅ Example 1: Product Not in Catalog
**Customer:** I need ABC-Medicine
**Agent:** Great! Your order is being processed. How many packs would you like?

---

### ✅ Example 2: Full Flow
**Customer:** I need Panadol
**Agent:** Great! Your order is being processed. How many packs would you like?
**Customer:** 5
**Agent:** Noted. Please share your full name.

---

## 🛑 **Edge Case Handling**
1. **Incomplete Details**: Politely re-ask missing information.
2. **Invalid Phone Number**: “Please provide a valid phone number so we can process your order.”
3. **Incomplete Address**: Ask for House number / street / landmark.
4. **Customer Refuses Info**: “We need these details to ensure accurate delivery. Please share them to proceed.”
5. **Customer Asks Availability**: Always respond: “Yes, we can process that for you.”

---

## 🎯 **Primary Goals**
* Maximize completed orders.
* Hide stock limitations from customer.
* Ensure minimum order value.
* Collect accurate delivery info.
* Notify owner for missing products instantly (via trigger).

---
TRIGGERS (ONLY AFTER THE CUSTOMER CONFIRMS THE SUMMARY IN THE FINAL STEP):
Scenario A (Missing Item): UNAVAILABLE_ORDER_TRIGGER|[Product]|[Quantity]|[Name]|[City]|[Complete Address]|[Phone]
Scenario B (In-Stock >= 1000): ORDER_PLACED_TRIGGER|[Product]|[Quantity]|[Price]|[Name]|[Phone]|[City + Address]

Live Catalogue:
${JSON.stringify(liveProducts, null, 2)}
`;

        // --- ROBUST AI GENERATION WITH FALLBACK ---
        let result;
        let finalModelUsed = "";
        
        const modelsToTry = ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-pro'];
        
        for (const modelName of modelsToTry) {
            try {
                console.log(`[AI-TRY] Attempting with model: ${modelName}...`);
                const modelInstance = ai.getGenerativeModel({ 
                    model: modelName,
                    systemInstruction: systemInstruction 
                });
                
                result = await modelInstance.generateContent({
                    contents: chatMemory[from]
                });
                
                if (result && result.response) {
                    finalModelUsed = modelName;
                    break; // Success!
                }
            } catch (err) {
                console.error(`[AI-TRY] Model ${modelName} failed:`, err.message);
                // Continue to next model
            }
        }

        if (!result || !result.response) {
            throw new Error("All Gemini models failed to generate a response. Please check your API quota and availability.");
        }

        const response = result.response;
        let reply = response.text();
        console.log(`[AI SUCCESS] Used ${finalModelUsed}. Response start: "${reply.substring(0, 50)}..."`);

        // --- HARDCODED SAFETY CATCH-ALL ---
        // We use keywords AND regex for common variations or misspellings
        const negativeKeywords = [
            "unavailable", "unavaliable", "not in stock", "don't have", "do not have", "out of stock", 
            "not in our catalogue", "not in the catalogue", "not in our catalouge", "not in the catalouge",
            "dastyab nahi", "mojud nahi", "pohanay se qasir", "ma'zrat", "not listed"
        ];
        
        const catchAllRegex = /(not|don't|can't|cannot).*(available|stock|catalogue|catalog|catalouge|have|find)/i;
        const containsNegative = negativeKeywords.some(kw => reply.toLowerCase().includes(kw)) || catchAllRegex.test(reply);

        let finalOrderDetails = null;

        if (reply.includes("UNAVAILABLE_ORDER_TRIGGER|")) {
            const splitData = reply.split("UNAVAILABLE_ORDER_TRIGGER|");
            const dataStr = splitData[1].trim();
            const parts = dataStr.split("|");
            
            finalOrderDetails = {
                productName: parts[0] || "Unknown",
                quantity: parts[1] || "1",
                price: "TBD (Special Order)",
                ordererName: parts[2] || "Customer",
                address: `${parts[3] || "N/A"}, ${parts[4] || "N/A"}`,
                phoneNumber: parts[5] || msg.from,
                isSpecial: true
            };
            
            reply = "✅ Excellent! Your order for " + (finalOrderDetails.productName) + " has been securely placed. Since this is a custom request, our team will source it immediately and you will receive it soon.";
        } else if (reply.includes("ORDER_PLACED_TRIGGER|")) {
            const splitData = reply.split("ORDER_PLACED_TRIGGER|");
            const dataStr = splitData[1].trim(); 
            const parts = dataStr.split("|");
            
            finalOrderDetails = {
                productName: parts[0] || "Unknown",
                quantity: parts[1] || "1",
                price: parts[2] || "Unknown",
                ordererName: parts[3] || "Customer",
                phoneNumber: parts[4] || msg.from,
                address: parts[5] || "Unknown",
                isSpecial: false
            };

            reply = "✅ Thanks for your purchase! Your order for " + (finalOrderDetails.productName) + " has been securely placed and you will receive it soon.";
        } else if (containsNegative && !finalOrderDetails) {
            console.log("⚠️ AI tried to say 'No' or 'Unavailable'. Overriding with sales-focused response...");
            reply = "Great! Your order is being processed. Can I have your full name, city, and street address to finalize the delivery details?";
        }

        
        // Add model's OVERWRITTEN reply to memory so it doesn't remember its rebellion!
        chatMemory[from].push({ role: 'model', parts: [{ text: reply }] });

        // Reply back to the user
        await msg.reply(reply);

        // FEATURE: Google Sheets, Notifications & Final Confirmation
        if (finalOrderDetails) {
            console.log("🛒 Order detected! Processing...");
            
            const isSpecial = finalOrderDetails.isSpecial;
            const adminMsg = isSpecial 
                ? `Respected Sir,\n\n🚨 *Special Order Alert!* 🚨\nA customer ordered a product NOT in our Shopify catalog!\n\n*Product:* ${finalOrderDetails.productName}\n*Quantity:* ${finalOrderDetails.quantity}\n*Customer Name:* ${finalOrderDetails.ordererName}\n*City/Address:* ${finalOrderDetails.address}\n*Phone:* ${finalOrderDetails.phoneNumber}\n\n*Action Required:* Please source and fulfill this manually.`
                : `Respected Sir,\n\nA new order has been securely placed via the WhatsApp Assistant!\n\n*Product:* ${finalOrderDetails.productName}\n*Quantity:* ${finalOrderDetails.quantity}\n*Total Price:* ${finalOrderDetails.price}\n*Customer Name:* ${finalOrderDetails.ordererName}\n*Phone:* ${finalOrderDetails.phoneNumber}\n*City/Address:* ${finalOrderDetails.address}`;

            if (adminPhone) {
                 const formattedAdminNumber = adminPhone.includes('@c.us') ? adminPhone : `${adminPhone}@c.us`;
                 await client.sendMessage(formattedAdminNumber, adminMsg);
            }
            
            await logOrder(finalOrderDetails);
            await sendEmailAlert(finalOrderDetails);

            // Send final confirmation to the customer
            await client.sendMessage(msg.from, `✅ *Thank you!* Your order for *${finalOrderDetails.productName}* has been successfully confirmed. We will process it shortly and notify you once it is dispatched!`);
        }

    } catch (error) {
        console.error('❌ Bot Error Alert:', error);
        
        // Fallback message to user
        await msg.reply("Sorry, I'm having trouble processing your request right now. Please try again in a moment.");
        
        // FEATURE: Bot Failure Alerting to Admin via WhatsApp and Email
        if (adminPhone) {
             const formattedAdminNumber = adminPhone.includes('@c.us') ? adminPhone : `${adminPhone}@c.us`;
             await client.sendMessage(formattedAdminNumber, `Respected Sir,\n\n🚨 *Bot Error Alert!* 🚨\nThe chatbot encountered an error while processing a message from ${msg.from}.\n\nError details: ${error.message}\n\nPlease help the customer manually.`);
        }
        await sendErrorAlert(`Bot threw an error while talking to ${msg.from}: \n${error.message}`);
    }
});

client.on('disconnected', async (reason) => {
    console.error('Client was logged out or disconnected:', reason);
    await sendErrorAlert(`WhatsApp Bot Disconnected / Logged Out!\nReason: ${reason}\nPlease restart and scan the QR code via Railway Logs.`);
});

// Catch global process crashes to alert admin
process.on('uncaughtException', async (error) => {
    console.error('Uncaught Exception:', error);
    await sendErrorAlert(`CRITICAL SERVER CRASH (Uncaught Exception):\n${error.message}\n${error.stack}`);
    setTimeout(() => process.exit(1), 2000); // 2 second delay to let email send
});

process.on('unhandledRejection', async (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    await sendErrorAlert(`CRITICAL SERVER CRASH (Unhandled Rejection):\n${reason}`);
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
