const mongoose = require('mongoose');

const productConnection = mongoose.createConnection();
let connectionPromise;

// Keep users on the URI's database and connect products to a separate database on the same cluster.
function connectDB() {
    if (mongoose.connection.readyState === 1 && productConnection.readyState === 1) {
        return Promise.resolve();
    }
    if (connectionPromise) return connectionPromise;

    const pendingConnection = (async () => {
        try {
            if (mongoose.connection.readyState !== 1) {
                await mongoose.connect(process.env.MONGO_URI);
                console.log('Connected to MongoDB user database');
            }

            if (productConnection.readyState !== 1) {
                await productConnection.openUri(process.env.MONGO_URI, {
                    dbName: 'product'
                });
                console.log('Connected to MongoDB product database');
            }
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
    productConnection
};
