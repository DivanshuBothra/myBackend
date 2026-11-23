const mongoose = require('mongoose');
const UserModel = require('../models/user.model');
const PushSubscriptionModel = require('../models/push-subscription.model');
const {
    isPushConfigured,
    sendPushToSubscriptions
} = require('../services/push-notification.service');

function getSubscriptionDetails(subscription) {
    const endpoint = subscription?.endpoint;
    const p256dh = subscription?.keys?.p256dh;
    const auth = subscription?.keys?.auth;

    if (typeof endpoint !== 'string' || endpoint.length > 2048 ||
        typeof p256dh !== 'string' || !/^[A-Za-z0-9_-]{8,256}$/.test(p256dh) ||
        typeof auth !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(auth)) {
        return null;
    }

    try {
        if (new URL(endpoint).protocol !== 'https:') return null;
    } catch {
        return null;
    }

    return { endpoint, p256dh, auth };
}

async function getPublicKey(req, res) {
    if (!isPushConfigured()) {
        return res.status(503).json({ message: 'Web Push notifications are not configured on the server.' });
    }
    return res.status(200).json({ publicKey: process.env.VAPID_PUBLIC_KEY.trim() });
}

async function subscribe(req, res, next) {
    const details = getSubscriptionDetails(req.body?.subscription);
    if (!details) {
        return res.status(400).json({ message: 'A valid HTTPS push subscription is required.' });
    }

    try {
        await PushSubscriptionModel.findOneAndUpdate(
            { endpoint: details.endpoint },
            {
                $set: {
                    admin_id: req.authUserId,
                    p256dh: details.p256dh,
                    auth: details.auth,
                    user_agent: String(req.get('user-agent') || '').slice(0, 500)
                }
            },
            { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
        );
        return res.status(201).json({ message: 'Order notifications are enabled for this device.' });
    } catch (error) {
        return next(error);
    }
}

async function unsubscribe(req, res, next) {
    const endpoint = req.body?.endpoint;
    if (typeof endpoint !== 'string' || endpoint.length > 2048) {
        return res.status(400).json({ message: 'A valid subscription endpoint is required.' });
    }

    try {
        if (new URL(endpoint).protocol !== 'https:') {
            return res.status(400).json({ message: 'The subscription endpoint must use HTTPS.' });
        }
    } catch {
        return res.status(400).json({ message: 'A valid subscription endpoint is required.' });
    }

    try {
        await PushSubscriptionModel.deleteOne({ endpoint, admin_id: req.authUserId });
        return res.status(200).json({ message: 'Notifications are turned off for this device.' });
    } catch (error) {
        return next(error);
    }
}

async function sendTest(req, res, next) {
    try {
        if (!isPushConfigured()) {
            return res.status(503).json({ message: 'Web Push notifications are not configured on the server.' });
        }

        const subscriptions = await PushSubscriptionModel.find({ admin_id: req.authUserId }).lean();
        if (!subscriptions.length) {
            return res.status(404).json({ message: 'This admin has no enabled notification devices.' });
        }

        const result = await sendPushToSubscriptions(subscriptions, {
            title: 'Test notification',
            body: 'Order notifications are working on this device.',
            url: '/admin?tab=orders'
        });
        if (!result.sent) {
            return res.status(502).json({ message: 'The test notification could not be delivered. Enable notifications again and retry.' });
        }

        return res.status(200).json({ message: 'Test notification sent.' });
    } catch (error) {
        return next(error);
    }
}

async function requireAdmin(req, res, next) {
    if (!mongoose.isValidObjectId(req.authUserId)) {
        return res.status(403).json({ message: 'Admin access required.' });
    }

    try {
        const user = await UserModel.findById(req.authUserId).select('role');
        if (!user || user.role !== 'admin') {
            return res.status(403).json({ message: 'Admin access required.' });
        }
        return next();
    } catch (error) {
        return next(error);
    }
}

module.exports = { getPublicKey, requireAdmin, sendTest, subscribe, unsubscribe };
