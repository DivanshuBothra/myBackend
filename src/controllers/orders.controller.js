const { createHmac, randomBytes, timingSafeEqual } = require('node:crypto');
const mongoose = require('mongoose');
const ProductModel = require('../models/product.model');
const UserModel = require('../models/user.model');
const OrderModel = require('../models/order.model');
const CancelledOrderModel = require('../models/cancelled-order.model');
const cookieOptions = require('../auth-cookie-options');
const {
    MAX_CONSECUTIVE_ORDER_CANCELLATIONS,
    MAX_ORDER_CANCELLATION_SCORE,
    getNextCancellationScore,
    addOneCalendarMonth
} = require('../account-ban');

const MAX_CART_QUANTITY = 25;
const ORDER_CANCELLATION_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
const PURCHASED_ORDER_STATUSES = ['delivered'];

function getRazorpayCredentials() {
    const keyId = process.env.RAZORPAY_KEY_ID?.trim();
    const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim();
    if (!keyId || !keySecret) return null;

    return {
        keyId,
        authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
        keySecret
    };
}

function getAddressSnapshot(address) {
    return {
        fullName: typeof address.fullName === 'string' ? address.fullName.trim() : '',
        phone: typeof address.phone === 'string' ? address.phone.trim() : '',
        line1: typeof address.line1 === 'string' ? address.line1.trim() : '',
        line2: typeof address.line2 === 'string' ? address.line2.trim() : '',
        city: typeof address.city === 'string' ? address.city.trim() : '',
        state: typeof address.state === 'string' ? address.state.trim() : '',
        pincode: typeof address.pincode === 'string' ? address.pincode.trim() : ''
    };
}

function generateOrderNumber() {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return `BSH-${date}-${randomBytes(8).toString('hex').toUpperCase()}`;
}

async function calculatePurchasedProductCount(userId, session) {
    let aggregation = OrderModel.aggregate([
        {
            $match: {
                userId: new mongoose.Types.ObjectId(String(userId)),
                status: { $in: PURCHASED_ORDER_STATUSES }
            }
        },
        { $unwind: '$items' },
        { $group: { _id: null, count: { $sum: '$items.quantity' } } }
    ]);
    if (session) aggregation = aggregation.session(session);
    const [result] = await aggregation;
    return result?.count || 0;
}

async function calculateCancellationScore(userId, currentScore, resetAt, session) {
    const lastDeliveredOrder = await OrderModel.findOne({ userId, status: 'delivered' })
        .sort({ updatedAt: -1 })
        .select('statusHistory createdAt updatedAt')
        .session(session);
    const deliveryEvent = lastDeliveredOrder?.statusHistory
        ?.filter((entry) => entry.status === 'delivered')
        .sort((left, right) => right.changedAt - left.changedAt)[0];
    const lastDeliveredAt = deliveryEvent?.changedAt ||
        lastDeliveredOrder?.updatedAt ||
        lastDeliveredOrder?.createdAt ||
        new Date(0);
    const resetDate = resetAt ? new Date(resetAt) : new Date(0);
    const historyStart = resetDate > lastDeliveredAt ? resetDate : lastDeliveredAt;
    const cancellationsSinceLastDelivery = {
        userId,
        status: 'cancelled',
        cancelledAt: { $gt: historyStart }
    };
    const legacyCount = await OrderModel.countDocuments(cancellationsSinceLastDelivery).session(session);
    const separateCount = await CancelledOrderModel.countDocuments(cancellationsSinceLastDelivery).session(session);
    const historicalScore = -Math.min(
        MAX_CONSECUTIVE_ORDER_CANCELLATIONS,
        legacyCount + separateCount
    );
    return Math.min(Number.isFinite(currentScore) ? currentScore : 0, historicalScore);
}

function getPaymentInstrument(payment) {
    const instrument = {};
    if (typeof payment.method === 'string') instrument.method = payment.method.slice(0, 30);
    if (payment.method === 'card') {
        if (typeof payment.card?.network === 'string') instrument.cardNetwork = payment.card.network.slice(0, 30);
        if (typeof payment.card?.last4 === 'string' && /^\d{4}$/.test(payment.card.last4)) {
            instrument.cardLast4 = payment.card.last4;
        }
    }
    if (typeof payment.bank === 'string') instrument.bankName = payment.bank.slice(0, 60);
    if (typeof payment.wallet === 'string') instrument.walletName = payment.wallet.slice(0, 60);
    return instrument;
}

async function loadOrderContext(req, res) {
    const user = await UserModel.findById(req.authUserId);
    if (!user) {
        res.status(401).json({ message: 'Please sign in to continue.' });
        return null;
    }
    if (!user.address) {
        res.status(409).json({ code: 'ADDRESS_REQUIRED', message: 'Add a delivery address before checkout.' });
        return null;
    }
    const deliveryAddress = getAddressSnapshot(user.address);
    if (!deliveryAddress.fullName || !deliveryAddress.line1 || !deliveryAddress.city ||
        !deliveryAddress.state || deliveryAddress.fullName.length > 100 ||
        deliveryAddress.line1.length > 150 || deliveryAddress.line2.length > 150 ||
        deliveryAddress.city.length > 80 || deliveryAddress.state.length > 80 ||
        !/^\d{6}$/.test(deliveryAddress.pincode)) {
        res.status(409).json({ code: 'ADDRESS_REQUIRED', message: 'Update your delivery address before checkout.' });
        return null;
    }

    const requestedItems = req.body?.items;
    if (!Array.isArray(requestedItems) || requestedItems.length === 0) {
        res.status(400).json({ message: 'Your cart is empty.' });
        return null;
    }

    const quantities = new Map();
    let itemCount = 0;
    for (const item of requestedItems) {
        const productId = item?.productId;
        const quantity = Number(item?.quantity);
        if (typeof productId !== 'string' || !mongoose.isValidObjectId(productId) ||
            !Number.isInteger(quantity) || quantity < 1) {
            res.status(400).json({ message: 'The cart contains an invalid product or quantity.' });
            return null;
        }

        itemCount += quantity;
        if (itemCount > MAX_CART_QUANTITY) {
            res.status(400).json({ message: `Your cart can contain up to ${MAX_CART_QUANTITY} items.` });
            return null;
        }
        quantities.set(productId, (quantities.get(productId) || 0) + quantity);
    }

    const products = await ProductModel.find({ _id: { $in: Array.from(quantities.keys()) } });
    if (products.length !== quantities.size) {
        res.status(400).json({ message: 'One or more products in your cart are no longer available.' });
        return null;
    }

    const productsById = new Map(products.map((product) => [String(product._id), product]));
    const items = [];
    for (const [productId, quantity] of quantities) {
        const product = productsById.get(productId);
        const title = [product.title, product.heading].find((value) => typeof value === 'string' && value.trim());
        const heading = [product.heading, product.title].find((value) => typeof value === 'string' && value.trim());
        const price = Number(product.price);
        const unitPricePaise = Math.round(price * 100);
        const lineTotalPaise = unitPricePaise * quantity;
        if (!title || !heading || product.price === null || product.price === undefined ||
            (typeof product.price === 'string' && !product.price.trim()) ||
            !Number.isFinite(price) || price < 0 || !Number.isSafeInteger(unitPricePaise) ||
            !Number.isSafeInteger(lineTotalPaise)) {
            res.status(400).json({ message: 'One or more products in your cart have invalid catalogue data.' });
            return null;
        }

        items.push({
            productId: product._id,
            title: title.trim(),
            heading: heading.trim(),
            url: product.url || '',
            uri: product.uri || '',
            unitPricePaise,
            quantity,
            lineTotalPaise
        });
    }
    const amountPaise = items.reduce((total, item) => total + item.lineTotalPaise, 0);
    if (!Number.isSafeInteger(amountPaise)) {
        res.status(400).json({ message: 'The order total is invalid.' });
        return null;
    }

    return { user, items, amountPaise, deliveryAddress };
}

async function createCashOnDeliveryOrder(req, res, next) {
    try {
        const context = await loadOrderContext(req, res);
        if (!context) return;

        const order = await OrderModel.create({
            orderNumber: generateOrderNumber(),
            userId: context.user._id,
            items: context.items,
            deliveryAddress: context.deliveryAddress,
            amountPaise: context.amountPaise,
            paymentMethod: 'cod',
            paymentTiming: 'postpaid',
            paymentStatus: 'pending',
            status: 'confirmed',
            statusHistory: [{ status: 'confirmed', changedAt: new Date() }]
        });
        return res.status(201).json({ order });
    } catch (error) {
        return next(error);
    }
}

async function createRazorpayOrder(req, res, next) {
    try {
        const context = await loadOrderContext(req, res);
        if (!context) return;
        if (context.amountPaise < 100) {
            return res.status(400).json({ message: 'Online payment requires an order total of at least ₹1.' });
        }

        const credentials = getRazorpayCredentials();
        if (!credentials) {
            return res.status(503).json({ message: 'Online payment is not configured on the server.' });
        }

        const receipt = `bsh_${Date.now()}_${randomBytes(6).toString('hex')}`;
        let response;
        let gatewayOrder;
        try {
            response = await fetch('https://api.razorpay.com/v1/orders', {
                method: 'POST',
                headers: {
                    Authorization: credentials.authorization,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    amount: context.amountPaise,
                    currency: 'INR',
                    receipt
                })
            });
            gatewayOrder = await response.json();
        } catch (error) {
            console.error('Razorpay order creation request failed:', error.name);
            return res.status(502).json({ message: 'Could not start online payment. Try again.' });
        }

        if (!response.ok || !gatewayOrder.id || gatewayOrder.amount !== context.amountPaise) {
            console.error('Razorpay rejected order creation:', gatewayOrder.error?.code || response.status);
            return res.status(502).json({ message: 'Could not start online payment. Try again.' });
        }

        const order = await OrderModel.create({
            orderNumber: generateOrderNumber(),
            userId: context.user._id,
            items: context.items,
            deliveryAddress: context.deliveryAddress,
            amountPaise: context.amountPaise,
            paymentMethod: 'razorpay',
            paymentTiming: 'prepaid',
            paymentStatus: 'pending',
            status: 'pending_payment',
            statusHistory: [{ status: 'pending_payment', changedAt: new Date() }],
            receipt,
            razorpayOrderId: gatewayOrder.id
        });

        return res.status(201).json({
            order,
            keyId: credentials.keyId,
            razorpayOrderId: gatewayOrder.id,
            amountPaise: context.amountPaise,
            currency: 'INR'
        });
    } catch (error) {
        return next(error);
    }
}

async function verifyRazorpayPayment(req, res, next) {
    const { razorpay_order_id: razorpayOrderId, razorpay_payment_id: razorpayPaymentId, razorpay_signature: signature } = req.body || {};
    if (!mongoose.isValidObjectId(req.params.orderId)) {
        return res.status(400).json({ message: 'Invalid order ID.' });
    }
    if (typeof razorpayOrderId !== 'string' || typeof razorpayPaymentId !== 'string' ||
        typeof signature !== 'string' || !/^[\da-f]{64}$/i.test(signature)) {
        return res.status(400).json({ message: 'The payment verification details are invalid.' });
    }

    try {
        const order = await OrderModel.findOne({ _id: req.params.orderId, userId: req.authUserId });
        if (!order) return res.status(404).json({ message: 'Order not found.' });
        if (order.paymentMethod !== 'razorpay' || order.razorpayOrderId !== razorpayOrderId) {
            return res.status(400).json({ message: 'This payment does not match the order.' });
        }
        if (order.paymentStatus === 'paid') {
            if (order.razorpayPaymentId === razorpayPaymentId) return res.status(200).json({ order });
            return res.status(409).json({ message: 'This order has already been paid.' });
        }
        if (order.status !== 'pending_payment') {
            return res.status(409).json({ message: 'This order is not awaiting payment.' });
        }

        const credentials = getRazorpayCredentials();
        if (!credentials) {
            return res.status(503).json({ message: 'Online payment verification is not configured on the server.' });
        }

        const expectedSignature = createHmac('sha256', credentials.keySecret)
            .update(`${razorpayOrderId}|${razorpayPaymentId}`)
            .digest();
        const receivedSignature = Buffer.from(signature, 'hex');
        if (!timingSafeEqual(expectedSignature, receivedSignature)) {
            return res.status(400).json({ message: 'Payment signature verification failed.' });
        }

        let paymentResponse;
        let gatewayPayment;
        try {
            paymentResponse = await fetch(
                `https://api.razorpay.com/v1/payments/${encodeURIComponent(razorpayPaymentId)}`,
                { headers: { Authorization: credentials.authorization } }
            );
            gatewayPayment = await paymentResponse.json();
        } catch (error) {
            console.error('Razorpay payment verification request failed:', error.name);
            return res.status(502).json({ message: 'Could not verify payment status. Please try again.' });
        }

        if (!paymentResponse.ok) {
            console.error('Razorpay payment lookup failed:', gatewayPayment.error?.code || paymentResponse.status);
            return res.status(502).json({ message: 'Could not verify payment status. Please try again.' });
        }
        if (gatewayPayment.order_id !== razorpayOrderId || gatewayPayment.amount !== order.amountPaise ||
            gatewayPayment.currency !== order.currency || gatewayPayment.status !== 'captured') {
            return res.status(409).json({ message: 'Payment has not been captured for this order.' });
        }

        const updatedOrder = await OrderModel.findOneAndUpdate(
            { _id: order._id, userId: req.authUserId, paymentStatus: 'pending', status: 'pending_payment' },
            {
                $set: {
                    razorpayPaymentId,
                    paymentStatus: 'paid',
                    status: 'confirmed',
                    paymentInstrument: getPaymentInstrument(gatewayPayment)
                },
                $push: { statusHistory: { status: 'confirmed', changedAt: new Date() } }
            },
            { new: true, runValidators: true }
        );
        if (updatedOrder) {
            return res.status(200).json({ order: updatedOrder });
        }

        const currentOrder = await OrderModel.findById(order._id);
        if (currentOrder?.paymentStatus === 'paid' && currentOrder.razorpayPaymentId === razorpayPaymentId) {
            return res.status(200).json({ order: currentOrder });
        }
        return res.status(409).json({ message: 'This order payment could not be confirmed.' });
    } catch (error) {
        return next(error);
    }
}

async function getMyOrders(req, res, next) {
    try {
        const [orders, separateCancelledOrders, legacyCancelledOrders, productsPurchased] = await Promise.all([
            OrderModel.find({ userId: req.authUserId, status: { $ne: 'cancelled' } })
                .sort({ createdAt: -1 }).limit(50),
            CancelledOrderModel.find({ userId: req.authUserId }).sort({ createdAt: -1 }).limit(50),
            OrderModel.find({ userId: req.authUserId, status: 'cancelled' }).sort({ createdAt: -1 }).limit(50),
            calculatePurchasedProductCount(req.authUserId)
        ]);
        const cancelledOrders = [...separateCancelledOrders, ...legacyCancelledOrders]
            .sort((left, right) => right.createdAt - left.createdAt)
            .slice(0, 50);
        await UserModel.updateOne({ _id: req.authUserId }, { $set: { productsPurchased } });
        return res.status(200).json({ orders, cancelledOrders, productsPurchased });
    } catch (error) {
        return next(error);
    }
}

async function getAdminOrders(req, res, next) {
    try {
        const user = await UserModel.findById(req.authUserId).select('role');
        if (!user || user.role !== 'admin') {
            return res.status(403).json({ message: 'Admin access required.' });
        }

        const [orders, separateCancelledOrders, legacyCancelledOrders] = await Promise.all([
            OrderModel.find({ status: { $ne: 'cancelled' } }).sort({ createdAt: -1 }).limit(100),
            CancelledOrderModel.find().sort({ createdAt: -1 }).limit(100),
            OrderModel.find({ status: 'cancelled' }).sort({ createdAt: -1 }).limit(100)
        ]);
        const cancelledOrders = [...separateCancelledOrders, ...legacyCancelledOrders]
            .sort((left, right) => right.createdAt - left.createdAt)
            .slice(0, 100);
        const userIds = new Set(
            [...orders, ...cancelledOrders].map((order) => String(order.userId)).filter(Boolean)
        );
        const customers = await UserModel.find({ _id: { $in: [...userIds] } })
            .select('_id username phonenum');
        const customerById = new Map(customers.map((customer) => [String(customer._id), customer]));
        const attachCustomer = (order) => {
            const plain = typeof order.toObject === 'function' ? order.toObject() : { ...order };
            const customer = customerById.get(String(order.userId));
            plain.customer = customer ? {
                username: customer.username,
                phone: customer.phonenum
            } : null;
            if (!plain.deliveryAddress?.phone && plain.customer?.phone) {
                plain.deliveryAddress = { ...plain.deliveryAddress, phone: plain.customer.phone };
            }
            return plain;
        };
        return res.status(200).json({
            orders: orders.map(attachCustomer),
            cancelledOrders: cancelledOrders.map(attachCustomer)
        });
    } catch (error) {
        return next(error);
    }
}

async function cancelMyOrder(req, res, next) {
    if (!mongoose.isValidObjectId(req.params.orderId)) {
        return res.status(400).json({ message: 'Invalid order ID.' });
    }

    let session;
    try {
        session = await mongoose.startSession();
        let outcome;
        await session.withTransaction(async () => {
            const order = await OrderModel.findOne({
                _id: req.params.orderId,
                userId: req.authUserId
            }).session(session);

            if (!order) {
                const previouslyCancelled = await CancelledOrderModel.findOne({
                    _id: req.params.orderId,
                    userId: req.authUserId
                }).session(session);
                outcome = previouslyCancelled
                    ? { status: 200, body: { order: previouslyCancelled } }
                    : { status: 404, body: { message: 'Order not found.' } };
                return;
            }
            if (order.status === 'cancelled') {
                outcome = { status: 200, body: { order } };
                return;
            }

            const cancellationCutoff = new Date(Date.now() - ORDER_CANCELLATION_WINDOW_MS);
            const cancellableStatuses = ['pending_payment', 'confirmed', 'processing'];
            if (!cancellableStatuses.includes(order.status) || order.createdAt < cancellationCutoff) {
                outcome = {
                    status: 409,
                    body: { message: 'Orders can only be cancelled within 2 days and before shipment.' }
                };
                return;
            }

            const user = await UserModel.findById(order.userId).session(session);
            if (!user) {
                outcome = { status: 401, body: { message: 'Please sign in to continue.' } };
                return;
            }

            const currentScore = await calculateCancellationScore(
                user._id,
                user.orderCancellationScore,
                user.orderCancellationResetAt,
                session
            );
            const changedAt = new Date();
            const snapshot = order.toObject();
            snapshot.status = 'cancelled';
            snapshot.cancelledAt = changedAt;
            snapshot.refundStatus = order.paymentStatus === 'paid' ? 'pending' : 'not_required';
            snapshot.statusHistory.push({ status: 'cancelled', changedAt });

            const [cancelledOrder] = await CancelledOrderModel.create([snapshot], { session });
            const deletion = await OrderModel.deleteOne({
                _id: order._id,
                userId: req.authUserId,
                status: order.status
            }, { session });
            if (deletion.deletedCount !== 1) {
                throw new Error('Order changed while it was being cancelled.');
            }

            user.orderCancellationScore = getNextCancellationScore(currentScore);
            if (user.orderCancellationScore <= MAX_ORDER_CANCELLATION_SCORE) {
                user.accountBannedUntil = addOneCalendarMonth(changedAt);
            }
            await user.save({ session });

            outcome = {
                status: 200,
                body: {
                    order: cancelledOrder,
                    cancellationScore: user.orderCancellationScore,
                    bannedUntil: user.accountBannedUntil
                }
            };
        });

        if (outcome.body.bannedUntil) {
            res.clearCookie('token', cookieOptions);
        }
        return res.status(outcome.status).json(outcome.body);
    } catch (error) {
        return next(error);
    } finally {
        if (session) await session.endSession();
    }
}

async function updateAdminOrderStatus(req, res, next) {
    if (!mongoose.isValidObjectId(req.params.orderId)) {
        return res.status(400).json({ message: 'Invalid order ID.' });
    }

    const transitions = {
        confirmed: 'processing',
        processing: 'shipped',
        shipped: 'delivered'
    };
    const nextStatus = req.body?.status;
    if (!Object.values(transitions).includes(nextStatus)) {
        return res.status(400).json({ message: 'Choose a valid next order status.' });
    }

    let session;
    try {
        const user = await UserModel.findById(req.authUserId).select('role');
        if (!user || user.role !== 'admin') {
            return res.status(403).json({ message: 'Admin access required.' });
        }

        session = await mongoose.startSession();
        let outcome;
        await session.withTransaction(async () => {
            const order = await OrderModel.findById(req.params.orderId).session(session);
            if (!order) {
                outcome = { status: 404, body: { message: 'Order not found.' } };
                return;
            }
            if (transitions[order.status] !== nextStatus) {
                outcome = {
                    status: 409,
                    body: { message: 'Order status can only move to the next tracking step.' }
                };
                return;
            }

            const changedAt = new Date();
            const updatedOrder = await OrderModel.findOneAndUpdate(
                { _id: order._id, status: order.status },
                {
                    $set: { status: nextStatus },
                    $push: { statusHistory: { status: nextStatus, changedAt } }
                },
                { new: true, runValidators: true, session }
            );
            if (!updatedOrder) {
                outcome = {
                    status: 409,
                    body: { message: 'The order status changed. Refresh and try again.' }
                };
                return;
            }

            if (nextStatus === 'delivered') {
                for (const item of order.items) {
                    const stockUpdate = await ProductModel.findOneAndUpdate(
                        { _id: item.productId, stock: { $gte: item.quantity } },
                        { $inc: { stock: -item.quantity, soldCount: item.quantity } },
                        { new: true }
                    );
                    if (!stockUpdate) {
                        throw new Error(`Insufficient stock for ${item.heading}.`);
                    }
                }
                const productsPurchased = await calculatePurchasedProductCount(order.userId, session);
                await UserModel.updateOne(
                    { _id: order.userId },
                    {
                        $set: {
                            productsPurchased,
                            orderCancellationScore: 0,
                            accountBannedUntil: null,
                            orderCancellationResetAt: changedAt
                        }
                    },
                    { session }
                );
            }

            outcome = { status: 200, body: { order: updatedOrder } };
        });

        return res.status(outcome.status).json(outcome.body);
    } catch (error) {
        return next(error);
    } finally {
        if (session) await session.endSession();
    }
}

async function requestReturn(req, res, next) {
    if (!mongoose.isValidObjectId(req.params.orderId)) {
        return res.status(400).json({ message: 'Invalid order ID.' });
    }

    try {
        const order = await OrderModel.findOne({
            _id: req.params.orderId,
            userId: req.authUserId,
            status: 'delivered'
        });
        if (!order) return res.status(404).json({ message: 'Only a delivered order can be returned.' });
        if (order.returnStatus === 'requested') {
            return res.status(409).json({ message: 'Your return request is awaiting admin approval.' });
        }
        if (order.returnStatus === 'accepted') {
            return res.status(409).json({ message: 'This return has already been accepted.' });
        }

        const deliveredEvent = order.statusHistory
            ?.filter((entry) => entry.status === 'delivered')
            .sort((left, right) => right.changedAt - left.changedAt)[0];
        const deliveredAt = deliveredEvent?.changedAt || order.updatedAt || order.createdAt;
        if (!deliveredAt || Date.now() - new Date(deliveredAt).getTime() > ORDER_CANCELLATION_WINDOW_MS) {
            return res.status(409).json({ message: 'The 2-day return window has ended.' });
        }

        const updatedOrder = await OrderModel.findOneAndUpdate(
            { _id: order._id, status: 'delivered', returnStatus: 'none' },
            { $set: { returnStatus: 'requested', returnRequestedAt: new Date() } },
            { new: true, runValidators: true }
        );
        if (!updatedOrder) return res.status(409).json({ message: 'This return could not be requested.' });
        return res.status(200).json({ order: updatedOrder });
    } catch (error) {
        return next(error);
    }
}

async function acceptReturn(req, res, next) {
    if (!mongoose.isValidObjectId(req.params.orderId)) {
        return res.status(400).json({ message: 'Invalid order ID.' });
    }

    let session;
    try {
        const user = await UserModel.findById(req.authUserId).select('role');
        if (!user || user.role !== 'admin') {
            return res.status(403).json({ message: 'Admin access required.' });
        }

        session = await mongoose.startSession();
        let outcome;
        await session.withTransaction(async () => {
            const order = await OrderModel.findOne({
                _id: req.params.orderId,
                status: 'delivered',
                returnStatus: 'requested'
            }).session(session);
            if (!order) {
                outcome = { status: 409, body: { message: 'This order has no pending return request.' } };
                return;
            }

            for (const item of order.items) {
                const product = await ProductModel.findById(item.productId).session(session);
                if (product) {
                    product.stock += item.quantity;
                    product.soldCount = Math.max(0, Number(product.soldCount || 0) - item.quantity);
                    await product.save({ session });
                }
            }

            const updatedOrder = await OrderModel.findOneAndUpdate(
                { _id: order._id, status: 'delivered', returnStatus: 'requested' },
                { $set: { returnStatus: 'accepted', returnedAt: new Date() } },
                { new: true, runValidators: true, session }
            );
            outcome = { status: 200, body: { order: updatedOrder } };
        });
        return res.status(outcome.status).json(outcome.body);
    } catch (error) {
        return next(error);
    } finally {
        if (session) await session.endSession();
    }
}

async function markRefundProcessed(req, res, next) {
    if (!mongoose.isValidObjectId(req.params.orderId)) {
        return res.status(400).json({ message: 'Invalid order ID.' });
    }

    try {
        const user = await UserModel.findById(req.authUserId).select('role');
        if (!user || user.role !== 'admin') {
            return res.status(403).json({ message: 'Admin access required.' });
        }

        const refundUpdate = {
            $set: { refundStatus: 'processed', refundProcessedAt: new Date() }
        };
        const updateOptions = { new: true, runValidators: true };
        const order = await CancelledOrderModel.findOneAndUpdate(
            {
                _id: req.params.orderId,
                status: 'cancelled',
                paymentStatus: 'paid',
                refundStatus: 'pending'
            },
            refundUpdate,
            updateOptions
        ) || await OrderModel.findOneAndUpdate({
            _id: req.params.orderId,
            status: 'cancelled',
            paymentStatus: 'paid',
            refundStatus: 'pending'
        }, refundUpdate, updateOptions);
        if (!order) {
            return res.status(409).json({ message: 'This order does not have a pending prepaid refund.' });
        }

        return res.status(200).json({ order });
    } catch (error) {
        return next(error);
    }
}

async function getOrderById(req, res, next) {
    if (!mongoose.isValidObjectId(req.params.orderId)) {
        return res.status(400).json({ message: 'Invalid order ID.' });
    }

    try {
        const order = await OrderModel.findOne({ _id: req.params.orderId, userId: req.authUserId }) ||
            await CancelledOrderModel.findOne({ _id: req.params.orderId, userId: req.authUserId });
        if (!order) return res.status(404).json({ message: 'Order not found.' });
        return res.status(200).json({ order });
    } catch (error) {
        return next(error);
    }
}

module.exports = {
    createCashOnDeliveryOrder,
    createRazorpayOrder,
    verifyRazorpayPayment,
    getMyOrders,
    getAdminOrders,
    cancelMyOrder,
    requestReturn,
    acceptReturn,
    updateAdminOrderStatus,
    markRefundProcessed,
    getOrderById
};
