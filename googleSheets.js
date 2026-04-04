const { google } = require('googleapis');

// Helper to authenticate
async function getSheetsConfig() {
    const auth = new google.auth.GoogleAuth({
        keyFile: './credentials.json',
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
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
