const mongoose = require('mongoose');
const { productConnection } = require('../db/db');

// Each Product document stores only the image URL and product details; Mongo supplies its _id.
const productSchema = new mongoose.Schema({
    url:{
        type: String,
        required: true,
    },
    // Retain this optional field so older GridFS-backed product records remain readable.
    uri:{
        type: String,
    },
    // Product name displayed to customers.
    title:{
        type: String,
        required: true,
    },
    // Descriptive product information.
    about:{
        type: String,
        required: true,
    },
    // Price stored as a number for database queries and calculations.
    price:{
        type: Number,
        required: true,
    }
}, {
    versionKey: false,
    collection: 'products'
});

const ProductModel = productConnection.model('Product', productSchema);

module.exports = ProductModel;