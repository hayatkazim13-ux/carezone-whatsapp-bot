const { google } = require('googleapis');

// Helper to authenticate
async function getSheetsConfig() {
    let authOptions = {
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
    };

    // If running on Railway/Cloud, use the environment variable
    if (process.env.GOOGLE_CREDENTIALS) {
        try {
            // Extreme cleanup for Railway environments where quotes might be added to the secret
            let rawCreds = process.env.GOOGLE_CREDENTIALS || "";
            rawCreds = rawCreds.trim().replace(/^['"]|['"]$/g, '');
            
            const creds = JSON.parse(rawCreds);
            
            if (creds.private_key) {
                creds.private_key = creds.private_key
                    .replace(/\\n/g, '\n')
                    .replace(/^['"]|['"]$/g, '')
                    .trim();
            }
            authOptions.credentials = creds;
            console.log("[DEBUG] Google Credentials parsed and cleaned successfully.");
        } catch (e) {
            console.error("Error parsing GOOGLE_CREDENTIALS JSON:", e.message);
        }
    } else {
        // Fallback for local development
        authOptions.keyFile = './credentials.json';
    }

    const auth = new google.auth.GoogleAuth(authOptions);
    const client = await auth.getClient();
    return google.sheets({ version: 'v4', auth: client });
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
