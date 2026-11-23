const mongoose = require('mongoose');

// Use the same MongoClient for both databases so one transaction session can
// safely update product stock and the user's order across those databases.
const productConnection = mongoose.connection.useDb('product', { useCache: true });
let connectionPromise;

// Keep users/orders on the URI database and products in the `product` database.
function connectDB() {
    if (mongoose.connection.readyState === 1) {
        return Promise.resolve();
    }
    if (connectionPromise) return connectionPromise;

    const pendingConnection = (async () => {
        try {
            if (mongoose.connection.readyState !== 1) {
                await mongoose.connect(process.env.MONGO_URI);
                console.log('Connected to MongoDB user database');
            }
            console.log('Connected to MongoDB product database through the shared client');
        } catch (error) {
            console.error('Error connecting to MongoDB:', error.name);
            throw error;
        }
    })();

    connectionPromise = pendingConnection;
    pendingConnection.then(
        () => {
            if (connectionPromise === pendingConnection) connectionPromise = null;
        },
        () => {
            if (connectionPromise === pendingConnection) connectionPromise = null;
        }
    );
    return pendingConnection;
}

module.exports = {
    connectDB,
    productConnection,
    databaseErrorDetails(error) {
        const message = String(error?.message || 'Database request failed')
            .replace(/mongodb(?:\+srv)?:\/\/[^\s"'<>]+/gi, '[redacted MongoDB URI]')
            .slice(0, 500);
        return {
            name: error?.name || 'Error',
            code: error?.code || error?.codeName || undefined,
            message
        };
    }
};
