const ProductModel = require('../models/product.model');
const OrderModel = require('../models/order.model');
const CancelledOrderModel = require('../models/cancelled-order.model');
const UserModel = require('../models/user.model');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const {
    uploadImage,
    findImage,
    downloadImage,
    deleteImage,
    getUploadAuthenticationParameters,
    deleteUploadedImage
} = require('../services/storage.service');

const COMPLETION_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
const PAYMENT_RESERVATION_WINDOW_MS = 30 * 60 * 1000;
const OPEN_ORDER_STATUSES = ['confirmed', 'processing', 'shipped'];

async function ensureAdmin(req, res) {
    if (!req.authUserId) {
        res.status(401).json({ message: 'Please sign in to continue.' });
        return false;
    }

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

function parseProductFields(body = {}) {
    const { title, heading, about, price: rawPrice, costPrice: rawCostPrice,
        purchaseCost: rawPurchaseCost, taxPercent: rawTaxPercent,
        deliveryCostPerUnit: rawDeliveryCost, stock: rawStock } = body;
    const price = Number(rawPrice);
    const costPrice = rawCostPrice === undefined || rawCostPrice === '' ? 0 : Number(rawCostPrice);
    const purchaseCost = rawPurchaseCost === undefined || rawPurchaseCost === '' ? 0 : Number(rawPurchaseCost);
    const taxPercent = rawTaxPercent === undefined || rawTaxPercent === '' ? 0 : Number(rawTaxPercent);
    const deliveryCostPerUnit = rawDeliveryCost === undefined || rawDeliveryCost === '' ? 0 : Number(rawDeliveryCost);
    const stock = Number(rawStock);

    if (
        typeof title !== 'string' || !title.trim() ||
        typeof heading !== 'string' || !heading.trim() ||
        typeof about !== 'string' || !about.trim() ||
        rawPrice === undefined || String(rawPrice).trim() === '' ||
        !Number.isFinite(price) || price < 0 ||
        !Number.isFinite(costPrice) || costPrice < 0 || costPrice > price ||
        !Number.isFinite(purchaseCost) || purchaseCost < 0 ||
        !Number.isFinite(taxPercent) || taxPercent < 0 || taxPercent > 100 ||
        !Number.isFinite(deliveryCostPerUnit) || deliveryCostPerUnit < 0 ||
        rawStock === undefined || String(rawStock).trim() === '' ||
        !Number.isInteger(stock) || stock < 0
    ) return null;

    return {
        title: title.trim(),
        heading: heading.trim(),
        about: about.trim(),
        price,
        costPrice,
        purchaseCost,
        taxPercent,
        deliveryCostPerUnit,
        stock
    };
}

async function getProductUploadAuth(req, res, next) {
    try {
        if (!await ensureAdmin(req, res)) return;
        return res.status(200).json(getUploadAuthenticationParameters(5));
    } catch (error) {
        return next(error);
    }
}

async function createProductFromImageKit(req, res, next) {
    try {
        if (!await ensureAdmin(req, res)) return;

        const fields = parseProductFields(req.body);
        if (!fields) {
            return res.status(400).json({ message: 'Enter a valid title, heading, description, price, cost, and stock.' });
        }

        const images = req.body?.images;
        if (!Array.isArray(images) || images.length < 4 || images.length > 5) {
            return res.status(400).json({ message: 'Choose 4 or 5 product photos.' });
        }
        const validImages = images.every((image) => (
            image &&
            typeof image.fileId === 'string' && image.fileId.trim() &&
            typeof image.url === 'string' &&
            (() => {
                try {
                    return new URL(image.url).protocol === 'https:';
                } catch {
                    return false;
                }
            })() &&
            Number.isSafeInteger(Number(image.size)) && Number(image.size) > 0
        ));
        const totalImageSize = images.reduce((sum, image) => sum + Number(image?.size || 0), 0);
        if (!validImages || totalImageSize > 25 * 1024 * 1024) {
            return res.status(400).json({ message: 'The product photos must be valid HTTPS images totalling no more than 25 MB.' });
        }

        const imageUrls = images.map((image) => image.url);
        let product;
        try {
            product = await ProductModel.create({
                ...fields,
                url: imageUrls[0],
                imageUrls
            });
        } catch (error) {
            await Promise.allSettled(images.map((image) => deleteUploadedImage(image.fileId)));
            throw error;
        }

        return res.status(201).json({ message: 'Product created successfully.', product });
    } catch (error) {
        return next(error);
    }
}

async function cleanupUploadedImages(req, res, next) {
    try {
        if (!await ensureAdmin(req, res)) return;

        const fileIds = req.body?.fileIds;
        if (!Array.isArray(fileIds) || fileIds.length > 5 ||
            fileIds.some((fileId) => typeof fileId !== 'string' || !fileId.trim())) {
            return res.status(400).json({ message: 'A valid list of uploaded image IDs is required.' });
        }

        const results = await Promise.allSettled(
            [...new Set(fileIds)].map((fileId) => deleteUploadedImage(fileId))
        );
        return res.status(200).json({
            removed: results.filter((result) => result.status === 'fulfilled').length
        });
    } catch (error) {
        return next(error);
    }
}

function getRangeStart(range) {
    const daysByRange = { '24h': 1, '3d': 3, week: 7, month: 30, '6months': 180, '12months': 365 };
    const days = daysByRange[range] || daysByRange.month;
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function getDeliveredAt(order) {
    const deliveredEvent = order.statusHistory
        ?.filter((entry) => entry.status === 'delivered')
        .sort((left, right) => new Date(right.changedAt) - new Date(left.changedAt))[0];
    return deliveredEvent?.changedAt || order.updatedAt || order.createdAt;
}

// POST /upload saves product details and an ImageKit URL; GET /images/:fileId serves legacy GridFS images.
async function handleProductRequest(req, res, next) {
    // Keep old image URLs working without creating new GridFS files or chunks.
    if (req.method === 'GET' || req.method === 'HEAD') {
        try {
            const file = await findImage(req.params.fileId);
            if (!file) {
                return res.status(404).json({ message: 'Image not found' });
            }

            if (file.metadata?.contentType) {
                res.type(file.metadata.contentType);
            }
            res.set('Cache-Control', 'public, max-age=31536000, immutable');
            res.set('Content-Length', String(file.length));

            const stream = downloadImage(req.params.fileId);
            stream.once('error', next);
            return stream.pipe(res);
        } catch (error) {
            return next(error);
        }
    }

    // New admin UI uploads signed ImageKit files directly, then saves their URLs.
    if (Array.isArray(req.body?.images)) {
        return createProductFromImageKit(req, res, next);
    }

    // Only admins may create products.
    const token = req.cookies.token;
    if (!token) {
        return res.status(401).json({ message: 'Unauthorized' });
    }

    let decoded;
    try {
        decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (error) {
        console.error(error)
        return res.status(401).json({ message: 'Unauthorized' });
    }

    if (decoded.role !== 'admin') {
        return res.status(403).json({ message: 'Admin access required' });
    }

    // Validate the text fields before uploading an image or writing to the database.
    const { title, heading, about, price: rawPrice, costPrice: rawCostPrice, purchaseCost: rawPurchaseCost,
        taxPercent: rawTaxPercent, deliveryCostPerUnit: rawDeliveryCost, stock: rawStock } = req.body || {};
    const price = Number(rawPrice);
    const costPrice = rawCostPrice === undefined || rawCostPrice === '' ? 0 : Number(rawCostPrice);
    const purchaseCost = rawPurchaseCost === undefined || rawPurchaseCost === '' ? 0 : Number(rawPurchaseCost);
    const taxPercent = rawTaxPercent === undefined || rawTaxPercent === '' ? 0 : Number(rawTaxPercent);
    const deliveryCostPerUnit = rawDeliveryCost === undefined || rawDeliveryCost === '' ? 0 : Number(rawDeliveryCost);
    const stock = Number(rawStock);
    if (
        typeof title !== 'string' || !title.trim() ||
        typeof heading !== 'string' || !heading.trim() ||
        typeof about !== 'string' || !about.trim() ||
        typeof rawPrice !== 'string' || !rawPrice.trim() ||
        !Number.isFinite(price) || price < 0 ||
        !Number.isFinite(costPrice) || costPrice < 0 || costPrice > price ||
        !Number.isFinite(purchaseCost) || purchaseCost < 0 ||
        !Number.isFinite(taxPercent) || taxPercent < 0 || taxPercent > 100 ||
        !Number.isFinite(deliveryCostPerUnit) || deliveryCostPerUnit < 0 ||
        typeof rawStock !== 'string' || !rawStock.trim() ||
        !Number.isInteger(stock) || stock < 0
    ) {
        return res.status(400).json({ message: 'Catalogue title, product heading, about, valid non-negative price, and initial stock are required' });
    }


    const file = req.file;
    if (!file) {
        return res.status(400).json({ message: 'Product image is required in the image form-data field' });
    }

    if (!file.mimetype?.startsWith('image/')) {
        return res.status(400).json({ message: 'The uploaded file must be an image' });
    }

    let uploadedImage;
    try {
        // Store the image externally, then keep its URL with the product data.
        uploadedImage = await uploadImage(file.buffer, file.originalname, file.mimetype);
        const product = await ProductModel.create({
            url: uploadedImage.url,
            title: title.trim(),
            heading: heading.trim(),
            about: about.trim(),
            price,
            costPrice,
            purchaseCost,
            taxPercent,
            deliveryCostPerUnit,
            stock
        });

        return res.status(201).json({
            message: 'Product created successfully',
            product: {
                id: product._id,
                url: product.url,
                title: product.title,
                heading: product.heading,
                about: product.about,
                price: product.price,
                costPrice: product.costPrice,
                stock: product.stock,
                soldCount: product.soldCount
            }
        });
    } catch (error) {
        console.error(error)
        if (uploadedImage?.id) {
            try {
                await deleteImage(uploadedImage.id);
            } catch (cleanupError) {
                console.error('Could not remove ImageKit file after product save failed:', cleanupError.name);
            }
        }

        return next(error);
    }
}

async function adjustInventory(req, res, next) {
    try {
        if (!await ensureAdmin(req, res)) return;
        if (!mongoose.isValidObjectId(req.params.productId)) {
            return res.status(400).json({ message: 'Invalid product ID' });
        }
        const quantity = Number(req.body?.quantity);
        const reason = req.body?.reason;
        const validReasons = ['net_purchase', 'restock', 'damaged', 'supplier_return'];
        if (!validReasons.includes(reason)) {
            return res.status(400).json({ message: 'Choose a valid inventory adjustment type.' });
        }
        if (!Number.isInteger(quantity) || quantity < 1) {
            return res.status(400).json({ message: 'Enter a valid quantity.' });
        }
        const removesStock = reason === 'damaged' || reason === 'supplier_return';
        const increment = reason === 'damaged'
            ? { stock: -quantity, damagedCount: quantity }
            : reason === 'supplier_return'
                ? { stock: -quantity, supplierReturnCount: quantity }
                : { stock: quantity };
        let minimumStock = quantity;
        if (removesStock) {
            const pendingPaymentCutoff = new Date(Date.now() - PAYMENT_RESERVATION_WINDOW_MS);
            const [activeOrders, pendingPaymentOrders] = await Promise.all([
                OrderModel.find({
                    status: { $in: OPEN_ORDER_STATUSES },
                    'items.productId': new mongoose.Types.ObjectId(req.params.productId)
                }).select('items').lean(),
                OrderModel.find({
                    status: 'pending_payment',
                    createdAt: { $gte: pendingPaymentCutoff },
                    'items.productId': new mongoose.Types.ObjectId(req.params.productId)
                }).select('items').lean()
            ]);
            const reserved = [...activeOrders, ...pendingPaymentOrders].reduce((sum, order) => (
                sum + (order.items || [])
                    .filter((item) => String(item.productId) === req.params.productId)
                    .reduce((quantitySum, item) => quantitySum + Number(item.quantity || 0), 0)
            ), 0);
            minimumStock += reserved;
        }

        const product = await ProductModel.findOneAndUpdate(
            removesStock
                ? { _id: req.params.productId, stock: { $gte: minimumStock } }
                : { _id: req.params.productId },
            { $inc: increment },
            { new: true }
        );
        if (!product) return res.status(409).json({ message: 'The quantity cannot exceed remaining stock, or the product no longer exists.' });
        return res.status(200).json({ product });
    } catch (error) {
        return next(error);
    }
}

async function getInventorySales(req, res, next) {
    try {
        if (!await ensureAdmin(req, res)) return;

        const range = typeof req.query.range === 'string' ? req.query.range : 'month';
        const start = getRangeStart(range);
        const [products, orders, cancelledOrders, legacyCancelledOrders] = await Promise.all([
            ProductModel.find().sort({ title: 1, heading: 1 }).lean(),
            OrderModel.find().select('items status returnStatus returnRequestedAt returnedAt createdAt updatedAt statusHistory').lean(),
            CancelledOrderModel.find().select('items cancelledAt createdAt updatedAt').lean(),
            OrderModel.find({ status: 'cancelled' }).select('items cancelledAt createdAt updatedAt').lean()
        ]);
        const productStats = new Map(products.map((product) => [String(product._id), {
            product,
            reservedCount: 0,
            confirmedSold: 0,
            lifetimeSoldCount: 0,
            confirmedRevenuePaise: 0,
            confirmedExpensesPaise: 0,
            confirmedNetProfitPaise: 0,
            activeCount: 0,
            inProcessCount: 0,
            cancelledCount: 0,
            returnCount: 0,
            lifetimeReturnedCount: 0
        }]));
        const addOrderItems = (order, field, date, ignoreRange = false) => {
            if (!ignoreRange && new Date(date || 0).getTime() < start.getTime()) return;
            for (const item of order.items || []) {
                const stats = productStats.get(String(item.productId));
                if (stats) stats[field] += Number(item.quantity || 0);
            }
        };

        const now = Date.now();
        for (const order of orders) {
            const isLivePaymentReservation = order.status === 'pending_payment' &&
                now - new Date(order.createdAt || 0).getTime() <= PAYMENT_RESERVATION_WINDOW_MS;
            if (OPEN_ORDER_STATUSES.includes(order.status) || isLivePaymentReservation) {
                addOrderItems(order, 'activeCount', order.createdAt, true);
                addOrderItems(order, 'reservedCount', order.createdAt, true);
            }
            if (order.status === 'delivered' && order.returnStatus !== 'accepted') {
                const deliveredAt = getDeliveredAt(order);
                const deliveredTime = new Date(deliveredAt || 0).getTime();
                const ageSinceDelivery = now - deliveredTime;
                const isInProcess = ageSinceDelivery >= 0 && ageSinceDelivery < COMPLETION_WINDOW_MS;
                const isConfirmed = ageSinceDelivery >= COMPLETION_WINDOW_MS;
                const confirmedTime = deliveredTime + COMPLETION_WINDOW_MS;
                for (const item of order.items || []) {
                    const stats = productStats.get(String(item.productId));
                    if (!stats) continue;
                    const quantity = Number(item.quantity || 0);
                    if (isInProcess) stats.inProcessCount += quantity;
                    if (isConfirmed) stats.lifetimeSoldCount += quantity;
                    if (isConfirmed && confirmedTime >= start.getTime()) {
                        const lineRevenuePaise = Number(item.lineTotalPaise || (
                            Number(item.unitPricePaise || 0) * quantity
                        ));
                        const unitCostPaise = Number.isFinite(Number(item.unitPurchaseCostPaise))
                            ? Number(item.unitPurchaseCostPaise)
                            : Math.round(Number(stats.product.purchaseCost || stats.product.costPrice || 0) * 100);
                        const deliveryCostPaise = Number.isFinite(Number(item.unitDeliveryCostPaise))
                            ? Number(item.unitDeliveryCostPaise)
                            : Math.round(Number(stats.product.deliveryCostPerUnit || 0) * 100);
                        const taxPercent = Number.isFinite(Number(item.taxPercent))
                            ? Number(item.taxPercent)
                            : Number(stats.product.taxPercent || 0);
                        const taxPaise = Math.round(
                            Number(item.unitPricePaise || 0) * quantity * taxPercent / 100
                        );
                        const expensesPaise = (unitCostPaise + deliveryCostPaise) * quantity + taxPaise;
                        stats.confirmedSold += quantity;
                        stats.confirmedRevenuePaise += lineRevenuePaise;
                        stats.confirmedExpensesPaise += expensesPaise;
                        stats.confirmedNetProfitPaise += lineRevenuePaise - expensesPaise;
                    }
                }
            }
            if (order.returnStatus === 'accepted') {
                for (const item of order.items || []) {
                    const stats = productStats.get(String(item.productId));
                    if (stats) stats.lifetimeReturnedCount += Number(item.quantity || 0);
                }
                addOrderItems(order, 'returnCount', order.returnedAt || order.returnRequestedAt || getDeliveredAt(order));
            }
        }

        const cancelledById = new Map(
            [...cancelledOrders, ...legacyCancelledOrders].map((order) => [String(order._id), order])
        );
        for (const order of cancelledById.values()) {
            addOrderItems(order, 'cancelledCount', order.cancelledAt || order.updatedAt || order.createdAt);
        }

        return res.status(200).json({
            range,
            products: [...productStats.values()].map(({ product, ...stats }) => ({
                id: String(product._id),
                title: product.title,
                heading: product.heading,
                price: product.price,
                costPrice: product.costPrice,
                purchaseCost: product.purchaseCost,
                taxPercent: product.taxPercent,
                deliveryCostPerUnit: product.deliveryCostPerUnit,
                stock: Math.max(0, Number(product.stock || 0) - stats.reservedCount),
                physicalStock: product.stock,
                reservedCount: stats.reservedCount,
                soldCount: stats.lifetimeSoldCount,
                lifetimeSoldCount: stats.lifetimeSoldCount,
                damagedCount: product.damagedCount,
                supplierReturnCount: product.supplierReturnCount || 0,
                viewCount: product.viewCount,
                url: product.url,
                uri: product.uri,
                imageUrls: product.imageUrls || [],
                confirmedSold: stats.confirmedSold,
                confirmedRevenuePaise: stats.confirmedRevenuePaise,
                confirmedExpensesPaise: stats.confirmedExpensesPaise,
                confirmedNetProfitPaise: stats.confirmedNetProfitPaise,
                activeCount: stats.activeCount,
                inProcessCount: stats.inProcessCount,
                cancelledCount: stats.cancelledCount,
                returnCount: stats.returnCount,
                lifetimeReturnedCount: stats.lifetimeReturnedCount
            }))
        });
    } catch (error) {
        return next(error);
    }
}

async function getAllProducts(req, res, next) {
    try {
        let productsQuery = ProductModel.find();
        if (req.query.sort === 'popular') {
            productsQuery = productsQuery.sort({ viewCount: -1, _id: -1 });
        }

        const products = await productsQuery;
        return res.status(200).json({
            message: "Products fetched Sucesfull",
            products
        });
    } catch (error) {
        return next(error);
    }
}

async function getProductById(req, res, next) {
    if (!mongoose.isValidObjectId(req.params.productId)) {
        return res.status(400).json({ message: 'Invalid product ID' });
    }

    try {
        const product = await ProductModel.findById(req.params.productId);
        if (!product) {
            return res.status(404).json({ message: 'Product not found' });
        }

        return res.status(200).json({ product });
    } catch (error) {
        return next(error);
    }
}

async function incrementProductView(req, res, next) {
    if (!mongoose.isValidObjectId(req.params.productId)) {
        return res.status(400).json({ message: 'Invalid product ID' });
    }

    try {
        const product = await ProductModel.findByIdAndUpdate(
            req.params.productId,
            { $inc: { viewCount: 1 } },
            { new: true }
        );
        if (!product) {
            return res.status(404).json({ message: 'Product not found' });
        }

        return res.status(200).json({ viewCount: product.viewCount });
    } catch (error) {
        return next(error);
    }
}

module.exports = {
    handleProductRequest,
    getProductUploadAuth,
    createProductFromImageKit,
    cleanupUploadedImages,
    adjustInventory,
    getInventorySales,
    getAllProducts,
    getProductById,
    incrementProductView
};
