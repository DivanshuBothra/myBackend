const ProductModel = require('../models/product.model');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { uploadImage, findImage, downloadImage, deleteImage } = require('../services/storage.service');

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
            res.set('Content-Length', String(file.length));

            const stream = downloadImage(req.params.fileId);
            stream.once('error', next);
            return stream.pipe(res);
        } catch (error) {
            return next(error);
        }
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
    const { title, about, price: rawPrice } = req.body || {};
    const price = Number(rawPrice);
    if (
        typeof title !== 'string' || !title.trim() ||
        typeof about !== 'string' || !about.trim() ||
        typeof rawPrice !== 'string' || !rawPrice.trim() ||
        !Number.isFinite(price) || price < 0
    ) {
        return res.status(400).json({ message: 'Title, about, and a valid non-negative price are required' });
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
            about: about.trim(),
            price
        });

        return res.status(201).json({
            message: 'Product created successfully',
            product: {
                id: product._id,
                url: product.url,
                title: product.title,
                about: product.about,
                price: product.price
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
    getAllProducts,
    getProductById,
    incrementProductView
};
