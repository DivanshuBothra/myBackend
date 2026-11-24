const PushSubscriptionModel = require('../models/push-subscription.model');
const UserModel = require('../models/user.model');
const { getVapidConfig, sendPushToSubscription } = require('../services/push-notification.service');

async function ensureAdmin(req, res) {
    const user = await UserModel.findById(req.authUserId).select('role');
    if (!user) {
        res.status(401).json({ message: 'Please sign in to continue.' });
        return false;
    }
    if (user.role !== 'admin') {
        res.status(403).json({ message: 'Admin access required.' });
        return false;
    }
    return true;
}

async function getPublicKey(req, res, next) {
    try {
        if (!await ensureAdmin(req, res)) return;
        return res.status(200).json({ publicKey: getVapidConfig().publicKey });
    } catch (error) {
        return next(error);
    }
}

async function subscribe(req, res, next) {
    try {
        if (!await ensureAdmin(req, res)) return;
        getVapidConfig();
        const subscription = req.body?.subscription;
        let endpoint;
        try {
            endpoint = new URL(subscription?.endpoint);
        } catch {
            return res.status(400).json({ message: 'A valid browser notification subscription is required.' });
        }
        if (endpoint.protocol !== 'https:' ||
            typeof subscription?.keys?.p256dh !== 'string' || !subscription.keys.p256dh ||
            typeof subscription?.keys?.auth !== 'string' || !subscription.keys.auth) {
            return res.status(400).json({ message: 'A valid browser notification subscription is required.' });
        }

        await PushSubscriptionModel.findOneAndUpdate(
            { endpoint: endpoint.href },
            {
                $set: {
                    userId: req.authUserId,
                    endpoint: endpoint.href,
                    keys: {
                        p256dh: subscription.keys.p256dh,
                        auth: subscription.keys.auth
                    }
                }
            },
            { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
        );
        return res.status(201).json({ subscribed: true });
    } catch (error) {
        return next(error);
    }
}

async function unsubscribe(req, res, next) {
    try {
        if (!await ensureAdmin(req, res)) return;
        const endpoint = req.body?.endpoint;
        if (typeof endpoint !== 'string' || !endpoint.trim()) {
            return res.status(400).json({ message: 'A subscription endpoint is required.' });
        }
        await PushSubscriptionModel.deleteOne({ userId: req.authUserId, endpoint: endpoint.trim() });
        return res.status(200).json({ subscribed: false });
    } catch (error) {
        return next(error);
    }
}

async function sendTest(req, res, next) {
    try {
        if (!await ensureAdmin(req, res)) return;
        getVapidConfig();
        const subscriptions = await PushSubscriptionModel.find({ userId: req.authUserId }).lean();
        if (subscriptions.length === 0) {
            return res.status(409).json({ message: 'Enable notifications on this device first.' });
        }

        const results = await Promise.allSettled(subscriptions.map((subscription) => sendPushToSubscription(
            subscription,
            { title: 'Order notifications', body: 'This device can receive new order alerts.', url: '/admin' }
        )));
        if (!results.some((result) => result.status === 'fulfilled' && result.value)) {
            return res.status(410).json({ message: 'This device subscription has expired. Enable notifications again.' });
        }
        return res.status(200).json({ message: 'Test notification sent.' });
    } catch (error) {
        return next(error);
    }
}

module.exports = { getPublicKey, subscribe, unsubscribe, sendTest };
