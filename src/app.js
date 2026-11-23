const express = require('express');
const cookieParser = require('cookie-parser');
const authRoutes = require('./routes/auth.routes');
const productRoutes = require('./routes/product.routes');
const ordersRoutes = require('./routes/orders.routes');
const analyticsRoutes = require('./routes/analytics.routes');
const pushRoutes = require('./routes/push.routes');
const errorHandler = require('./middleware/error.middleware');
const { connectDB } = require('./db/db');
const cors = require('cors')

const app = express();
const allowedFrontendOrigins = new Set([
    'http://localhost:5190',
    'http://127.0.0.1:5190',
    ...(process.env.FRONTEND_ORIGIN || '').split(',').map((origin) => origin.trim()).filter(Boolean)
]);

app.use(cors({
    origin(origin, callback) {
        if (!origin || allowedFrontendOrigins.has(origin)) return callback(null, true);
        return callback(null, false);
    },
    credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// vercel.json sends requests directly to this module, so wait for MongoDB
// before any API controller reads or writes data.
app.use('/api', async (req, res, next) => {
    try {
        await connectDB();
        next();
    } catch (error) {
        next(error);
    }
});

// Mount the authentication and product APIs under their respective prefixes.
app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/push', pushRoutes);
app.use(errorHandler);

app.get('/', (req, res) => { 
    res.send('Backend is running successfully!');
});

module.exports = app;
