const axios = require('axios');

async function fetchProducts() {
    try {
        console.log("Fetching ALL live products from Carezone.pk...");
        let allProducts = [];
        let page = 1;
        let hasMore = true;

        while (hasMore) {
            const url = `https://carezone.pk/products.json?limit=250&page=${page}`;
            const response = await axios.get(url);
            
            if (!response.data || !response.data.products || response.data.products.length === 0) {
                hasMore = false;
                break;
            }

            const products = response.data.products.map(p => {
                return {
                    name: p.title,
                    price: p.variants[0] ? p.variants[0].price : "Unknown",
                    in_stock: p.variants[0] ? p.variants[0].available : false
                };
            });

            allProducts = allProducts.concat(products);
            page++;
            
            // Safety break to prevent infinite loops on massive stores
            if (page > 30) break;
        }

        console.log(`Successfully fetched ${allProducts.length} TOTAL products.`);
        return allProducts;
    } catch (error) {
        console.error("Error fetching products from Shopify:", error.message);
        return []; 
    }
}

module.exports = { fetchProducts };
