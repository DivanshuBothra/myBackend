const mongoose = require('mongoose');
const AnalyticsEvent = require('../models/analytics-event.model');
const UserModel = require('../models/user.model');
const OrderModel = require('../models/order.model');
const CancelledOrderModel = require('../models/cancelled-order.model');
const ProductModel = require('../models/product.model');

const RANGE_DAYS = { '24h': 1, '3d': 3, week: 7, month: 30, '6months': 180, '12months': 365 };
const COMPLETION_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

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
        const headerLocation = [
            req.headers['x-vercel-ip-city'],
            req.headers['cf-ipcity'],
            req.headers['x-vercel-ip-country-region']
        ].filter((value) => typeof value === 'string' && value.trim()).join(', ');
        const location = typeof body.location === 'string' && body.location.trim()
            ? body.location.trim().slice(0, 100)
            : headerLocation || 'Unknown';
        await AnalyticsEvent.create({
            sessionId,
            type,
            page: typeof body.page === 'string' ? body.page.slice(0, 200) : '',
            keyword: typeof body.keyword === 'string' ? body.keyword.trim().slice(0, 100) : '',
            durationSeconds: Number.isFinite(Number(body.durationSeconds)) ? Math.max(0, Number(body.durationSeconds)) : 0,
            location
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

function getDeliveredAt(order) {
    const deliveredEvent = order.statusHistory
        ?.filter((entry) => entry.status === 'delivered')
        .sort((left, right) => new Date(right.changedAt) - new Date(left.changedAt))[0];
    return deliveredEvent?.changedAt || order.updatedAt || order.createdAt;
}

function getCancelledAt(order) {
    const cancelledEvent = order.statusHistory
        ?.filter((entry) => entry.status === 'cancelled')
        .sort((left, right) => new Date(right.changedAt) - new Date(left.changedAt))[0];
    return order.cancelledAt || cancelledEvent?.changedAt || order.updatedAt || order.createdAt;
}

function toDateKey(date) {
    return date.toISOString().slice(0, 10);
}

function buildSalesRows(range, start, completedOrders) {
    const salesByKey = {};
    for (const order of completedOrders) {
        const deliveredAt = getDeliveredAt(order);
        if (!deliveredAt) continue;
        const date = new Date(deliveredAt);
        let key;
        if (range === '12months') {
            key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
        } else if (range === '6months') {
            const startUtc = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
            const elapsedDays = Math.max(0, Math.floor((date.getTime() - startUtc) / 86400000));
            const bucketStart = new Date(startUtc + Math.floor(elapsedDays / 15) * 15 * 86400000);
            key = toDateKey(bucketStart);
        } else {
            key = toDateKey(date);
        }
        salesByKey[key] = (salesByKey[key] || 0) + Number(order.amountPaise || 0) / 100;
    }

    const rows = [];
    const now = new Date();
    if (range === '12months') {
        for (let index = 11; index >= 0; index -= 1) {
            const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - index, 1));
            const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
            rows.push({
                date: date.toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' }),
                sales: Math.round((salesByKey[key] || 0) * 100) / 100
            });
        }
    } else if (range === '6months') {
        for (let index = 0; index < 12; index += 1) {
            const date = new Date(start.getTime() + index * 15 * 86400000);
            const key = toDateKey(date);
            const endDate = new Date(date.getTime() + 14 * 86400000);
            rows.push({
                date: `${date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' })}–${endDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' })}`,
                sales: Math.round((salesByKey[key] || 0) * 100) / 100
            });
        }
    } else {
        const days = RANGE_DAYS[range] || RANGE_DAYS.month;
        for (let index = days - 1; index >= 0; index -= 1) {
            const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - index * 86400000);
            const key = toDateKey(date);
            rows.push({
                date: date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }),
                sales: Math.round((salesByKey[key] || 0) * 100) / 100
            });
        }
    }
    return rows;
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

        const [events, allOrders, deliveredOrders, cancelledOrders, legacyCancelled, products, allDashboardOrders, allCancelledOrders, allLegacyCancelledOrders] = await Promise.all([
            AnalyticsEvent.find({ createdAt: { $gte: start } }),
            OrderModel.find({ createdAt: { $gte: start } }).select('status amountPaise items createdAt deliveryAddress'),
            OrderModel.find({ status: 'delivered', createdAt: { $gte: start } }),
            CancelledOrderModel.find({ createdAt: { $gte: start } }),
            OrderModel.find({ status: 'cancelled', createdAt: { $gte: start } }),
            ProductModel.find(),
            OrderModel.find({}).select('status amountPaise items createdAt updatedAt statusHistory deliveryAddress returnStatus returnRequestedAt returnedAt cancelledAt'),
            CancelledOrderModel.find({}).select('status amountPaise items createdAt updatedAt cancelledAt statusHistory returnStatus'),
            OrderModel.find({ status: 'cancelled' }).select('status amountPaise items createdAt updatedAt cancelledAt statusHistory returnStatus')
        ]);

        const sessions = new Set(events.map((event) => event.sessionId));
        const locationSessionSets = {};
        const hourSessionSets = {};
        const pageCounts = {};
        const pageDurations = {};
        const keywordCounts = {};

        for (const event of events) {
            if (event.location) {
                if (!locationSessionSets[event.location]) locationSessionSets[event.location] = new Set();
                if (event.sessionId) locationSessionSets[event.location].add(event.sessionId);
            }
            const hour = event.createdAt.getHours();
            if (!hourSessionSets[hour]) hourSessionSets[hour] = new Set();
            if (event.sessionId) hourSessionSets[hour].add(event.sessionId);
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
        const productSalesByKey = {};
        const completedSalesOrders = allDashboardOrders.filter((order) => {
            if (order.status !== 'delivered' || order.returnStatus === 'accepted') return false;
            const deliveredAt = getDeliveredAt(order);
            return deliveredAt && Date.now() - new Date(deliveredAt).getTime() >= COMPLETION_WINDOW_MS;
        });
        const inProcessOrders = allDashboardOrders.filter((order) => {
            if (['pending_payment', 'confirmed', 'processing', 'shipped'].includes(order.status)) return true;
            if (order.status !== 'delivered' || order.returnStatus === 'accepted') return false;
            const deliveredAt = getDeliveredAt(order);
            return deliveredAt && Date.now() - new Date(deliveredAt).getTime() < COMPLETION_WINDOW_MS;
        });
        const acceptedReturns = allDashboardOrders.filter((order) => order.returnStatus === 'accepted');
        const pendingConfirmationOrders = allDashboardOrders.filter((order) => {
            if (order.status !== 'delivered' || order.returnStatus === 'accepted') return false;
            const deliveredAt = getDeliveredAt(order);
            return deliveredAt && Date.now() - new Date(deliveredAt).getTime() < COMPLETION_WINDOW_MS;
        });
        const periodCompletedOrders = completedSalesOrders.filter((order) => {
            const confirmedAt = getDeliveredAt(order);
            return confirmedAt && new Date(confirmedAt).getTime() >= start.getTime();
        });
        const periodActiveOrders = allDashboardOrders.filter((order) =>
            ['pending_payment', 'confirmed', 'processing', 'shipped'].includes(order.status) &&
            new Date(order.createdAt).getTime() >= start.getTime()
        );
        const periodInProcessOrders = allDashboardOrders.filter((order) => {
            if (order.status !== 'delivered' || order.returnStatus === 'accepted') return false;
            const deliveredAt = getDeliveredAt(order);
            return deliveredAt &&
                new Date(deliveredAt).getTime() >= start.getTime() &&
                Date.now() - new Date(deliveredAt).getTime() < COMPLETION_WINDOW_MS;
        });
        const periodAcceptedReturns = acceptedReturns.filter((order) => {
            const returnDate = order.returnedAt || order.returnRequestedAt || getDeliveredAt(order);
            return returnDate && new Date(returnDate).getTime() >= start.getTime();
        });
        const periodCancelledOrders = [...allCancelledOrders, ...allLegacyCancelledOrders]
            .filter((order) => {
                const cancelledDate = getCancelledAt(order);
                return cancelledDate && new Date(cancelledDate).getTime() >= start.getTime();
            })
            .filter((order, index, orders) => (
                orders.findIndex((candidate) => String(candidate._id) === String(order._id)) === index
            ));
        const countOrderItems = (orders) => orders.reduce((count, order) => (
            count + (order.items || []).reduce((itemCount, item) => itemCount + Number(item.quantity || 0), 0)
        ), 0);
        for (const order of periodCompletedOrders) {
            const address = order.deliveryAddress || {};
            const location = [address.city, address.state].filter(Boolean).join(', ') || 'Unknown';
            salesByLocation[location] = (salesByLocation[location] || 0) + 1;
            const confirmationDate = getDeliveredAt(order);
            const day = confirmationDate ? new Date(confirmationDate).toISOString().slice(0, 10) : order.createdAt.toISOString().slice(0, 10);
            salesByDay[day] = (salesByDay[day] || 0) + order.amountPaise / 100;
            for (const item of order.items) {
                const id = String(item.productId);
                productSales[id] = (productSales[id] || 0) + item.quantity;
                const confirmedDate = getDeliveredAt(order);
                let seriesKey;
                if (confirmedDate) {
                    const date = new Date(confirmedDate);
                    if (range === '12months') {
                        seriesKey = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
                    } else if (range === '6months') {
                        const elapsedDays = Math.max(0, Math.floor((date.getTime() - start.getTime()) / 86400000));
                        seriesKey = toDateKey(new Date(start.getTime() + Math.floor(elapsedDays / 15) * 15 * 86400000));
                    } else {
                        seriesKey = toDateKey(date);
                    }
                    if (!productSalesByKey[id]) productSalesByKey[id] = {};
                    productSalesByKey[id][seriesKey] = (productSalesByKey[id][seriesKey] || 0) + item.quantity;
                }
                const product = products.find((entry) => String(entry._id) === id);
                const unitCost = Number(product?.costPrice) || 0;
                productProfit[id] = (productProfit[id] || 0) +
                    (Number(item.unitPricePaise) / 100 - unitCost) * item.quantity;
            }
        }

        const periodReturnOrders = allDashboardOrders.filter((order) => {
            if (!['requested', 'accepted'].includes(order.returnStatus)) return false;
            const returnDate = order.returnedAt || order.returnRequestedAt || getDeliveredAt(order);
            return returnDate && new Date(returnDate).getTime() >= start.getTime();
        });
        const returnCounts = {};
        for (const order of periodReturnOrders) {
            for (const item of order.items || []) {
                const id = String(item.productId);
                returnCounts[id] = (returnCounts[id] || 0) + item.quantity;
            }
        }
        const cancelledCounts = {};
        for (const order of periodCancelledOrders) {
            for (const item of order.items || []) {
                const id = String(item.productId);
                cancelledCounts[id] = (cancelledCounts[id] || 0) + item.quantity;
            }
        }

        const productName = (id) => products.find((product) => String(product._id) === id)?.heading || 'Unknown product';
        const mostSold = Object.entries(productSales)
            .map(([id, quantity]) => ({ productId: id, name: productName(id), quantity }))
            .sort((a, b) => b.quantity - a.quantity).slice(0, 10);
        const salesRowsForRange = buildSalesRows(range, start, periodCompletedOrders);
        const productPerformance = mostSold.slice(0, 4).map((product) => ({
            ...product,
            rows: salesRowsForRange.map((row, index) => {
                let key;
                if (range === '12months') {
                    const now = new Date();
                    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (11 - index), 1));
                    key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
                } else if (range === '6months') {
                    key = toDateKey(new Date(start.getTime() + index * 15 * 86400000));
                } else {
                    const now = new Date();
                    const days = RANGE_DAYS[range] || RANGE_DAYS.month;
                    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - (days - 1 - index) * 86400000);
                    key = toDateKey(date);
                }
                return { date: row.date, quantity: productSalesByKey[product.productId]?.[key] || 0 };
            })
        }));
        const returns = Object.entries(returnCounts)
            .map(([id, quantity]) => ({ productId: id, name: productName(id), quantity }))
            .sort((a, b) => b.quantity - a.quantity).slice(0, 10);
        const cancellations = Object.entries(cancelledCounts)
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
        const realtimeCutoff = new Date(Date.now() - 5 * 60 * 1000);
        const realtimeEvents = await AnalyticsEvent.find({ createdAt: { $gte: realtimeCutoff } }).select('sessionId');
        const realtimeVisitors = new Set(realtimeEvents.map((event) => event.sessionId)).size;

        const inProcessStatuses = ['pending_payment', 'confirmed', 'processing', 'shipped'];
        const cancelledInRange = [...cancelledOrders, ...legacyCancelled];
        const statusCounts = [
            {
                label: 'Completed',
                count: completedSalesOrders.length,
                sales: completedSalesOrders.reduce((sum, order) => sum + order.amountPaise / 100, 0)
            },
            {
                label: 'In process',
                count: inProcessOrders.length,
                sales: inProcessOrders.reduce((sum, order) => sum + order.amountPaise / 100, 0)
            },
            {
                label: 'Returned',
                count: acceptedReturns.length,
                sales: acceptedReturns.reduce((sum, order) => sum + order.amountPaise / 100, 0)
            },
            {
                label: 'Cancelled',
                count: cancelledInRange.length,
                sales: cancelledInRange.reduce((sum, order) => sum + order.amountPaise / 100, 0)
            }
        ];
        const topPages = pagePerformance
            .map((row) => ({ page: row.page || '/', visitors: row.exits, averageSeconds: row.averageSeconds }))
            .sort((a, b) => b.visitors - a.visitors)
            .slice(0, 10);
        const getRecentProductTime = (product) => {
            const timestamp = product.createdAt ? new Date(product.createdAt).getTime() : 0;
            if (Number.isFinite(timestamp) && timestamp > 0) return timestamp;
            return mongoose.isValidObjectId(product._id) ? product._id.getTimestamp().getTime() : 0;
        };
        const recentProducts = [...products]
            .sort((left, right) => getRecentProductTime(right) - getRecentProductTime(left))
            .slice(0, 5)
            .map((product) => {
                const productId = String(product._id);
                const productOrders = allDashboardOrders.filter((order) =>
                    order.items?.some((item) => String(item.productId) === productId)
                );
                const completed = productOrders.filter((order) => {
                    if (order.status !== 'delivered' || order.returnStatus === 'accepted') return false;
                    const deliveredAt = getDeliveredAt(order);
                    return deliveredAt && Date.now() - new Date(deliveredAt).getTime() >= COMPLETION_WINDOW_MS;
                }).reduce((count, order) => {
                    const item = order.items.find((entry) => String(entry.productId) === productId);
                    return count + Number(item?.quantity || 0);
                }, 0);
                const inProcess = productOrders.filter((order) => (
                    ['pending_payment', 'confirmed', 'processing', 'shipped'].includes(order.status) ||
                    (order.status === 'delivered' && order.returnStatus !== 'accepted' &&
                        (() => {
                            const deliveredAt = getDeliveredAt(order);
                            return deliveredAt && Date.now() - new Date(deliveredAt).getTime() < COMPLETION_WINDOW_MS;
                        })())
                )).reduce((count, order) => {
                    const item = order.items.find((entry) => String(entry.productId) === productId);
                    return count + Number(item?.quantity || 0);
                }, 0);
                const returns = productOrders.filter((order) => order.returnStatus === 'accepted')
                    .reduce((count, order) => {
                        const item = order.items.find((entry) => String(entry.productId) === productId);
                        return count + Number(item?.quantity || 0);
                    }, 0);
                const orders = productOrders.filter((order) => order.status !== 'cancelled')
                    .reduce((count, order) => {
                        const item = order.items.find((entry) => String(entry.productId) === productId);
                        return count + Number(item?.quantity || 0);
                    }, 0);

                return {
                    title: product.title,
                    heading: product.heading,
                    image: product.url || '',
                    url: product.url || '',
                    uri: product.uri || '',
                    views: Number(product.viewCount || 0),
                    orders,
                    inProcess,
                    completed,
                    returns
                };
            });

        return res.status(200).json({
            range,
            summary: {
                visitors: sessions.size,
                visits: events.filter((event) => event.type === 'visit').length,
                deliveredOrders: periodCompletedOrders.length,
                salesPaise: periodCompletedOrders.reduce((sum, order) => sum + order.amountPaise, 0),
                completedOrders: periodCompletedOrders.length,
                activeOrders: periodActiveOrders.length,
                activeOrderAmountPaise: periodActiveOrders.reduce((sum, order) => sum + Number(order.amountPaise || 0), 0),
                inProcessOrders: periodInProcessOrders.length,
                inProcessAmountPaise: periodInProcessOrders.reduce((sum, order) => sum + Number(order.amountPaise || 0), 0),
                inProcessProductCount: countOrderItems(periodInProcessOrders),
                pendingConfirmationOrders: periodInProcessOrders.length,
                pendingConfirmationRevenuePaise: periodInProcessOrders.reduce((sum, order) => sum + Number(order.amountPaise || 0), 0),
                returnOrders: periodAcceptedReturns.length,
                returnAmountPaise: periodAcceptedReturns.reduce((sum, order) => sum + Number(order.amountPaise || 0), 0),
                returnedProductCount: countOrderItems(periodAcceptedReturns),
                cancelledOrdersPeriod: periodCancelledOrders.length,
                cancelledAmountPaise: periodCancelledOrders.reduce((sum, order) => sum + Number(order.amountPaise || 0), 0),
                cancelledProductCount: countOrderItems(periodCancelledOrders),
                realtimeVisitors,
                inProcessRevenuePaise: inProcessOrders.reduce((sum, order) => sum + order.amountPaise, 0),
                cancelledOrders: cancelledInRange.length
            },
            statusCounts,
            recentProducts,
            topPages,
            visitorLocations: Object.entries(locationSessionSets)
                .map(([location, sessionSet]) => ({ location, visitors: sessionSet.size }))
                .sort((a, b) => b.visitors - a.visitors)
                .slice(0, 10),
            reachByHour: Object.entries(hourSessionSets).map(([hour, sessionSet]) => ({ hour: Number(hour), visitors: sessionSet.size }))
                .sort((a, b) => a.hour - b.hour),
            salesByLocation: ranked(salesByLocation, 'location', 'orders'),
            salesByDay: buildSalesRows(range, start, periodCompletedOrders),
            keywords: ranked(keywordCounts, 'keyword', 'searches'),
            pagePerformance,
            mostSold,
            productPerformance,
            returns,
            cancellations,
            profits
        });
    } catch (error) {
        return next(error);
    }
}

module.exports = { trackEvent, getAnalytics };
