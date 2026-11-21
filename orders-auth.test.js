const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const ordersRoutes = require('./src/routes/orders.routes');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/orders', ordersRoutes);

test('all order and checkout API routes reject unauthenticated requests', async () => {
    const requests = [
        request(app).get('/orders/mine'),
        request(app).post('/orders').send({ items: [] }),
        request(app).post('/orders/razorpay').send({ items: [] }),
        request(app).post('/orders/example/cancel').send({}),
        request(app).get('/orders/example')
    ];

    const responses = await Promise.all(requests);
    for (const response of responses) {
        assert.equal(response.status, 401);
        assert.equal(response.body.message, 'Please sign in to continue.');
    }
});
