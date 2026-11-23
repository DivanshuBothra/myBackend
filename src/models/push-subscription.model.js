const mongoose = require('mongoose');

const pushSubscriptionSchema = new mongoose.Schema({
    admin_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    endpoint: {
        type: String,
        required: true,
        unique: true,
        trim: true
    },
    p256dh: { type: String, required: true },
    auth: { type: String, required: true },
    user_agent: { type: String, default: '', maxlength: 500 }
}, {
    collection: 'push_subscriptions',
    timestamps: { createdAt: 'created_at', updatedAt: false }
});

module.exports = mongoose.model('PushSubscription', pushSubscriptionSchema);
