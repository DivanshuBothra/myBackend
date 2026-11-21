const mongoose = require('mongoose');
const { productConnection } = require('../db/db');

// Product documents store image details, product information, and popularity views; Mongo supplies _id.
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