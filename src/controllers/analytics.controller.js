const mongoose = require('mongoose');
const AnalyticsEvent = require('../models/analytics-event.model');
const UserModel = require('../models/user.model');
const OrderModel = require('../models/order.model');
const CancelledOrderModel = require('../models/cancelled-order.model');
const ProductModel = require('../models/product.model');

const RANGE_DAYS = { week: 7, month: 30, '6months': 180, '12months': 365 };

async function requireAdmin(req) {
    const user = await UserModel.findById(req.authUserId).select('role');
    return user?.role === 'admin';
}

async function trackEvent(req, res, next) {
    const body = req.body || {};
    const type = body.type;
    if (!['visit', 'page_exit', 'search'].includes(type)) {
        return res.status(400).json({ message: 'Invalid analytics event.' });
    }
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.slice(0, 100) : '';
    if (!sessionId) return res.status(400).json({ message: 'Session ID is required.' });
    try {
        await AnalyticsEvent.create({
            sessionId,
            type,
            page: typeof body.page === 'string' ? body.page.slice(0, 200) : '',
            keyword: typeof body.keyword === 'string' ? body.keyword.trim().slice(0, 100) : '',
            durationSeconds: Number.isFinite(Number(body.durationSeconds)) ? Math.max(0, Number(body.durationSeconds)) : 0,
            location: typeof body.location === 'string' ? body.location.trim().slice(0, 100) : ''
        });
        return res.status(201).json({ tracked: true });
    } catch (error) {
        return next(error);
    }
}

function getRangeStart(range) {
    const days = RANGE_DAYS[range] || RANGE_DAYS.month;
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function ranked(items, key, countKey) {
    return Object.entries(items)
        .map(([name, count]) => ({ [key]: name, [countKey]: count }))
        .sort((a, b) => b[countKey] - a[countKey])
        .slice(0, 10);
}

async function getAnalytics(req, res, next) {
    try {
        if (!await requireAdmin(req)) return res.status(403).json({ message: 'Admin access required.' });
        const range = typeof req.query.range === 'string' ? req.query.range : 'month';
        const start = getRangeStart(range);

        const [events, deliveredOrders, cancelledOrders, legacyCancelled, products] = await Promise.all([
            AnalyticsEvent.find({ createdAt: { $gte: start } }),
            OrderModel.find({ status: 'delivered', createdAt: { $gte: start } }),
            CancelledOrderModel.find({ createdAt: { $gte: start } }),
            OrderModel.find({ status: 'cancelled', createdAt: { $gte: start } }),
            ProductModel.find()
        ]);

        const sessions = new Set(events.map((event) => event.sessionId));
        const locationCounts = {};
        const hourCounts = {};
        const pageCounts = {};
        const pageDurations = {};
        const keywordCounts = {};

        for (const event of events) {
            if (event.location) locationCounts[event.location] = (locationCounts[event.location] || 0) + 1;
            const hour = event.createdAt.getHours();
            hourCounts[hour] = (hourCounts[hour] || 0) + 1;
            if (event.type === 'page_exit') {
                pageCounts[event.page] = (pageCounts[event.page] || 0) + 1;
                pageDurations[event.page] = (pageDurations[event.page] || 0) + event.durationSeconds;
            }
            if (event.type === 'search' && event.keyword) {
                keywordCounts[event.keyword.toLowerCase()] = (keywordCounts[event.keyword.toLowerCase()] || 0) + 1;
            }
        }

        const salesByLocation = {};
        const salesByDay = {};
        const productSales = {};
        const productProfit = {};
        for (const order of deliveredOrders) {
            const address = order.deliveryAddress || {};
            const location = [address.city, address.state].filter(Boolean).join(', ') || 'Unknown';
            salesByLocation[location] = (salesByLocation[location] || 0) + 1;
            const day = order.createdAt.toISOString().slice(0, 10);
            salesByDay[day] = (salesByDay[day] || 0) + order.amountPaise / 100;
            for (const item of order.items) {
                const id = String(item.productId);
                productSales[id] = (productSales[id] || 0) + item.quantity;
                const product = products.find((entry) => String(entry._id) === id);
                const unitCost = Number(product?.costPrice) || 0;
                productProfit[id] = (productProfit[id] || 0) +
                    (Number(item.unitPricePaise) / 100 - unitCost) * item.quantity;
            }
        }

        const returnCounts = {};
        for (const order of [...cancelledOrders, ...legacyCancelled]) {
            for (const item of order.items || []) {
                const id = String(item.productId);
                returnCounts[id] = (returnCounts[id] || 0) + item.quantity;
            }
        }

        const productName = (id) => products.find((product) => String(product._id) === id)?.heading || 'Unknown product';
        const mostSold = Object.entries(productSales)
            .map(([id, quantity]) => ({ productId: id, name: productName(id), quantity }))
            .sort((a, b) => b.quantity - a.quantity).slice(0, 10);
        const returns = Object.entries(returnCounts)
            .map(([id, quantity]) => ({ productId: id, name: productName(id), quantity }))
            .sort((a, b) => b.quantity - a.quantity).slice(0, 10);
        const profits = Object.entries(productProfit)
            .map(([id, profit]) => ({ productId: id, name: productName(id), profit: Math.round(profit * 100) / 100 }))
            .sort((a, b) => b.profit - a.profit).slice(0, 10);

        const pagePerformance = Object.entries(pageCounts)
            .map(([page, exits]) => ({
                page,
                exits,
                averageSeconds: exits ? Math.round(pageDurations[page] / exits) : 0
            }))
            .sort((a, b) => b.exits - a.exits).slice(0, 10);

        return res.status(200).json({
            range,
            summary: {
                visitors: sessions.size,
                visits: events.filter((event) => event.type === 'visit').length,
                deliveredOrders: deliveredOrders.length,
                salesPaise: deliveredOrders.reduce((sum, order) => sum + order.amountPaise, 0)
            },
            visitorLocations: ranked(locationCounts, 'location', 'visitors'),
            reachByHour: Object.entries(hourCounts).map(([hour, visitors]) => ({ hour: Number(hour), visitors }))
                .sort((a, b) => a.hour - b.hour),
            salesByLocation: ranked(salesByLocation, 'location', 'orders'),
            salesByDay: Object.entries(salesByDay).map(([date, sales]) => ({ date, sales: Math.round(sales * 100) / 100 }))
                .sort((a, b) => a.date.localeCompare(b.date)),
            keywords: ranked(keywordCounts, 'keyword', 'searches'),
            pagePerformance,
            mostSold,
            returns,
            profits
        });
    } catch (error) {
        return next(error);
    }
}

module.exports = { trackEvent, getAnalytics };
