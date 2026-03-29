const axios = require('axios');

async function fetchProducts() {
    try {
        console.log("Fetching live products from Carezone.pk...");
        // Using Shopify's public products.json endpoint
        const response = await axios.get('https://carezone.pk/products.json?limit=250');
        
        if (!response.data || !response.data.products) {
            throw new Error("Invalid response format from Shopify");
        }

        // Map the complex Shopify data into a simple, clean list for the AI
        const products = response.data.products.map(p => {
            // Remove HTML tags from the description
            const cleanDescription = p.body_html 
                ? p.body_html.replace(/<[^>]*>?/gm, '').substring(0, 150) + "..."
                : "No description available";

            return {
                id: p.id,
                name: p.title,
                price: p.variants[0] ? `Rs. ${p.variants[0].price}` : "Unknown price",
                in_stock: p.variants[0] ? p.variants[0].available : false,
                description: cleanDescription
            };
        });

        console.log(`Successfully fetched ${products.length} products.`);
        return products;
    } catch (error) {
        console.error("Error fetching products from Shopify:", error.message);
        return []; // Return empty array on failure so bot doesn't crash
    }
}

module.exports = { fetchProducts };
