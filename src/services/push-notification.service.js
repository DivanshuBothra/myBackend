const webPush = require('web-push');
const PushSubscriptionModel = require('../models/push-subscription.model');

const vapidSubject = process.env.VAPID_SUBJECT?.trim();
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY?.trim();
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY?.trim();
const pushConfigured = Boolean(vapidSubject && vapidPublicKey && vapidPrivateKey);

// Configure once when the app loads; the private key stays on the server.
if (pushConfigured) {
    webPush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
}

async function sendPushToSubscriptions(subscriptions, payload) {
    const results = await Promise.all(subscriptions.map(async (subscription) => {
        try {
            await webPush.sendNotification(
                {
                    endpoint: subscription.endpoint,
                    keys: { p256dh: subscription.p256dh, auth: subscription.auth }
                },
                JSON.stringify(payload),
                { urgency: 'high', TTL: 60 * 60 }
            );
            return 'sent';
        } catch (error) {
            const statusCode = Number(error.statusCode || error.status);
            if (statusCode === 404 || statusCode === 410 || statusCode === 401 || statusCode === 403) {
                await PushSubscriptionModel.deleteOne({ endpoint: subscription.endpoint }).catch((deleteError) => {
                    console.error('Could not remove an expired push subscription:', deleteError.name);
                });
                if (statusCode === 401 || statusCode === 403) {
                    console.error('Removed a push subscription rejected by the push service; the admin device will resubscribe on its next admin visit.');
                }
                return 'expired';
            }

            console.error('Web Push delivery failed:', statusCode || error.name || 'unknown error');
            return 'failed';
        }
    }));

    return {
        sent: results.filter((result) => result === 'sent').length,
        failed: results.filter((result) => result !== 'sent').length
    };
}

async function notifyAdminsNewOrder(order) {
    try {
        if (!order?._id) return;
        if (!pushConfigured) {
            console.error('New-order push skipped: VAPID keys are not configured on this backend.');
            return;
        }

        const subscriptions = await PushSubscriptionModel.find({}).lean();
        if (!subscriptions.length) {
            console.error('New-order push skipped: no admin devices are subscribed.');
            return;
        }

        const orderTime = new Intl.DateTimeFormat('en-IN', {
            timeZone: 'Asia/Kolkata',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23'
        }).format(new Date(order.createdAt || Date.now()));

        const result = await sendPushToSubscriptions(subscriptions, {
            title: 'New Order',
            body: `Order placed at ${orderTime}, User ID: ${order.userId}`,
            url: `/admin?tab=orders&orderId=${encodeURIComponent(order._id)}`
        });
        console.info(`New-order push finished: ${result.sent} delivered, ${result.failed} not delivered.`);
    } catch (error) {
        // Push failures must never affect checkout or payment confirmation.
        console.error('Could not prepare new-order push notification:', error.name || 'unknown error');
    }
}

module.exports = {
    isPushConfigured: () => pushConfigured,
    notifyAdminsNewOrder,
    sendPushToSubscriptions
};
