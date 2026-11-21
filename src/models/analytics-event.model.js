const mongoose = require('mongoose');

const analyticsEventSchema = new mongoose.Schema({
    sessionId: { type: String, required: true, index: true },
    type: { type: String, enum: ['visit', 'page_exit', 'search'], required: true, index: true },
    page: { type: String, default: '' },
    keyword: { type: String, default: '' },
    durationSeconds: { type: Number, default: 0, min: 0 },
    location: { type: String, default: '' }
}, { timestamps: true, collection: 'analytics_events', versionKey: false });

module.exports = mongoose.model('AnalyticsEvent', analyticsEventSchema);
