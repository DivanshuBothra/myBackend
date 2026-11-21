const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const authRoutes = require('./src/routes/auth.routes');

const app = express();
app.use(express.json());
app.use('/auth', authRoutes);

test('logout clears the authentication cookie', async () => {
    const response = await request(app)
        .post('/auth/logout')
        .set('Cookie', 'token=active-session')
        .send({});

    assert.equal(response.status, 200);
    const clearedCookie = response.headers['set-cookie']
        ?.find((cookie) => cookie.startsWith('token=;'));
    assert.ok(clearedCookie);
});
