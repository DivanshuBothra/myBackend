const mongoose = require('mongoose');

const addressSchema = new mongoose.Schema({
    fullName: { type: String, required: true, trim: true, maxlength: 100 },
    line1: { type: String, required: true, trim: true, maxlength: 150 },
    line2: { type: String, trim: true, maxlength: 150, default: '' },
    city: { type: String, required: true, trim: true, maxlength: 80 },
    state: { type: String, required: true, trim: true, maxlength: 80 },
    pincode: { type: String, required: true, match: /^\d{6}$/ }
}, { _id: false });

// Store login fields, the normalized role, and the user's delivery address.
const userSchema = new mongoose.Schema({
    username: {
        type: String,
        required: true,
        maxlength: 16,
        trim: true,
    },
    phonenum: {
        type: String,
        required: true,
        unique: true,
    },
    password: {
        type: String,
        required: true,
    },
    role: {
        type: String,
        enum: ['user', 'admin'],
        default: 'user'
    },
    address: {
        type: addressSchema,
        default: null
    },
});

const UserModel = mongoose.model('User', userSchema);

module.exports = UserModel;