const mongoose = require('mongoose');

const productConnection = mongoose.createConnection();
const connectionOptions = { serverSelectionTimeoutMS: 8000 };
let connectionPromise;

// Keep users on the URI's database and products in a separate database on the same cluster.
async function connectDB() {
    const uri = process.env.MONGO_URI?.trim();
    if (!uri) {
        const error = new Error('MONGO_URI is not configured');
        error.name = 'DatabaseConfigurationError';
        error.code = 'MISSING_MONGO_URI';
        throw error;
    }

    if (mongoose.connection.readyState === 1 && productConnection.readyState === 1) {
        return;
    }

    // Share one in-flight attempt across requests in a serverless cold start.
    if (connectionPromise) {
        return connectionPromise;
    }

    const pendingConnection = Promise.all([
        mongoose.connection.readyState === 2
            ? mongoose.connection.asPromise()
            : mongoose.connect(uri, connectionOptions),
        productConnection.readyState === 2
            ? productConnection.asPromise()
            : productConnection.openUri(uri, {
                ...connectionOptions,
                dbName: 'product'
            }).asPromise()
    ]).then(() => {
        console.log('Connected to MongoDB user and product databases');
    });

    connectionPromise = pendingConnection;
    try {
        await pendingConnection;
    } catch (error) {
        console.error('MongoDB connection failed:', databaseErrorDetails(error));
        throw error;
    } finally {
        if (connectionPromise === pendingConnection) {
            connectionPromise = null;
        }
    }
}

// Include enough detail for deployment diagnostics without printing credentials.
function databaseErrorDetails(error) {
    const uri = process.env.MONGO_URI?.trim();
    let message = String(error?.message || 'Unknown database error');
    if (uri) {
        message = message.split(uri).join('[redacted MongoDB URI]');
    }

    return {
        name: error?.name || 'Error',
        code: error?.code || error?.cause?.code || undefined,
        message: message.slice(0, 700)
    };
}

module.exports = {
    connectDB,
    productConnection,
    databaseErrorDetails
};
