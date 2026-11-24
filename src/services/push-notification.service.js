const PushSubscriptionModel = require('../models/push-subscription.model');
const UserModel = require('../models/user.model');

function getVapidConfig() {
    const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
    const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
    const subject = process.env.VAPID_SUBJECT?.trim();
    if (!publicKey || !privateKey || !subject) {
        const error = new Error('Order notifications are not configured. Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT.');
        error.status = 503;
        throw error;
    }
    if (!subject.startsWith('mailto:') && !subject.startsWith('https://')) {
        const error = new Error('VAPID_SUBJECT must be a mailto: or https:// address.');
        error.status = 503;
        throw error;
    }
    return { publicKey, privateKey, subject };
}

async function getWebPush() {
    const config = getVapidConfig();
    const webPush = await import('web-push');
    webPush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
    return webPush;
}

async function sendPushToSubscription(subscription, payload) {
    const webPush = await getWebPush();
    try {
        await webPush.sendNotification({
            endpoint: subscription.endpoint,
            keys: subscription.keys
        }, JSON.stringify(payload), { TTL: 60 });
        return true;
    } catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) {
            await PushSubscriptionModel.deleteOne({ endpoint: subscription.endpoint });
            return false;
        }
        throw error;
    }
}

async function notifyAdminsOfNewOrder(order) {
    const admins = await UserModel.find({ role: 'admin' }).select('_id').lean();
    if (admins.length === 0) return;

    const subscriptions = await PushSubscriptionModel.find({
        userId: { $in: admins.map((admin) => admin._id) }
    }).lean();
    if (subscriptions.length === 0) return;
    await getWebPush();

    const orderNumber = order.orderNumber || String(order._id);
    const amount = (Number(order.amountPaise || 0) / 100).toLocaleString('en-IN');
    const payload = {
        title: 'New order received',
        body: `${orderNumber} · ₹${amount}`,
        url: `/admin?tab=orders&orderId=${encodeURIComponent(String(order._id))}`
    };
    await Promise.allSettled(subscriptions.map((subscription) => sendPushToSubscription(subscription, payload)));
}

module.exports = {
    getVapidConfig,
    sendPushToSubscription,
    notifyAdminsOfNewOrder
};
