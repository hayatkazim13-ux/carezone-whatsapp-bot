const { google } = require('googleapis');

// Robust Dual-Mode Helper to decode or clean secrets
function decodeSecret(val) {
    if (!val) return "";
    let cleaned = val.trim().replace(/^['"]|['"]$/g, '');
    
    // Helper to remove invisible control characters that break JSON.parse
    const sanitize = (s) => s.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim();

    // 1. If it's already a valid plain JSON string or Private Key, return it cleaned
    if (cleaned.includes('{') || cleaned.includes('PRIVATE KEY')) {
        return sanitize(cleaned).replace(/\\n/g, '\n'); 
    }

    // 2. Otherwise, check if it's Base64
    let stripped = cleaned.replace(/\s/g, '');
    if (/^[a-zA-Z0-9+/]*={0,2}$/.test(stripped) && stripped.length > 50) {
        try {
            const decoded = Buffer.from(stripped, 'base64').toString('utf8');
            if (decoded.includes('{') || decoded.includes('PRIVATE KEY')) {
                console.log(`[DUAL-MODE] SUCCESS: Decoded Base64 Credentials`);
                return sanitize(decoded);
            }
        } catch (e) { /* fallback */ }
    }
    
    return sanitize(cleaned);
}

// Helper to authenticate
async function getSheetsConfig() {
    let authOptions = {
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
    };

    // If running on Railway/Cloud, use the environment variable
    if (process.env.GOOGLE_CREDENTIALS) {
        try {
            // Use Base64-aware decoding
            let rawCreds = decodeSecret(process.env.GOOGLE_CREDENTIALS);
            
            const creds = JSON.parse(rawCreds);
            const email = creds.client_email || "MISSING";
            console.log(`[DEBUG] Using Google Service Account: ${email}`);
            
            if (creds.private_key) {
                // Nuclear Scrubbing: Remove EVERYTHING suspicious
                creds.private_key = creds.private_key
                    .replace(/\\n/g, '\n')   // Fix escaped newlines
                    .replace(/\r/g, '')      // Remove carriage returns
                    .replace(/^['"]|['"]$/g, '') // Remove outer quotes
                    .trim();
                
                // Heads & Tails Diagnostic (Masked)
                const pk = creds.private_key;
                const head = pk.substring(0, 25).replace(/\n/g, '[NL]');
                const tail = pk.substring(pk.length - 25).replace(/\n/g, '[NL]');
                console.log(`[SECRET-CHECK] Private Key Head: ${head}...`);
                console.log(`[SECRET-CHECK] Private Key Tail: ...${tail}`);
            }
            authOptions.credentials = creds;
            console.log("[DEBUG] Google Credentials parsed and cleaned successfully.");
        } catch (e) {
            console.error("[DIAGNOSTIC] Error parsing GOOGLE_CREDENTIALS JSON:", e.message);
        }
    } else {
        console.warn("[DIAGNOSTIC] GOOGLE_CREDENTIALS environment variable is MISSING.");
        // Fallback for local development
        authOptions.keyFile = './credentials.json';
    }

    const auth = new google.auth.GoogleAuth(authOptions);
    
    try {
        const client = await auth.getClient();
        return google.sheets({ version: 'v4', auth: client });
    } catch (error) {
        console.error("[DIAGNOSTIC] Google Sheets Auth FAILED");
        console.error(`[DIAGNOSTIC] Error Message: ${error.message}`);
        if (error.response && error.response.data) {
            console.error(`[DIAGNOSTIC] Raw Error Data: ${JSON.stringify(error.response.data)}`);
        }
        throw error;
    }
}

async function logCustomer(phoneNumber, name) {
    try {
        const spreadsheetId = process.env.SPREADSHEET_ID;
        if (!spreadsheetId) return;

        const sheets = await getSheetsConfig();
        const dateStr = new Date().toLocaleString('en-US', { timeZone: 'Asia/Karachi' });
        
        const values = [[dateStr, phoneNumber, name]];
        const resource = { values };
        
        // Target the 'Customers' tab specifically
        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: 'Customers!A:C', 
            valueInputOption: 'USER_ENTERED',
            resource
        });
        console.log(`Customer ${name} (${phoneNumber}) logged to Google Sheets.`);
    } catch (e) {
        console.error("Failed to log customer to Google Sheets:", e.message);
    }
}

async function logOrder(orderDetails) {
    try {
        const spreadsheetId = process.env.SPREADSHEET_ID;
        if (!spreadsheetId) {
            console.log("No SPREADSHEET_ID found in .env. Skipping Google Sheets logging.");
            return;
        }

        const sheets = await getSheetsConfig();

        const values = [
            [
                orderDetails.productName,
                orderDetails.price || "Unknown",        // B: Total Price
                orderDetails.ordererName,
                orderDetails.address,                 // D: City + Delivery Place
                "New Order",                          // E: Status
                "No",                                 // F: Paid
                orderDetails.quantity || "Unknown",   // G: Quantity inserted here
                orderDetails.phoneNumber || "Unknown" // H: Phone Number
            ]
        ];

        const resource = { values };
        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: 'A:H',
            valueInputOption: 'USER_ENTERED',
            resource
        });

        console.log("Order logged to Google Sheets.");
    } catch (e) {
        console.error("Failed to log order to Google Sheets:", e.message);
    }
}

module.exports = { logOrder, logCustomer };
