const mongoose = require('mongoose');

const productConnection = mongoose.createConnection();

// Keep users on the URI's database and connect products to a separate database on the same cluster.
async function connectDB() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB user database');

        await productConnection.openUri(process.env.MONGO_URI, {
            dbName: 'product'
        }).asPromise();
        console.log('Connected to MongoDB product database');
    }
    catch (error) {
        console.error('Error connecting to MongoDB:', error.name);
        throw error;
    }
}

module.exports = {
    connectDB,
    productConnection
};
