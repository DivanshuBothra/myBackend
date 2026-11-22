const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { connectDB, productConnection } = require('./src/db/db');

test('database connections are shared across concurrent API requests', async (t) => {
    const originalConnect = mongoose.connect;
    const originalOpenUri = productConnection.openUri;
    const originalUserState = mongoose.connection.readyState;
    const originalProductState = productConnection.readyState;
    let userConnectCalls = 0;
    let productConnectCalls = 0;

    t.after(() => {
        mongoose.connect = originalConnect;
        productConnection.openUri = originalOpenUri;
        mongoose.connection.readyState = originalUserState;
        productConnection.readyState = originalProductState;
    });

    mongoose.connection.readyState = 0;
    productConnection.readyState = 0;
    mongoose.connect = async () => {
        userConnectCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        mongoose.connection.readyState = 1;
        return mongoose;
    };
    productConnection.openUri = async () => {
        productConnectCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        productConnection.readyState = 1;
        return productConnection;
    };

    await Promise.all([connectDB(), connectDB(), connectDB()]);
    await connectDB();

    assert.equal(userConnectCalls, 1);
    assert.equal(productConnectCalls, 1);
});
