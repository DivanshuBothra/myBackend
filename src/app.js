const express = require('express');
const cookieParser = require('cookie-parser');
const authRoutes = require('./routes/auth.routes');
const productRoutes = require('./routes/product.routes');
const errorHandler = require('./middleware/error.middleware');
const { connectDB } = require('./db/db');

// Establish the database connection when this module loads.
// vercel.json routes all requests directly to this file (not through server.js),
// so connectDB() must be called here — server.js is not executed on Vercel.
connectDB().catch((err) => console.error('Database connection failed on startup:', err.name));

const app = express();
app.use(express.json());
app.use(cookieParser());
// Mount the authentication and product APIs under their respective prefixes.
app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use(errorHandler);

app.get('/', (req, res) => {
    res.send('Backend is running successfully!');
});
module.exports = app;
