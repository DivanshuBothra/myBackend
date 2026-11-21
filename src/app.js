const express = require('express');
const cookieParser = require('cookie-parser');
const authRoutes = require('./routes/auth.routes');
const productRoutes = require('./routes/product.routes');
const errorHandler = require('./middleware/error.middleware');
const { connectDB } = require('./db/db');
const cors = require('cors')

app.use(cors({ origin: 'http://localhost:5173', credentials: true }))
const app = express();
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
app.use(errorHandler);

app.get('/', (req, res) => {
    res.send('Backend is running successfully!');
});

module.exports = app;
