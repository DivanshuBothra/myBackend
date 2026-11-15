const mongoose = require('mongoose');

// Store login fields and the server-controlled role used by product authorization.
const userSchema = new mongoose.Schema({
    username: {
        type: String,
        required: true,
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
    }
});

const UserModel = mongoose.model('User', userSchema);

module.exports = UserModel;