const ProductModel = require('../models/product.model');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const OrderModel = require('../models/order.model');
const CancelledOrderModel = require('../models/cancelled-order.model');
const { getUploadAuthenticationParameters, findImage, downloadImage, deleteImage } = require('../services/storage.service');

const MAX_PRODUCT_IMAGES = 5;
const MIN_PRODUCT_IMAGES = 4;
const MAX_PRODUCT_IMAGE_BYTES = 25 * 1024 * 1024;

function verifyAdminRequest(req, res) {
    const token = req.cookies?.token;
    if (!token) {
        res.status(401).json({ message: 'Unauthorized' });
        return null;
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded.role !== 'admin') {
            res.status(403).json({ message: 'Admin access required' });
            return null;
        }
        return decoded;
    } catch (error) {
        res.status(401).json({ message: 'Unauthorized' });
        return null;
    }
}

async function cleanupImageFiles(fileIds = []) {
    const uniqueFileIds = [...new Set(fileIds.filter((fileId) => typeof fileId === 'string' && fileId.trim()))];
    await Promise.all(uniqueFileIds.map((fileId) => deleteImage(fileId).catch((error) => {
        console.error('Could not remove an unused ImageKit upload:', error.name);
    })));
}

async function getImageUploadAuth(req, res, next) {
    if (!verifyAdminRequest(req, res)) return;

    const publicKey = process.env.IMAGEKIT_PUBLIC_KEY?.trim();
    if (!publicKey) {
        return res.status(503).json({ message: 'Image upload is not configured. Set IMAGEKIT_PUBLIC_KEY on the backend.' });
    }

    try {
        const uploadAuth = Array.from({ length: MAX_PRODUCT_IMAGES }, () => getUploadAuthenticationParameters());
        return res.status(200).json({ uploadAuth, publicKey });
    } catch (error) {
        return next(error);
    }
}

async function cleanupImageUploads(req, res) {
    if (!verifyAdminRequest(req, res)) return;
    const fileIds = req.body?.fileIds;
    if (!Array.isArray(fileIds) || fileIds.length > MAX_PRODUCT_IMAGES) {
        return res.status(400).json({ message: 'Invalid uploaded image list.' });
    }

    await cleanupImageFiles(fileIds);
    return res.status(200).json({ message: 'Unused product images removed.' });
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

    // Only admins may create products.
    if (!verifyAdminRequest(req, res)) return;

    const images = Array.isArray(req.body?.images) ? req.body.images : [];
    const uploadedFileIds = images.map((image) => image?.fileId).filter((fileId) => typeof fileId === 'string');
    const discardUploadedImages = () => cleanupImageFiles(uploadedFileIds);
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
        await discardUploadedImages();
        return res.status(400).json({ message: 'Catalogue title, product heading, about, valid non-negative price, and initial stock are required' });
    }

    const imageBytes = images.reduce((sum, image) => sum + Number(image?.size || 0), 0);
    const validImages = images.length >= MIN_PRODUCT_IMAGES &&
        images.length <= MAX_PRODUCT_IMAGES &&
        images.every((image) => (
            typeof image?.url === 'string' && /^https:\/\//i.test(image.url) &&
            typeof image?.fileId === 'string' && image.fileId.trim() &&
            Number.isInteger(image.size) && image.size > 0
        ));
    if (!validImages || imageBytes > MAX_PRODUCT_IMAGE_BYTES) {
        await discardUploadedImages();
        return res.status(400).json({ message: 'Upload 4 or 5 product photos with a combined size of 25 MB or less.' });
    }

    try {
        const imageUrls = images.map((image) => image.url);
        const product = await ProductModel.create({
            url: imageUrls[0],
            imageUrls,
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
                imageUrls: product.imageUrls,
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
        await discardUploadedImages();

        return next(error);
    }
}

async function adjustInventory(req, res, next) {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ message: 'Unauthorized' });
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded.role !== 'admin') return res.status(403).json({ message: 'Admin access required' });
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
        const removesStock = ['damaged', 'supplier_return'].includes(reason);
        const update = reason === 'damaged'
            ? { $inc: { stock: -quantity, damagedCount: quantity } }
            : reason === 'supplier_return'
                ? { $inc: { stock: -quantity, supplierReturnCount: quantity } }
                : { $inc: { stock: quantity } };
        const product = await ProductModel.findOneAndUpdate(
            removesStock ? { _id: req.params.productId, stock: { $gte: quantity } } : { _id: req.params.productId },
            update,
            { new: true }
        );
        if (!product) return res.status(409).json({ message: 'Adjustment quantity cannot exceed remaining stock.' });
        return res.status(200).json({ product });
    } catch (error) {
        if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
            return res.status(401).json({ message: 'Unauthorized' });
        }
        return next(error);
    }
}

async function getInventorySales(req, res, next) {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ message: 'Unauthorized' });
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded.role !== 'admin') {
            return res.status(403).json({ message: 'Admin access required' });
        }
        const range = typeof req.query.range === 'string' ? req.query.range : 'month';
        const rangeDays = { '24h': 1, '3d': 3, week: 7, month: 30, '6months': 180, '12months': 365 };
        const start = new Date(Date.now() - (rangeDays[range] || 30) * 24 * 60 * 60 * 1000);
        const completionWindow = 2 * 24 * 60 * 60 * 1000;

        const [products, activeOrders, separateCancelled, legacyCancelled] = await Promise.all([
            ProductModel.find().sort({ title: 1, heading: 1 }),
            OrderModel.find({ status: { $ne: 'cancelled' } }).select('status amountPaise items createdAt statusHistory updatedAt returnStatus'),
            CancelledOrderModel.find().select('status amountPaise items createdAt updatedAt cancelledAt statusHistory'),
            OrderModel.find({ status: 'cancelled' }).select('status amountPaise items createdAt updatedAt cancelledAt statusHistory')
        ]);

        const getDeliveredAt = (order) => {
            const event = order.statusHistory
                ?.filter((entry) => entry.status === 'delivered')
                .sort((left, right) => new Date(right.changedAt) - new Date(left.changedAt))[0];
            return event?.changedAt || order.updatedAt || order.createdAt;
        };
        const getCancelledAt = (order) => {
            const event = order.statusHistory
                ?.filter((entry) => entry.status === 'cancelled')
                .sort((left, right) => new Date(right.changedAt) - new Date(left.changedAt))[0];
            return order.cancelledAt || event?.changedAt || order.updatedAt || order.createdAt;
        };

        const confirmedOrders = activeOrders.filter((order) => {
            if (order.status !== 'delivered' || order.returnStatus === 'accepted') return false;
            const deliveredAt = getDeliveredAt(order);
            return deliveredAt &&
                new Date(deliveredAt).getTime() >= start.getTime() &&
                Date.now() - new Date(deliveredAt).getTime() >= completionWindow;
        });
        const inProcessOrders = activeOrders.filter((order) => {
            if (['pending_payment', 'confirmed', 'processing', 'shipped'].includes(order.status)) {
                return new Date(order.createdAt).getTime() >= start.getTime();
            }
            if (order.status !== 'delivered' || order.returnStatus === 'accepted') return false;
            const deliveredAt = getDeliveredAt(order);
            return deliveredAt &&
                new Date(deliveredAt).getTime() >= start.getTime() &&
                Date.now() - new Date(deliveredAt).getTime() < completionWindow;
        });
        const activeOrdersInRange = activeOrders.filter((order) => (
            ['pending_payment', 'confirmed', 'processing', 'shipped'].includes(order.status) &&
            new Date(order.createdAt).getTime() >= start.getTime()
        ));
        const returnOrders = activeOrders.filter((order) => {
            if (!['requested', 'accepted'].includes(order.returnStatus)) return false;
            const date = order.returnedAt || order.returnRequestedAt || getDeliveredAt(order);
            return date && new Date(date).getTime() >= start.getTime();
        });
        const cancelledOrders = [...separateCancelled, ...legacyCancelled]
            .filter((order, index, orders) => (
                orders.findIndex((candidate) => String(candidate._id) === String(order._id)) === index
            ))
            .filter((order) => {
                const date = getCancelledAt(order);
                return date && new Date(date).getTime() >= start.getTime();
            });

        const countForProduct = (orders, productId) => orders.reduce((count, order) => {
            const item = (order.items || []).find((entry) => String(entry.productId) === String(productId));
            return count + Number(item?.quantity || 0);
        }, 0);
        const sumForProduct = (orders, productId) => orders.reduce((sum, order) => {
            const item = (order.items || []).find((entry) => String(entry.productId) === String(productId));
            return sum + Number(item?.lineTotalPaise || 0);
        }, 0);

        return res.status(200).json({
            range,
            products: products.map((product) => ({
                id: product._id,
                url: product.url,
                uri: product.uri,
                title: product.title,
                heading: product.heading,
                price: product.price,
                costPrice: product.costPrice,
                purchaseCost: product.purchaseCost,
                taxPercent: product.taxPercent,
                deliveryCostPerUnit: product.deliveryCostPerUnit,
                stock: product.stock,
                soldCount: product.soldCount,
                damagedCount: product.damagedCount,
                supplierReturnCount: product.supplierReturnCount,
                viewCount: product.viewCount,
                confirmedSold: countForProduct(confirmedOrders, product._id),
                activeCount: countForProduct(activeOrdersInRange, product._id),
                inProcessCount: countForProduct(inProcessOrders, product._id),
                cancelledCount: countForProduct(cancelledOrders, product._id),
                returnCount: countForProduct(returnOrders, product._id),
                confirmedRevenuePaise: sumForProduct(confirmedOrders, product._id)
            }))
        });
    } catch (error) {
        if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
            return res.status(401).json({ message: 'Unauthorized' });
        }
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
    getImageUploadAuth,
    cleanupImageUploads,
    adjustInventory,
    getInventorySales,
    getAllProducts,
    getProductById,
    incrementProductView
};
