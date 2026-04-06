const nodemailer = require('nodemailer');

async function sendEmailAlert(orderDetails) {
    const email = process.env.ADMIN_EMAIL;
    const password = process.env.ADMIN_EMAIL_PASSWORD; // Must be a Gmail App Password

    if (!email || !password) {
        console.log("No ADMIN_EMAIL or ADMIN_EMAIL_PASSWORD in .env. Skipping Email notification.");
        return;
    }

    try {
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: email,
                pass: password
            }
        });

        const mailText = `
🚨 New Order Received from WhatsApp Chatbot 🚨

Customer Name: ${orderDetails.ordererName}
Address: ${orderDetails.address}
Product: ${orderDetails.productName}
Price: ${orderDetails.price}

A new row has also been securely logged to your Google Sheet!
`;

        const mailOptions = {
            from: email,
            to: email, // Admin sends email to themselves as an alert
            subject: '🚨 New Order Received from WhatsApp Chatbot',
            text: mailText
        };

        await transporter.sendMail(mailOptions);
        console.log("✅ Email notification sent to Admin.");
    } catch (e) {
        console.error("❌ Failed to send Email notification:", e.message);
    }
}

async function sendErrorAlert(errorMessage) {
    const email = process.env.ADMIN_EMAIL;
    const password = process.env.ADMIN_EMAIL_PASSWORD; // Must be a Gmail App Password

    if (!email || !password) return;

    try {
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: email,
                pass: password
            }
        });

        const mailOptions = {
            from: email,
            to: email, // Admin sends email to themselves
            subject: '🔴 ALERT: WhatsApp Bot Error / Offline',
            text: `Carezone Bot Error Alert:\n\n${errorMessage}\n\nPlease check your Railway server logs.`
        };

        await transporter.sendMail(mailOptions);
    } catch (e) {
        console.error("❌ Failed to send Error Email notification:", e.message);
    }
}

module.exports = { sendEmailAlert, sendErrorAlert };
