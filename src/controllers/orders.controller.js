const { createHmac, randomBytes, timingSafeEqual } = require('node:crypto');
const mongoose = require('mongoose');
const ProductModel = require('../models/product.model');
const UserModel = require('../models/user.model');
const OrderModel = require('../models/order.model');

const MAX_CART_QUANTITY = 25;

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
        line1: typeof address.line1 === 'string' ? address.line1.trim() : '',
        line2: typeof address.line2 === 'string' ? address.line2.trim() : '',
        city: typeof address.city === 'string' ? address.city.trim() : '',
        state: typeof address.state === 'string' ? address.state.trim() : '',
        pincode: typeof address.pincode === 'string' ? address.pincode.trim() : ''
    };
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
            userId: context.user._id,
            items: context.items,
            deliveryAddress: context.deliveryAddress,
            amountPaise: context.amountPaise,
            paymentMethod: 'cod',
            paymentStatus: 'pending',
            status: 'confirmed'
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
            userId: context.user._id,
            items: context.items,
            deliveryAddress: context.deliveryAddress,
            amountPaise: context.amountPaise,
            paymentMethod: 'razorpay',
            paymentStatus: 'pending',
            status: 'pending_payment',
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
            { $set: { razorpayPaymentId, paymentStatus: 'paid', status: 'confirmed' } },
            { new: true, runValidators: true }
        );
        if (updatedOrder) return res.status(200).json({ order: updatedOrder });

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
        const orders = await OrderModel.find({ userId: req.authUserId }).sort({ createdAt: -1 }).limit(50);
        return res.status(200).json({ orders });
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

        const orders = await OrderModel.find().sort({ createdAt: -1 }).limit(100);
        return res.status(200).json({ orders });
    } catch (error) {
        return next(error);
    }
}

async function getOrderById(req, res, next) {
    if (!mongoose.isValidObjectId(req.params.orderId)) {
        return res.status(400).json({ message: 'Invalid order ID.' });
    }

    try {
        const order = await OrderModel.findOne({ _id: req.params.orderId, userId: req.authUserId });
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
    getOrderById
};
