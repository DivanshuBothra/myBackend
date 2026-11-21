const mongoose = require('mongoose');
const { productConnection } = require('../db/db');

// Product documents store catalogue title, product heading/details, image, price, and popularity views.
const productSchema = new mongoose.Schema({
    url:{
        type: String,
        required: true,
    },
    // Retain this optional field so older GridFS-backed product records remain readable.
    uri:{
        type: String,
    },
    // Catalogue name used to group products.
    title:{
        type: String,
        required: true,
    },
    // Product name displayed on cards and the product detail page.
    heading:{
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
    },
    viewCount:{
        type: Number,
        default: 0,
        min: 0,
    }
}, {
    versionKey: false,
    collection: 'products'
});

const ProductModel = productConnection.model('Product', productSchema);

module.exports = ProductModel;