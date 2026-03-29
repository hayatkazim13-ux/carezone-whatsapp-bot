const { google } = require('googleapis');

async function logOrder(orderDetails) {
    try {
        const auth = new google.auth.GoogleAuth({
            keyFile: './credentials.json',
            scopes: ['https://www.googleapis.com/auth/spreadsheets']
        });

        const client = await auth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: client });
        
        const spreadsheetId = process.env.SPREADSHEET_ID;
        if (!spreadsheetId) {
            console.log("No SPREADSHEET_ID found in .env. Skipping Google Sheets logging.");
            return;
        }

        const values = [
            [
                orderDetails.productName,
                orderDetails.price || "Unknown",
                orderDetails.ordererName,
                orderDetails.address,
                "New Order",
                "No",
                ""
            ]
        ];

        const resource = { values };
        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: 'A:G',
            valueInputOption: 'USER_ENTERED',
            resource
        });

        console.log("Order logged to Google Sheets.");
    } catch (e) {
        console.error("Failed to log order to Google Sheets:", e.message);
    }
}

module.exports = { logOrder };
